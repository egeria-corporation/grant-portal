/**
 * Magic links and 6-digit codes (spec §7.1).
 *
 * - Token: 256-bit random; only SHA-256(token) is stored.
 * - Code: 6 digits; only SHA-256(code + per-request salt) is stored.
 * - Consumption is one atomic UPDATE … WHERE used_at IS NULL AND expires_at > now.
 * - Codes allow 5 attempts per request; the 5th failure invalidates the request
 *   (link included).
 * - A new request supersedes the same email's outstanding requests of that purpose.
 */
import type { AppEnv } from '../env';
import { randomBytes, randomToken, sha256Hex, timingSafeEqual, toHex } from '../lib/crypto';
import { newId } from '../lib/ids';

export type LinkPurpose = 'signin' | 'invite' | 'setup';

export const SIGNIN_TTL_MS = 15 * 60_000;
export const INVITE_TTL_MS = 72 * 3600_000;
export const MAX_CODE_ATTEMPTS = 5;

export interface LinkRow {
  id: string;
  email: string;
  purpose: LinkPurpose;
  client_id: string | null;
  invite_role: string | null;
  created_by: string | null;
  expires_at: number;
}

const LINK_COLUMNS = 'id, email, purpose, client_id, invite_role, created_by, expires_at';

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
export function sixDigitCode(): string {
  for (;;) {
    const n = new DataView(randomBytes(4).buffer).getUint32(0);
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0');
  }
}

export async function createLink(
  env: AppEnv,
  p: {
    email: string;
    purpose: LinkPurpose;
    ttlMs: number;
    withCode: boolean;
    clientId?: string | null;
    inviteRole?: string | null;
    createdBy?: string | null;
    ipHash?: string | null;
    uaHash?: string | null;
    supersede?: boolean;
  },
): Promise<{ id: string; token: string; code: string | null; expiresAt: number }> {
  const now = Date.now();
  const id = newId('ml');
  const token = randomToken(32);
  const code = p.withCode ? sixDigitCode() : null;
  const salt = code ? toHex(randomBytes(16)) : null;
  const stmts: D1PreparedStatement[] = [];
  if (p.supersede) {
    stmts.push(
      env.DB.prepare('UPDATE magic_links SET used_at = ? WHERE email = ? AND purpose = ? AND used_at IS NULL').bind(
        now,
        p.email,
        p.purpose,
      ),
    );
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO magic_links (id, email, token_hash, code_hash, code_salt, attempts, expires_at, ip_hash, ua_hash,
         purpose, client_id, invite_role, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      p.email,
      await sha256Hex(token),
      code && salt ? await sha256Hex(code + salt) : null,
      salt,
      now + p.ttlMs,
      p.ipHash ?? null,
      p.uaHash ?? null,
      p.purpose,
      p.clientId ?? null,
      p.inviteRole ?? null,
      p.createdBy ?? null,
      now,
    ),
  );
  await env.DB.batch(stmts);
  return { id, token, code, expiresAt: now + p.ttlMs };
}

function plausibleToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Looks up a live link without consuming it (for the interstitial). */
export async function peekLink(env: AppEnv, token: string): Promise<LinkRow | null> {
  if (!plausibleToken(token)) return null;
  return env.DB.prepare(
    `SELECT ${LINK_COLUMNS} FROM magic_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(await sha256Hex(token), Date.now())
    .first<LinkRow>();
}

/** Single-use, atomic. Returns the link only to the one caller that consumed it. */
export async function consumeLink(env: AppEnv, token: string): Promise<LinkRow | null> {
  if (!plausibleToken(token)) return null;
  const now = Date.now();
  return env.DB.prepare(
    `UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING ${LINK_COLUMNS}`,
  )
    .bind(now, await sha256Hex(token), now)
    .first<LinkRow>();
}

export type CodeResult = { ok: true; link: LinkRow } | { ok: false; reason: 'invalid' | 'locked' };

/** Checks a code against the email's latest live request of this purpose. */
export async function consumeCode(env: AppEnv, email: string, purpose: LinkPurpose, code: string): Promise<CodeResult> {
  const now = Date.now();
  const latest = await env.DB.prepare(
    `SELECT id FROM magic_links
      WHERE email = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? AND code_hash IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email, purpose, now)
    .first<{ id: string }>();

  if (!latest || !/^\d{6}$/.test(code)) {
    // Same hashing work as a real attempt, so response time does not reveal
    // whether a request exists for this email.
    await sha256Hex(code + toHex(randomBytes(16)));
    return { ok: false, reason: 'invalid' };
  }

  // Count the attempt before checking it; concurrent guesses can't exceed the cap.
  const counted = await env.DB.prepare(
    `UPDATE magic_links SET attempts = attempts + 1
      WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?
      RETURNING attempts, code_hash, code_salt`,
  )
    .bind(latest.id, now, MAX_CODE_ATTEMPTS)
    .first<{ attempts: number; code_hash: string; code_salt: string }>();
  if (!counted) return { ok: false, reason: 'locked' };

  const matches = timingSafeEqual(await sha256Hex(code + counted.code_salt), counted.code_hash);
  if (matches) {
    const link = await env.DB.prepare(
      `UPDATE magic_links SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? RETURNING ${LINK_COLUMNS}`,
    )
      .bind(now, latest.id, now)
      .first<LinkRow>();
    return link ? { ok: true, link } : { ok: false, reason: 'invalid' };
  }

  if (counted.attempts >= MAX_CODE_ATTEMPTS) {
    await env.DB.prepare('UPDATE magic_links SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, latest.id).run();
    return { ok: false, reason: 'locked' };
  }
  return { ok: false, reason: 'invalid' };
}
