/**
 * The signed-in user's own account: who am I, my sessions, my passkeys, and
 * the client memberships a client user can see. Nothing here takes another
 * user's ID; every query is scoped to the caller.
 */
import { Hono } from 'hono';
import { authOf, requireAuth, requireClientUser, requireStepUp } from '../auth/guards';
import { listSessions } from '../auth/session';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/http';
import { getSetting } from '../lib/settings';

export const me = new Hono<AppBindings>().get('/', requireAuth, async (c) => {
  const auth = authOf(c);
  const passkeys = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?')
    .bind(auth.user.id)
    .first<{ n: number }>();
  const setup = auth.user.role === 'owner' ? await getSetting(c.env, 'setup') : null;
  return c.json(
    {
      user: { id: auth.user.id, email: auth.user.email, name: auth.user.name, kind: auth.user.kind, role: auth.user.role },
      session: { id: auth.session.publicId, stepUpAt: auth.session.stepUpAt },
      needsPasskey: auth.needsPasskey,
      passkeyCount: passkeys?.n ?? 0,
      setupStatus: setup?.status ?? null,
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});

export const sessions = new Hono<AppBindings>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const auth = authOf(c);
    return c.json({ sessions: await listSessions(c.env, auth.user.id, auth.session.idHash) });
  })
  .delete('/:id', async (c) => {
    const auth = authOf(c);
    const id = c.req.param('id');
    const res = await c.env.DB.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE public_id = ? AND user_id = ? AND revoked_at IS NULL',
    )
      .bind(Date.now(), id, auth.user.id)
      .run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    await audit(c, { action: 'session.revoked', target: id });
    return c.json({ ok: true });
  });

export const passkeysApi = new Hono<AppBindings>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const rows = await c.env.DB.prepare(
      'SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE user_id = ? ORDER BY created_at',
    )
      .bind(authOf(c).user.id)
      .all();
    return c.json({ passkeys: rows.results });
  })
  .delete('/:id', requireStepUp(), async (c) => {
    const id = c.req.param('id');
    const res = await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(id, authOf(c).user.id).run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    await audit(c, { action: 'passkey.removed', target: id });
    return c.json({ ok: true });
  });

/** Client users: which client orgs they belong to (portal home fills out in M3). */
export const portal = new Hono<AppBindings>().get('/home', requireClientUser, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, m.role FROM client_members m JOIN clients c ON c.id = m.client_id
      WHERE m.user_id = ? AND c.archived_at IS NULL ORDER BY c.name`,
  )
    .bind(authOf(c).user.id)
    .all();
  return c.json({ clients: rows.results });
});
