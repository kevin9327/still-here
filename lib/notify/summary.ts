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
  /** The one claim a model is most likely to invent, pre-written so it can only be copied. */
  lastActivitySentence: string;
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
    lastActivitySentence: last
      ? `The last sign of life was at ${hhmm(h, last.at)}.`
      : 'There has been no activity at all today.',
    timeline: h.log.slice(-8).map((l) => `${hhmm(h, l.at)} ${l.text}`),
  };
}

/**
 * Fact gate: a model may rearrange the evidence, never add to it.
 *
 * Two checks, both learned the hard way from a local model that turned "14 days learned"
 * into "last sign of life was 14 days ago" in a message to a worried family:
 *   - the pre-written last-activity sentence must appear verbatim
 *   - every clock time in the output must exist somewhere in the evidence
 * Anything else falls back to the deterministic sentence, which is never wrong.
 */
export function passesFactGate(text: string, evidence: Evidence): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  if (!norm(text).includes(norm(evidence.lastActivitySentence))) return false;

  const evidenceText = JSON.stringify(evidence);
  const allowedTimes = new Set(evidenceText.match(/\d{1,2}:\d{2}/g) ?? []);
  for (const t of text.match(/\d{1,2}:\d{2}/g) ?? []) if (!allowedTimes.has(t)) return false;
  return true;
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

export type MessageSource = 'ollama' | 'bedrock' | 'rules';

const SYSTEM_PROMPT = [
  'You write one short SMS to an adult child about their elderly parent living alone.',
  'Use only the facts in the JSON — never invent times, never speculate about medical causes.',
  'Two or three sentences, calm and concrete, no exclamation marks, no greeting, no sign-off.',
  'Copy the value of "lastActivitySentence" into your message word for word.',
  'Also say what is different from this household\'s normal pattern, and that the home already',
  'played the check-in chime and got no answer.',
].join(' ');

/**
 * Phrase the evidence kindly, preferring a model that runs **in the house**.
 *
 * Order is deliberate: Ollama on the home hub first, Bedrock if the household has cloud, and
 * the deterministic sentence if neither answers. For an app whose whole subject is an elderly
 * person's day, "the description of your mother's morning never left her home" is a feature,
 * not a limitation — and it means the safety path has no cloud dependency at all.
 */
export async function familyMessagePhrased(
  h: Household,
): Promise<{ text: string; evidence: Evidence; source: MessageSource; rejected?: MessageSource[] }> {
  const base = familyMessage(h);
  const rejected: MessageSource[] = [];

  for (const [source, run] of [
    ['ollama', tryOllama],
    ['bedrock', tryBedrock],
  ] as const) {
    const draft = await run(base.evidence);
    if (!draft) continue;
    if (passesFactGate(draft, base.evidence)) {
      return { text: draft, evidence: base.evidence, source, ...(rejected.length ? { rejected } : {}) };
    }
    rejected.push(source);      // the model added something that is not in the evidence
  }
  return { ...base, ...(rejected.length ? { rejected } : {}) };
}

/** Local model on the home hub (Ollama). Short timeout: a caregiver alert cannot wait. */
async function tryOllama(evidence: Evidence): Promise<string | null> {
  const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const model = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.OLLAMA_TIMEOUT_MS ?? 20_000));
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.2, num_predict: 160 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(evidence) },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const text = body.message?.content?.trim();
    return text && text.length > 20 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Optional cloud path. Same prompt, same rule: rewrite the evidence, never reason about it. */
async function tryBedrock(evidence: Evidence): Promise<string | null> {
  const modelId = process.env.BEDROCK_MODEL_ID;
  const region = process.env.AWS_REGION;
  if (!modelId || !region) return null;

  try {
    const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region });
    const res = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify(evidence) }] }],
        inferenceConfig: { maxTokens: 200, temperature: 0.2 },
      }),
    );
    const text = res.output?.message?.content?.map((c) => c.text ?? '').join('').trim();
    return text && text.length > 20 ? text : null;
  } catch {
    return null;
  }
}
