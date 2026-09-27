/**
 * Scheduled client updates (spec §5.7): a branded email with blocks that
 * fill themselves from live data at send time ("Deadlines this month", "New
 * opportunities", "Documents we still need", "Wins"). An update is sent now,
 * once later, or on a repeating schedule. With review on (the default), a
 * scheduled run builds a draft and asks the consultant to send it (spec §12).
 */
import type { AppEnv } from '../env';
import type { UpdateBlock } from '../email/templates/notify';
import { eventStmts } from '../lib/events';
import { HttpError } from '../lib/http';
import { newId } from '../lib/ids';
import { clientName, notify } from '../notify';

export const BLOCK_KINDS = ['deadlines', 'opportunities', 'documents', 'wins'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

const DAY = 86_400_000;

const fmt = (ms: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(ms);
const money = (n: number | null) => (n === null ? null : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);

/** Builds the requested blocks from what's in the database right now. `since` bounds "new" and "wins". */
export async function buildBlocks(env: AppEnv, clientId: string, kinds: BlockKind[], since: number, tz: string, now = Date.now()): Promise<UpdateBlock[]> {
  const out: UpdateBlock[] = [];
  for (const kind of BLOCK_KINDS.filter((k) => kinds.includes(k))) {
    if (kind === 'deadlines') {
      const rows = await env.DB.prepare(
        `SELECT title, due FROM (
           SELECT title, due_at AS due FROM deliverables WHERE client_id = ?1 AND due_at BETWEEN ?2 AND ?3 AND status NOT IN ('approved','done')
           UNION ALL SELECT title, due_at FROM doc_requests WHERE client_id = ?1 AND due_at BETWEEN ?2 AND ?3 AND status = 'open'
           UNION ALL SELECT title, deadline_at FROM opportunities WHERE client_id = ?1 AND deadline_at BETWEEN ?2 AND ?3 AND stage IN ('researching','preparing'))
         ORDER BY due LIMIT 15`,
      )
        .bind(clientId, now, now + 31 * DAY)
        .all<{ title: string; due: number }>();
      out.push({ kind, title: 'Deadlines this month', items: rows.results.map((r) => ({ title: r.title, detail: fmt(r.due, tz) })), empty: 'No deadlines in the next 30 days.' });
    }
    if (kind === 'opportunities') {
      const rows = await env.DB.prepare(
        `SELECT title, funder_name, amount_max, deadline_at FROM opportunities
          WHERE client_id = ? AND created_at >= ? AND stage != 'declined' ORDER BY created_at DESC LIMIT 10`,
      )
        .bind(clientId, since)
        .all<{ title: string; funder_name: string | null; amount_max: number | null; deadline_at: number | null }>();
      out.push({
        kind,
        title: 'New opportunities',
        items: rows.results.map((r) => ({
          title: r.title,
          detail: [r.funder_name, money(r.amount_max), r.deadline_at ? `due ${fmt(r.deadline_at, tz)}` : null].filter(Boolean).join(' · ') || undefined,
        })),
        empty: 'No new opportunities since the last update.',
      });
    }
    if (kind === 'documents') {
      const rows = await env.DB.prepare(
        `SELECT i.label, r.due_at FROM doc_request_items i JOIN doc_requests r ON r.id = i.doc_request_id
          WHERE r.client_id = ? AND r.status = 'open' AND i.fulfilled_at IS NULL AND i.required = 1 ORDER BY r.due_at IS NULL, r.due_at, i.position LIMIT 20`,
      )
        .bind(clientId)
        .all<{ label: string; due_at: number | null }>();
      out.push({ kind, title: 'Documents we still need', items: rows.results.map((r) => ({ title: r.label, detail: r.due_at ? `due ${fmt(r.due_at, tz)}` : undefined })), empty: 'Nothing outstanding. Thank you!' });
    }
    if (kind === 'wins') {
      const rows = await env.DB.prepare(
        `SELECT type, payload_json FROM events WHERE client_id = ? AND created_at >= ? AND type IN ('deliverable.approved', 'opportunity.awarded', 'request.completed')
          ORDER BY created_at DESC LIMIT 10`,
      )
        .bind(clientId, since)
        .all<{ type: string; payload_json: string | null }>();
      const items = rows.results.map((r) => {
        const p = r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : {};
        const title = typeof p.title === 'string' ? p.title : '';
        return r.type === 'opportunity.awarded' ? { title: `Awarded: ${title}` } : r.type === 'request.completed' ? { title: `Documents complete: ${title}` } : { title: `Approved: ${title}` };
      });
      out.push({ kind, title: 'Wins', items, empty: 'More to come.' });
    }
  }
  return out;
}

/** When the client's last update went out (bounds "new since last time"). */
async function lastSentAt(env: AppEnv, clientId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT MAX(sent_at) AS t FROM updates WHERE client_id = ? AND status = 'sent'").bind(clientId).first<{ t: number | null }>();
  return row?.t ?? Date.now() - 30 * DAY;
}

async function orgTimezone(env: AppEnv): Promise<string> {
  const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'org'").first<{ value_json: string }>();
  try {
    return row ? ((JSON.parse(row.value_json) as { timezone?: string }).timezone ?? 'UTC') : 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function freeze(env: AppEnv, updateId: string): Promise<void> {
  const u = await env.DB.prepare('SELECT client_id, blocks_json FROM updates WHERE id = ?').bind(updateId).first<{ client_id: string; blocks_json: string }>();
  if (!u) return;
  const blocks = await buildBlocks(env, u.client_id, JSON.parse(u.blocks_json) as BlockKind[], await lastSentAt(env, u.client_id), await orgTimezone(env));
  await env.DB.prepare('UPDATE updates SET content_json = ? WHERE id = ?').bind(JSON.stringify(blocks), updateId).run();
}

/** Sends an update to the client's users. Idempotent: only a scheduled or pending update is sent, once. */
export async function sendUpdate(env: AppEnv, updateId: string, actorId: string | null): Promise<void> {
  const u = await env.DB.prepare("SELECT id, client_id, subject, status, content_json FROM updates WHERE id = ? AND status IN ('scheduled', 'pending_review')")
    .bind(updateId)
    .first<{ id: string; client_id: string; subject: string; status: string; content_json: string | null }>();
  if (!u) throw new HttpError(409, 'update_not_sendable');
  // A reviewed draft is sent as reviewed; otherwise blocks are filled now.
  if (!u.content_json || u.status === 'scheduled') await freeze(env, u.id);
  const now = Date.now();
  const res = await env.DB.prepare("UPDATE updates SET status = 'sent', sent_at = ?, reviewed_by = COALESCE(reviewed_by, ?) WHERE id = ? AND status IN ('scheduled', 'pending_review')")
    .bind(now, actorId, u.id)
    .run();
  if (!res.meta.changes) return;
  await env.DB.batch(eventStmts(env, { clientId: u.client_id, actor: actorId, type: 'update.sent', payload: { updateId: u.id, title: u.subject } }));
  await notify(env, { clientId: u.client_id, audience: 'client', kind: 'update', payload: { updateId: u.id, clientName: await clientName(env, u.client_id) } });
}

export interface UpdateConfig {
  subject: string;
  intro: string | null;
  blocks: BlockKind[];
}

/** A due schedule run: make this run's update, then send it or hold it for review. */
export async function runUpdateSchedule(env: AppEnv, schedule: { id: string; client_id: string | null; config_json: string | null; requires_review: number; created_by: string | null }, runAt: number): Promise<void> {
  if (!schedule.client_id || !schedule.config_json) return;
  const config = JSON.parse(schedule.config_json) as UpdateConfig;
  // One update per (schedule, run): a retried job finds the row it already made.
  const existing = await env.DB.prepare('SELECT id, status FROM updates WHERE schedule_id = ? AND send_at = ?').bind(schedule.id, runAt).first<{ id: string; status: string }>();
  const id = existing?.id ?? newId('upd');
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO updates (id, client_id, schedule_id, subject, intro, blocks_json, status, send_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
    )
      .bind(id, schedule.client_id, schedule.id, config.subject, config.intro, JSON.stringify(config.blocks), runAt, schedule.created_by, Date.now())
      .run();
  } else if (existing.status !== 'scheduled') {
    return;
  }
  if (schedule.requires_review) {
    await freeze(env, id);
    const moved = await env.DB.prepare("UPDATE updates SET status = 'pending_review' WHERE id = ? AND status = 'scheduled'").bind(id).run();
    if (moved.meta.changes) {
      await notify(env, {
        clientId: schedule.client_id,
        audience: 'staff',
        kind: 'update.review',
        payload: { updateId: id, subject: config.subject, clientName: await clientName(env, schedule.client_id) },
      });
    }
    return;
  }
  await sendUpdate(env, id, null);
}
