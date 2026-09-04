import { NextResponse } from 'next/server';
import { describeRhythm } from '@/lib/rhythm/model';
import { describeConcern } from '@/lib/rhythm/engine';
import { DEMO_DEVICES } from '@/lib/sim/household';
import { deviceName, household } from '@/lib/store';
import { familyMessage } from '@/lib/notify/summary';

export const dynamic = 'force-dynamic';

/** Everything the dashboard renders, in one poll. */
export async function GET() {
  const h = household();
  const minuteOf = (at: number) => Math.round((at - h.startOfDay) / 60_000);

  return NextResponse.json({
    name: h.name,
    scenario: h.scenario,
    live: h.live,
    nowMinute: minuteOf(h.now),
    startOfDay: h.startOfDay,
    devices: DEMO_DEVICES.map((d) => ({ ...d, knocking: h.lastKnockDeviceId === d.id && h.watch.phase === 'knocking' })),
    rhythm: {
      summary: describeRhythm(h.model),
      days: h.model.days,
      hourly: h.model.hourly,
      firstPresence: h.model.firstPresence,
      lastPresence: h.model.lastPresence,
      eventsPerDay: h.model.eventsPerDay,
    },
    watch: {
      phase: h.watch.phase,
      knocks: h.watch.knocks,
      concern: h.watch.concern ? { ...h.watch.concern, text: describeConcern(h.watch.concern) } : null,
      knockMinute: h.watch.knockAt ? minuteOf(h.watch.knockAt) : null,
      ackWindowMinutes: h.options.ackWindowMinutes,
    },
    today: h.todayEvents.map((e) => ({
      minute: minuteOf(e.at),
      type: e.type,
      device: deviceName(e.deviceId),
      role: e.role,
    })),
    log: [...h.log]
      .sort((a, b) => a.at - b.at)
      .slice(-40)
      .map((l) => ({ minute: minuteOf(l.at), kind: l.kind, text: l.text })),
    familyMessage: h.watch.phase === 'escalated' ? familyMessage(h) : null,
  });
}
