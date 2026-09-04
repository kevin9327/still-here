import { describe, expect, it } from 'vitest';
import { passesFactGate, type Evidence } from '../lib/notify/summary';

const evidence: Evidence = {
  household: "Mum's place",
  concern: 'No activity yet today — usually up by 06:44.',
  rhythm: '14 days learned · up around 06:40 (±5m) · settles around 22:10 · 25 activity events a day',
  knocks: 2,
  ackWindowMinutes: 10,
  lastActivity: 'nothing today',
  lastActivitySentence: 'There has been no activity at all today.',
  timeline: ['09:00 Learned 14 days of rhythm from Ring event history.'],
};

describe('fact gate', () => {
  it('accepts a message that only rearranges the evidence', () => {
    const text =
      'There has been no activity at all today. That is unlike this household, which is usually up by 06:44, ' +
      'and the home has already played the check-in chime twice with no answer.';
    expect(passesFactGate(text, evidence)).toBe(true);
  });

  it('rejects the hallucination this gate was written for', () => {
    // A local model turned "14 days learned" into a last-seen time, in a message to a family.
    const text = "Mum's place is quiet today, she usually gets up by 06:44. Last sign of life was 14 days ago.";
    expect(passesFactGate(text, evidence)).toBe(false);
  });

  it('rejects an invented clock time even when the required sentence is present', () => {
    const text = 'There has been no activity at all today. The last motion was at 03:15.';
    expect(passesFactGate(text, evidence)).toBe(false);
  });

  it('tolerates curly quotes and reflowed whitespace', () => {
    const withActivity: Evidence = {
      ...evidence,
      lastActivity: '08:16 — motion detected',
      lastActivitySentence: 'The last sign of life was at 08:16.',
    };
    const text = 'Quiet for 11 hours.\n  The last sign of life   was at 08:16.  The chime went unanswered twice.';
    expect(passesFactGate(text, withActivity)).toBe(true);
  });
});
