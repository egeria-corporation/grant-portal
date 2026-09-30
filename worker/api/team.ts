/**
 * Team management (spec §5.9 "Team and roles", §7.3: Owner only). Inviting a
 * consultant, changing a role, removing someone or resetting their passkeys
 * needs a recent step-up. There is always at least one Owner.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authOf, requireOwner, requireStepUp } from '../auth/guards';
import { revokeAllForUser } from '../auth/session';
import type { AppBindings, AppEnv } from '../env';
import { audit } from '../lib/audit';
import { emailField, HttpError, normalizeEmail, parseJson } from '../lib/http';
import { createInvite } from './invites';

interface StaffRow {
  id: string;
  email: string;
  name: string | null;
  role: 'owner' | 'consultant';
}

async function staffMember(env: AppEnv, id: string): Promise<StaffRow> {
  const row = await env.DB.prepare("SELECT id, email, name, role FROM users WHERE id = ? AND kind = 'staff' AND disabled_at IS NULL").bind(id).first<StaffRow>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

async function ownerCount(env: AppEnv): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'staff' AND role = 'owner' AND disabled_at IS NULL").first<{ n: number }>())?.n ?? 0;
}

export const team = new Hono<AppBindings>()
  .use('*', requireOwner)
  .get('/', async (c) => {
    const now = Date.now();
    const [members, invites] = await Promise.all([
      c.env.DB.prepare(
        `SELECT u.id, u.email, u.name, u.role, u.all_clients AS allClients, u.created_at AS createdAt,
           (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
           (SELECT COUNT(*) FROM staff_assignments s WHERE s.user_id = u.id) AS clients,
           (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS lastSeenAt
          FROM users u WHERE u.kind = 'staff' AND u.disabled_at IS NULL ORDER BY u.created_at`,
      ).all(),
      c.env.DB.prepare(
        `SELECT id, email, expires_at AS expiresAt FROM magic_links
          WHERE purpose = 'invite' AND invite_role = 'consultant' AND used_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC LIMIT 50`,
      )
        .bind(now)
        .all(),
    ]);
    return c.json({
      members: members.results.map((m) => ({ ...m, allClients: Boolean(m.allClients) })),
      invites: invites.results,
    });
  })

  /** A new consultant is new staff access, so it needs a step-up like a role change (D-079). */
  .post('/invites', requireStepUp(), async (c) => {
    const body = await parseJson(c, z.object({ email: emailField, delivery: z.enum(['email', 'link']) }));
    const out = await createInvite(c, { email: normalizeEmail(body.email), role: 'consultant', clientId: null, delivery: body.delivery });
    return c.json(out, 201);
  })

  .delete('/invites/:inviteId', async (c) => {
    const res = await c.env.DB.prepare("UPDATE magic_links SET expires_at = ? WHERE id = ? AND purpose = 'invite' AND invite_role = 'consultant' AND used_at IS NULL")
      .bind(Date.now() - 1, c.req.param('inviteId'))
      .run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    await audit(c, { action: 'team.removed', target: c.req.param('inviteId'), meta: { invite: true } });
    return c.json({ ok: true });
  })

  /** Role (Owner / Consultant) and whether a consultant sees every client. */
  .patch('/:userId', requireStepUp(), async (c) => {
    const body = await parseJson(c, z.object({ role: z.enum(['owner', 'consultant']).optional(), allClients: z.boolean().optional() }));
    const member = await staffMember(c.env, c.req.param('userId'));
    if (body.role === 'consultant' && member.role === 'owner' && (await ownerCount(c.env)) <= 1) throw new HttpError(409, 'last_owner');
    await c.env.DB.prepare('UPDATE users SET role = COALESCE(?, role), all_clients = COALESCE(?, all_clients) WHERE id = ?')
      .bind(body.role ?? null, body.allClients === undefined ? null : body.allClients ? 1 : 0, member.id)
      .run();
    // New privileges start with a fresh sign-in.
    if (body.role && body.role !== member.role) await revokeAllForUser(c.env, member.id, member.id === authOf(c).user.id ? authOf(c).session.idHash : undefined);
    await audit(c, { action: 'team.role_changed', target: member.id, meta: body });
    return c.json({ ok: true });
  })

  /** Removes a staff member: disabled, signed out everywhere, unassigned. Their history stays. */
  .delete('/:userId', requireStepUp(), async (c) => {
    const member = await staffMember(c.env, c.req.param('userId'));
    if (member.id === authOf(c).user.id) throw new HttpError(409, 'cannot_remove_self');
    if (member.role === 'owner' && (await ownerCount(c.env)) <= 1) throw new HttpError(409, 'last_owner');
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').bind(Date.now(), member.id),
      c.env.DB.prepare('DELETE FROM staff_assignments WHERE user_id = ?').bind(member.id),
      c.env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(member.id),
      c.env.DB.prepare('DELETE FROM calendar_feeds WHERE user_id = ?').bind(member.id),
    ]);
    await revokeAllForUser(c.env, member.id);
    await audit(c, { action: 'team.removed', target: member.id });
    return c.json({ ok: true });
  })

  /** Lost device: remove all of someone's passkeys so they can sign in by email and enroll again. */
  .delete('/:userId/passkeys', requireStepUp(), async (c) => {
    const member = await staffMember(c.env, c.req.param('userId'));
    const res = await c.env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(member.id).run();
    await revokeAllForUser(c.env, member.id, member.id === authOf(c).user.id ? authOf(c).session.idHash : undefined);
    await audit(c, { action: 'team.passkeys_reset', target: member.id, meta: { removed: res.meta.changes } });
    return c.json({ removed: res.meta.changes });
  });
