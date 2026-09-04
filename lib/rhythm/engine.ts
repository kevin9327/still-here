/**
 * The watch loop: notice a break in the rhythm, knock first, escalate only if nobody answers.
 *
 * Design rule that shapes everything here: an alert that turns out to be nothing costs a
 * family a phone call and costs the person their privacy. So the house asks first — it plays
 * a chime and treats *any* sign of life as an answer. Family is only pulled in when the home
 * itself could not get an answer.
 */

import { HomeEvent, isPresenceEvent } from '../ring/events';
import { DayKeyOptions, RhythmModel, isConfident, localParts, quietHours } from './model';

export type Phase = 'calm' | 'knocking' | 'answered' | 'escalated' | 'muted';

export type Concern =
  | { kind: 'no_morning_activity'; expectedByMinute: number }
  | { kind: 'unusual_silence'; silentMinutes: number; usualGapMinutes: number }
  | { kind: 'likely_out'; silentMinutes: number };

export interface WatchState {
  phase: Phase;
  dayKey: string;
  concern?: Concern;
  /** when the last chime was played */
  knockAt?: number;
  knocks: number;
  escalatedAt?: number;
  answeredAt?: number;
}

export type Action =
  | { type: 'knock'; reason: Concern; knockIndex: number }
  | { type: 'escalate'; reason: Concern; since: number }
  | { type: 'resolve'; answeredAt: number };

export interface EngineOptions extends DayKeyOptions {
  /** minutes past the usual latest wake-up before we get curious */
  morningGraceMinutes: number;
  /** floor for the silence rule so quiet households aren't nagged */
  silenceFloorMinutes: number;
  /** multiplier applied to the household's own p90 waking gap */
  silenceFactor: number;
  /** how long to wait for a sign of life after a knock */
  ackWindowMinutes: number;
  /** knocks played before family is contacted */
  knocksBeforeEscalation: number;
  /** after someone leaves through the front door, silence is expected for a while */
  awayGraceMinutes: number;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  tzOffsetMinutes: 540,          // KST; the dashboard sets this per household
  morningGraceMinutes: 90,
  silenceFloorMinutes: 240,
  silenceFactor: 1.5,
  ackWindowMinutes: 10,
  knocksBeforeEscalation: 2,
  awayGraceMinutes: 240,
};

export function initialState(now: number, opts: DayKeyOptions): WatchState {
  return { phase: 'calm', dayKey: localParts(now, opts).day, knocks: 0 };
}

/** Presence events that happened on the local day of `now`, oldest first. */
function todaysPresence(events: HomeEvent[], now: number, opts: DayKeyOptions): HomeEvent[] {
  const today = localParts(now, opts).day;
  return events
    .filter((e) => isPresenceEvent(e) && localParts(e.at, opts).day === today)
    .sort((a, b) => a.at - b.at);
}

/** True when the most recent front-door activity looks like "went out". */
function looksAway(events: HomeEvent[], now: number, opts: EngineOptions): boolean {
  const today = todaysPresence(events, now, opts);
  const last = today[today.length - 1];
  if (!last) return false;
  const minutesSince = (now - last.at) / 60_000;
  return last.role === 'front_door' && minutesSince <= opts.awayGraceMinutes;
}

function detectConcern(
  events: HomeEvent[],
  model: RhythmModel,
  now: number,
  opts: EngineOptions,
): Concern | null {
  if (!isConfident(model) || !model.firstPresence) return null;

  const { minute, hour } = localParts(now, opts);
  if (quietHours(model).has(hour)) return null;      // they are asleep; let them sleep

  const today = todaysPresence(events, now, opts);

  if (today.length === 0) {
    const expectedBy = model.firstPresence.p90 + opts.morningGraceMinutes;
    if (minute > expectedBy) return { kind: 'no_morning_activity', expectedByMinute: model.firstPresence.p90 };
    return null;
  }

  const last = today[today.length - 1];
  const silentMinutes = (now - last.at) / 60_000;
  const usualGap = Math.max(model.wakingGapP90 * opts.silenceFactor, opts.silenceFloorMinutes);

  if (looksAway(events, now, opts)) {
    // They probably stepped out. Only worry once the away grace is spent.
    if (silentMinutes > opts.awayGraceMinutes + usualGap) {
      return { kind: 'likely_out', silentMinutes: Math.round(silentMinutes) };
    }
    return null;
  }

  if (silentMinutes > usualGap) {
    return { kind: 'unusual_silence', silentMinutes: Math.round(silentMinutes), usualGapMinutes: Math.round(usualGap) };
  }
  return null;
}

