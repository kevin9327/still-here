/**
 * Probe a real Ring account with a Playground token — the fastest way to see what a
 * household actually exposes before pointing the dashboard at it.
 *
 *   npx tsx scripts/ring-probe.ts            # reads RING_ACCESS_TOKEN from the environment
 *   npx tsx scripts/ring-probe.ts eyJ...     # or pass the token directly
 */

import { RingClient } from '../lib/ring/client';
import { learnRhythm, describeRhythm } from '../lib/rhythm/model';
import { DEFAULT_OPTIONS } from '../lib/rhythm/engine';
import type { DeviceRole } from '../lib/ring/events';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const token = process.argv[2] ?? process.env.RING_ACCESS_TOKEN;
  if (!token) {
    console.error('No token. Generate one at https://developer.amazon.com/ring/console/playground');
    process.exit(1);
  }

  const ring = new RingClient({ accessToken: token });

  const me = await ring.accountId();
  console.log(`account   ${me?.id ?? '(unknown)'}`);

  const devices = await ring.devices();
  console.log(`devices   ${devices.length}`);
  const roles = new Map<string, DeviceRole>(devices.map((d) => [d.id, d.role]));

  for (const d of devices) {
    const [status, caps] = await Promise.all([
      ring.status(d.id).catch((e) => ({ error: String(e).slice(0, 60) })),
      ring.capabilities(d.id).catch(() => null),
    ]);
    const knock = caps?.chimeControls ? `chime slots: ${caps.audioSlots.join(', ') || '(none listed)'}` : 'no chime controls';
    console.log(`  · ${d.name} [${d.role}] ${JSON.stringify(status).slice(0, 80)} — ${knock}`);
  }

  const until = Date.now();
  const cameras = devices.filter((d) => d.role !== 'chime');
  const events = (
    await Promise.all(cameras.map((d) => ring.history(d.id, { since: until - 14 * DAY_MS, until, limit: 500 }, (id) => roles.get(id) ?? 'unknown').catch(() => [])))
  ).flat();

  console.log(`\nhistory   ${events.length} events over 14 days`);
  if (events.length) {
    const model = learnRhythm(events, DEFAULT_OPTIONS);
    console.log(`rhythm    ${describeRhythm(model)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
