/**
 * Synthetic household generator.
 *
 * Ring's sandbox gives synthetic devices and events; this adds the missing piece for a
 * caretaking demo — a *believable person* behind those events, and a way to replay both an
 * ordinary day and the day something goes wrong. Everything is seeded, so a demo run is
 * reproducible and a test can assert on it.
 */

import { HomeEvent, RingEventType, RingWebhookEnvelope, DeviceRole } from '../ring/events';

export interface SimDevice {
  id: string;
  name: string;
  role: DeviceRole;
}

export const DEMO_DEVICES: SimDevice[] = [
  { id: 'ava1.ring.device.SIMDOOR01', name: 'Front Door', role: 'front_door' },
  { id: 'ava1.ring.device.SIMLIVING1', name: 'Living Room', role: 'indoor' },
  { id: 'ava1.ring.device.SIMCHIME01', name: 'Kitchen Chime', role: 'chime' },
];

export type Scenario =
  | 'normal'          // an ordinary day: up, moves about, settles
  | 'late_start'      // no activity by late morning — the case the app exists for
  | 'afternoon_stop'  // normal morning, then nothing for hours
  | 'went_out';       // leaves through the front door and stays out

/** Deterministic PRNG (mulberry32) so demos and tests replay identically. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimOptions {
  /** epoch ms of local midnight for day 0 */
  startOfDay: number;
  tzOffsetMinutes: number;
  seed: number;
  /** typical wake-up, minutes since local midnight */
  wakeMinute: number;
  /** typical settle-down time */
  sleepMinute: number;
  /** presence events on an ordinary day */
  eventsPerDay: number;
}

export const DEFAULT_SIM: SimOptions = {
  startOfDay: 0,
  tzOffsetMinutes: 540,
  seed: 20260904,
  wakeMinute: 6 * 60 + 40,
  sleepMinute: 22 * 60 + 10,
  eventsPerDay: 22,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function ev(deviceId: string, role: DeviceRole, type: RingEventType, at: number, subType?: string): HomeEvent {
  return { id: `${deviceId}_${type}_${at}`, deviceId, type, at, subType, role };
}

/** One ordinary day of presence events, jittered around the household's habits. */
function ordinaryDay(dayStart: number, o: SimOptions, r: () => number): HomeEvent[] {
  const out: HomeEvent[] = [];
  const wake = o.wakeMinute + Math.round((r() - 0.5) * 50);
  const sleep = o.sleepMinute + Math.round((r() - 0.5) * 60);
  const door = DEMO_DEVICES[0];
  const living = DEMO_DEVICES[1];

  out.push(ev(living.id, living.role, 'motion_detected', dayStart + wake * 60_000, 'human'));

  const n = Math.max(6, Math.round(o.eventsPerDay + (r() - 0.5) * 8));
  for (let i = 0; i < n; i++) {
    const t = wake + Math.round(r() * (sleep - wake));
    const useDoor = r() < 0.15;
    const d = useDoor ? door : living;
    out.push(ev(d.id, d.role, 'motion_detected', dayStart + t * 60_000, 'human'));
  }
  // The mail arrives most days.
  if (r() < 0.6) out.push(ev(door.id, door.role, 'button_press', dayStart + (11 * 60 + Math.round(r() * 240)) * 60_000));
  out.push(ev(living.id, living.role, 'motion_detected', dayStart + sleep * 60_000, 'human'));
  return out.sort((a, b) => a.at - b.at);
}

/** `days` of ordinary history ending the day before `startOfDay`. */
export function history(days: number, o: SimOptions = DEFAULT_SIM): HomeEvent[] {
  const r = rng(o.seed);
  const out: HomeEvent[] = [];
  for (let d = days; d >= 1; d--) out.push(...ordinaryDay(o.startOfDay - d * DAY_MS, o, r));
  return out;
}

/** Events for the day under observation, up to `untilMinute` of that day. */
export function today(scenario: Scenario, untilMinute: number, o: SimOptions = DEFAULT_SIM): HomeEvent[] {
  const r = rng(o.seed + 7);
  const day = o.startOfDay;
  const door = DEMO_DEVICES[0];
  const living = DEMO_DEVICES[1];
  const cut = (list: HomeEvent[]) => list.filter((e) => e.at <= day + untilMinute * 60_000).sort((a, b) => a.at - b.at);

  switch (scenario) {
    case 'normal':
      return cut(ordinaryDay(day, o, r));
    case 'late_start':
      return [];                                   // nothing at all: the alarm case
    case 'afternoon_stop': {
      const morning = ordinaryDay(day, o, r).filter((e) => e.at <= day + 13 * 60 * 60_000);
      return cut(morning);
    }
    case 'went_out': {
      const morning = ordinaryDay(day, o, r).filter((e) => e.at <= day + (9 * 60 + 30) * 60_000);
      morning.push(ev(door.id, door.role, 'motion_detected', day + (9 * 60 + 35) * 60_000, 'human'));
      return cut(morning);
    }
  }
}

/** Wrap a normalized event back into the exact webhook envelope Ring would POST. */
export function toWebhook(e: HomeEvent, accountId = 'ava1.ring.account.SIMULATED'): RingWebhookEnvelope {
  return {
    meta: {
      version: '1.1',
      time: new Date(e.at).toISOString(),
      request_id: `sim-${e.id}`,
      account_id: accountId,
    },
    data: {
      id: e.id,
      type: e.type,
      attributes: {
        source: e.deviceId,
        source_type: 'devices',
        timestamp: e.at,
        ...(e.subType ? { sub_type: e.subType } : {}),
      },
      relationships: { devices: { links: { self: `/v1/devices/${e.deviceId}` } } },
    },
  };
}

export function roleOf(deviceId: string): DeviceRole {
  return DEMO_DEVICES.find((d) => d.id === deviceId)?.role ?? 'unknown';
}