/**
 * Advance the watch. Pure: give it the same inputs and you get the same actions,
 * which is what makes the escalation policy testable rather than a pile of timers.
 */
export function step(
  state: WatchState,
  events: HomeEvent[],
  model: RhythmModel,
  now: number,
  opts: EngineOptions = DEFAULT_OPTIONS,
): { state: WatchState; actions: Action[] } {
  const actions: Action[] = [];
  let s: WatchState = { ...state };

  const today = localParts(now, opts).day;
  if (s.dayKey !== today) s = { phase: s.phase === 'muted' ? 'muted' : 'calm', dayKey: today, knocks: 0 };
  if (s.phase === 'muted') return { state: s, actions };

  // A sign of life after a knock always wins, whatever we were about to do.
  if (s.phase === 'knocking' && s.knockAt !== undefined) {
    const answer = events.find((e) => isPresenceEvent(e) && e.at > s.knockAt!);
    if (answer) {
      actions.push({ type: 'resolve', answeredAt: answer.at });
      return { state: { ...s, phase: 'answered', answeredAt: answer.at, concern: undefined }, actions };
    }
    const waited = (now - s.knockAt) / 60_000;
    if (waited >= opts.ackWindowMinutes) {
      if (s.knocks < opts.knocksBeforeEscalation) {
        actions.push({ type: 'knock', reason: s.concern!, knockIndex: s.knocks + 1 });
        return { state: { ...s, knocks: s.knocks + 1, knockAt: now }, actions };
      }
      actions.push({ type: 'escalate', reason: s.concern!, since: s.knockAt });
      return { state: { ...s, phase: 'escalated', escalatedAt: now }, actions };
    }
    return { state: s, actions };
  }

  // Escalation is not the end of the story: if she walks past a camera at 11:03, the family
  // that just got a message deserves the follow-up more than the app deserves a tidy state.
  if (s.phase === 'escalated') {
    const since = s.escalatedAt ?? s.knockAt ?? 0;
    const answer = events.find((e) => isPresenceEvent(e) && e.at > since);
    if (answer) {
      actions.push({ type: 'resolve', answeredAt: answer.at });
      return { state: { ...s, phase: 'answered', answeredAt: answer.at, concern: undefined }, actions };
    }
    return { state: s, actions };
  }

  const concern = detectConcern(events, model, now, opts);
  if (!concern) {
    // Coming back to calm after an answered check-in keeps the next concern honest.
    return { state: s.phase === 'answered' ? { ...s, phase: 'calm' } : s, actions };
  }

  actions.push({ type: 'knock', reason: concern, knockIndex: 1 });
  return { state: { ...s, phase: 'knocking', concern, knocks: 1, knockAt: now }, actions };
}

/** One line a family member can read on a lock screen. */
export function describeConcern(c: Concern): string {
  switch (c.kind) {
    case 'no_morning_activity': {
      const h = String(Math.floor(c.expectedByMinute / 60)).padStart(2, '0');
      const m = String(Math.round(c.expectedByMinute % 60)).padStart(2, '0');
      return `No activity yet today — usually up by ${h}:${m}.`;
    }
    case 'unusual_silence':
      return `Quiet for ${Math.round(c.silentMinutes / 60)}h — longer than the usual ${Math.round(c.usualGapMinutes / 60)}h gap.`;
    case 'likely_out':
      return `Out since this morning — quiet for ${Math.round(c.silentMinutes / 60)}h.`;
  }
}
