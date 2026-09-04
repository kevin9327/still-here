/**
 * Ring Partner API webhook v1.1 payloads and event-history records.
 *
 * Shapes follow the public docs (Notifications > Webhook v1.1 Payload Structure).
 * Everything here is pure types + parsing so it can be unit-tested without a token.
 */

export const RING_EVENT_TYPES = [
  'motion_detected',
  'button_press',
  'device_added',
  'device_removed',
  'device_online',
  'device_offline',
  'app_integration_added',
  'app_integration_removed',
  'subscription_activated',
  'subscription_deactivated',
] as const;

export type RingEventType = (typeof RING_EVENT_TYPES)[number];

export interface RingWebhookEnvelope {
  meta: {
    version: '1.1';
    /** ISO 8601 timestamp when Ring sent the webhook. */
    time: string;
    /** Unique per delivery — use it for idempotency. */
    request_id: string;
    account_id: string;
  };
  data: {
    /** `<device_id>_<event_type>_<timestamp>` */
    id: string;
    type: RingEventType;
    attributes: {
      source: string;
      source_type: 'devices';
      /** epoch milliseconds */
      timestamp: number;
      /** e.g. `human` on motion events */
      sub_type?: string;
      /** present on multi-camera devices */
      component_ids?: number[];
    };
    relationships?: {
      devices?: { links?: { self?: string } };
    };
  };
}

/** Normalized event used by the rhythm engine — webhook and history collapse into this. */
export interface HomeEvent {
  /** stable id, used for idempotency */
  id: string;
  deviceId: string;
  type: RingEventType;
  /** epoch milliseconds */
  at: number;
  subType?: string;
  /** which device role produced it, resolved from the device inventory */
  role?: DeviceRole;
}

/**
 * A household is described by roles rather than model names: the rhythm engine cares
 * that "the front door opened", not that it was a Ring Battery Doorbell Plus.
 */
export type DeviceRole =
  | 'front_door'      // doorbell / entry camera
  | 'indoor'          // indoor cam covering a living area
  | 'chime'           // the speaker we knock with
  | 'unknown';

export class WebhookParseError extends Error {}

/** Parse and validate a webhook body. Throws WebhookParseError on anything unexpected. */
export function parseWebhook(body: unknown): RingWebhookEnvelope {
  const b = body as RingWebhookEnvelope;
  if (!b || typeof b !== 'object') throw new WebhookParseError('body is not an object');
  if (b.meta?.version !== '1.1') throw new WebhookParseError(`unsupported version: ${b.meta?.version}`);
  if (!b.meta.request_id) throw new WebhookParseError('meta.request_id missing');
  if (!b.data?.type || !(RING_EVENT_TYPES as readonly string[]).includes(b.data.type)) {
    throw new WebhookParseError(`unknown event type: ${b.data?.type}`);
  }
  const attrs = b.data.attributes;
  if (!attrs?.source) throw new WebhookParseError('data.attributes.source missing');
  if (typeof attrs.timestamp !== 'number') throw new WebhookParseError('data.attributes.timestamp missing');
  return b;
}

export function toHomeEvent(w: RingWebhookEnvelope, roleOf: (deviceId: string) => DeviceRole = () => 'unknown'): HomeEvent {
  return {
    id: w.data.id || `${w.data.attributes.source}_${w.data.type}_${w.data.attributes.timestamp}`,
    deviceId: w.data.attributes.source,
    type: w.data.type,
    at: w.data.attributes.timestamp,
    subType: w.data.attributes.sub_type,
    role: roleOf(w.data.attributes.source),
  };
}

/** Events that mean "a person is alive and moving in there". */
export function isPresenceEvent(e: HomeEvent): boolean {
  if (e.type === 'motion_detected') {
    // Ring tags human motion; anything else may be a cat or headlights.
    return e.subType === undefined || e.subType === 'human';
  }
  return e.type === 'button_press';
}
