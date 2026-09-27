/**
 * Funding reports (spec §5.3, §6.4). Mounted under
 * `/api/clients/:clientId/reports`. Staff build and send; client users read
 * sent reports and answer each opportunity Pursue / Not now / Question.
 * "Pursue" puts the opportunity on the client's pipeline (stage researching).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { accessOf, authOf, requireClientAccess } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { eventStmts } from '../lib/events';
import { HttpError, parseJson } from '../lib/http';
import { newId } from '../lib/ids';
import { clientName, notify } from '../notify';
import { pdfFilename, ReportError, reportPdf, sendReport, type ReportRow } from '../reports';
import { toOpportunity, type OpportunityRow } from './opportunities';

const anyMember = requireClientAccess();
const staffOnly = requireClientAccess({ clientRoles: 'none' });

export const TAGS = ['recommended', 'consider', 'fyi'] as const;
export const RESPONSES = ['pursue', 'not_now', 'question'] as const;
const MAX_ITEMS = 100;

interface ItemRow extends OpportunityRow {
  position: number;
  note_md: string | null;
  tag: (typeof TAGS)[number] | null;
  client_response: (typeof RESPONSES)[number] | null;
  client_comment: string | null;
  responded_at: number | null;
  report_id: string;
}

const toReport = (r: ReportRow & { item_count?: number; pursue_count?: number; answered_count?: number }, staff: boolean) => ({
  id: r.id,
  title: r.title,
  intro: r.intro_md,
  status: r.status,
  sentAt: r.sent_at,
  createdAt: r.created_at,
  itemCount: r.item_count ?? 0,
  answeredCount: r.answered_count ?? 0,
  pursueCount: r.pursue_count ?? 0,
  ...(staff ? { pendingReview: Boolean(r.pending_review), fromSchedule: Boolean(r.schedule_id), updatedAt: r.updated_at ?? r.created_at } : {}),
});

async function reportRow(env: AppEnv, clientId: string, reportId: string, staff: boolean): Promise<ReportRow> {
  const row = await env.DB.prepare(`SELECT * FROM reports WHERE id = ? AND client_id = ?${staff ? '' : " AND status = 'sent'"}`)
    .bind(reportId, clientId)
    .first<ReportRow>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

async function draftRow(env: AppEnv, clientId: string, reportId: string): Promise<ReportRow> {
  const row = await reportRow(env, clientId, reportId, true);
  if (row.status !== 'draft') throw new HttpError(409, 'report_not_draft');
  return row;
}

async function items(env: AppEnv, report: ReportRow): Promise<ItemRow[]> {
  const rows = await env.DB.prepare(
    `SELECT o.*, i.report_id, i.position, i.note_md, i.tag, i.client_response, i.client_comment, i.responded_at
       FROM report_items i JOIN opportunities o ON o.id = i.opportunity_id
      WHERE i.report_id = ? AND o.client_id = ? ORDER BY i.position`,
  )
    .bind(report.id, report.client_id)
    .all<ItemRow>();
  return rows.results;
}

const toItem = (r: ItemRow, staff: boolean) => ({
  opportunity: toOpportunity(r, staff),
  position: r.position,
  note: r.note_md,
  tag: r.tag,
  response: r.client_response,
  comment: r.client_comment,
  respondedAt: r.responded_at,
});

const touch = (env: AppEnv, reportId: string) => env.DB.prepare('UPDATE reports SET updated_at = ? WHERE id = ?').bind(Date.now(), reportId);

export const reportsApi = new Hono<AppBindings>()
  .get('/', anyMember, async (c) => {
    const staff = accessOf(c) === 'staff';
    const rows = await c.env.DB.prepare(
      `SELECT r.*,
         (SELECT COUNT(*) FROM report_items i WHERE i.report_id = r.id) AS item_count,
         (SELECT COUNT(*) FROM report_items i WHERE i.report_id = r.id AND i.client_response IS NOT NULL) AS answered_count,
         (SELECT COUNT(*) FROM report_items i WHERE i.report_id = r.id AND i.client_response = 'pursue') AS pursue_count
        FROM reports r WHERE r.client_id = ?${staff ? '' : " AND r.status = 'sent'"}
       ORDER BY COALESCE(r.sent_at, r.created_at) DESC LIMIT 200`,
    )
      .bind(c.req.param('clientId'))
      .all<ReportRow & { item_count: number; answered_count: number; pursue_count: number }>();
    return c.json({ reports: rows.results.map((r) => toReport(r, staff)) });
  })

  .post('/', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(
      c,
      z.object({
        title: z.string().trim().min(1).max(160),
        intro: z.string().trim().max(8000).nullable().optional(),
        opportunityIds: z.array(z.string().max(40)).max(MAX_ITEMS).optional(),
      }),
    );
    const id = newId('rpt');
    const now = Date.now();
    const oppIds = [...new Set(body.opportunityIds ?? [])];
    if (oppIds.length) {
      const found = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM opportunities WHERE client_id = ? AND id IN (${oppIds.map(() => '?').join(',')})`)
        .bind(clientId, ...oppIds)
        .first<{ n: number }>();
      if (found?.n !== oppIds.length) throw new HttpError(422, 'invalid_input', { fields: ['opportunityIds'] });
    }
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO reports (id, client_id, title, intro_md, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)").bind(
        id,
        clientId,
        body.title,
        body.intro || null,
        authOf(c).user.id,
        now,
        now,
      ),
      ...oppIds.map((oid, i) => c.env.DB.prepare('INSERT INTO report_items (report_id, opportunity_id, position) VALUES (?, ?, ?)').bind(id, oid, i)),
    ]);
    return c.json({ id }, 201);
  })

  .get('/:reportId', anyMember, async (c) => {
    const staff = accessOf(c) === 'staff';
    const report = await reportRow(c.env, c.req.param('clientId') as string, c.req.param('reportId'), staff);
    const list = await items(c.env, report);
    return c.json({
      report: toReport({ ...report, item_count: list.length, answered_count: list.filter((i) => i.client_response).length, pursue_count: list.filter((i) => i.client_response === 'pursue').length }, staff),
      items: list.map((i) => toItem(i, staff)),
    });
  })

  .patch('/:reportId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, z.object({ title: z.string().trim().min(1).max(160).optional(), intro: z.string().trim().max(8000).nullable().optional() }));
    const row = await draftRow(c.env, clientId, c.req.param('reportId'));
    await c.env.DB.prepare('UPDATE reports SET title = ?, intro_md = ?, updated_at = ? WHERE id = ? AND client_id = ?')
      .bind(body.title ?? row.title, body.intro === undefined ? row.intro_md : body.intro || null, Date.now(), row.id, clientId)
      .run();
    return c.json({ ok: true });
  })

  .delete('/:reportId', staffOnly, async (c) => {
    const res = await c.env.DB.prepare('DELETE FROM reports WHERE id = ? AND client_id = ?').bind(c.req.param('reportId'), c.req.param('clientId')).run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    return c.json({ ok: true });
  })

  /** Adds an opportunity (already saved for this client) at the end. */
  .post('/:reportId/items', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, z.object({ opportunityId: z.string().max(40), note: z.string().trim().max(4000).nullable().optional(), tag: z.enum(TAGS).nullable().optional() }));
    const report = await draftRow(c.env, clientId, c.req.param('reportId'));
    const opp = await c.env.DB.prepare('SELECT id FROM opportunities WHERE id = ? AND client_id = ?').bind(body.opportunityId, clientId).first();
    if (!opp) throw new HttpError(422, 'invalid_input', { fields: ['opportunityId'] });
    const stats = await c.env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM report_items WHERE report_id = ?').bind(report.id).first<{ n: number; last: number }>();
    if ((stats?.n ?? 0) >= MAX_ITEMS) throw new HttpError(422, 'too_many_items');
    const res = await c.env.DB.prepare('INSERT OR IGNORE INTO report_items (report_id, opportunity_id, position, note_md, tag) VALUES (?, ?, ?, ?, ?)')
      .bind(report.id, body.opportunityId, (stats?.last ?? -1) + 1, body.note || null, body.tag ?? null)
      .run();
    await touch(c.env, report.id).run();
    return c.json({ ok: true, added: res.meta.changes > 0 }, res.meta.changes ? 201 : 200);
  })

  .patch('/:reportId/items/:opportunityId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, z.object({ note: z.string().trim().max(4000).nullable().optional(), tag: z.enum(TAGS).nullable().optional() }));
    const report = await draftRow(c.env, clientId, c.req.param('reportId'));
    const item = await c.env.DB.prepare('SELECT note_md, tag FROM report_items WHERE report_id = ? AND opportunity_id = ?')
      .bind(report.id, c.req.param('opportunityId'))
      .first<{ note_md: string | null; tag: string | null }>();
    if (!item) throw new HttpError(404, 'not_found');
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE report_items SET note_md = ?, tag = ? WHERE report_id = ? AND opportunity_id = ?').bind(
        body.note === undefined ? item.note_md : body.note || null,
        body.tag === undefined ? item.tag : body.tag,
        report.id,
        c.req.param('opportunityId'),
      ),
      touch(c.env, report.id),
    ]);
    return c.json({ ok: true });
  })

  .delete('/:reportId/items/:opportunityId', staffOnly, async (c) => {
    const report = await draftRow(c.env, c.req.param('clientId') as string, c.req.param('reportId'));
    const res = await c.env.DB.prepare('DELETE FROM report_items WHERE report_id = ? AND opportunity_id = ?').bind(report.id, c.req.param('opportunityId')).run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    await touch(c.env, report.id).run();
    return c.json({ ok: true });
  })

  /** New order: must name exactly the items already in the report. */
  .put('/:reportId/order', staffOnly, async (c) => {
    const body = await parseJson(c, z.object({ opportunityIds: z.array(z.string().max(40)).max(MAX_ITEMS) }));
    const report = await draftRow(c.env, c.req.param('clientId') as string, c.req.param('reportId'));
    const current = await c.env.DB.prepare('SELECT opportunity_id FROM report_items WHERE report_id = ?').bind(report.id).all<{ opportunity_id: string }>();
    const have = new Set(current.results.map((r) => r.opportunity_id));
    if (body.opportunityIds.length !== have.size || new Set(body.opportunityIds).size !== have.size || !body.opportunityIds.every((id) => have.has(id))) {
      throw new HttpError(422, 'invalid_input', { fields: ['opportunityIds'] });
    }
    await c.env.DB.batch([
      ...body.opportunityIds.map((oid, i) => c.env.DB.prepare('UPDATE report_items SET position = ? WHERE report_id = ? AND opportunity_id = ?').bind(i, report.id, oid)),
      touch(c.env, report.id),
    ]);
    return c.json({ ok: true });
  })

  .post('/:reportId/send', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    await reportRow(c.env, clientId, c.req.param('reportId'), true);
    try {
      await sendReport(c.env, c.req.param('reportId'), clientId, authOf(c).user.id);
    } catch (err) {
      if (err instanceof ReportError) throw new HttpError(409, err.code);
      throw err;
    }
    return c.json({ ok: true });
  })

  /** Client users answer an opportunity in a sent report (spec §5.3 "Client response"). */
  .post('/:reportId/items/:opportunityId/respond', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, z.object({ response: z.enum(RESPONSES), comment: z.string().trim().max(2000).nullable().optional() }));
    if (body.response === 'question' && !body.comment) throw new HttpError(422, 'invalid_input', { fields: ['comment'] });
    const report = await reportRow(c.env, clientId, c.req.param('reportId'), false);
    // The answer is the client's to give; staff see it, they don't make it.
    if (accessOf(c) === 'staff') throw new HttpError(403, 'client_users_only');
    const item = await c.env.DB.prepare(
      `SELECT o.id, o.title, o.stage FROM report_items i JOIN opportunities o ON o.id = i.opportunity_id
        WHERE i.report_id = ? AND i.opportunity_id = ? AND o.client_id = ?`,
    )
      .bind(report.id, c.req.param('opportunityId'), clientId)
      .first<{ id: string; title: string; stage: string }>();
    if (!item) throw new HttpError(404, 'not_found');
    const { user } = authOf(c);
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('UPDATE report_items SET client_response = ?, client_comment = ?, responded_at = ? WHERE report_id = ? AND opportunity_id = ?').bind(
        body.response,
        body.comment || null,
        now,
        report.id,
        item.id,
      ),
      ...eventStmts(c.env, { clientId, actor: user.id, type: 'report.response', payload: { reportId: report.id, opportunityId: item.id, title: item.title, response: body.response } }),
    ];
    const pursued = body.response === 'pursue' && item.stage === 'none';
    if (pursued) {
      stmts.push(
        c.env.DB.prepare("UPDATE opportunities SET stage = 'researching', stage_changed_at = ?, updated_at = ? WHERE id = ? AND client_id = ? AND stage = 'none'").bind(now, now, item.id, clientId),
        ...eventStmts(c.env, { clientId, actor: user.id, type: 'opportunity.stage_changed', payload: { opportunityId: item.id, title: item.title, from: 'none', to: 'researching' } }),
      );
    }
    await c.env.DB.batch(stmts);
    c.executionCtx.waitUntil(
      notify(c.env, {
        clientId,
        audience: 'staff',
        kind: 'report.response',
        actorId: user.id,
        payload: {
          reportId: report.id,
          opportunityId: item.id,
          title: item.title,
          response: body.response,
          comment: body.comment || null,
          by: user.name || user.email,
          clientName: await clientName(c.env, clientId),
        },
      }),
    );
    return c.json({ ok: true, stage: pursued ? 'researching' : item.stage });
  })

  .get('/:reportId/pdf', anyMember, async (c) => {
    const staff = accessOf(c) === 'staff';
    const report = await reportRow(c.env, c.req.param('clientId') as string, c.req.param('reportId'), staff);
    const pdf = await reportPdf(c.env, report);
    return new Response(pdf as Uint8Array<ArrayBuffer>, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdfFilename(report.title)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
