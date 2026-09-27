/**
 * Deliverables (spec §5.5, §6.5): things the consultant owes the client, or
 * the client owes the consultant. The owning side adds versions (a vault file
 * or a link); the other side approves or asks for changes. Every version and
 * decision is kept. Templates create a set of deliverables with due dates
 * relative to an anchor date. Mounted under `/api/clients/:clientId/deliverables`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { accessOf, authOf, requireClientAccess, requireStaff, type ClientAccess } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { audit } from '../lib/audit';
import { eventStmts } from '../lib/events';
import { HttpError, parseJson } from '../lib/http';
import { newId } from '../lib/ids';
import { clientName, notify } from '../notify';
import { visibleFile, visibleFiles } from './files';

const DAY = 86_400_000;
export const DELIVERABLE_STATUSES = ['not_started', 'in_progress', 'in_review', 'approved', 'done'] as const;

interface DeliverableRow {
  id: string;
  client_id: string;
  opportunity_id: string | null;
  title: string;
  description: string | null;
  side: 'consultant' | 'client';
  assignee_user_id: string | null;
  due_at: number | null;
  status: (typeof DELIVERABLE_STATUSES)[number];
  template_id: string | null;
  created_at: number;
  updated_at: number | null;
}

type ListRow = DeliverableRow & {
  assignee_name: string | null;
  assignee_email: string | null;
  opportunity_title: string | null;
  version_count: number;
  latest_version_id: string | null;
  latest_decision: 'approved' | 'changes' | null;
};

function toDeliverable(r: ListRow) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    side: r.side,
    status: r.status,
    dueAt: r.due_at,
    assignee: r.assignee_user_id ? { id: r.assignee_user_id, name: r.assignee_name ?? r.assignee_email } : null,
    opportunity: r.opportunity_id ? { id: r.opportunity_id, title: r.opportunity_title } : null,
    versionCount: r.version_count,
    latestVersionId: r.latest_version_id,
    latestDecision: r.latest_decision,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
  };
}

const LIST_SELECT = `SELECT d.*, u.name AS assignee_name, u.email AS assignee_email, o.title AS opportunity_title,
    (SELECT COUNT(*) FROM deliverable_versions v WHERE v.deliverable_id = d.id) AS version_count,
    (SELECT v.id FROM deliverable_versions v WHERE v.deliverable_id = d.id ORDER BY v.version DESC LIMIT 1) AS latest_version_id,
    (SELECT a.decision FROM approvals a JOIN deliverable_versions v ON v.id = a.deliverable_version_id
       WHERE v.deliverable_id = d.id ORDER BY v.version DESC, a.created_at DESC LIMIT 1) AS latest_decision
  FROM deliverables d
  LEFT JOIN users u ON u.id = d.assignee_user_id
  LEFT JOIN opportunities o ON o.id = d.opportunity_id`;

export async function listDeliverables(env: AppEnv, clientId: string) {
  const rows = await env.DB.prepare(`${LIST_SELECT} WHERE d.client_id = ? ORDER BY d.due_at IS NULL, d.due_at, d.created_at LIMIT 300`)
    .bind(clientId)
    .all<ListRow>();
  return rows.results.map(toDeliverable);
}

async function deliverableRow(env: AppEnv, clientId: string, id: string): Promise<DeliverableRow> {
  const row = await env.DB.prepare('SELECT * FROM deliverables WHERE id = ? AND client_id = ?').bind(id, clientId).first<DeliverableRow>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

/** The assignee must be staff who can reach this client, or one of its client users. */
async function checkAssignee(env: AppEnv, clientId: string, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const ok = await env.DB.prepare(
    `SELECT 1 AS ok FROM users u WHERE u.id = ? AND u.disabled_at IS NULL AND (
       (u.kind = 'staff' AND (u.role = 'owner' OR u.all_clients = 1 OR EXISTS (SELECT 1 FROM staff_assignments s WHERE s.client_id = ? AND s.user_id = u.id)))
       OR EXISTS (SELECT 1 FROM client_members m WHERE m.client_id = ? AND m.user_id = u.id))`,
  )
    .bind(userId, clientId, clientId)
    .first();
  if (!ok) throw new HttpError(422, 'invalid_input', { fields: ['assigneeUserId'] });
}

async function checkOpportunity(env: AppEnv, clientId: string, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const ok = await env.DB.prepare('SELECT 1 AS ok FROM opportunities WHERE id = ? AND client_id = ?').bind(id, clientId).first();
  if (!ok) throw new HttpError(422, 'invalid_input', { fields: ['opportunityId'] });
}

