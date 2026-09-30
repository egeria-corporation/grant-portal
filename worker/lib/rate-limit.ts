/**
 * Fixed-window rate limits on KV counters (spec §7.1: 5/h per email, 20/h per IP).
 *
 * KV has no atomic increment, so concurrent requests in the same instant can
 * each read the same count; a burst can overshoot a limit by the number of
 * racing requests. That is acceptable here because every limited action has a
 * second, atomic bound in D1 (single-use tokens, 5 code attempts per request,
 * and the portal-wide `GLOBAL_LIMITS` below). IPv6 clients count per /64.
 * Keys hold a keyed hash of the subject, never the raw email or IP.
 * See docs/DECISIONS.md D-020.
 */
import type { Context } from 'hono';
import { DEFAULT_ORG_ID } from '../db/schema';
import type { AppBindings, AppEnv } from '../env';
import { HttpError, keyedHash, rateLimitIp } from './http';

export interface Limit {
  bucket: string;
  limit: number;
  windowSec: number;
  /** The subject is an IP address: counted per IPv6 /64 (`rateLimitIp`). */
  ip?: true;
}

export const LIMITS = {
  magicPerEmail: { bucket: 'magic:email', limit: 5, windowSec: 3600 },
  magicPerIp: { bucket: 'magic:ip', limit: 20, windowSec: 3600, ip: true },
  codePerIp: { bucket: 'code:ip', limit: 30, windowSec: 3600, ip: true },
  consumePerIp: { bucket: 'consume:ip', limit: 60, windowSec: 3600, ip: true },
  setupPerIp: { bucket: 'setup:ip', limit: 10, windowSec: 3600, ip: true },
  demoPerIp: { bucket: 'demo:ip', limit: 20, windowSec: 3600, ip: true },
  passkeyPerIp: { bucket: 'passkey:ip', limit: 60, windowSec: 3600, ip: true },
} as const satisfies Record<string, Limit>;

/**
 * Portal-wide limits, counted atomically in D1, for claiming an unclaimed
 * portal: one secret is shared by the whole portal there, and per-IP limits
 * aren't a bound against an attacker with many addresses (DECISIONS D-019).
 */
export const GLOBAL_LIMITS = {
  /** Setup emails sent (or attempted). Each carries one 6-digit code with 5 tries. */
  setupEmail: { bucket: 'setup:email', limit: 10, windowSec: 3600 },
  /** Guesses at the 60-bit setup code from the logs. */
  setupCodeAttempt: { bucket: 'setup:code', limit: 100, windowSec: 3600 },
  /** Fresh setup codes printed on request (each one retires the last). */
  setupCodeReissue: { bucket: 'setup:reissue', limit: 3, windowSec: 3600 },
} as const satisfies Record<string, Limit>;

/** Counts one hit; returns false when the subject is already over the limit. */
export async function hit(c: Context<AppBindings>, limit: Limit, subject: string): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / limit.windowSec);
  const who = limit.ip ? rateLimitIp(subject) : subject;
  const key = `rl:${limit.bucket}:${await keyedHash(c, `rl:${limit.bucket}`, who)}:${window}`;
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

/**
 * Counts one portal-wide hit in D1 (`settings` row `rl:<bucket>`). One upsert
 * counts and checks, so concurrent requests can never overshoot the limit.
 */
export async function hitGlobal(env: AppEnv, limit: Limit): Promise<boolean> {
  const now = Date.now();
  const window = Math.floor(now / 1000 / limit.windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO settings (org_id, key, value_json, updated_at) VALUES (?1, ?2, json_object('window', ?3, 'count', 1), ?4)
     ON CONFLICT (org_id, key) DO UPDATE SET
       value_json = CASE WHEN json_extract(value_json, '$.window') = ?3
         THEN json_set(value_json, '$.count', json_extract(value_json, '$.count') + 1)
         ELSE excluded.value_json END,
       updated_at = excluded.updated_at
     WHERE json_extract(value_json, '$.window') <> ?3 OR json_extract(value_json, '$.count') < ?5
     RETURNING 1 AS ok`,
  )
    .bind(DEFAULT_ORG_ID, `rl:${limit.bucket}`, window, now, limit.limit)
    .first<{ ok: number }>();
  return row !== null;
}

/** Throws 429 when the portal-wide budget for this window is spent. */
export async function enforceGlobal(env: AppEnv, limit: Limit): Promise<void> {
  if (!(await hitGlobal(env, limit))) {
    const elapsed = Math.floor(Date.now() / 1000) % limit.windowSec;
    throw new HttpError(429, 'rate_limited', { retryAfterSec: limit.windowSec - elapsed });
  }
}
