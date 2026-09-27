/**
 * Clients (spec §5.2): list, profile, status, staff assignments, EIN, people
 * and invites, timeline, and the per-client overview both surfaces use.
 * Sub-resources (files, requests, deliverables, messages) live in their own
 * modules and are mounted under `/:clientId`. Every `:clientId` route is scoped
 * by requireClientAccess; every query also filters on the client ID.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { accessOf, authOf, requireClientAccess, requireOwner, requireStaff, requireStepUp } from '../auth/guards';
import { revokeAllForUser } from '../auth/session';
import type { AppBindings, AppEnv } from '../env';
import { audit } from '../lib/audit';
import { decryptField, encryptField } from '../lib/crypto';
import { eventStmts } from '../lib/events';
import { emailField, HttpError, normalizeEmail, parseJson } from '../lib/http';
import { newId } from '../lib/ids';
import { reminderSettings } from '../jobs/dispatch';
import { dataKeys, getSecret } from '../lib/secrets';
import { deleteClient } from './data';
import { deleteDemo, loadDemo } from './demo';
import { deliverables, listDeliverables } from './deliverables';
import { uploads, vault } from './files';
import { createInvite } from './invites';
import { messages, unreadCount } from './messages';
import { listRequests, requests } from './requests';
import { alertsApi, clientFundingApi } from './funding';
import { opportunitiesApi } from './opportunities';
import { reportsApi } from './reports';
import { updatesApi } from './updates';

export const CLIENT_STATUSES = ['onboarding', 'active', 'paused', 'archived'] as const;
export const FUNDING_TYPES = ['federal', 'state', 'foundation', 'corporate'] as const;

const anyMember = requireClientAccess();
const adminOrStaff = requireClientAccess({ clientRoles: ['admin'] });
const staffOnly = requireClientAccess({ clientRoles: 'none' });

const list = (max: number) => z.array(z.string().trim().min(1).max(120)).max(max);

/** Org basics a client admin may edit when the consultant allows it (spec §6.7). */
const clientEditable = z.object({
  legalName: z.string().trim().max(200).nullable(),
  entityType: z.string().trim().max(60).nullable(),
  is501c3: z.boolean().nullable(),
  ntee: z.string().trim().max(12).nullable(),
  geography: list(20),
  budgetBand: z.string().trim().max(40).nullable(),
  fyeMonth: z.number().int().min(1).max(12).nullable(),
  ueiSamStatus: z.string().trim().max(60).nullable(),
  mission: z.string().trim().max(4000).nullable(),
  programs: list(30),
  populations: list(30),
});

const staffEditable = clientEditable.extend({
  name: z.string().trim().min(1).max(120),
  status: z.enum(CLIENT_STATUSES),
  focusTags: list(30),
  fundingGoals: z.object({
    targetAmount: z.number().int().min(0).max(1e12).nullable(),
    timeline: z.string().trim().max(200).nullable(),
    types: z.array(z.enum(FUNDING_TYPES)).max(4),
  }),
  clientCanEdit: z.boolean(),
  reminders: z.object({ documents: z.boolean(), approvals: z.boolean(), deadlines: z.boolean() }),
});

type ProfilePatch = Partial<z.infer<typeof staffEditable>>;

interface ClientRow {
  id: string;
  name: string;
  legal_name: string | null;
  status: (typeof CLIENT_STATUSES)[number];
  ein_last4: string | null;
  ein_enc: string | null;
  entity_type: string | null;
  is_501c3: number | null;
  ntee: string | null;
  geography_json: string | null;
  budget_band: string | null;
  fye_month: number | null;
  uei_sam_status: string | null;
  mission: string | null;
  programs_json: string | null;
  populations_json: string | null;
  focus_tags_json: string | null;
  funding_goals_json: string | null;
  client_can_edit: number;
  reminders_json: string | null;
  is_demo: number;
  created_at: number;
  archived_at: number | null;
  last_activity_at: number | null;
}

const arr = (json: string | null): string[] => (json ? (JSON.parse(json) as string[]) : []);

