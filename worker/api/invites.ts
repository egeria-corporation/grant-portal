/**
 * Invites for team members and client contacts. Both are single-use 72-hour
 * links (spec §3.4). Email delivery needs a verified sending domain; before
 * that, or on request, the link is returned once for the inviter to copy.
 *
 * Client invites answer the same way whatever account the address already has
 * (none, a client user elsewhere, staff, disabled), so inviting someone can't
 * be used to look up who else uses the portal (DECISIONS D-079). A copied link
 * can only ever create a new account; that is enforced when it's opened
 * (auth/signin.ts), because the account may appear between minting and use.
 */
import { demoMode } from '../demo/mode';
import { securityPolicy, staffEmailAllowed } from '../lib/security';
import type { Context } from 'hono';
import { createLink, INVITE_TTL_MS } from '../auth/magic';
import { canEmailOthers, sendEmail } from '../email';
import { inviteEmail } from '../email/templates/auth';
import { loadEmailBrand } from '../email/templates/brand';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { HttpError, publicOrigin } from '../lib/http';
import { enforce, type Limit } from '../lib/rate-limit';

export interface InviteResult {
  emailed: boolean;
  /** Present only when delivery was `link`: shown once, never stored. */
  link?: string;
  expiresAt: number | null;
}

/**
 * Invite caps (DECISIONS D-079). Per inviter, so one account can't use the
 * firm's sending domain to mail strangers in bulk; per recipient and client, so
 * nobody gets flooded, and one client's admin can't use up another client's
 * invites to the same person.
 */
export const INVITE_LIMITS = {
  perInviterHour: { bucket: 'invite:inviter:h', limit: 30, windowSec: 3600 },
  perInviterDay: { bucket: 'invite:inviter:d', limit: 100, windowSec: 86_400 },
  perRecipient: { bucket: 'invite:recipient', limit: 5, windowSec: 86_400 },
} as const satisfies Record<string, Limit>;

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
  if (demoMode(c.env)) throw new HttpError(403, 'demo_mode');
  if (p.delivery === 'email' && !(await canEmailOthers(c.env))) throw new HttpError(409, 'email_domain_unverified');
  const kind = p.role === 'consultant' ? 'staff' : 'client';
  if (kind === 'staff' && !staffEmailAllowed(await securityPolicy(c.env), p.email)) throw new HttpError(422, 'domain_not_allowed', { fields: ['email'] });
  if (p.clientId) {
    // Nobody can join an archived client (D-080); only staff can reach one to try.
    const client = await c.env.DB.prepare('SELECT archived_at FROM clients WHERE id = ?').bind(p.clientId).first<{ archived_at: number | null }>();
    if (!client) throw new HttpError(404, 'not_found');
    if (client.archived_at) throw new HttpError(409, 'client_archived');
  }

  await enforce(c, INVITE_LIMITS.perInviterHour, inviter.user.id);
  await enforce(c, INVITE_LIMITS.perInviterDay, inviter.user.id);
  await enforce(c, INVITE_LIMITS.perRecipient, `${p.clientId ?? 'team'}:${p.email}`);

  const existing = await c.env.DB.prepare('SELECT id, kind, disabled_at FROM users WHERE email = ?')
    .bind(p.email)
    .first<{ id: string; kind: string; disabled_at: number | null }>();

  // Someone who can already reach this client: the inviter can see the member list, so saying so leaks nothing.
  if (p.clientId && existing) {
    const member = await c.env.DB.prepare('SELECT 1 AS ok FROM client_members WHERE client_id = ? AND user_id = ?').bind(p.clientId, existing.id).first();
    if (member) throw new HttpError(409, 'already_member');
  }
  // Team invites are Owner-only, and the Owner sees every account, so plain errors leak nothing there.
  if (!p.clientId && existing) {
    if (existing.kind !== 'staff' || existing.disabled_at) throw new HttpError(409, 'invite_conflict');
    // A copyable sign-in link for an existing account would sign in whoever opens it as them (DECISIONS D-027).
    if (p.delivery === 'link') throw new HttpError(409, 'already_member');
  }
  // An address that can never accept this invite (a staff or disabled account) still gets a link row, so it
  // looks like any other pending invite, but no email: nothing to send them, and no mail on the inviter's say-so.
  const unusable = Boolean(existing && (existing.kind !== kind || existing.disabled_at));

  const link = await createLink(c.env, {
    email: p.email,
    purpose: 'invite',
    ttlMs: INVITE_TTL_MS,
    withCode: false,
    clientId: p.clientId,
    inviteRole: p.role,
    createdBy: inviter.user.id,
    delivery: p.delivery,
    // Only the latest invite for this address and client works.
    supersede: true,
  });
  const url = `${publicOrigin(c.req.raw)}/auth/verify?t=${link.token}`;
  await audit(c, {
    action: 'invite.created',
    target: p.clientId ?? 'team',
    meta: { role: p.role, delivery: p.delivery, ...(unusable && p.delivery === 'email' ? { notSent: 'account_conflict' } : {}) },
  });

  if (p.delivery === 'email') {
    if (!unusable) {
      // After the response, like sign-in mail (D-022), so its timing doesn't say whether mail went out.
      // A failed send is recorded in `emails` and shows on the System page.
      const env = c.env;
      const origin = publicOrigin(c.req.raw);
      const name = inviter.user.name;
      c.executionCtx.waitUntil(
        (async () => {
          const rendered = await inviteEmail(await loadEmailBrand(env, origin), { link: url, inviter: name, hours: INVITE_TTL_MS / 3600_000 });
          await sendEmail(env, { to: p.email, template: 'invite', rendered, clientId: p.clientId });
        })().catch(() => undefined),
      );
    }
    return { emailed: true, expiresAt: link.expiresAt };
  }
  return { emailed: false, link: url, expiresAt: link.expiresAt };
}