/** Who adds versions: the owning side (staff may always act for the firm). */
function canAddVersion(access: ClientAccess, side: DeliverableRow['side']): boolean {
  return access === 'staff' || side === 'client';
}

/** Who decides: the side that is owed the deliverable. */
function canDecide(access: ClientAccess, side: DeliverableRow['side']): boolean {
  return side === 'consultant' ? access !== 'staff' : access === 'staff';
}

const anyMember = requireClientAccess();
const staffOnly = requireClientAccess({ clientRoles: 'none' });

const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
  side: z.enum(['consultant', 'client']),
  dueAt: z.number().int().positive().nullable().optional(),
  assigneeUserId: z.string().max(40).nullable().optional(),
  opportunityId: z.string().max(40).nullable().optional(),
});

export const deliverables = new Hono<AppBindings>()
  .get('/', anyMember, async (c) => c.json({ deliverables: await listDeliverables(c.env, c.req.param('clientId') as string) }))

  .post('/', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, createSchema);
    await checkAssignee(c.env, clientId, body.assigneeUserId);
    await checkOpportunity(c.env, clientId, body.opportunityId);
    const id = newId('dlv');
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO deliverables (id, client_id, opportunity_id, title, description, side, assignee_user_id, due_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?)`,
      ).bind(id, clientId, body.opportunityId ?? null, body.title, body.description || null, body.side, body.assigneeUserId ?? null, body.dueAt ?? null, now, now),
      ...eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'deliverable.created', payload: { deliverableId: id, title: body.title } }),
    ]);
    return c.json({ id }, 201);
  })

  .post('/from-template', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(
      c,
      z.object({ templateId: z.string().max(40), anchorAt: z.number().int().positive(), opportunityId: z.string().max(40).nullable().optional() }),
    );
    await checkOpportunity(c.env, clientId, body.opportunityId);
    const tpl = await c.env.DB.prepare('SELECT id, name, items_json FROM deliverable_templates WHERE id = ?')
      .bind(body.templateId)
      .first<{ id: string; name: string; items_json: string }>();
    if (!tpl) throw new HttpError(404, 'not_found');
    const items = templateItems.parse(JSON.parse(tpl.items_json));
    const now = Date.now();
    const ids = items.map(() => newId('dlv'));
    await c.env.DB.batch([
      ...items.map((item, i) =>
        c.env.DB.prepare(
          `INSERT INTO deliverables (id, client_id, opportunity_id, title, side, due_at, status, template_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?)`,
        ).bind(ids[i], clientId, body.opportunityId ?? null, item.title, item.side, body.anchorAt + item.offsetDays * DAY, tpl.id, now, now),
      ),
      ...eventStmts(c.env, {
        clientId,
        actor: authOf(c).user.id,
        type: 'deliverable.created',
        payload: { templateId: tpl.id, template: tpl.name, count: items.length },
      }),
    ]);
    return c.json({ ids }, 201);
  })

  .get('/:deliverableId', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const row = await c.env.DB.prepare(`${LIST_SELECT} WHERE d.id = ? AND d.client_id = ?`)
      .bind(c.req.param('deliverableId'), clientId)
      .first<ListRow>();
    if (!row) throw new HttpError(404, 'not_found');
    const versions = await c.env.DB.prepare(
      `SELECT v.id, v.version, v.file_id, v.url, v.note_md, v.created_at, v.created_by, u.name, u.email, u.kind
         FROM deliverable_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.deliverable_id = ? ORDER BY v.version DESC`,
    )
      .bind(row.id)
      .all<{ id: string; version: number; file_id: string | null; url: string | null; note_md: string | null; created_at: number; created_by: string | null; name: string | null; email: string | null; kind: string | null }>();
    const approvals = versions.results.length
      ? await c.env.DB.prepare(
          `SELECT a.id, a.deliverable_version_id, a.decision, a.comment, a.created_at, u.name, u.email, u.kind
             FROM approvals a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.deliverable_version_id IN (${versions.results.map(() => '?').join(',')}) ORDER BY a.created_at`,
        )
          .bind(...versions.results.map((v) => v.id))
          .all<{ id: string; deliverable_version_id: string; decision: 'approved' | 'changes'; comment: string | null; created_at: number; name: string | null; email: string | null; kind: string | null }>()
      : { results: [] };
    const files = await visibleFiles(
      c.env,
      clientId,
      versions.results.flatMap((v) => (v.file_id ? [v.file_id] : [])),
      access,
    );
    return c.json({
      deliverable: toDeliverable(row),
      canAddVersion: canAddVersion(access, row.side),
      canDecide: canDecide(access, row.side),
      versions: versions.results.map((v) => ({
        id: v.id,
        version: v.version,
        file: (v.file_id ? files.get(v.file_id) : null) ?? null,
        url: v.url,
        note: v.note_md,
        createdAt: v.created_at,
        createdBy: { name: v.name ?? v.email, kind: v.kind },
        decisions: approvals.results
          .filter((a) => a.deliverable_version_id === v.id)
          .map((a) => ({ id: a.id, decision: a.decision, comment: a.comment, createdAt: a.created_at, by: { name: a.name ?? a.email, kind: a.kind } })),
      })),
    });
  })

  .patch('/:deliverableId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, createSchema.partial().extend({ status: z.enum(DELIVERABLE_STATUSES).optional() }));
    const row = await deliverableRow(c.env, clientId, c.req.param('deliverableId'));
    await checkAssignee(c.env, clientId, body.assigneeUserId);
    await checkOpportunity(c.env, clientId, body.opportunityId);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE deliverables SET title = ?, description = ?, side = ?, due_at = ?, assignee_user_id = ?, opportunity_id = ?, status = ?, updated_at = ?
          WHERE id = ? AND client_id = ?`,
      ).bind(
        body.title ?? row.title,
        body.description === undefined ? row.description : body.description || null,
        body.side ?? row.side,
        body.dueAt === undefined ? row.due_at : body.dueAt,
        body.assigneeUserId === undefined ? row.assignee_user_id : body.assigneeUserId,
        body.opportunityId === undefined ? row.opportunity_id : body.opportunityId,
        body.status ?? row.status,
        Date.now(),
        row.id,
        clientId,
      ),
      ...eventStmts(c.env, {
        clientId,
        actor: authOf(c).user.id,
        type: 'deliverable.updated',
        payload: { deliverableId: row.id, title: body.title ?? row.title, ...(body.status && body.status !== row.status ? { status: body.status } : {}) },
      }),
    ]);
    return c.json({ ok: true });
  })

  .delete('/:deliverableId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const row = await deliverableRow(c.env, clientId, c.req.param('deliverableId'));
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM deliverables WHERE id = ? AND client_id = ?').bind(row.id, clientId),
      ...eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'deliverable.deleted', payload: { title: row.title } }),
    ]);
    return c.json({ ok: true });
  })

  .post('/:deliverableId/versions', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const { user } = authOf(c);
    const body = await parseJson(
      c,
      z
        .object({
          fileId: z.string().max(40).optional(),
          url: z
            .url({ protocol: /^https$/ })
            .max(2000)
            .optional(),
          note: z.string().trim().max(4000).optional(),
        })
        .refine((b) => Boolean(b.fileId) !== Boolean(b.url), { message: 'file or url' }),
    );
    const row = await deliverableRow(c.env, clientId, c.req.param('deliverableId'));
    if (!canAddVersion(access, row.side)) throw new HttpError(403, 'not_your_side');
    if (body.fileId) {
      // Reuse from the vault (spec §5.6): any file of this client the caller can see.
      const file = await visibleFile(c.env, clientId, body.fileId, access);
      if (!file) throw new HttpError(404, 'not_found');
      // A draft the client must review has to be visible to them.
      if (!file.shared_with_client) throw new HttpError(409, 'file_not_shared');
    }
    const last = await c.env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM deliverable_versions WHERE deliverable_id = ?')
      .bind(row.id)
      .first<{ v: number }>();
    const version = (last?.v ?? 0) + 1;
    const id = newId('dvv');
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO deliverable_versions (id, deliverable_id, file_id, url, version, note_md, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, row.id, body.fileId ?? null, body.url ?? null, version, body.note || null, user.id, now),
      c.env.DB.prepare("UPDATE deliverables SET status = 'in_review', updated_at = ? WHERE id = ?").bind(now, row.id),
      ...eventStmts(c.env, { clientId, actor: user.id, type: 'deliverable.version_added', payload: { deliverableId: row.id, title: row.title, version } }),
    ]);
    // The side that's owed the deliverable reviews it.
    c.executionCtx.waitUntil(
      (async () =>
        notify(c.env, {
          clientId,
          audience: row.side === 'consultant' ? 'client' : 'staff',
          kind: 'deliverable.review',
          actorId: user.id,
          payload: { deliverableId: row.id, title: row.title, version, note: body.note ?? null, from: user.name ?? user.email, clientName: await clientName(c.env, clientId) },
        }))().catch((err) => console.error('[notify] deliverable.review', err)),
    );
    return c.json({ id, version }, 201);
  })

  .post('/:deliverableId/versions/:versionId/decision', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const { user } = authOf(c);
    const body = await parseJson(
      c,
      z
        .object({ decision: z.enum(['approved', 'changes']), comment: z.string().trim().max(4000).optional() })
        .refine((b) => b.decision === 'approved' || Boolean(b.comment), { message: 'comment required', path: ['comment'] }),
    );
    const row = await deliverableRow(c.env, clientId, c.req.param('deliverableId'));
    if (!canDecide(access, row.side)) throw new HttpError(403, 'not_your_side');
    const latest = await c.env.DB.prepare('SELECT id, version FROM deliverable_versions WHERE deliverable_id = ? ORDER BY version DESC LIMIT 1')
      .bind(row.id)
      .first<{ id: string; version: number }>();
    if (!latest || latest.id !== c.req.param('versionId')) throw new HttpError(409, 'not_latest_version');
    const now = Date.now();
    // One decision per version: the conditional insert makes a double-click (or two reviewers) harmless.
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO approvals (id, deliverable_version_id, user_id, decision, comment, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM approvals WHERE deliverable_version_id = ?)`,
      ).bind(newId('apr'), latest.id, user.id, body.decision, body.comment || null, now, latest.id),
    ]);
    if (!res[0]?.meta.changes) throw new HttpError(409, 'already_decided');
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE deliverables SET status = ?, updated_at = ? WHERE id = ?').bind(
        body.decision === 'approved' ? 'approved' : 'in_progress',
        now,
        row.id,
      ),
      ...eventStmts(c.env, {
        clientId,
        actor: user.id,
        type: body.decision === 'approved' ? 'deliverable.approved' : 'deliverable.changes_requested',
        payload: { deliverableId: row.id, title: row.title, version: latest.version },
      }),
    ]);
    await audit(c, { action: 'deliverable.decided', target: row.id, meta: { version: latest.version, decision: body.decision } });
    c.executionCtx.waitUntil(
      (async () =>
        notify(c.env, {
          clientId,
          audience: row.side === 'consultant' ? 'staff' : 'client',
          kind: 'deliverable.decision',
          actorId: user.id,
          payload: {
            deliverableId: row.id,
            title: row.title,
            version: latest.version,
            decision: body.decision,
            comment: body.comment ?? null,
            by: user.name ?? user.email,
            clientName: await clientName(c.env, clientId),
          },
        }))().catch((err) => console.error('[notify] deliverable.decision', err)),
    );
    return c.json({ ok: true });
  });

// ---------------------------------------------------------------------------
// Templates (staff, org-wide): `/api/templates`
// ---------------------------------------------------------------------------

const templateItems = z
  .array(
    z.object({
      title: z.string().trim().min(1).max(160),
      side: z.enum(['consultant', 'client']),
      /** Days relative to the anchor date; negative is before (e.g. deadline − 14). */
      offsetDays: z.number().int().min(-730).max(730),
    }),
  )
  .min(1)
  .max(40);

const templateBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  items: templateItems,
});

export const templates = new Hono<AppBindings>()
  .use('*', requireStaff)
  .get('/', async (c) => {
    const rows = await c.env.DB.prepare('SELECT id, name, description, items_json, updated_at FROM deliverable_templates ORDER BY name LIMIT 200').all<{
      id: string;
      name: string;
      description: string | null;
      items_json: string;
      updated_at: number;
    }>();
    return c.json({
      templates: rows.results.map((r) => ({ id: r.id, name: r.name, description: r.description, items: JSON.parse(r.items_json) as unknown, updatedAt: r.updated_at })),
    });
  })
  .post('/', async (c) => {
    const body = await parseJson(c, templateBody);
    const id = newId('tpl');
    const now = Date.now();
    await c.env.DB.prepare(
      'INSERT INTO deliverable_templates (id, name, description, items_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, body.name, body.description || null, JSON.stringify(body.items), authOf(c).user.id, now, now)
      .run();
    return c.json({ id }, 201);
  })
  .put('/:id', async (c) => {
    const body = await parseJson(c, templateBody);
    const res = await c.env.DB.prepare('UPDATE deliverable_templates SET name = ?, description = ?, items_json = ?, updated_at = ? WHERE id = ?')
      .bind(body.name, body.description || null, JSON.stringify(body.items), Date.now(), c.req.param('id'))
      .run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    return c.json({ ok: true });
  })
  .delete('/:id', async (c) => {
    const res = await c.env.DB.prepare('DELETE FROM deliverable_templates WHERE id = ?').bind(c.req.param('id')).run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    return c.json({ ok: true });
  });