function profileOf(r: ClientRow) {
  return {
    id: r.id,
    name: r.name,
    legalName: r.legal_name,
    status: r.status,
    einLast4: r.ein_last4,
    hasEin: Boolean(r.ein_enc),
    entityType: r.entity_type,
    is501c3: r.is_501c3 === null ? null : Boolean(r.is_501c3),
    ntee: r.ntee,
    geography: arr(r.geography_json),
    budgetBand: r.budget_band,
    fyeMonth: r.fye_month,
    ueiSamStatus: r.uei_sam_status,
    mission: r.mission,
    programs: arr(r.programs_json),
    populations: arr(r.populations_json),
    focusTags: arr(r.focus_tags_json),
    fundingGoals: r.funding_goals_json
      ? (JSON.parse(r.funding_goals_json) as z.infer<typeof staffEditable>['fundingGoals'])
      : { targetAmount: null, timeline: null, types: [] },
    clientCanEdit: Boolean(r.client_can_edit),
    reminders: reminderSettings(r.reminders_json),
    isDemo: Boolean(r.is_demo),
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
  };
}

async function clientRow(env: AppEnv, id: string): Promise<ClientRow> {
  const row = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first<ClientRow>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

/** Column updates for a validated patch; unknown keys never reach SQL. */
function profileAssignments(p: ProfilePatch): [string, unknown][] {
  const cols: [string, unknown][] = [];
  const set = (col: string, v: unknown) => cols.push([col, v]);
  if (p.name !== undefined) set('name', p.name);
  if (p.legalName !== undefined) set('legal_name', p.legalName || null);
  if (p.status !== undefined) {
    set('status', p.status);
    set('archived_at', p.status === 'archived' ? Date.now() : null);
  }
  if (p.entityType !== undefined) set('entity_type', p.entityType || null);
  if (p.is501c3 !== undefined) set('is_501c3', p.is501c3 === null ? null : p.is501c3 ? 1 : 0);
  if (p.ntee !== undefined) set('ntee', p.ntee || null);
  if (p.geography !== undefined) set('geography_json', JSON.stringify(p.geography));
  if (p.budgetBand !== undefined) set('budget_band', p.budgetBand || null);
  if (p.fyeMonth !== undefined) set('fye_month', p.fyeMonth);
  if (p.ueiSamStatus !== undefined) set('uei_sam_status', p.ueiSamStatus || null);
  if (p.mission !== undefined) set('mission', p.mission || null);
  if (p.programs !== undefined) set('programs_json', JSON.stringify(p.programs));
  if (p.populations !== undefined) set('populations_json', JSON.stringify(p.populations));
  if (p.focusTags !== undefined) set('focus_tags_json', JSON.stringify(p.focusTags));
  if (p.fundingGoals !== undefined) set('funding_goals_json', JSON.stringify(p.fundingGoals));
  if (p.clientCanEdit !== undefined) set('client_can_edit', p.clientCanEdit ? 1 : 0);
  if (p.reminders !== undefined) set('reminders_json', JSON.stringify(p.reminders));
  return cols;
}

/** EIN: 9 digits, shown as XX-XXXXXXX. */
const einField = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{9}$/));

const einAad = (clientId: string) => `clients.ein_enc:${clientId}`;

/**
 * What needs doing for one client, from either side. Staff and client users
 * both call it; "needs your attention" is computed for the caller's side.
 */
