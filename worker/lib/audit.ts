/** Append-only security audit log (spec §7.5). Personal data stays out: IDs and hashes only. */
import type { Context } from 'hono';
import type { AppBindings, AppEnv } from '../env';
import { clientIp, keyedHash } from './http';
import { newId } from './ids';

export type AuditAction =
  | 'setup.claimed'
  | 'setup.code_failed'
  | 'setup.completed'
  | 'auth.link_requested'
  | 'auth.signin'
  | 'auth.code_failed'
  | 'auth.code_locked'
  | 'auth.signout'
  | 'auth.signout_all'
  | 'auth.passkey_denied'
  | 'session.revoked'
  | 'session.revoked_all_for_user'
  | 'passkey.registered'
  | 'passkey.removed'
  | 'passkey.signin'
  | 'passkey.step_up'
  | 'invite.created'
  | 'invite.accepted'
  | 'settings.updated'
  | 'client.created'
  | 'demo.loaded'
  | 'demo.deleted';

export function auditStmt(
  env: AppEnv,
  entry: { actor: string | null; action: AuditAction; target?: string | null; ipHash?: string | null; meta?: object },
): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO audit_log (id, actor_user_id, action, target, ip_hash, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    newId('aud'),
    entry.actor,
    entry.action,
    entry.target ?? null,
    entry.ipHash ?? null,
    entry.meta ? JSON.stringify(entry.meta) : null,
    Date.now(),
  );
}

export async function audit(
  c: Context<AppBindings>,
  entry: { actor?: string | null; action: AuditAction; target?: string | null; meta?: object },
): Promise<void> {
  const ipHash = await keyedHash(c, 'ip', clientIp(c.req.raw));
  const actor = entry.actor === undefined ? (c.get('auth')?.user.id ?? null) : entry.actor;
  await auditStmt(c.env, { ...entry, actor, ipHash }).run();
}
