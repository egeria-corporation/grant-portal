/**
 * Document requests (spec §5.6, §6.3): "we need your 990, audited financials,
 * board list and W-9". Staff create them; each item becomes a checklist row in
 * the portal with an upload slot. Reminder cadence is stored here and sent by
 * the scheduler (M4). Mounted under `/api/clients/:clientId/requests`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { accessOf, authOf, requireClientAccess } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { eventStmts } from '../lib/events';
import { HttpError, parseJson } from '../lib/http';
import { newId } from '../lib/ids';
import { visibleFile, visibleFiles, type FileSummary } from './files';

/** Spec §5.7 example cadence: 3 days before, on the due date, 2 days overdue. Open question §16.7. */
export const DEFAULT_REMINDERS = { beforeDays: [3], onDue: true, afterDays: [2] };

const reminderSchema = z.object({
  beforeDays: z.array(z.number().int().min(1).max(60)).max(5),
  onDue: z.boolean(),
  afterDays: z.array(z.number().int().min(1).max(60)).max(5),
});

const itemSchema = z.object({
  label: z.string().trim().min(1).max(160),
  required: z.boolean().default(true),
  hint: z.string().trim().max(400).optional(),
});

interface RequestRow {
  id: string;
  title: string;
  message: string | null;
  due_at: number | null;
  reminder_policy_json: string | null;
  status: 'open' | 'complete' | 'cancelled';
  created_at: number;
}

interface ItemRow {
  id: string;
  doc_request_id: string;
  label: string;
  required: number;
  hint: string | null;
  file_id: string | null;
  fulfilled_at: number | null;
  position: number;
}

export async function listRequests(env: AppEnv, clientId: string, access: 'staff' | 'admin' | 'member') {
  const requests = await env.DB.prepare(
    `SELECT id, title, message, due_at, reminder_policy_json, status, created_at FROM doc_requests
      WHERE client_id = ? AND (? OR status != 'cancelled') ORDER BY status = 'open' DESC, COALESCE(due_at, created_at) ASC LIMIT 200`,
  )
    .bind(clientId, access === 'staff' ? 1 : 0)
    .all<RequestRow>();
  if (!requests.results.length) return [];
  const ids = requests.results.map((r) => r.id);
  const items = await env.DB.prepare(
    `SELECT id, doc_request_id, label, required, hint, file_id, fulfilled_at, position FROM doc_request_items
      WHERE doc_request_id IN (${ids.map(() => '?').join(',')}) ORDER BY position`,
  )
    .bind(...ids)
    .all<ItemRow>();
  const files = await visibleFiles(
    env,
    clientId,
    items.results.flatMap((i) => (i.file_id ? [i.file_id] : [])),
    access,
  );
  return requests.results.map((r) => ({
    id: r.id,
    title: r.title,
    message: r.message,
    dueAt: r.due_at,
    status: r.status,
    reminders: r.reminder_policy_json ? (JSON.parse(r.reminder_policy_json) as typeof DEFAULT_REMINDERS) : null,
    createdAt: r.created_at,
    items: items.results
      .filter((i) => i.doc_request_id === r.id)
      .map((i) => ({
        id: i.id,
        label: i.label,
        required: Boolean(i.required),
        hint: i.hint,
        fulfilledAt: i.fulfilled_at,
        file: (i.file_id ? files.get(i.file_id) : null) ?? null,
      })) as { id: string; label: string; required: boolean; hint: string | null; fulfilledAt: number | null; file: FileSummary | null }[],
  }));
}

