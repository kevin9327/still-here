import { describe, expect, it } from 'vitest';
import { learnRhythm, isConfident, quietHours, describeRhythm } from '../lib/rhythm/model';
import { DEFAULT_OPTIONS, initialState, step, describeConcern } from '../lib/rhythm/engine';
import { DEFAULT_SIM, history, today, toWebhook, roleOf } from '../lib/sim/household';
import { parseWebhook, toHomeEvent, isPresenceEvent, WebhookParseError } from '../lib/ring/events';

// Local midnight (KST) for 2026-09-04.
const START = Date.UTC(2026, 8, 3, 15, 0, 0);
const SIM = { ...DEFAULT_SIM, startOfDay: START };
const OPTS = { ...DEFAULT_OPTIONS, tzOffsetMinutes: 540 };
const at = (minute: number) => START + minute * 60_000;

describe('rhythm model', () => {
  const model = learnRhythm(history(14, SIM), OPTS);

  it('learns one entry per observed day', () => {
    expect(model.days).toBe(14);
    expect(isConfident(model)).toBe(true);
  });

  it('recovers the household wake-up time within the jitter it was generated with', () => {
    expect(model.firstPresence).not.toBeNull();
    expect(Math.abs(model.firstPresence!.median - SIM.wakeMinute)).toBeLessThan(30);
  });

  it('marks the small hours as quiet', () => {
    const quiet = quietHours(model);
    for (const h of [1, 2, 3, 4]) expect(quiet.has(h)).toBe(true);
    expect(quiet.has(12)).toBe(false);
  });

  it('refuses to be confident on three days of history', () => {
    expect(isConfident(learnRhythm(history(3, SIM), OPTS))).toBe(false);
  });

  it('describes itself in a line a caregiver can check', () => {
    expect(describeRhythm(model)).toMatch(/14 days learned .* up around 0[5-7]:/);
  });
});

describe('watch engine', () => {
  const model = learnRhythm(history(14, SIM), OPTS);

  it('stays calm through an ordinary morning', () => {
    const now = at(9 * 60);
    const events = today('normal', 9 * 60, SIM);
    const { state, actions } = step(initialState(now, OPTS), events, model, now, OPTS);
    expect(actions).toEqual([]);
    expect(state.phase).toBe('calm');
  });

  it('knocks — not alarms — when the morning never starts', () => {
    const now = at(10 * 60);
    const { state, actions } = step(initialState(now, OPTS), today('late_start', 10 * 60, SIM), model, now, OPTS);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'knock', knockIndex: 1 });
    expect(state.phase).toBe('knocking');
    expect(describeConcern(state.concern!)).toMatch(/No activity yet today/);
  });

  it('treats any sign of life after the knock as an answer and never bothers family', () => {
    const now = at(10 * 60);
    const first = step(initialState(now, OPTS), today('late_start', 10 * 60, SIM), model, now, OPTS);
    const answer = { id: 'a', deviceId: 'ava1.ring.device.SIMLIVING1', type: 'motion_detected' as const, at: at(10 * 60 + 3), subType: 'human', role: 'indoor' as const };
    const later = at(10 * 60 + 4);
    const { state, actions } = step(first.state, [answer], model, later, OPTS);
    expect(actions).toEqual([{ type: 'resolve', answeredAt: answer.at }]);
    expect(state.phase).toBe('answered');
  });

  it('knocks twice before it escalates', () => {
    let now = at(10 * 60);
    let s = step(initialState(now, OPTS), today('late_start', 10 * 60, SIM), model, now, OPTS).state;

    now = at(10 * 60 + OPTS.ackWindowMinutes);
    const second = step(s, [], model, now, OPTS);
    expect(second.actions[0]).toMatchObject({ type: 'knock', knockIndex: 2 });
    s = second.state;

    now = at(10 * 60 + OPTS.ackWindowMinutes * 2);
    const third = step(s, [], model, now, OPTS);
    expect(third.actions[0]).toMatchObject({ type: 'escalate' });
    expect(third.state.phase).toBe('escalated');
  });

  it('stands down when someone appears after family was already told', () => {
    let now = at(10 * 60);
    let s = step(initialState(now, OPTS), today('late_start', 10 * 60, SIM), model, now, OPTS).state;
    now = at(10 * 60 + OPTS.ackWindowMinutes);
    s = step(s, [], model, now, OPTS).state;
    now = at(10 * 60 + OPTS.ackWindowMinutes * 2);
    s = step(s, [], model, now, OPTS).state;
    expect(s.phase).toBe('escalated');

    const late = { id: 'late', deviceId: 'ava1.ring.device.SIMLIVING1', type: 'motion_detected' as const, at: now + 3 * 60_000, subType: 'human', role: 'indoor' as const };
    const after = step(s, [late], model, now + 4 * 60_000, OPTS);
    expect(after.actions).toEqual([{ type: 'resolve', answeredAt: late.at }]);
    expect(after.state.phase).toBe('answered');
  });

  it('does not knock in the middle of the night', () => {
    const now = at(3 * 60);
    const { actions } = step(initialState(now, OPTS), [], model, now, OPTS);
    expect(actions).toEqual([]);
  });

  it('gives someone who went out through the front door room to be out', () => {
    const now = at(12 * 60);
    const { actions } = step(initialState(now, OPTS), today('went_out', 12 * 60, SIM), model, now, OPTS);
    expect(actions).toEqual([]);
  });

  it('never alerts on a household it has not learned yet', () => {
    const thin = learnRhythm(history(2, SIM), OPTS);
    const now = at(14 * 60);
    const { actions } = step(initialState(now, OPTS), [], thin, now, OPTS);
    expect(actions).toEqual([]);
  });

  it('notices an afternoon that goes silent', () => {
    const now = at(19 * 60);
    const { actions, state } = step(initialState(now, OPTS), today('afternoon_stop', 19 * 60, SIM), model, now, OPTS);
    expect(actions[0]).toMatchObject({ type: 'knock' });
    expect(state.concern!.kind).toBe('unusual_silence');
  });
});

describe('webhook parsing', () => {
  it('round-trips a simulated event through the real envelope shape', () => {
    const source = today('normal', 12 * 60, SIM)[0];
    const parsed = parseWebhook(toWebhook(source));
    const back = toHomeEvent(parsed, roleOf);
    expect(back.deviceId).toBe(source.deviceId);
    expect(back.at).toBe(source.at);
    expect(back.role).toBe('indoor');
    expect(isPresenceEvent(back)).toBe(true);
  });

  it('rejects a payload from an older webhook version', () => {
    const bad = toWebhook(today('normal', 12 * 60, SIM)[0]) as any;
    bad.meta.version = '1.0';
    expect(() => parseWebhook(bad)).toThrow(WebhookParseError);
  });

  it('rejects an unknown event type', () => {
    const bad = toWebhook(today('normal', 12 * 60, SIM)[0]) as any;
    bad.data.type = 'doorbell_exploded';
    expect(() => parseWebhook(bad)).toThrow(WebhookParseError);
  });

  it('does not count a passing car as a sign of life', () => {
    expect(isPresenceEvent({ id: 'x', deviceId: 'd', type: 'motion_detected', at: 0, subType: 'vehicle' })).toBe(false);
  });
});
