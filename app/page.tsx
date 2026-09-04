'use client';

import { useCallback, useEffect, useState } from 'react';

type Phase = 'calm' | 'knocking' | 'answered' | 'escalated' | 'muted';

interface Snapshot {
  name: string;
  scenario: string;
  live: boolean;
  nowMinute: number;
  devices: { id: string; name: string; role: string; knocking: boolean }[];
  rhythm: {
    summary: string;
    days: number;
    hourly: number[];
    firstPresence: { median: number; mad: number; p90: number } | null;
    lastPresence: { median: number; mad: number; p90: number } | null;
    eventsPerDay: number;
  };
  watch: {
    phase: Phase;
    knocks: number;
    concern: { kind: string; text: string } | null;
    knockMinute: number | null;
    ackWindowMinutes: number;
  };
  today: { minute: number; type: string; device: string; role: string }[];
  log: { minute: number; kind: string; text: string }[];
  familyMessage: { text: string; evidence: { timeline: string[]; rhythm: string } } | null;
}

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(((m % 60) + 60) % 60)).padStart(2, '0')}`;

const SCENARIOS: { key: string; label: string }[] = [
  { key: 'normal', label: 'Ordinary day' },
  { key: 'late_start', label: 'Morning never starts' },
  { key: 'afternoon_stop', label: 'Afternoon goes silent' },
  { key: 'went_out', label: 'Went out' },
];

export default function Page() {
  const [s, setS] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/household', { cache: 'no-store' });
    setS(await res.json());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load]);

  const sim = async (body: Record<string, unknown>) => {
    setBusy(true);
    await fetch('/api/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await load();
    setBusy(false);
  };

  if (!s) return <div className="wrap">Loading…</div>;

  const banner = bannerFor(s);
  const lastEvent = s.today[s.today.length - 1];

  return (
    <div className="wrap">
      <header className="top">
        <h1>Still Here</h1>
        <span className="tag">the house checks in, so family doesn&apos;t have to</span>
        <span className="who">
          {s.name} · {s.live ? 'live Ring account' : 'Ring sandbox'} · {hhmm(s.nowMinute)}
        </span>
      </header>

      <div className="devices">
        {s.devices.map((d) => (
          <span key={d.id} className={`chip${d.knocking ? ' ringing' : ''}`}>
            <i className="dot" />
            {d.name}
            <span style={{ color: 'var(--muted)' }}>{d.role.replace('_', ' ')}</span>
          </span>
        ))}
      </div>

      <section className={`banner ${s.watch.phase}`}>
        <h2>{banner.title}</h2>
        <p>{banner.detail}</p>
        {s.familyMessage && (
          <div className="message">
            <div className="to">Sent to family</div>
            <p>{s.familyMessage.text}</p>
            <ul className="evidence">
              {s.familyMessage.evidence.timeline.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="grid">
        <section className="card">
          <h3>Learned rhythm</h3>
          <div className="hours">
            {s.rhythm.hourly.map((v, h) => (
              <i key={h} style={{ height: `${Math.max(2, v * 100)}%` }} title={`${h}:00 — ${(v * 100).toFixed(0)}% of days`} />
            ))}
          </div>
          <div className="hours-axis">
            <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
          </div>
          <div className="stat"><span>Days learned</span><span>{s.rhythm.days}</span></div>
          <div className="stat">
            <span>Usually up by</span>
            <span>{s.rhythm.firstPresence ? `${hhmm(s.rhythm.firstPresence.median)} ±${Math.round(s.rhythm.firstPresence.mad)}m` : '—'}</span>
          </div>
          <div className="stat">
            <span>Settles around</span>
            <span>{s.rhythm.lastPresence ? hhmm(s.rhythm.lastPresence.median) : '—'}</span>
          </div>
          <div className="stat"><span>Activity a day</span><span>{Math.round(s.rhythm.eventsPerDay)} events</span></div>
        </section>

        <section className="card">
          <h3>Today</h3>
          <div className="timeline">
            {s.today.map((e, i) => (
              <span
                key={i}
                className={`tick ${e.type === 'button_press' ? 'press' : e.role === 'front_door' ? 'door' : ''}`}
                style={{ left: `${(e.minute / 1440) * 100}%` }}
                title={`${hhmm(e.minute)} ${e.device} — ${e.type.replace('_', ' ')}`}
              />
            ))}
            {s.watch.knockMinute !== null && (
              <span className="knock" style={{ left: `${(s.watch.knockMinute / 1440) * 100}%` }} title="knock" />
            )}
            <span className="now" style={{ left: `${(s.nowMinute / 1440) * 100}%` }} />
            <span className="axis">
              {Array.from({ length: 8 }, (_, i) => (
                <b key={i}>{String(i * 3).padStart(2, '0')}</b>
              ))}
            </span>
          </div>
          <div className="stat" style={{ marginTop: 12 }}>
            <span>Last sign of life</span>
            <span>{lastEvent ? `${hhmm(lastEvent.minute)} · ${lastEvent.device}` : 'nothing today'}</span>
          </div>
          <div className="stat"><span>Events today</span><span>{s.today.length}</span></div>
          <div className="stat"><span>Knocks</span><span>{s.watch.knocks}</span></div>
        </section>

        <section className="card">
          <h3>What the home did</h3>
          <div className="log">
            {s.log.map((l, i) => (
              <div key={i} className={`row ${l.kind}`}>
                <time>{hhmm(l.minute)}</time>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="controls">
        <h3>Sandbox — replay a day</h3>
        <div className="row" style={{ marginBottom: 10 }}>
          {SCENARIOS.map((sc) => (
            <button
              key={sc.key}
              className={s.scenario === sc.key ? 'on' : ''}
              disabled={busy}
              onClick={() => sim({ scenario: sc.key, toMinute: 9 * 60, replay: true })}
            >
              {sc.label}
            </button>
          ))}
        </div>
        <div className="row">
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>Move the clock:</span>
          {[9, 10, 11, 12, 15, 19, 22].map((h) => (
            <button key={h} disabled={busy} onClick={() => sim({ toMinute: h * 60, replay: true })}>
              {String(h).padStart(2, '0')}:00
            </button>
          ))}
          <button disabled={busy} onClick={() => sim({ toMinute: s.nowMinute + s.watch.ackWindowMinutes, replay: true })}>
            +{s.watch.ackWindowMinutes} min
          </button>
        </div>
      </section>

      <footer className="note">
        Events are replayed through the same signed <code>/api/webhook/ring</code> endpoint Ring posts to, verified with
        HMAC-SHA256 before anything reaches the watch engine. Knocks call{' '}
        <code>POST /v1/devices/&#123;id&#125;/media/audio/playback</code>; escalation pulls one still from{' '}
        <code>POST /v1/devices/&#123;id&#125;/media/image/download</code>. No continuous video is ever recorded.
      </footer>
    </div>
  );
}

function bannerFor(s: Snapshot): { title: string; detail: string } {
  const last = s.today[s.today.length - 1];
  switch (s.watch.phase) {
    case 'knocking':
      return {
        title: s.watch.concern?.text ?? 'Something is off.',
        detail: `Check-in chime played at ${s.watch.knockMinute !== null ? hhmm(s.watch.knockMinute) : '—'}. Waiting ${s.watch.ackWindowMinutes} minutes for any sign of life — a step past a camera is enough. Family has not been contacted.`,
      };
    case 'answered':
      return {
        title: 'Answered.',
        detail: 'Someone moved after the chime, so the home stood down. Nobody was phoned, nothing was recorded.',
      };
    case 'escalated':
      return {
        title: 'No answer after two knocks — family notified.',
        detail: 'The home escalated only after asking twice. The message below is what was sent.',
      };
    case 'muted':
      return { title: 'Paused.', detail: 'Checks are muted for this household.' };
    default:
      return {
        title: `All quiet at ${s.name}.`,
        detail: last
          ? `Last sign of life ${hhmm(last.minute)} — ${last.device}. Rhythm: ${s.rhythm.summary}.`
          : `Watching. Rhythm: ${s.rhythm.summary}.`,
      };
  }
}
