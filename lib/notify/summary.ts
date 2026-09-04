/**
 * What the family actually receives.
 *
 * The rule here is "evidence, not adjectives": a caregiver three hours away needs to decide
 * between a phone call and a drive, so the message states what the home saw, what it tried,
 * and what is normal for this household. A model can make that read more kindly, but the
 * facts are assembled deterministically first — so the app still works, and still tells the
 * truth, when no model is reachable.
 */

import { describeConcern } from '../rhythm/engine';
import { describeRhythm } from '../rhythm/model';
import type { Household } from '../store';

export interface Evidence {
  household: string;
  concern: string;
  rhythm: string;
  knocks: number;
  ackWindowMinutes: number;
  lastActivity: string;
  timeline: string[];
}

const hhmm = (h: Household, at: number) => {
  const m = Math.round((at - h.startOfDay) / 60_000);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
};

export function buildEvidence(h: Household): Evidence {
  const last = h.todayEvents[h.todayEvents.length - 1];
  return {
    household: h.name,
    concern: h.watch.concern ? describeConcern(h.watch.concern) : 'Rhythm broken.',
    rhythm: describeRhythm(h.model),
    knocks: h.watch.knocks,
    ackWindowMinutes: h.options.ackWindowMinutes,
    lastActivity: last ? `${hhmm(h, last.at)} — ${last.type.replace('_', ' ')}` : 'nothing today',
    timeline: h.log.slice(-8).map((l) => `${hhmm(h, l.at)} ${l.text}`),
  };
}

/** Deterministic message — always available, and the fallback when Bedrock is not configured. */
export function familyMessage(h: Household): { text: string; evidence: Evidence; source: 'rules' } {
  const e = buildEvidence(h);
  const text = [
    `${e.household}: ${e.concern}`,
    `Last activity ${e.lastActivity}. Usual pattern — ${e.rhythm}.`,
    `The home played ${e.knocks} check-in chime${e.knocks === 1 ? '' : 's'} and waited ${e.ackWindowMinutes} minutes each time. No response.`,
    `A snapshot from the entry camera is attached. If you reach her, tap "All good" and the home will stop asking.`,
  ].join(' ');
  return { text, evidence: e, source: 'rules' };
}

/**
 * Optional: let Bedrock phrase the same evidence. Never invents facts — the prompt is the
 * evidence object and the model is told to rewrite, not to reason about what happened.
 * Falls back silently to the rules version if AWS is not configured or the call fails.
 */
export async function familyMessageWithBedrock(
  h: Household,
): Promise<{ text: string; evidence: Evidence; source: 'bedrock' | 'rules' }> {
  const modelId = process.env.BEDROCK_MODEL_ID;
  const region = process.env.AWS_REGION;
  const base = familyMessage(h);
  if (!modelId || !region) return base;

  try {
    const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region });
    const res = await client.send(
      new ConverseCommand({
        modelId,
        system: [
          {
            text:
              'You write one short SMS to an adult child about their elderly parent living alone. ' +
              'Use only the facts in the JSON. Never speculate about medical causes. Two sentences, calm, concrete, no exclamation marks.',
          },
        ],
        messages: [{ role: 'user', content: [{ text: JSON.stringify(base.evidence) }] }],
        inferenceConfig: { maxTokens: 200, temperature: 0.2 },
      }),
    );
    const text = res.output?.message?.content?.map((c) => c.text ?? '').join('').trim();
    return text ? { text, evidence: base.evidence, source: 'bedrock' } : base;
  } catch {
    return base;
  }
}
