/**
 * Household state for a single running instance.
 *
 * Deliberately in-memory: Still Here holds a rhythm model, a day of events and a watch
 * state — a few kilobytes per household — and keeping it out of a database means a
 * reviewer can run the whole thing with `npm run dev` and no infrastructure. A production
 * deployment swaps this module for a store keyed by Ring account id; the interface is the
 * seam for that.
 */

import { HomeEvent } from './ring/events';
import { RhythmModel, learnRhythm } from './rhythm/model';
import { Action, DEFAULT_OPTIONS, EngineOptions, WatchState, initialState, step } from './rhythm/engine';
import { DEFAULT_SIM, DEMO_DEVICES, history, roleOf, today as simToday, Scenario } from './sim/household';

export interface LogEntry {
  at: number;
  kind: 'knock' | 'escalate' | 'resolve' | 'event' | 'note';
  text: string;
}

export interface Household {
  id: string;
  name: string;
  /** Local midnight of the observed day, epoch ms. */
  startOfDay: number;
  /** Simulated wall clock, epoch ms — the demo drives this; production uses Date.now(). */
  now: number;
  options: EngineOptions;
  model: RhythmModel;
  historyEvents: HomeEvent[];
  todayEvents: HomeEvent[];
  watch: WatchState;
  log: LogEntry[];
  scenario: Scenario;
  /** set when a knock is played, so the UI can show which device rang */
  lastKnockDeviceId?: string;
  /** live mode = talking to the real Ring API with a Playground token */
  live: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function midnightKstOf(ms: number, tzOffsetMinutes: number): number {
  const shifted = ms + tzOffsetMinutes * 60_000;
  return Math.floor(shifted / DAY_MS) * DAY_MS - tzOffsetMinutes * 60_000;
}

function fresh(scenario: Scenario = 'normal'): Household {
  const options = { ...DEFAULT_OPTIONS };
  const startOfDay = midnightKstOf(Date.now(), options.tzOffsetMinutes);
  const sim = { ...DEFAULT_SIM, startOfDay, tzOffsetMinutes: options.tzOffsetMinutes };
  const historyEvents = history(14, sim);
  const now = startOfDay + 9 * 60 * 60_000;
  return {
    id: 'demo',
    name: "Mum's place",
    startOfDay,
    now,
    options,
    model: learnRhythm(historyEvents, options),
    historyEvents,
    todayEvents: simToday(scenario, 9 * 60, sim),
    watch: initialState(now, options),
    log: [{ at: now, kind: 'note', text: 'Learned 14 days of rhythm from Ring event history.' }],
    scenario,
    live: false,
  };
}

// Next dev-mode reloads modules; keep the household on globalThis so a demo survives HMR.
const g = globalThis as unknown as { __stillHere?: Household };
export function household(): Household {
  if (!g.__stillHere) g.__stillHere = fresh();
  return g.__stillHere;
}

export function resetHousehold(scenario: Scenario = 'normal'): Household {
  g.__stillHere = fresh(scenario);
  return g.__stillHere;
}

export function deviceName(id: string): string {
  return DEMO_DEVICES.find((d) => d.id === id)?.name ?? id;
}

export function chimeDeviceId(): string | undefined {
  return DEMO_DEVICES.find((d) => d.role === 'chime')?.id;
}

const hhmm = (h: Household, at: number) => {
  const m = Math.floor((at - h.startOfDay) / 60_000);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
};

/** Record an incoming event and let the engine react. Returns the actions it produced. */
export function ingest(h: Household, e: HomeEvent): Action[] {
  if (!h.todayEvents.some((x) => x.id === e.id)) {
    h.todayEvents = [...h.todayEvents, { ...e, role: e.role ?? roleOf(e.deviceId) }].sort((a, b) => a.at - b.at);
    h.log.push({ at: e.at, kind: 'event', text: `${deviceName(e.deviceId)}: ${e.type.replace('_', ' ')}` });
  }
  return advance(h, Math.max(h.now, e.at));
}

/** Move the clock and run the watch loop. */
export function advance(h: Household, to: number): Action[] {
  h.now = to;
  const { state, actions } = step(h.watch, h.todayEvents, h.model, h.now, h.options);
  h.watch = state;
  for (const a of actions) {
    if (a.type === 'knock') {
      h.lastKnockDeviceId = chimeDeviceId();
      h.log.push({
        at: h.now,
        kind: 'knock',
        text: `Knock ${a.knockIndex} played on ${deviceName(h.lastKnockDeviceId ?? '')} — waiting ${h.options.ackWindowMinutes} min for any sign of life.`,
      });
    } else if (a.type === 'resolve') {
      h.log.push({ at: a.answeredAt, kind: 'resolve', text: `Answered at ${hhmm(h, a.answeredAt)}. Family was not contacted.` });
    } else if (a.type === 'escalate') {
      h.log.push({ at: h.now, kind: 'escalate', text: 'No answer after two knocks — notifying family with a snapshot and the timeline.' });
    }
  }
  return actions;
}
