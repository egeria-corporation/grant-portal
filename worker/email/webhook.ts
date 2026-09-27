/**
 * Resend delivery webhooks (spec §7.6, §9). Resend signs with Svix: the
 * signature is base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)),
 * sent as `v1,<sig>` (several may be space-separated), and the secret is
 * `whsec_<base64 key>`. Old timestamps are refused so a captured request
 * can't be replayed later; duplicate IDs are ignored by the caller.
 */
import { fromBase64Url, timingSafeEqual } from '../lib/crypto';

const TOLERANCE_S = 5 * 60;

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return fromBase64Url(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

async function sign(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', b64ToBytes(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function signSvix(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  return `v1,${await sign(secret, `${id}.${timestamp}.${body}`)}`;
}

export async function verifySvix(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, body: string, now = Date.now()): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_S) return false;
  const expected = await sign(secret, `${headers.id}.${headers.timestamp}.${body}`);
  return headers.signature
    .split(' ')
    .map((s) => s.split(',', 2))
    .some(([version, sig]) => version === 'v1' && sig !== undefined && timingSafeEqual(sig, expected));
}

export interface DeliveryEvent {
  type: string;
  emailId: string;
  to: string[];
  at: number;
  bounceType: string | null;
}

export function parseDeliveryEvent(body: unknown): DeliveryEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; to?: unknown; bounce?: { type?: unknown } } };
  if (typeof b.type !== 'string' || typeof b.data?.email_id !== 'string') return null;
  const at = typeof b.created_at === 'string' ? Date.parse(b.created_at) : NaN;
  return {
    type: b.type,
    emailId: b.data.email_id,
    to: Array.isArray(b.data.to) ? b.data.to.filter((t): t is string => typeof t === 'string') : [],
    at: Number.isFinite(at) ? at : Date.now(),
    bounceType: typeof b.data.bounce?.type === 'string' ? b.data.bounce.type : null,
  };
}
