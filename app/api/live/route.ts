import { NextResponse } from 'next/server';
import { RingClient, guessRole } from '@/lib/ring/client';
import { learnRhythm } from '@/lib/rhythm/model';
import { initialState } from '@/lib/rhythm/engine';
import { household } from '@/lib/store';
import type { DeviceRole } from '@/lib/ring/events';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Switch the dashboard from the sandbox to a real Ring account.
 *
 * Everything downstream is unchanged: the same rhythm model, the same watch engine, the
 * same escalation policy. Only the source of events differs — which is the point of keeping
 * the engine free of Ring types.
 */
export async function POST() {
  const accessToken = process.env.RING_ACCESS_TOKEN;
  if (!accessToken) {
    return NextResponse.json(
      { error: 'Set RING_ACCESS_TOKEN (Ring Developer Playground > Generate Token) in .env.local' },
      { status: 400 },
    );
  }

  const client = new RingClient({ accessToken });
  try {
    const [account, devices] = await Promise.all([client.accountId(), client.devices()]);
    if (devices.length === 0) {
      return NextResponse.json({ error: 'The token has no devices attached.' }, { status: 400 });
    }

    const roles = new Map<string, DeviceRole>(devices.map((d) => [d.id, d.role]));
    const roleOf = (id: string) => roles.get(id) ?? 'unknown';

    // Capabilities tell us which device can actually be knocked on.
    const caps = await Promise.all(
      devices.map(async (d) => ({ id: d.id, caps: await client.capabilities(d.id).catch(() => null) })),
    );
    const chime = caps.find((c) => c.caps?.chimeControls)?.id ?? devices.find((d) => d.role === 'chime')?.id;

    const until = Date.now();
    const since = until - 14 * DAY_MS;
    const histories = await Promise.all(
      devices
        .filter((d) => d.role !== 'chime')
        .map((d) => client.history(d.id, { since, until, limit: 500 }, roleOf).catch(() => [])),
    );
    const events = histories.flat().sort((a, b) => a.at - b.at);

    const h = household();
    const startOfDay = h.startOfDay;
    h.live = true;
    h.name = 'Live Ring account';
    h.historyEvents = events.filter((e) => e.at < startOfDay);
    h.todayEvents = events.filter((e) => e.at >= startOfDay);
    h.model = learnRhythm(h.historyEvents, h.options);
    h.watch = initialState(Date.now(), h.options);
    h.now = Date.now();
    h.lastKnockDeviceId = chime;
    h.log.push({
      at: h.now,
      kind: 'note',
      text: `Connected to Ring account ${String(account?.id ?? '').slice(-6)} — ${devices.length} devices, ${events.length} events over 14 days.`,
    });

    return NextResponse.json({
      ok: true,
      account: account?.id ?? null,
      devices: devices.map((d) => ({ id: d.id, name: d.name, role: d.role, kind: d.kind, guessed: guessRole(d.name, d.kind) })),
      chimeDeviceId: chime ?? null,
      historyEvents: h.historyEvents.length,
      todayEvents: h.todayEvents.length,
      rhythmDays: h.model.days,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
