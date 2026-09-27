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
import { isValidTimeZone } from '@shared/rrule';
import { z } from 'zod';
import { parseJson } from '../lib/http';
import { PREFS, parsePrefs } from '../notify';

export const me = new Hono<AppBindings>()
  .get('/', requireAuth, async (c) => {
  const auth = authOf(c);
  const [passkeys, extra] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(auth.user.id).first<{ n: number }>(),
    c.env.DB.prepare('SELECT timezone, notif_prefs_json, email_suppressed_at FROM users WHERE id = ?')
      .bind(auth.user.id)
      .first<{ timezone: string | null; notif_prefs_json: string | null; email_suppressed_at: number | null }>(),
  ]);
  const setup = auth.user.role === 'owner' ? await getSetting(c.env, 'setup') : null;
  return c.json(
    {
      user: { id: auth.user.id, email: auth.user.email, name: auth.user.name, kind: auth.user.kind, role: auth.user.role },
      session: { id: auth.session.publicId, stepUpAt: auth.session.stepUpAt },
      needsPasskey: auth.needsPasskey,
      passkeyCount: passkeys?.n ?? 0,
      setupStatus: setup?.status ?? null,
      timezone: extra?.timezone ?? null,
      preferences: parsePrefs(extra?.notif_prefs_json ?? null),
      emailSuppressed: Boolean(extra?.email_suppressed_at),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
})

  /** Name, time zone and email preferences (spec §6.7, §9). */
  .put('/preferences', requireAuth, async (c) => {
    const auth = authOf(c);
    const body = await parseJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        timezone: z.string().max(64).refine(isValidTimeZone).optional(),
        preferences: PREFS.partial().optional(),
        /** Re-enable email after fixing a bounced mailbox. */
        clearSuppression: z.boolean().optional(),
      }),
    );
    const row = await c.env.DB.prepare('SELECT name, timezone, notif_prefs_json FROM users WHERE id = ?')
      .bind(auth.user.id)
      .first<{ name: string | null; timezone: string | null; notif_prefs_json: string | null }>();
    const prefs = { ...parsePrefs(row?.notif_prefs_json ?? null), ...body.preferences };
    await c.env.DB.prepare(
      'UPDATE users SET name = ?, timezone = ?, notif_prefs_json = ?, email_suppressed_at = CASE WHEN ? THEN NULL ELSE email_suppressed_at END WHERE id = ?',
    )
      .bind(body.name ?? row?.name ?? null, body.timezone ?? row?.timezone ?? null, JSON.stringify(prefs), body.clearSuppression ? 1 : 0, auth.user.id)
      .run();
    return c.json({ preferences: prefs });
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

/** Client users: the client orgs they belong to, with what's waiting in each. */
export const portal = new Hono<AppBindings>().get('/home', requireClientUser, async (c) => {
  const userId = authOf(c).user.id;
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, m.role,
       (SELECT COUNT(*) FROM doc_request_items i JOIN doc_requests r ON r.id = i.doc_request_id
          WHERE r.client_id = c.id AND r.status = 'open' AND i.fulfilled_at IS NULL) AS openItems,
       (SELECT COUNT(*) FROM deliverables d WHERE d.client_id = c.id AND d.status = 'in_review' AND d.side = 'consultant') AS awaitingYou
       FROM client_members m JOIN clients c ON c.id = m.client_id
      WHERE m.user_id = ? AND c.archived_at IS NULL ORDER BY c.name`,
  )
    .bind(userId)
    .all();
  return c.json({ clients: rows.results }, 200, { 'Cache-Control': 'no-store' });
});