async function requestRow(env: AppEnv, clientId: string, requestId: string): Promise<RequestRow> {
  const row = await env.DB.prepare(
    'SELECT id, title, message, due_at, reminder_policy_json, status, created_at FROM doc_requests WHERE id = ? AND client_id = ?',
  )
    .bind(requestId, clientId)
    .first<RequestRow>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

async function itemRow(env: AppEnv, clientId: string, requestId: string, itemId: string): Promise<ItemRow & { status: string }> {
  const row = await env.DB.prepare(
    `SELECT i.*, r.status FROM doc_request_items i JOIN doc_requests r ON r.id = i.doc_request_id
      WHERE i.id = ? AND i.doc_request_id = ? AND r.client_id = ?`,
  )
    .bind(itemId, requestId, clientId)
    .first<ItemRow & { status: string }>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

/** Statement that closes the request when every required item has a file (or reopens it when one is removed). */
function syncStatusStmt(env: AppEnv, requestId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE doc_requests SET status = CASE
        WHEN EXISTS (SELECT 1 FROM doc_request_items WHERE doc_request_id = ?1 AND required = 1 AND fulfilled_at IS NULL) THEN 'open'
        ELSE 'complete' END
      WHERE id = ?1 AND status != 'cancelled'`,
  ).bind(requestId);
}

const anyMember = requireClientAccess();
const staffOnly = requireClientAccess({ clientRoles: 'none' });

export const requests = new Hono<AppBindings>()
  .get('/', anyMember, async (c) => {
    return c.json({ requests: await listRequests(c.env, c.req.param('clientId') as string, accessOf(c)) });
  })

  .post('/', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const { user } = authOf(c);
    const body = await parseJson(
      c,
      z.object({
        title: z.string().trim().min(1).max(160),
        message: z.string().trim().max(4000).optional(),
        dueAt: z.number().int().positive().nullable().optional(),
        items: z.array(itemSchema).min(1).max(40),
        reminders: reminderSchema.optional(),
      }),
    );
    const id = newId('dr');
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO doc_requests (id, client_id, title, message, due_at, reminder_policy_json, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).bind(id, clientId, body.title, body.message || null, body.dueAt ?? null, JSON.stringify(body.reminders ?? DEFAULT_REMINDERS), user.id, now),
      ...body.items.map((item, i) =>
        c.env.DB.prepare('INSERT INTO doc_request_items (id, doc_request_id, label, required, hint, position) VALUES (?, ?, ?, ?, ?, ?)').bind(
          newId('dri'),
          id,
          item.label,
          item.required ? 1 : 0,
          item.hint || null,
          i,
        ),
      ),
      ...eventStmts(c.env, { clientId, actor: user.id, type: 'request.created', payload: { requestId: id, title: body.title, items: body.items.length } }),
    ]);
    return c.json({ id }, 201);
  })

  .patch('/:requestId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(
      c,
      z.object({
        title: z.string().trim().min(1).max(160).optional(),
        message: z.string().trim().max(4000).nullable().optional(),
        dueAt: z.number().int().positive().nullable().optional(),
        status: z.enum(['open', 'cancelled']).optional(),
        reminders: reminderSchema.optional(),
        addItems: z.array(itemSchema).max(40).optional(),
      }),
    );
    const row = await requestRow(c.env, clientId, c.req.param('requestId'));
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('UPDATE doc_requests SET title = ?, message = ?, due_at = ?, reminder_policy_json = ?, status = ? WHERE id = ? AND client_id = ?').bind(
        body.title ?? row.title,
        body.message === undefined ? row.message : body.message || null,
        body.dueAt === undefined ? row.due_at : body.dueAt,
        body.reminders ? JSON.stringify(body.reminders) : row.reminder_policy_json,
        body.status ?? row.status,
        row.id,
        clientId,
      ),
    ];
    if (body.addItems?.length) {
      const max = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM doc_request_items WHERE doc_request_id = ?')
        .bind(row.id)
        .first<{ p: number }>();
      body.addItems.forEach((item, i) =>
        stmts.push(
          c.env.DB.prepare('INSERT INTO doc_request_items (id, doc_request_id, label, required, hint, position) VALUES (?, ?, ?, ?, ?, ?)').bind(
            newId('dri'),
            row.id,
            item.label,
            item.required ? 1 : 0,
            item.hint || null,
            (max?.p ?? -1) + 1 + i,
          ),
        ),
      );
    }
    // Reopening re-evaluates completeness rather than trusting the caller.
    if (body.status === 'open' || body.addItems?.length) stmts.push(syncStatusStmt(c.env, row.id));
    stmts.push(...eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'request.updated', payload: { requestId: row.id } }));
    await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  })

  /** Attach an uploaded (or existing vault) file to a checklist item. */
  .put('/:requestId/items/:itemId/file', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const { user } = authOf(c);
    const body = await parseJson(c, z.object({ fileId: z.string().max(40) }));
    const item = await itemRow(c.env, clientId, c.req.param('requestId'), c.req.param('itemId'));
    if (item.status === 'cancelled') throw new HttpError(409, 'request_closed');
    const file = await visibleFile(c.env, clientId, body.fileId, access);
    if (!file) throw new HttpError(404, 'not_found');
    const before = await requestRow(c.env, clientId, item.doc_request_id);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE doc_request_items SET file_id = ?, fulfilled_at = ? WHERE id = ?').bind(file.id, Date.now(), item.id),
      syncStatusStmt(c.env, item.doc_request_id),
      ...eventStmts(c.env, {
        clientId,
        actor: user.id,
        type: 'request.item_fulfilled',
        payload: { requestId: item.doc_request_id, itemId: item.id, label: item.label, fileId: file.id },
      }),
    ]);
    const after = await requestRow(c.env, clientId, item.doc_request_id);
    if (before.status !== 'complete' && after.status === 'complete') {
      await c.env.DB.batch(eventStmts(c.env, { clientId, actor: user.id, type: 'request.completed', payload: { requestId: after.id, title: after.title } }));
    }
    return c.json({ ok: true, status: after.status });
  })

  /** Staff send an item back ("wrong year, please upload the 2025 990"). The file stays in the vault. */
  .delete('/:requestId/items/:itemId/file', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const item = await itemRow(c.env, clientId, c.req.param('requestId'), c.req.param('itemId'));
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE doc_request_items SET file_id = NULL, fulfilled_at = NULL WHERE id = ?').bind(item.id),
      syncStatusStmt(c.env, item.doc_request_id),
      ...eventStmts(c.env, {
        clientId,
        actor: authOf(c).user.id,
        type: 'request.item_returned',
        payload: { requestId: item.doc_request_id, itemId: item.id, label: item.label },
      }),
    ]);
    return c.json({ ok: true });
  });
