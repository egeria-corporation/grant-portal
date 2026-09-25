/**
 * Minimal client endpoints for the wizard's "first client" step and for staff
 * revoking client sessions (spec §7.1). The full client workspace is M3.
 * Every `:clientId` route is scoped by requireClientAccess.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authOf, requireClientAccess, requireOwner, requireStaff } from '../auth/guards';
import { revokeAllForUser } from '../auth/session';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { HttpError, normalizeEmail, parseJson, emailField } from '../lib/http';
import { newId } from '../lib/ids';
import { deleteDemo, loadDemo } from './demo';
import { createInvite } from './invites';

const staffOnly = requireClientAccess({ clientRoles: 'none' });

export const clients = new Hono<AppBindings>()
  .get('/', requireStaff, async (c) => {
    const { user } = authOf(c);
    const all = user.role === 'owner' || user.allClients;
    const rows = await c.env.DB.prepare(
      `SELECT c.id, c.name, c.status, c.is_demo AS isDemo, c.created_at AS createdAt FROM clients c
        WHERE c.archived_at IS NULL
          AND (? OR EXISTS (SELECT 1 FROM staff_assignments s WHERE s.client_id = c.id AND s.user_id = ?))
        ORDER BY c.created_at DESC LIMIT 200`,
    )
      .bind(all ? 1 : 0, user.id)
      .all();
    return c.json({ clients: rows.results });
  })

  .post('/', requireStaff, async (c) => {
    const { user } = authOf(c);
    const body = await parseJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(120),
        contact: z.object({ email: emailField, delivery: z.enum(['email', 'link']) }).optional(),
      }),
    );
    const id = newId('cli');
    const now = Date.now();
    const stmts = [
      c.env.DB.prepare('INSERT INTO clients (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)').bind(id, body.name, user.id, now),
    ];
    if (user.role !== 'owner') {
      stmts.push(
        c.env.DB.prepare('INSERT INTO staff_assignments (client_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, user.id, now),
      );
    }
    await c.env.DB.batch(stmts);
    await audit(c, { action: 'client.created', target: id });
    const invite = body.contact
      ? await createInvite(c, { email: normalizeEmail(body.contact.email), role: 'client_admin', clientId: id, delivery: body.contact.delivery })
      : null;
    return c.json({ id, invite }, 201);
  })

  .get('/:clientId/members', staffOnly, async (c) => {
    const now = Date.now();
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, m.role,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL
                 AND s.idle_expires_at > ? AND s.abs_expires_at > ?) AS activeSessions
         FROM client_members m JOIN users u ON u.id = m.user_id
        WHERE m.client_id = ? ORDER BY m.created_at`,
    )
      .bind(now, now, c.req.param('clientId'))
      .all();
    return c.json({ members: rows.results });
  })

  .post('/:clientId/invites', staffOnly, async (c) => {
    const body = await parseJson(
      c,
      z.object({ email: emailField, role: z.enum(['admin', 'member']), delivery: z.enum(['email', 'link']) }),
    );
    const out = await createInvite(c, {
      email: normalizeEmail(body.email),
      role: body.role === 'admin' ? 'client_admin' : 'client_member',
      clientId: c.req.param('clientId'),
      delivery: body.delivery,
    });
    return c.json(out, 201);
  })

  /** Staff can revoke any session of a client user in a client they can access. */
  .post('/:clientId/members/:userId/revoke-sessions', staffOnly, async (c) => {
    const userId = c.req.param('userId');
    const member = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM client_members m JOIN users u ON u.id = m.user_id
        WHERE m.client_id = ? AND m.user_id = ? AND u.kind = 'client'`,
    )
      .bind(c.req.param('clientId'), userId)
      .first();
    if (!member) throw new HttpError(404, 'not_found');
    const count = await revokeAllForUser(c.env, userId);
    await audit(c, { action: 'session.revoked_all_for_user', target: userId, meta: { count } });
    return c.json({ revoked: count });
  });

export const demo = new Hono<AppBindings>()
  .use('*', requireOwner)
  .post('/', async (c) => {
    const id = await loadDemo(c.env, authOf(c).user.id);
    await audit(c, { action: 'demo.loaded', target: id });
    return c.json({ id }, 201);
  })
  .delete('/', async (c) => {
    const count = await deleteDemo(c.env);
    await audit(c, { action: 'demo.deleted', meta: { count } });
    return c.json({ deleted: count });
  });
