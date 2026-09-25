/**
 * Sessions (spec §7.1): opaque 256-bit ID in `__Host-session`; D1 stores only
 * its SHA-256. Idle and absolute expiry depend on the user kind. Sessions
 * rotate (new ID, same row) on privilege changes such as a step-up.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AppBindings, AppEnv, AuthState, AuthUser } from '../env';
import { randomToken, sha256Hex } from '../lib/crypto';
import { clientIp, keyedHash, uaLabel } from '../lib/http';
import { newId } from '../lib/ids';
import { getSetting } from '../lib/settings';
import { clearSessionCookie, readCookie, SESSION_COOKIE, writeSessionCookie } from './cookies';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const SESSION_POLICY = {
  staff: { idleMs: 12 * HOUR, absMs: 14 * DAY },
  client: { idleMs: 7 * DAY, absMs: 30 * DAY },
} as const;

/** Refresh last_seen/idle expiry at most this often, to keep D1 writes low. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

type C = Context<AppBindings>;

interface SessionRow {
  id_hash: string;
  public_id: string | null;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  idle_expires_at: number;
  abs_expires_at: number;
  step_up_at: number | null;
  email: string;
  name: string | null;
  kind: 'staff' | 'client';
  role: AuthUser['role'];
  all_clients: number;
}

export async function createSession(
  c: C,
  user: Pick<AuthUser, 'id' | 'kind'>,
  opts: { stepUp: boolean },
): Promise<{ publicId: string }> {
  const now = Date.now();
  const policy = SESSION_POLICY[user.kind];
  const raw = randomToken(32);
  const publicId = newId('ses');
  await c.env.DB.prepare(
    `INSERT INTO sessions (id_hash, public_id, user_id, created_at, last_seen_at, idle_expires_at, abs_expires_at,
       step_up_at, ip_hash, ua_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(raw),
      publicId,
      user.id,
      now,
      now,
      now + policy.idleMs,
      now + policy.absMs,
      opts.stepUp ? now : null,
      await keyedHash(c, 'ip', clientIp(c.req.raw)),
      uaLabel(c.req.header('User-Agent')),
    )
    .run();
  writeSessionCookie(c, raw, Math.floor(policy.absMs / 1000));
  return { publicId };
}

async function lookup(env: AppEnv, idHash: string): Promise<SessionRow | null> {
  return env.DB.prepare(
    `SELECT s.id_hash, s.public_id, s.user_id, s.created_at, s.last_seen_at, s.idle_expires_at, s.abs_expires_at,
            s.step_up_at, u.email, u.name, u.kind, u.role, u.all_clients
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.revoked_at IS NULL AND u.disabled_at IS NULL`,
  )
    .bind(idHash)
    .first<SessionRow>();
}

async function passkeyGate(env: AppEnv, userId: string, kind: 'staff' | 'client'): Promise<boolean> {
  if (kind !== 'staff') return false;
  const [policy, user, count] = await Promise.all([
    getSetting(env, 'security'),
    env.DB.prepare('SELECT passkey_required FROM users WHERE id = ?').bind(userId).first<{ passkey_required: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(userId).first<{ n: number }>(),
  ]);
  const required = Boolean(policy?.requirePasskeysForStaff) || Boolean(user?.passkey_required);
  return required && (count?.n ?? 0) === 0;
}

/** Global middleware: resolves the session cookie to `c.var.auth` (or null). */
export const loadSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set('auth', null);
  const raw = readCookie(c, SESSION_COOKIE);
  if (raw && raw.length <= 128) {
    const idHash = await sha256Hex(raw);
    const row = await lookup(c.env, idHash);
    const now = Date.now();
    if (row && row.idle_expires_at > now && row.abs_expires_at > now) {
      if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
        const idle = Math.min(now + SESSION_POLICY[row.kind].idleMs, row.abs_expires_at);
        c.executionCtx.waitUntil(
          c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id_hash = ?')
            .bind(now, idle, idHash)
            .run(),
        );
      }
      c.set('auth', {
        user: {
          id: row.user_id,
          email: row.email,
          name: row.name,
          kind: row.kind,
          role: row.role,
          allClients: Boolean(row.all_clients),
        },
        session: {
          idHash,
          publicId: row.public_id ?? '',
          createdAt: row.created_at,
          stepUpAt: row.step_up_at,
          absExpiresAt: row.abs_expires_at,
        },
        needsPasskey: await passkeyGate(c.env, row.user_id, row.kind),
      } satisfies AuthState);
    } else {
      // Unknown, expired, or revoked: drop the cookie so the client stops sending it.
      clearSessionCookie(c);
    }
  }
  await next();
};

/**
 * New session ID for the same session row (privilege change, step-up). The old
 * ID stops working immediately.
 */
export async function rotateSession(c: C, opts: { stepUp: boolean }): Promise<void> {
  const auth = c.get('auth');
  if (!auth) return;
  const raw = randomToken(32);
  const newHash = await sha256Hex(raw);
  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE sessions SET id_hash = ?, step_up_at = CASE WHEN ? THEN ? ELSE step_up_at END WHERE id_hash = ?',
  )
    .bind(newHash, opts.stepUp ? 1 : 0, now, auth.session.idHash)
    .run();
  writeSessionCookie(c, raw, Math.max(1, Math.floor((auth.session.absExpiresAt - now) / 1000)));
  c.set('auth', {
    ...auth,
    session: { ...auth.session, idHash: newHash, stepUpAt: opts.stepUp ? now : auth.session.stepUpAt },
  });
}

export async function revokeCurrent(c: C): Promise<void> {
  const auth = c.get('auth');
  if (auth) {
    await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ?').bind(Date.now(), auth.session.idHash).run();
  }
  clearSessionCookie(c);
}

/** Revokes every live session of a user. Returns how many were revoked. */
export async function revokeAllForUser(env: AppEnv, userId: string, exceptIdHash?: string): Promise<number> {
  const res = await env.DB.prepare(
    'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id_hash != ?',
  )
    .bind(Date.now(), userId, exceptIdHash ?? '')
    .run();
  return res.meta.changes ?? 0;
}

export interface SessionSummary {
  id: string;
  device: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export async function listSessions(env: AppEnv, userId: string, currentIdHash?: string): Promise<SessionSummary[]> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id_hash, public_id, ua_label, created_at, last_seen_at FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND abs_expires_at > ?
      ORDER BY last_seen_at DESC LIMIT 50`,
  )
    .bind(userId, now, now)
    .all<{ id_hash: string; public_id: string | null; ua_label: string | null; created_at: number; last_seen_at: number }>();
  return rows.results.map((r) => ({
    id: r.public_id ?? '',
    device: r.ua_label ?? 'Unknown device',
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.id_hash === currentIdHash,
  }));
}
