import { NextRequest, NextResponse } from 'next/server';
import { parseWebhook, toHomeEvent, WebhookParseError } from '@/lib/ring/events';
import { verifyWebhookSignature } from '@/lib/ring/signature';
import { roleOf } from '@/lib/sim/household';
import { household, ingest } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Ring posts every household event here.
 *
 * Order matters: read the raw bytes, verify `X-Signature` against them, and only then
 * parse. Ring retries on non-2xx, so anything we cannot use is acknowledged with 200 and
 * dropped rather than left to loop.
 */
export async function POST(req: NextRequest) {
  const raw = Buffer.from(await req.arrayBuffer());
  const secret = process.env.RING_WEBHOOK_SECRET;

  if (secret) {
    if (!verifyWebhookSignature(secret, raw, req.headers.get('x-signature'))) {
      return NextResponse.json({ error: 'bad signature' }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    // Refuse to run unauthenticated in production even if someone forgets the env var.
    return NextResponse.json({ error: 'RING_WEBHOOK_SECRET not configured' }, { status: 500 });
  }

  let event;
  try {
    event = toHomeEvent(parseWebhook(JSON.parse(raw.toString('utf8'))), roleOf);
  } catch (err) {
    if (err instanceof WebhookParseError) {
      return NextResponse.json({ ok: true, ignored: err.message }, { status: 200 });
    }
    return NextResponse.json({ ok: true, ignored: 'unparseable body' }, { status: 200 });
  }

  const actions = ingest(household(), event);
  return NextResponse.json({ ok: true, actions: actions.map((a) => a.type) });
}
