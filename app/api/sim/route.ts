import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_SIM, Scenario, today as simToday, toWebhook } from '@/lib/sim/household';
import { signWebhook } from '@/lib/ring/signature';
import { advance, household, resetHousehold } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Demo control surface.
 *
 * `replay` deliberately posts each synthetic event to the real /api/webhook/ring endpoint,
 * signed the way Ring signs it. The demo therefore exercises the same parse → verify →
 * engine path that production traffic takes; nothing is short-circuited for the video.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    scenario?: Scenario;
    toMinute?: number;
    replay?: boolean;
  };

  // Picking a scenario always starts the day over, even the one already loaded — a demo
  // that cannot be rerun from a known state is a demo that fails on camera.
  let h = body.scenario ? resetHousehold(body.scenario) : household();

  if (body.replay) {
    const sim = { ...DEFAULT_SIM, startOfDay: h.startOfDay, tzOffsetMinutes: h.options.tzOffsetMinutes };
    const events = simToday(h.scenario, body.toMinute ?? 24 * 60, sim);
    const secret = process.env.RING_WEBHOOK_SECRET ?? '';
    const origin = req.nextUrl.origin;
    for (const e of events) {
      const raw = JSON.stringify(toWebhook(e));
      await fetch(`${origin}/api/webhook/ring`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'x-signature': signWebhook(secret, raw) } : {}),
        },
        body: raw,
      });
    }
  }

  if (typeof body.toMinute === 'number') {
    advance(h, h.startOfDay + body.toMinute * 60_000);
  }

  return NextResponse.json({ ok: true, scenario: h.scenario, phase: h.watch.phase });
}
