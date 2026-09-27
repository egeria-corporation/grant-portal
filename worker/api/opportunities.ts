/**
 * Opportunities and the pipeline (spec §5.3, §5.4). Mounted under
 * `/api/clients/:clientId/opportunities`, plus a cross-client pipeline for
 * staff at `/api/pipeline`.
 *
 * Stage `none` means "a candidate" (in a report, not yet pursued). The board
 * is everything else: researching → preparing → submitted → awarded/declined.
 * Client users see pipeline items and opportunities in reports they've been
 * sent, never consultant notes or the data source (§10.5).
 */
import { parseAmount, parseCsv, parseDay } from '@shared/csv';
import { Hono } from 'hono';
import { z } from 'zod';
import { accessOf, authOf, requireClientAccess, requireStaff } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { requireProvider } from '../funding/provider';
import { eventStmts } from '../lib/events';
import { HttpError, parseJson } from '../lib/http';
import { newId } from '../lib/ids';

export const STAGES = ['none', 'researching', 'preparing', 'submitted', 'awarded', 'declined'] as const;
export type Stage = (typeof STAGES)[number];
const MAX_IMPORT_ROWS = 500;

export interface OpportunityRow {
  id: string;
  client_id: string;
  source: 'manual' | 'opengrants' | 'csv';
  og_id: string | null;
  kind: string;
  title: string;
  funder_name: string | null;
  url: string | null;
  amount_min: number | null;
  amount_max: number | null;
  deadline_at: number | null;
  eligibility_notes: string | null;
  data_json: string | null;
  stage: Stage;
  notes: string | null;
  stage_changed_at: number | null;
  refreshed_at: number | null;
  updated_at: number | null;
  created_at: number;
  /** Present on list queries (DLV_COUNTS). */
  dlv_total?: number;
  dlv_done?: number;
}

/** Deliverable progress per opportunity, for pipeline cards. */
const DLV_COUNTS = `(SELECT COUNT(*) FROM deliverables d WHERE d.opportunity_id = o.id AND d.client_id = o.client_id) AS dlv_total,
  (SELECT COUNT(*) FROM deliverables d WHERE d.opportunity_id = o.id AND d.client_id = o.client_id AND d.status IN ('approved', 'done')) AS dlv_done`;

interface OpportunityData {
  summary?: string | null;
  fitScore?: number | null;
}

function dataOf(r: OpportunityRow): OpportunityData {
  if (!r.data_json) return {};
  try {
    return JSON.parse(r.data_json) as OpportunityData;
  } catch {
    return {};
  }
}

/**
 * The API shape. Staff also get the source, OpenGrants ID and their private
 * notes; client users get the funder's own listing as the source (§10.5).
 */
export function toOpportunity(r: OpportunityRow, staff: boolean) {
  const data = dataOf(r);
  const base = {
    id: r.id,
    clientId: r.client_id,
    kind: r.kind,
    title: r.title,
    funderName: r.funder_name,
    url: r.url,
    amountMin: r.amount_min,
    amountMax: r.amount_max,
    deadlineAt: r.deadline_at,
    eligibilityNotes: r.eligibility_notes,
    summary: data.summary ?? null,
    fitScore: data.fitScore ?? null,
    stage: r.stage,
    stageChangedAt: r.stage_changed_at,
    createdAt: r.created_at,
    ...(r.dlv_total === undefined ? {} : { deliverables: { total: r.dlv_total, done: r.dlv_done ?? 0 } }),
  };
  if (!staff) return base;
  return { ...base, source: r.source, ogId: r.og_id, notes: r.notes, refreshedAt: r.refreshed_at, updatedAt: r.updated_at ?? r.created_at };
}

/** What a client user may see: the pipeline, and anything in a report they were sent. */
export const CLIENT_VISIBLE = `(o.stage != 'none' OR EXISTS (SELECT 1 FROM report_items ri JOIN reports r ON r.id = ri.report_id
  WHERE ri.opportunity_id = o.id AND r.status = 'sent'))`;

export async function opportunityRow(env: AppEnv, clientId: string, id: string, staff: boolean): Promise<OpportunityRow> {
  const row = await env.DB.prepare(`SELECT o.* FROM opportunities o WHERE o.id = ? AND o.client_id = ?${staff ? '' : ` AND ${CLIENT_VISIBLE}`}`)
    .bind(id, clientId)
    .first<OpportunityRow>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

const url = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), 'http(s) only');
const amount = z.number().int().min(0).max(1e12);

