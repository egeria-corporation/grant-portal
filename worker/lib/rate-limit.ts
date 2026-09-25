/**
 * Fixed-window rate limits on KV counters (spec §7.1: 5/h per email, 20/h per IP).
 *
 * KV has no atomic increment, so concurrent requests in the same instant can
 * each read the same count; a burst can overshoot a limit by the number of
 * racing requests. That is acceptable here because every limited action has a
 * second, atomic bound in D1 (single-use tokens, 5 code attempts per request).
 * Keys hold a keyed hash of the subject, never the raw email or IP.
 * See docs/DECISIONS.md D-020.
 */
import type { Context } from 'hono';
import type { AppBindings } from '../env';
import { HttpError, keyedHash } from './http';

export interface Limit {
  bucket: string;
  limit: number;
  windowSec: number;
}

export const LIMITS = {
  magicPerEmail: { bucket: 'magic:email', limit: 5, windowSec: 3600 },
  magicPerIp: { bucket: 'magic:ip', limit: 20, windowSec: 3600 },
  codePerIp: { bucket: 'code:ip', limit: 30, windowSec: 3600 },
  consumePerIp: { bucket: 'consume:ip', limit: 60, windowSec: 3600 },
  setupPerIp: { bucket: 'setup:ip', limit: 10, windowSec: 3600 },
  passkeyPerIp: { bucket: 'passkey:ip', limit: 60, windowSec: 3600 },
} as const satisfies Record<string, Limit>;

/** Counts one hit; returns false when the subject is already over the limit. */
export async function hit(c: Context<AppBindings>, limit: Limit, subject: string): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / limit.windowSec);
  const key = `rl:${limit.bucket}:${await keyedHash(c, `rl:${limit.bucket}`, subject)}:${window}`;
  const current = Number((await c.env.KV.get(key)) ?? '0');
  if (current >= limit.limit) return false;
  // KV's minimum TTL is 60 s; the counter only needs to outlive its window.
  await c.env.KV.put(key, String(current + 1), { expirationTtl: Math.max(60, limit.windowSec * 2) });
  return true;
}

/** Throws 429 when over the limit. */
export async function enforce(c: Context<AppBindings>, limit: Limit, subject: string): Promise<void> {
  if (!(await hit(c, limit, subject))) {
    throw new HttpError(429, 'rate_limited', { retryAfterSec: limit.windowSec });
  }
}
