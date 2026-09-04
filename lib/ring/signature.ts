import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify the `X-Signature: sha256=<hex>` header Ring puts on every webhook.
 *
 * Two things the docs are emphatic about and that are easy to get wrong:
 *   - sign the *raw* body bytes, never a re-serialized JSON string
 *   - compare in constant time
 */
export function verifyWebhookSignature(signingKey: string, rawBody: Buffer | string, header: string | null): boolean {
  if (!header) return false;
  const received = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  if (!/^[0-9a-f]+$/i.test(received)) return false;

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', signingKey).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Test/simulator helper: produce the header Ring would have sent. */
export function signWebhook(signingKey: string, rawBody: Buffer | string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return `sha256=${createHmac('sha256', signingKey).update(body).digest('hex')}`;
}
