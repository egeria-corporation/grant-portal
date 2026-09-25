/**
 * What happens after a link, code, or passkey proves who someone is: claim
 * the portal (setup), accept an invite, or sign in; then a session, device
 * bookkeeping, the new-device email, and an audit entry.
 */
import type { Context } from 'hono';
import { DEFAULT_ORG_ID } from '../db/schema';
import { sendEmail } from '../email';
import { newDeviceEmail } from '../email/templates/auth';
import type { AppBindings, AppEnv, AuthUser, Role } from '../env';
import { audit } from '../lib/audit';
import { randomToken, sha256Hex } from '../lib/crypto';
import { HttpError, publicOrigin, uaLabel } from '../lib/http';
import { newId } from '../lib/ids';
import { getSetting } from '../lib/settings';
import { readCookie, writeDeviceCookie } from './cookies';
import type { LinkRow } from './magic';
import { createSession } from './session';

type C = Context<AppBindings>;

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  kind: 'staff' | 'client';
  role: Role;
  all_clients: number;
  disabled_at: number | null;
}

const toAuthUser = (r: UserRow): AuthUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  kind: r.kind,
  role: r.role,
  allClients: Boolean(r.all_clients),
});

export async function userByEmail(env: AppEnv, email: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT id, email, name, kind, role, all_clients, disabled_at FROM users WHERE email = ?')
    .bind(email)
    .first<UserRow>();
}

export async function userById(env: AppEnv, id: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT id, email, name, kind, role, all_clients, disabled_at FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();
}

export async function firmName(env: AppEnv): Promise<string> {
  return (await getSetting(env, 'brand'))?.firmName || 'your client portal';
}

/**
 * First claimant wins (spec §3.3). The `setup` row doesn't exist until the
 * portal is claimed, so INSERT OR IGNORE is the lock; the Owner row is only
 * inserted when this request's user id is the one recorded, in the same
 * transaction.
 */