async function overview(env: AppEnv, clientId: string, access: 'staff' | 'admin' | 'member', userId: string) {
  const now = Date.now();
  const [reqs, dels, unread, latest, pipeline] = await Promise.all([
    listRequests(env, clientId, access),
    listDeliverables(env, clientId),
    unreadCount(env, clientId, userId),
    env.DB.prepare(
      `SELECT m.id, m.body_md, m.created_at, u.name, u.email FROM messages m JOIN users u ON u.id = m.author_user_id
        WHERE m.client_id = ? AND u.kind = 'staff' ORDER BY m.created_at DESC LIMIT 1`,
    )
      .bind(clientId)
      .first<{ id: string; body_md: string; created_at: number; name: string | null; email: string }>(),
    env.DB.prepare("SELECT stage, COUNT(*) AS n FROM opportunities WHERE client_id = ? AND stage != 'none' GROUP BY stage")
      .bind(clientId)
      .all<{ stage: string; n: number }>(),
  ]);
  const [latestUpdate, reports, grantDeadlines] = await Promise.all([
    env.DB.prepare("SELECT id, subject, intro, sent_at FROM updates WHERE client_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1")
      .bind(clientId)
      .first<{ id: string; subject: string; intro: string | null; sent_at: number }>(),
    env.DB.prepare(
      `SELECT r.id, r.title, r.sent_at,
         (SELECT COUNT(*) FROM report_items i WHERE i.report_id = r.id AND i.client_response IS NULL) AS unanswered
        FROM reports r WHERE r.client_id = ? AND r.status = 'sent' ORDER BY r.sent_at DESC LIMIT 20`,
    )
      .bind(clientId)
      .all<{ id: string; title: string; sent_at: number; unanswered: number }>(),
    env.DB.prepare(
      "SELECT id, title, deadline_at FROM opportunities WHERE client_id = ? AND stage IN ('researching', 'preparing') AND deadline_at > ? ORDER BY deadline_at LIMIT 10",
    )
      .bind(clientId, now - 86_400_000)
      .all<{ id: string; title: string; deadline_at: number }>(),
  ]);
  const client = access !== 'staff';
  const openItems = reqs
    .filter((r) => r.status === 'open')
    .flatMap((r) => r.items.filter((i) => !i.fulfilledAt).map((i) => ({ requestId: r.id, requestTitle: r.title, itemId: i.id, label: i.label, required: i.required, dueAt: r.dueAt })));
  const awaitingDecision = dels.filter((d) => d.status === 'in_review' && (client ? d.side === 'consultant' : d.side === 'client'));
  const owedByCaller = dels.filter((d) => (client ? d.side === 'client' : d.side === 'consultant') && !['approved', 'done', 'in_review'].includes(d.status));
  const deadlines = [
    ...dels.filter((d) => d.dueAt && !['approved', 'done'].includes(d.status)).map((d) => ({ kind: 'deliverable' as const, id: d.id, title: d.title, dueAt: d.dueAt as number })),
    ...reqs.filter((r) => r.status === 'open' && r.dueAt).map((r) => ({ kind: 'request' as const, id: r.id, title: r.title, dueAt: r.dueAt as number })),
    ...grantDeadlines.results.map((o) => ({ kind: 'opportunity' as const, id: o.id, title: o.title, dueAt: o.deadline_at })),
  ]
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, 10);
  return {
    openItems,
    awaitingDecision,
    owedByCaller,
    unreadMessages: unread,
    deadlines,
    overdue: deadlines.filter((d) => d.dueAt < now).length,
    latestFromConsultant: latest
      ? { id: latest.id, body: latest.body_md.slice(0, 280), createdAt: latest.created_at, author: latest.name ?? latest.email }
      : null,
    pipeline: Object.fromEntries(pipeline.results.map((p) => [p.stage, p.n])) as Record<string, number>,
    latestUpdate: latestUpdate ? { id: latestUpdate.id, subject: latestUpdate.subject, intro: latestUpdate.intro?.slice(0, 280) ?? null, sentAt: latestUpdate.sent_at } : null,
    /** Sent reports with opportunities the client hasn't answered (spec §6.2 "opportunities to answer"). */
    reportsToAnswer: reports.results.filter((r) => r.unanswered > 0).map((r) => ({ id: r.id, title: r.title, unanswered: r.unanswered, sentAt: r.sent_at })),
    latestReport: reports.results[0] ? { id: reports.results[0].id, title: reports.results[0].title, sentAt: reports.results[0].sent_at } : null,
  };
}