const fields = z.object({
  kind: z.enum(['grant', 'contract']).default('grant'),
  title: z.string().trim().min(1).max(300),
  funderName: z.string().trim().max(200).nullable().optional(),
  url: url.nullable().optional(),
  amountMin: amount.nullable().optional(),
  amountMax: amount.nullable().optional(),
  deadlineAt: z.number().int().positive().nullable().optional(),
  eligibilityNotes: z.string().trim().max(2000).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

const patchSchema = fields.partial().extend({ stage: z.enum(STAGES).optional() });

/** Event type for a move to `stage`; awards are their own event so "Wins" can find them. */
const stageEvent = (stage: Stage) => (stage === 'awarded' ? 'opportunity.awarded' : 'opportunity.stage_changed');

/** Inserts a new opportunity with its event; returns the statements and ID. */
export function insertOpportunity(
  env: AppEnv,
  p: {
    clientId: string;
    actor: string | null;
    source: OpportunityRow['source'];
    ogId?: string | null;
    kind: string;
    title: string;
    funderName?: string | null;
    url?: string | null;
    amountMin?: number | null;
    amountMax?: number | null;
    deadlineAt?: number | null;
    eligibilityNotes?: string | null;
    notes?: string | null;
    data?: OpportunityData | null;
    stage?: Stage;
    now?: number;
  },
): { id: string; stmts: D1PreparedStatement[] } {
  const id = newId('opp');
  const now = p.now ?? Date.now();
  const stage = p.stage ?? 'none';
  return {
    id,
    stmts: [
      env.DB.prepare(
        `INSERT INTO opportunities (id, client_id, source, og_id, kind, title, funder_name, url, amount_min, amount_max, deadline_at,
           eligibility_notes, data_json, stage, notes, created_by, stage_changed_at, refreshed_at, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        p.clientId,
        p.source,
        p.ogId ?? null,
        p.kind,
        p.title,
        p.funderName ?? null,
        p.url ?? null,
        p.amountMin ?? null,
        p.amountMax ?? null,
        p.deadlineAt ?? null,
        p.eligibilityNotes ?? null,
        p.data ? JSON.stringify(p.data) : null,
        stage,
        p.notes ?? null,
        p.actor,
        stage === 'none' ? null : now,
        p.source === 'opengrants' ? now : null,
        now,
        now,
      ),
      ...eventStmts(env, { clientId: p.clientId, actor: p.actor, type: 'opportunity.created', payload: { opportunityId: id, title: p.title }, at: now }),
    ],
  };
}

/** Adds (or finds) an OpenGrants listing for a client. Saved rows keep the OpenGrants ID and source URL (§10.3). */
export async function addFromOpenGrants(env: AppEnv, clientId: string, actor: string | null, kind: 'grant' | 'contract', ogId: string): Promise<{ id: string; created: boolean }> {
  const existing = await env.DB.prepare('SELECT id FROM opportunities WHERE client_id = ? AND og_id = ?').bind(clientId, ogId).first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };
  const d = await (await requireProvider(env)).get(kind, ogId);
  const { id, stmts } = insertOpportunity(env, {
    clientId,
    actor,
    source: 'opengrants',
    ogId: d.ogId,
    kind: d.kind,
    title: d.title,
    funderName: d.funderName,
    url: d.url,
    amountMin: d.amountMin,
    amountMax: d.amountMax,
    deadlineAt: d.deadlineAt,
    eligibilityNotes: d.eligibilityNotes,
    data: { summary: d.summary, fitScore: d.fitScore },
  });
  await env.DB.batch(stmts);
  return { id, created: true };
}

/** CSV header → field. Column names are matched loosely so exports from other tools work. */
const HEADERS: Record<string, 'title' | 'funderName' | 'url' | 'deadlineAt' | 'amountMin' | 'amountMax' | 'notes' | 'eligibilityNotes'> = {
  title: 'title',
  name: 'title',
  opportunity: 'title',
  funder: 'funderName',
  funder_name: 'funderName',
  agency: 'funderName',
  url: 'url',
  link: 'url',
  deadline: 'deadlineAt',
  deadline_at: 'deadlineAt',
  due: 'deadlineAt',
  due_date: 'deadlineAt',
  amount: 'amountMax',
  amount_max: 'amountMax',
  max_amount: 'amountMax',
  amount_min: 'amountMin',
  min_amount: 'amountMin',
  notes: 'notes',
  eligibility: 'eligibilityNotes',
};

export interface ImportRow {
  title: string;
  funderName: string | null;
  url: string | null;
  deadlineAt: number | null;
  amountMin: number | null;
  amountMax: number | null;
  notes: string | null;
  eligibilityNotes: string | null;
}

/** Parses an opportunities CSV. Returns the valid rows and a list of problems by line number. */
export function parseOpportunityCsv(csv: string): { rows: ImportRow[]; errors: { line: number; error: string }[] } {
  const table = parseCsv(csv);
  const header = (table[0] ?? []).map((h) => HEADERS[h.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? null);
  if (!header.includes('title')) return { rows: [], errors: [{ line: 1, error: 'missing_title_column' }] };
  const rows: ImportRow[] = [];
  const errors: { line: number; error: string }[] = [];
  for (const [i, cells] of table.slice(1, MAX_IMPORT_ROWS + 1).entries()) {
    const line = i + 2;
    const r: ImportRow = { title: '', funderName: null, url: null, deadlineAt: null, amountMin: null, amountMax: null, notes: null, eligibilityNotes: null };
    let bad: string | null = null;
    header.forEach((field, col) => {
      const v = (cells[col] ?? '').trim();
      if (!field || !v) return;
      if (field === 'deadlineAt') {
        r.deadlineAt = parseDay(v);
        if (r.deadlineAt === null) bad ??= 'bad_deadline';
      } else if (field === 'amountMin' || field === 'amountMax') {
        r[field] = parseAmount(v);
        if (r[field] === null) bad ??= 'bad_amount';
      } else if (field === 'url') {
        if (/^https?:\/\//i.test(v)) r.url = v.slice(0, 2000);
        else bad ??= 'bad_url';
      } else if (field === 'title') {
        r.title = v.slice(0, 300);
      } else {
        r[field] = v.slice(0, field === 'funderName' ? 200 : 2000);
      }
    });
    if (!r.title) bad ??= 'missing_title';
    if (bad) errors.push({ line, error: bad });
    else rows.push(r);
  }
  if (table.length - 1 > MAX_IMPORT_ROWS) errors.push({ line: MAX_IMPORT_ROWS + 2, error: 'too_many_rows' });
  return { rows, errors };
}

const anyMember = requireClientAccess();
const staffOnly = requireClientAccess({ clientRoles: 'none' });

export const opportunitiesApi = new Hono<AppBindings>()
  .get('/', anyMember, async (c) => {
    const staff = accessOf(c) === 'staff';
    const rows = await c.env.DB.prepare(
      `SELECT o.*, ${DLV_COUNTS} FROM opportunities o WHERE o.client_id = ?${staff ? '' : ` AND ${CLIENT_VISIBLE}`}
        ORDER BY o.deadline_at IS NULL, o.deadline_at, o.created_at DESC LIMIT 500`,
    )
      .bind(c.req.param('clientId'))
      .all<OpportunityRow>();
    return c.json({ opportunities: rows.results.map((r) => toOpportunity(r, staff)) });
  })

  .post('/', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, fields.extend({ stage: z.enum(STAGES).default('none') }));
    const { id, stmts } = insertOpportunity(c.env, { ...body, clientId, actor: authOf(c).user.id, source: 'manual' });
    await c.env.DB.batch(stmts);
    return c.json({ id }, 201);
  })

  /** CSV import: valid rows are added, the rest are reported by line. */
  .post('/import', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, z.object({ csv: z.string().min(1).max(200_000) }));
    const { rows, errors } = parseOpportunityCsv(body.csv);
    const actor = authOf(c).user.id;
    const now = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i += 40) {
      const stmts = rows.slice(i, i + 40).flatMap((r) => {
        const out = insertOpportunity(c.env, { ...r, clientId, actor, source: 'csv', kind: 'grant', now });
        ids.push(out.id);
        return out.stmts;
      });
      await c.env.DB.batch(stmts);
    }
    return c.json({ imported: ids.length, ids, errors }, rows.length ? 201 : 422);
  })

  .post('/from-opengrants', staffOnly, async (c) => {
    const body = await parseJson(c, z.object({ kind: z.enum(['grant', 'contract']), ogId: z.string().trim().min(1).max(100) }));
    const out = await addFromOpenGrants(c.env, c.req.param('clientId') as string, authOf(c).user.id, body.kind, body.ogId);
    return c.json(out, out.created ? 201 : 200);
  })

  .get('/:opportunityId', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const staff = accessOf(c) === 'staff';
    const row = await opportunityRow(c.env, clientId, c.req.param('opportunityId'), staff);
    const dlv = await c.env.DB.prepare('SELECT id, title, status, due_at, side FROM deliverables WHERE client_id = ? AND opportunity_id = ? ORDER BY due_at IS NULL, due_at')
      .bind(clientId, row.id)
      .all<{ id: string; title: string; status: string; due_at: number | null; side: string }>();
    return c.json({
      opportunity: toOpportunity(row, staff),
      deliverables: dlv.results.map((d) => ({ id: d.id, title: d.title, status: d.status, dueAt: d.due_at, side: d.side })),
    });
  })

  .patch('/:opportunityId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, patchSchema);
    const row = await opportunityRow(c.env, clientId, c.req.param('opportunityId'), true);
    const actor = authOf(c).user.id;
    const now = Date.now();
    const next = {
      kind: body.kind ?? row.kind,
      title: body.title ?? row.title,
      funder_name: body.funderName === undefined ? row.funder_name : body.funderName,
      url: body.url === undefined ? row.url : body.url,
      amount_min: body.amountMin === undefined ? row.amount_min : body.amountMin,
      amount_max: body.amountMax === undefined ? row.amount_max : body.amountMax,
      deadline_at: body.deadlineAt === undefined ? row.deadline_at : body.deadlineAt,
      eligibility_notes: body.eligibilityNotes === undefined ? row.eligibility_notes : body.eligibilityNotes,
      notes: body.notes === undefined ? row.notes : body.notes,
      stage: body.stage ?? row.stage,
    };
    const stageChanged = next.stage !== row.stage;
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE opportunities SET kind = ?, title = ?, funder_name = ?, url = ?, amount_min = ?, amount_max = ?, deadline_at = ?,
           eligibility_notes = ?, notes = ?, stage = ?, stage_changed_at = ?, updated_at = ? WHERE id = ? AND client_id = ?`,
      ).bind(
        next.kind,
        next.title,
        next.funder_name,
        next.url,
        next.amount_min,
        next.amount_max,
        next.deadline_at,
        next.eligibility_notes,
        next.notes,
        next.stage,
        stageChanged ? now : row.stage_changed_at,
        now,
        row.id,
        clientId,
      ),
    ];
    if (stageChanged) {
      stmts.push(...eventStmts(c.env, { clientId, actor, type: stageEvent(next.stage), payload: { opportunityId: row.id, title: next.title, from: row.stage, to: next.stage } }));
    } else if (Object.keys(body).some((k) => k !== 'notes')) {
      // Private notes don't make the client's timeline.
      stmts.push(...eventStmts(c.env, { clientId, actor, type: 'opportunity.updated', payload: { opportunityId: row.id, title: next.title } }));
    }
    await c.env.DB.batch(stmts);
    return c.json({ opportunity: toOpportunity({ ...row, ...next, stage_changed_at: stageChanged ? now : row.stage_changed_at, updated_at: now }, true) });
  })

  .delete('/:opportunityId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const row = await opportunityRow(c.env, clientId, c.req.param('opportunityId'), true);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM opportunities WHERE id = ? AND client_id = ?').bind(row.id, clientId),
      ...eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'opportunity.deleted', payload: { title: row.title } }),
    ]);
    return c.json({ ok: true });
  });

/** Cross-client pipeline for staff: every client they can reach (spec §5.4). */
export const pipelineApi = new Hono<AppBindings>().get('/', requireStaff, async (c) => {
  const { user } = authOf(c);
  const all = user.role === 'owner' || user.allClients;
  const rows = await c.env.DB.prepare(
    `SELECT o.*, ${DLV_COUNTS}, c.name AS client_name FROM opportunities o JOIN clients c ON c.id = o.client_id
      WHERE o.stage != 'none' AND c.archived_at IS NULL
        AND (?1 OR EXISTS (SELECT 1 FROM staff_assignments s WHERE s.client_id = o.client_id AND s.user_id = ?2))
      ORDER BY o.deadline_at IS NULL, o.deadline_at LIMIT 1000`,
  )
    .bind(all ? 1 : 0, user.id)
    .all<OpportunityRow & { client_name: string }>();
  return c.json({ opportunities: rows.results.map((r) => ({ ...toOpportunity(r, true), clientName: r.client_name })) });
});