export async function claimPortal(env: AppEnv, email: string, name?: string | null): Promise<AuthUser> {
  const now = Date.now();
  const userId = newId('usr');
  const setup = JSON.stringify({ status: 'claimed', ownerUserId: userId, claimedAt: now, steps: {} });
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO settings (org_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)').bind(
      DEFAULT_ORG_ID,
      'setup',
      setup,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO users (id, org_id, email, name, kind, role, created_at)
       SELECT ?, ?, ?, ?, 'staff', 'owner', ?
        WHERE (SELECT json_extract(value_json, '$.ownerUserId') FROM settings WHERE org_id = ? AND key = 'setup') = ?`,
    ).bind(userId, DEFAULT_ORG_ID, email, name ?? null, now, DEFAULT_ORG_ID, userId),
    env.DB.prepare('INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)').bind(DEFAULT_ORG_ID, '', now),
  ]);
  const owner = await userById(env, userId);
  if (!owner) throw new HttpError(409, 'already_claimed');
  return toAuthUser(owner);
}

async function acceptInvite(env: AppEnv, link: LinkRow): Promise<AuthUser> {
  const role = link.invite_role as Role | null;
  if (role !== 'consultant' && role !== 'client_admin' && role !== 'client_member') throw new HttpError(410, 'link_invalid');
  const kind = role === 'consultant' ? 'staff' : 'client';
  const now = Date.now();

  let user = await userByEmail(env, link.email);
  if (user?.disabled_at) throw new HttpError(410, 'link_invalid');
  if (user && user.kind !== kind) throw new HttpError(409, 'invite_conflict');
  if (!user) {
    const id = newId('usr');
    await env.DB.prepare(
      'INSERT INTO users (id, org_id, email, kind, role, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
    )
      .bind(id, DEFAULT_ORG_ID, link.email, kind, role, now)
      .run();
    user = await userByEmail(env, link.email);
    if (!user) throw new HttpError(410, 'link_invalid');
  }
  if (kind === 'client') {
    if (!link.client_id) throw new HttpError(410, 'link_invalid');
    const exists = await env.DB.prepare('SELECT 1 AS ok FROM clients WHERE id = ? AND archived_at IS NULL')
      .bind(link.client_id)
      .first();
    if (!exists) throw new HttpError(410, 'link_invalid');
    await env.DB.prepare('INSERT OR IGNORE INTO client_members (client_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .bind(link.client_id, user.id, role === 'client_admin' ? 'admin' : 'member', now)
      .run();
  }
  return toAuthUser(user);
}

async function staffMustUsePasskey(env: AppEnv, user: AuthUser): Promise<boolean> {
  if (user.kind !== 'staff') return false;
  const [policy, row, count] = await Promise.all([
    getSetting(env, 'security'),
    env.DB.prepare('SELECT passkey_required FROM users WHERE id = ?').bind(user.id).first<{ passkey_required: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(user.id).first<{ n: number }>(),
  ]);
  const required = Boolean(policy?.requirePasskeysForStaff) || Boolean(row?.passkey_required);
  return required && (count?.n ?? 0) > 0;
}

/** Turns a consumed link into a signed-in user. */
export async function completeLink(c: C, link: LinkRow): Promise<{ redirect: string }> {
  let user: AuthUser;
  if (link.purpose === 'setup') {
    user = await claimPortal(c.env, link.email);
    await audit(c, { actor: user.id, action: 'setup.claimed', target: user.id, meta: { method: 'email' } });
  } else if (link.purpose === 'invite') {
    user = await acceptInvite(c.env, link);
    await audit(c, { actor: user.id, action: 'invite.accepted', target: link.client_id ?? user.id });
  } else {
    const row = await userByEmail(c.env, link.email);
    if (!row || row.disabled_at) throw new HttpError(410, 'link_invalid');
    user = toAuthUser(row);
    if (await staffMustUsePasskey(c.env, user)) {
      await audit(c, { actor: user.id, action: 'auth.passkey_denied', target: user.id });
      throw new HttpError(403, 'passkey_required');
    }
  }
  return startSession(c, user, 'link');
}

export async function startSession(c: C, user: AuthUser, method: 'link' | 'code' | 'passkey'): Promise<{ redirect: string }> {
  await createSession(c, user, { stepUp: true });
  await noteDevice(c, user);
  await audit(c, { actor: user.id, action: method === 'passkey' ? 'passkey.signin' : 'auth.signin', target: user.id, meta: { method } });
  return { redirect: await homeFor(c.env, user) };
}

export async function homeFor(env: AppEnv, user: Pick<AuthUser, 'kind' | 'role'>): Promise<string> {
  if (user.kind === 'client') return '/portal';
  if (user.role === 'owner') {
    const setup = await getSetting(env, 'setup');
    if (setup?.status !== 'complete') return '/setup';
  }
  return '/workspace';
}

/**
 * Remembers this browser for the user; emails them when a sign-in comes from
 * a browser they haven't used before (not on their very first sign-in).
 */
async function noteDevice(c: C, user: AuthUser): Promise<void> {
  let raw = readCookie(c, 'device');
  if (!raw || raw.length > 64) {
    raw = randomToken(24);
    writeDeviceCookie(c, raw);
  }
  const hash = await sha256Hex(`device:${raw}`);
  const now = Date.now();
  const device = uaLabel(c.req.header('User-Agent'));
  const [known, total] = await Promise.all([
    c.env.DB.prepare('SELECT 1 AS ok FROM user_devices WHERE user_id = ? AND device_hash = ?').bind(user.id, hash).first(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?').bind(user.id).first<{ n: number }>(),
  ]);
  await c.env.DB.prepare(
    `INSERT INTO user_devices (user_id, device_hash, ua_label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at, ua_label = excluded.ua_label`,
  )
    .bind(user.id, hash, device, now, now)
    .run();

  if (!known && (total?.n ?? 0) > 0) {
    const origin = publicOrigin(c.req.raw);
    const env = c.env;
    c.executionCtx.waitUntil(
      (async () => {
        const rendered = newDeviceEmail({
          firm: await firmName(env),
          device,
          when: new Date(now).toUTCString(),
          securityUrl: `${origin}${user.kind === 'staff' ? '/workspace/security' : '/portal/security'}`,
        });
        await sendEmail(env, { to: user.email, template: 'new_device', rendered, userId: user.id });
      })().catch(() => undefined),
    );
  }
}