export const clients = new Hono<AppBindings>()
  .get('/', requireStaff, async (c) => {
    const { user } = authOf(c);
    const all = user.role === 'owner' || user.allClients;
    const includeArchived = c.req.query('archived') === '1';
    const now = Date.now();
    const rows = await c.env.DB.prepare(
      `SELECT c.id, c.name, c.status, c.is_demo AS isDemo, c.created_at AS createdAt, c.last_activity_at AS lastActivityAt,
         (SELECT GROUP_CONCAT(COALESCE(u.name, u.email), ', ') FROM staff_assignments s JOIN users u ON u.id = s.user_id WHERE s.client_id = c.id) AS consultants,
         (SELECT MIN(d) FROM (
            SELECT due_at AS d FROM deliverables WHERE client_id = c.id AND due_at IS NOT NULL AND status NOT IN ('approved','done')
            UNION ALL SELECT due_at FROM doc_requests WHERE client_id = c.id AND due_at IS NOT NULL AND status = 'open'
            UNION ALL SELECT deadline_at FROM opportunities WHERE client_id = c.id AND deadline_at > ?2 AND stage IN ('researching','preparing'))) AS nextDeadline,
         (SELECT COUNT(*) FROM doc_requests r WHERE r.client_id = c.id AND r.status = 'open' AND r.due_at < ?2) AS overdueRequests,
         (SELECT COUNT(*) FROM deliverables d WHERE d.client_id = c.id AND d.status = 'in_review' AND d.side = 'consultant') AS awaitingClient,
         (SELECT COUNT(*) FROM messages m JOIN users mu ON mu.id = m.author_user_id
            WHERE m.client_id = c.id AND mu.kind = 'client'
              AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r WHERE r.client_id = c.id AND r.user_id = ?1 AND r.thread_ref = COALESCE(m.thread_ref, '')), 0)) AS unread
        FROM clients c
       WHERE (?3 OR c.archived_at IS NULL)
         AND (?4 OR EXISTS (SELECT 1 FROM staff_assignments s WHERE s.client_id = c.id AND s.user_id = ?1))
       ORDER BY c.archived_at IS NOT NULL, c.name COLLATE NOCASE LIMIT 500`,
    )
      .bind(user.id, now, includeArchived ? 1 : 0, all ? 1 : 0)
      .all();
    return c.json({ clients: rows.results });
  })

  .post('/', requireStaff, async (c) => {
    const { user } = authOf(c);
    const body = await parseJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(120),
        status: z.enum(CLIENT_STATUSES).optional(),
        contact: z.object({ email: emailField, delivery: z.enum(['email', 'link']) }).optional(),
      }),
    );
    const id = newId('cli');
    const now = Date.now();
    const stmts = [
      c.env.DB.prepare('INSERT INTO clients (id, name, status, owner_user_id, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
        id,
        body.name,
        body.status ?? 'onboarding',
        user.id,
        now,
        now,
      ),
    ];
    if (user.role !== 'owner') {
      stmts.push(c.env.DB.prepare('INSERT INTO staff_assignments (client_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, user.id, now));
    }
    stmts.push(...eventStmts(c.env, { clientId: id, actor: user.id, type: 'client.created', payload: { name: body.name } }));
    await c.env.DB.batch(stmts);
    await audit(c, { action: 'client.created', target: id });
    const invite = body.contact
      ? await createInvite(c, { email: normalizeEmail(body.contact.email), role: 'client_admin', clientId: id, delivery: body.contact.delivery })
      : null;
    return c.json({ id, invite }, 201);
  })

  .get('/:clientId', anyMember, async (c) => {
    const clientId = c.req.param('clientId');
    const access = accessOf(c);
    const row = await clientRow(c.env, clientId);
    const profile = profileOf(row);
    if (access !== 'staff') {
      // Client users see their org basics, not internal fields.
      const { focusTags: _f, fundingGoals: _g, isDemo: _d, einLast4: _e, hasEin: _h, reminders: _r, ...visible } = profile;
      return c.json({ client: { ...visible, canEdit: access === 'admin' && profile.clientCanEdit }, access });
    }
    const staff = await c.env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.role FROM staff_assignments s JOIN users u ON u.id = s.user_id WHERE s.client_id = ? ORDER BY u.name`,
    )
      .bind(clientId)
      .all<{ id: string; name: string | null; email: string; role: string }>();
    return c.json({ client: { ...profile, canEdit: true }, access, assignedStaff: staff.results });
  })

  .patch('/:clientId', adminOrStaff, async (c) => {
    const clientId = c.req.param('clientId');
    const access = accessOf(c);
    const row = await clientRow(c.env, clientId);
    let patch: ProfilePatch;
    if (access === 'staff') {
      patch = await parseJson(c, staffEditable.partial());
    } else {
      if (!row.client_can_edit) throw new HttpError(409, 'profile_locked');
      patch = await parseJson(c, clientEditable.partial().strict());
    }
    const cols = profileAssignments(patch);
    if (!cols.length) return c.json({ client: profileOf(row) });
    const { user } = authOf(c);
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE clients SET ${cols.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...cols.map(([, v]) => v), clientId),
      ...eventStmts(c.env, {
        clientId,
        actor: user.id,
        type: patch.status && patch.status !== row.status ? 'client.status_changed' : 'client.updated',
        payload: patch.status && patch.status !== row.status ? { from: row.status, to: patch.status } : { fields: Object.keys(patch) },
      }),
    ]);
    await audit(c, { action: 'client.updated', target: clientId, meta: { fields: Object.keys(patch) } });
    return c.json({ client: profileOf(await clientRow(c.env, clientId)) });
  })

  .put('/:clientId/ein', staffOnly, async (c) => {
    const clientId = c.req.param('clientId');
    const body = await parseJson(c, z.object({ ein: einField.nullable() }));
    const enc = body.ein ? await encryptField(await getSecret(c.env, 'DATA_ENCRYPTION_KEY'), body.ein, einAad(clientId)) : null;
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE clients SET ein_enc = ?, ein_last4 = ? WHERE id = ?').bind(enc, body.ein ? body.ein.slice(-4) : null, clientId),
      ...eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'client.ein_updated' }),
    ]);
    await audit(c, { action: 'client.ein_updated', target: clientId });
    return c.json({ einLast4: body.ein ? body.ein.slice(-4) : null });
  })

  /** Revealing the full EIN needs a recent strong sign-in and is logged (spec §7.5). */
  .post('/:clientId/ein/reveal', staffOnly, requireStepUp(), async (c) => {
    const clientId = c.req.param('clientId');
    const row = await clientRow(c.env, clientId);
    if (!row.ein_enc) throw new HttpError(409, 'no_ein');
    const ein = await decryptField(await dataKeys(c.env), row.ein_enc, einAad(clientId));
    await c.env.DB.batch(eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'client.ein_revealed' }));
    await audit(c, { action: 'client.ein_revealed', target: clientId });
    return c.json({ ein: `${ein.slice(0, 2)}-${ein.slice(2)}` }, 200, { 'Cache-Control': 'no-store' });
  })

  /**
   * Hard delete (spec §5.9): everything about the client, including its files.
   * Owner only, after a step-up, and the client's name must be typed to confirm.
   */
  .delete('/:clientId', requireOwner, staffOnly, requireStepUp(), async (c) => {
    const clientId = c.req.param('clientId');
    const body = await parseJson(c, z.object({ confirm: z.string().max(200) }));
    const row = await clientRow(c.env, clientId);
    if (body.confirm.trim() !== row.name) throw new HttpError(422, 'confirm_name_mismatch', { fields: ['confirm'] });
    const out = await deleteClient(c.env, clientId);
    await audit(c, { action: 'client.deleted', target: clientId, meta: { name: row.name, ...out } });
    return c.json({ ok: true, ...out });
  })

  /** The Owner decides which consultants work on a client (spec §7.3). */
  .put('/:clientId/assignments', requireOwner, staffOnly, async (c) => {
    const clientId = c.req.param('clientId');
    const body = await parseJson(c, z.object({ userIds: z.array(z.string().max(40)).max(50) }));
    const ids = [...new Set(body.userIds)];
    if (ids.length) {
      const ok = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND role = 'consultant' AND disabled_at IS NULL`,
      )
        .bind(...ids)
        .first<{ n: number }>();
      if (ok?.n !== ids.length) throw new HttpError(422, 'invalid_input', { fields: ['userIds'] });
    }
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM staff_assignments WHERE client_id = ?').bind(clientId),
      ...ids.map((id) => c.env.DB.prepare('INSERT INTO staff_assignments (client_id, user_id, created_at) VALUES (?, ?, ?)').bind(clientId, id, now)),
      ...eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'client.assignments_changed', payload: { count: ids.length } }),
    ]);
    await audit(c, { action: 'client.assignments_changed', target: clientId, meta: { userIds: ids } });
    return c.json({ ok: true });
  })

  .get('/:clientId/overview', anyMember, async (c) =>
    c.json(await overview(c.env, c.req.param('clientId'), accessOf(c), authOf(c).user.id), 200, { 'Cache-Control': 'no-store' }),
  )

  .get('/:clientId/timeline', staffOnly, async (c) => {
    const before = Number(c.req.query('before') ?? '') || Number.MAX_SAFE_INTEGER;
    const rows = await c.env.DB.prepare(
      `SELECT e.id, e.type, e.payload_json, e.created_at, u.name, u.email, u.kind FROM events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.client_id = ? AND e.created_at < ? ORDER BY e.created_at DESC LIMIT 100`,
    )
      .bind(c.req.param('clientId'), before)
      .all<{ id: string; type: string; payload_json: string | null; created_at: number; name: string | null; email: string | null; kind: string | null }>();
    return c.json({
      events: rows.results.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload_json ? (JSON.parse(e.payload_json) as Record<string, unknown>) : {},
        createdAt: e.created_at,
        actor: e.name || e.email ? { name: e.name ?? e.email, kind: e.kind } : null,
      })),
    });
  })

  .get('/:clientId/members', anyMember, async (c) => {
    const now = Date.now();
    const staff = accessOf(c) === 'staff';
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, m.role, m.created_at AS joinedAt,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL
                 AND s.idle_expires_at > ? AND s.abs_expires_at > ?) AS activeSessions
         FROM client_members m JOIN users u ON u.id = m.user_id
        WHERE m.client_id = ? ORDER BY m.created_at`,
    )
      .bind(now, now, c.req.param('clientId'))
      .all<{ id: string; email: string; name: string | null; role: string; joinedAt: number; activeSessions: number }>();
    // Session counts are for staff (who can revoke them), not for colleagues.
    return c.json({ members: rows.results.map((m) => (staff ? m : { ...m, activeSessions: undefined })) });
  })

  /** Staff, or a client admin for their own org (spec §7.3). Client admins can only send email invites. */
  .post('/:clientId/invites', adminOrStaff, async (c) => {
    const body = await parseJson(c, z.object({ email: emailField, role: z.enum(['admin', 'member']), delivery: z.enum(['email', 'link']) }));
    const clientId = c.req.param('clientId');
    if (accessOf(c) !== 'staff' && body.delivery !== 'email') throw new HttpError(403, 'link_invites_staff_only');
    const out = await createInvite(c, {
      email: normalizeEmail(body.email),
      role: body.role === 'admin' ? 'client_admin' : 'client_member',
      clientId,
      delivery: body.delivery,
    });
    await c.env.DB.batch(eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'member.invited', payload: { role: body.role } }));
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
  })

  .route('/:clientId/files', vault)
  .route('/:clientId/uploads', uploads)
  .route('/:clientId/requests', requests)
  .route('/:clientId/deliverables', deliverables)
  .route('/:clientId/messages', messages)
  .route('/:clientId/updates', updatesApi)
  .route('/:clientId/opportunities', opportunitiesApi)
  .route('/:clientId/reports', reportsApi)
  .route('/:clientId/funding', clientFundingApi)
  .route('/:clientId/alerts', alertsApi);

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
