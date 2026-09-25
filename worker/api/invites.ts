/**
 * Invites for team members and client contacts. Both are single-use 72-hour
 * links (spec §3.4). Email delivery needs a verified sending domain; before
 * that, or on request, the link is returned once for the inviter to copy.
 */
import type { Context } from 'hono';
import { createLink, INVITE_TTL_MS } from '../auth/magic';
import { firmName } from '../auth/signin';
import { canEmailOthers, sendEmail } from '../email';
import { inviteEmail } from '../email/templates/auth';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { HttpError, publicOrigin } from '../lib/http';

export interface InviteResult {
  emailed: boolean;
  /** Present only when delivery was `link`: shown once, never stored. */
  link?: string;
  /** An existing client user was added to the client directly; they sign in as usual. */
  added?: boolean;
  expiresAt: number | null;
}

export async function createInvite(
  c: Context<AppBindings>,
  p: {
    email: string;
    role: 'consultant' | 'client_admin' | 'client_member';
    clientId: string | null;
    delivery: 'email' | 'link';
  },
): Promise<InviteResult> {
  const inviter = c.get('auth');
  if (!inviter) throw new HttpError(401, 'unauthenticated');
  if (p.delivery === 'email' && !(await canEmailOthers(c.env))) throw new HttpError(409, 'email_domain_unverified');

  const existing = await c.env.DB.prepare('SELECT kind, disabled_at FROM users WHERE email = ?')
    .bind(p.email)
    .first<{ kind: string; disabled_at: number | null }>();
  const kind = p.role === 'consultant' ? 'staff' : 'client';
  if (existing && (existing.kind !== kind || existing.disabled_at)) throw new HttpError(409, 'invite_conflict');

  // Never mint a copyable sign-in link for someone who already has an account:
  // whoever opens it would be signed in as them (DECISIONS D-027).
  if (existing && p.delivery === 'link') {
    if (!p.clientId) throw new HttpError(409, 'already_member');
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(p.email).first<{ id: string }>();
    if (!user) throw new HttpError(409, 'invite_conflict');
    await c.env.DB.prepare('INSERT OR IGNORE INTO client_members (client_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .bind(p.clientId, user.id, p.role === 'client_admin' ? 'admin' : 'member', Date.now())
      .run();
    await audit(c, { action: 'invite.created', target: p.clientId, meta: { role: p.role, delivery: 'added_existing' } });
    return { emailed: false, added: true, expiresAt: null };
  }

  const link = await createLink(c.env, {
    email: p.email,
    purpose: 'invite',
    ttlMs: INVITE_TTL_MS,
    withCode: false,
    clientId: p.clientId,
    inviteRole: p.role,
    createdBy: inviter.user.id,
  });
  const url = `${publicOrigin(c.req.raw)}/auth/verify?t=${link.token}`;
  await audit(c, { action: 'invite.created', target: p.clientId ?? 'team', meta: { role: p.role, delivery: p.delivery } });

  if (p.delivery === 'email') {
    const rendered = inviteEmail({
      firm: await firmName(c.env),
      link: url,
      inviter: inviter.user.name,
      hours: INVITE_TTL_MS / 3600_000,
    });
    await sendEmail(c.env, { to: p.email, template: 'invite', rendered, clientId: p.clientId });
    return { emailed: true, expiresAt: link.expiresAt };
  }
  return { emailed: false, link: url, expiresAt: link.expiresAt };
}
