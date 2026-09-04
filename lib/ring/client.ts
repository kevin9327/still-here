/**
 * Ring Partner API client — the endpoints Still Here actually uses.
 *
 * Server-side only: Ring requires every call to api.amazonvision.com to come from a
 * partner backend, never from the browser. The client is deliberately thin; the fun
 * lives in lib/rhythm, and this file stays boring enough to audit.
 *
 * Auth: a Developer Playground access token (short-lived) or an OAuth refresh token.
 * Docs: https://developer.amazon.com/docs/ring/api-documentation.html
 */

import { HomeEvent, RingEventType, DeviceRole } from './events';

export const RING_API_BASE = process.env.RING_API_BASE ?? 'https://api.amazonvision.com';

export interface RingDevice {
  id: string;
  name: string;
  kind?: string;
  /** what this device means to the household, resolved from capabilities + name */
  role: DeviceRole;
  raw?: unknown;
}

export interface RingCapabilities {
  /** chimes expose audio slots; only those devices can be knocked on */
  chimeControls: boolean;
  audioSlots: string[];
  motionDetection: boolean;
  raw: unknown;
}

export class RingApiError extends Error {
  constructor(readonly status: number, readonly endpoint: string, readonly body: string) {
    super(`Ring API ${status} on ${endpoint}: ${body.slice(0, 300)}`);
  }
}

export interface RingClientOptions {
  accessToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** JSON:API responses wrap everything in `data`; a few endpoints return a bare object. */
function unwrap<T>(payload: any): T {
  return (payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload) as T;
}

export class RingClient {
  private readonly base: string;
  private readonly token: string;
  private readonly http: typeof fetch;

  constructor(opts: RingClientOptions) {
    this.token = opts.accessToken;
    this.base = opts.baseUrl ?? RING_API_BASE;
    this.http = opts.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.http(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new RingApiError(res.status, path, await res.text().catch(() => ''));
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return unwrap<T>(await (await this.request(path, init)).json());
  }

  /** GET /v1/users/me — account id, used to bind webhooks to a household. */
  accountId(): Promise<{ id: string; [k: string]: unknown }> {
    return this.json('/v1/users/me');
  }

  /** GET /v1/devices */
  async devices(): Promise<RingDevice[]> {
    const list = await this.json<any[]>('/v1/devices');
    return (Array.isArray(list) ? list : []).map((d) => {
      const name: string = d?.attributes?.name ?? d?.name ?? d?.id ?? 'device';
      const kind: string | undefined = d?.attributes?.kind ?? d?.attributes?.device_type ?? d?.kind;
      return { id: d?.id ?? d?.attributes?.id, name, kind, role: guessRole(name, kind), raw: d };
    });
  }

  /** GET /v1/devices/{id}/status */
  status(deviceId: string): Promise<{ online?: boolean; [k: string]: unknown }> {
    return this.json(`/v1/devices/${encodeURIComponent(deviceId)}/status`);
  }

  /** GET /v1/devices/{id}/capabilities — tells us whether we may knock on this device. */
  async capabilities(deviceId: string): Promise<RingCapabilities> {
    const raw = await this.json<any>(`/v1/devices/${encodeURIComponent(deviceId)}/capabilities`);
    const attrs = raw?.attributes ?? raw ?? {};
    const slots: string[] = attrs.audio_slots ?? attrs.audioSlots ?? attrs?.chime?.audio_slots ?? [];
    const actions: string[] = attrs.supported_actions ?? attrs.supportedActions ?? [];
    return {
      chimeControls: Boolean(attrs.chime_controls ?? attrs.chimeControls) || actions.includes('audio_playback') || slots.length > 0,
      audioSlots: Array.isArray(slots) ? slots.map(String) : [],
      motionDetection: Boolean(attrs.motion_detection ?? attrs.motionDetection ?? true),
      raw,
    };
  }

  /** GET /v1/devices/{id}/configurations — motion zones, audio slots, volume. */
  configurations(deviceId: string): Promise<unknown> {
    return this.json(`/v1/devices/${encodeURIComponent(deviceId)}/configurations`);
  }

  /**
   * GET /v1/history/devices/{id}/events — the raw material for the rhythm model.
   * `roleOf` maps device ids onto household roles so the engine stays device-agnostic.
   */
  async history(
    deviceId: string,
    params: { since?: number; until?: number; limit?: number } = {},
    roleOf: (id: string) => DeviceRole = () => 'unknown',
  ): Promise<HomeEvent[]> {
    const q = new URLSearchParams();
    if (params.since) q.set('start_time', new Date(params.since).toISOString());
    if (params.until) q.set('end_time', new Date(params.until).toISOString());
    if (params.limit) q.set('limit', String(params.limit));
    const suffix = q.toString() ? `?${q}` : '';
    const list = await this.json<any[]>(`/v1/history/devices/${encodeURIComponent(deviceId)}/events${suffix}`);
    return (Array.isArray(list) ? list : []).map((e) => {
      const attrs = e?.attributes ?? {};
      const at = typeof attrs.timestamp === 'number' ? attrs.timestamp : Date.parse(attrs.timestamp ?? e?.time ?? 0);
      const type = (attrs.event_type ?? e?.type ?? 'motion_detected') as RingEventType;
      const source = attrs.source ?? deviceId;
      return {
        id: e?.id ?? `${source}_${type}_${at}`,
        deviceId: source,
        type,
        at,
        subType: attrs.sub_type,
        role: roleOf(source),
      } satisfies HomeEvent;
    });
  }

  /**
   * POST /v1/devices/{id}/media/audio/playback — the knock.
   * `audio_ref` names a slot the chime already holds; Ring does not take arbitrary audio.
   */
  async playAudio(deviceId: string, audioRef: string): Promise<void> {
    await this.request(`/v1/devices/${encodeURIComponent(deviceId)}/media/audio/playback`, {
      method: 'POST',
      body: JSON.stringify({ audio_ref: audioRef }),
    });
  }

  /** POST /v1/devices/{id}/media/image/download — one still, pulled only when we escalate. */
  async snapshot(deviceId: string, components?: number[]): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await this.request(`/v1/devices/${encodeURIComponent(deviceId)}/media/image/download`, {
      method: 'POST',
      body: JSON.stringify(components ? { components } : {}),
      headers: { Accept: 'image/jpeg,image/png' },
    });
    return { bytes: await res.arrayBuffer(), contentType: res.headers.get('content-type') ?? 'image/jpeg' };
  }

  /** POST /v1/devices/{id}/media/streaming/whep/sessions — WebRTC offer in, answer out. */
  async startWhepSession(deviceId: string, sdpOffer: string): Promise<{ sdpAnswer: string; sessionId: string | null }> {
    const res = await this.request(`/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions`, {
      method: 'POST',
      body: sdpOffer,
      headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
    });
    const location = res.headers.get('location');
    return { sdpAnswer: await res.text(), sessionId: location ? location.split('/').pop() ?? null : null };
  }

  /** DELETE .../whep/sessions/{id} — always close the stream; battery devices cap at 30s anyway. */
  async stopWhepSession(deviceId: string, sessionId: string): Promise<void> {
    await this.request(
      `/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
  }
}

/** Ring names devices by where they are; that is enough to infer their role in a home. */
export function guessRole(name: string, kind?: string): DeviceRole {
  const s = `${name} ${kind ?? ''}`.toLowerCase();
  if (/chime/.test(s)) return 'chime';
  if (/doorbell|front|entry|porch|gate/.test(s)) return 'front_door';
  if (/indoor|living|kitchen|room|hall|stick.?up/.test(s)) return 'indoor';
  return 'unknown';
}
