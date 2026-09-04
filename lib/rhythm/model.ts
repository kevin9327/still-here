/**
 * Learns a household's daily rhythm from Ring event history.
 *
 * The model is deliberately small and explainable: a caregiver has to be able to read
 * "usually up by 6:40" on a dashboard and agree with it. Everything is robust to
 * outliers (median / MAD) because a single 3am bathroom trip must not move "morning".
 */

import { HomeEvent, isPresenceEvent } from '../ring/events';

export const MINUTES_PER_DAY = 24 * 60;

export interface RhythmModel {
  /** number of distinct local days observed */
  days: number;
  /** minutes-since-midnight of the first presence event, median across days */
  firstPresence: MinuteStat | null;
  /** minutes-since-midnight of the last presence event, median across days */
  lastPresence: MinuteStat | null;
  /** presence probability per hour: hourly[h] = days with >=1 presence in hour h / days */
  hourly: number[];
  /** median presence events per day */
  eventsPerDay: number;
  /** longest gap (minutes) between presence events during waking hours, p90 across days */
  wakingGapP90: number;
}

export interface MinuteStat {
  /** median, minutes since local midnight */
  median: number;
  /** median absolute deviation, minutes — how ragged this household's schedule is */
  mad: number;
  /** 90th percentile, minutes — "by this time they are always up" */
  p90: number;
}

export interface DayKeyOptions {
  /** IANA-ish offset in minutes applied before bucketing into days (e.g. +540 for KST). */
  tzOffsetMinutes: number;
}

/** Local day key (YYYY-MM-DD) and minute-of-day for an epoch, at a fixed UTC offset. */
export function localParts(at: number, { tzOffsetMinutes }: DayKeyOptions) {
  const shifted = new Date(at + tzOffsetMinutes * 60_000);
  const day = shifted.toISOString().slice(0, 10);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return { day, minute, hour: shifted.getUTCHours() };
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i];
}

function stat(xs: number[]): MinuteStat | null {
  if (xs.length === 0) return null;
  const med = median(xs);
  return { median: med, mad: median(xs.map((x) => Math.abs(x - med))), p90: percentile(xs, 0.9) };
}

/** Build the rhythm model. Only presence events count; door/online noise is ignored. */
export function learnRhythm(events: HomeEvent[], opts: DayKeyOptions): RhythmModel {
  const presence = events.filter(isPresenceEvent).sort((a, b) => a.at - b.at);
  const byDay = new Map<string, number[]>();       // day -> minutes of day
  for (const e of presence) {
    const { day, minute } = localParts(e.at, opts);
    const list = byDay.get(day);
    if (list) list.push(minute);
    else byDay.set(day, [minute]);
  }

  const firsts: number[] = [];
  const lasts: number[] = [];
  const counts: number[] = [];
  const gaps: number[] = [];
  const hourDays = new Array(24).fill(0);

  for (const minutes of byDay.values()) {
    minutes.sort((a, b) => a - b);
    firsts.push(minutes[0]);
    lasts.push(minutes[minutes.length - 1]);
    counts.push(minutes.length);
    const hoursSeen = new Set(minutes.map((m) => Math.floor(m / 60)));
    for (const h of hoursSeen) hourDays[h] += 1;
    let widest = 0;
    for (let i = 1; i < minutes.length; i++) widest = Math.max(widest, minutes[i] - minutes[i - 1]);
    gaps.push(widest);
  }

  const days = byDay.size;
  return {
    days,
    firstPresence: stat(firsts),
    lastPresence: stat(lasts),
    hourly: hourDays.map((d) => (days ? d / days : 0)),
    eventsPerDay: days ? median(counts) : 0,
    wakingGapP90: days ? percentile(gaps, 0.9) : 0,
  };
}

/** Hours the household is reliably asleep — never knock during these. */
export function quietHours(model: RhythmModel, threshold = 0.15): Set<number> {
  const quiet = new Set<number>();
  for (let h = 0; h < 24; h++) if (model.hourly[h] < threshold) quiet.add(h);
  return quiet;
}

/** A model built from too little data must not drive alerts. */
export function isConfident(model: RhythmModel, minDays = 7): boolean {
  return model.days >= minDays && model.firstPresence !== null;
}

/** Human-readable summary used on the dashboard and in the family message. */
export function describeRhythm(model: RhythmModel): string {
  if (!model.firstPresence || !model.lastPresence) return 'Not enough history yet.';
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  return [
    `${model.days} days learned`,
    `up around ${hhmm(model.firstPresence.median)} (±${Math.round(model.firstPresence.mad)}m)`,
    `settles around ${hhmm(model.lastPresence.median)}`,
    `${Math.round(model.eventsPerDay)} activity events a day`,
  ].join(' · ');
}
