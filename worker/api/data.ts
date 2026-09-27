/**
 * Owner data tools (spec §5.9 "Data", §7.3):
 * - `/api/audit`: the append-only audit log, filterable, and a CSV export;
 * - `/api/data/export`: everything as a ZIP of JSON tables plus the files;
 * - hard delete of a client (`deleteClient`, mounted in clients.ts).
 * Exports and deletes need a recent step-up and are themselves audited.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { requireOwner, requireStepUp } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/http';
import { zipPath, ZipWriter } from '../lib/zip';

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target: string | null;
  meta_json: string | null;
  created_at: number;
  actor_email: string | null;
  actor_name: string | null;
}

const auditQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().positive().optional(),
  action: z
    .string()
    .regex(/^[a-z_.]{1,60}$/)
    .optional(),
  actor: z.string().max(40).optional(),
});

async function auditRows(env: AppEnv, q: z.infer<typeof auditQuery>, limit: number): Promise<AuditRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    args.push(...values);
  };
  if (q.before) add('a.created_at < ?', q.before);
  if (q.after) add('a.created_at >= ?', q.after);
  // An exact action, or a family: `team` matches `team.removed`.
  if (q.action) add("(a.action = ? OR a.action LIKE ? ESCAPE '\\')", q.action, `${q.action.replace(/_/g, '\\_')}.%`);
  if (q.actor) add('a.actor_user_id = ?', q.actor);
  const rows = await env.DB.prepare(
    `SELECT a.id, a.actor_user_id, a.action, a.target, a.meta_json, a.created_at, u.email AS actor_email, u.name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.created_at DESC LIMIT ?`,
  )
    .bind(...args, limit)
    .all<AuditRow>();
  return rows.results;
}

const meta = (json: string | null): unknown => {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

/** CSV cell: quoted, and neutralised against spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const auditApi = new Hono<AppBindings>()
  .use('*', requireOwner)
  .get('/', async (c) => {
    const q = auditQuery.safeParse(c.req.query());
    if (!q.success) throw new HttpError(422, 'invalid_input');
    const rows = await auditRows(c.env, q.data, 100);
    return c.json({
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        target: r.target,
        meta: meta(r.meta_json),
        createdAt: r.created_at,
        actor: r.actor_user_id ? { id: r.actor_user_id, email: r.actor_email, name: r.actor_name } : null,
      })),
    });
  })
  .get('/export', requireStepUp(), async (c) => {
    const q = auditQuery.safeParse(c.req.query());
    if (!q.success) throw new HttpError(422, 'invalid_input');
    const rows = await auditRows(c.env, q.data, 50_000);
    await audit(c, { action: 'audit.exported', meta: { rows: rows.length } });
    const lines = [
      ['time_utc', 'action', 'actor_email', 'actor_id', 'target', 'details'].map(csvCell).join(','),
      ...rows.map((r) => [new Date(r.created_at).toISOString(), r.action, r.actor_email, r.actor_user_id, r.target, r.meta_json].map(csvCell).join(',')),
    ];
    return new Response(`${lines.join('\r\n')}\r\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

/**
 * Tables in the export, and columns left out. Secrets, credentials and
 * short-lived auth state are never exported: sessions, sign-in links,
 * passkeys, WebAuthn challenges, device cookies, calendar feed tokens,
 * notifications and job bookkeeping. The EIN stays encrypted at rest and is
 * exported as its last four digits only.
 */
export const EXPORT_TABLES: Record<string, string[]> = {
  orgs: [],
  users: [],
  clients: ['ein_enc'],
  client_members: [],
  staff_assignments: [],
  opportunities: [],
  schedules: [],
  reports: [],
  report_items: [],
  files: ['multipart_upload_id'],
  deliverables: [],
  deliverable_templates: [],
  deliverable_versions: [],
  approvals: [],
  doc_requests: [],
  doc_request_items: [],
  forms: [],
  form_responses: [],
  alerts: [],
  alert_matches: [],
  emails: [],
  messages: [],
  message_reads: [],
  updates: [],
  events: [],
  audit_log: [],
};

/** Settings keys in the export; anything ending in `Enc` is stripped too. */
const EXPORT_SETTINGS = ['brand', 'brand_assets', 'email', 'domain', 'security', 'org', 'files', 'setup'];

async function tableJson(env: AppEnv, table: string, omit: string[]): Promise<string> {
  const out: string[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).bind(PAGE, offset).all<Record<string, unknown>>();
    for (const r of rows.results) out.push(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !omit.includes(k)))));
    if (rows.results.length < PAGE) break;
  }
  return `[\n${out.join(',\n')}\n]\n`;
}

function stripEnc(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripEnc);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !k.endsWith('Enc')).map(([k, x]) => [k, stripEnc(x)]));
  return v;
}

async function writeExport(env: AppEnv, zip: ZipWriter): Promise<void> {
  const now = Date.now();
  await zip.add(
    'README.txt',
    [
      'Data export',
      `Created ${new Date(now).toISOString()}`,
      '',
      'data/*.json   one file per table, one object per row (timestamps are UTC epoch milliseconds)',
      'settings.json portal settings, without secrets',
      'files/        client documents: files/<client id>/<file id>-<filename>',
      'brand/        uploaded brand files',
      '',
      'Not included: sign-in sessions, sign-in links, passkeys, calendar feed tokens, API keys and',
      'other secrets. EINs are included as the last four digits only.',
    ].join('\r\n'),
    now,
  );
  for (const [table, omit] of Object.entries(EXPORT_TABLES)) await zip.add(`data/${table}.json`, await tableJson(env, table, omit), now);

  const settings = await env.DB.prepare(`SELECT key, value_json FROM settings WHERE key IN (${EXPORT_SETTINGS.map(() => '?').join(',')})`)
    .bind(...EXPORT_SETTINGS)
    .all<{ key: string; value_json: string }>();
  await zip.add('settings.json', `${JSON.stringify(Object.fromEntries(settings.results.map((s) => [s.key, stripEnc(JSON.parse(s.value_json))])), null, 2)}\n`, now);

  const files = await env.DB.prepare("SELECT id, client_id, r2_key, filename, created_at FROM files WHERE upload_status = 'complete' AND deleted_at IS NULL ORDER BY client_id, created_at").all<{
    id: string;
    client_id: string;
    r2_key: string;
    filename: string;
    created_at: number;
  }>();
  for (const f of files.results) {
    const obj = await env.FILES.get(f.r2_key);
    if (obj) await zip.add(zipPath('files', f.client_id, `${f.id}-${f.filename}`), obj.body, f.created_at);
  }
  const assets = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'brand_assets'").first<{ value_json: string }>();
  if (assets) {
    for (const [slot, a] of Object.entries(JSON.parse(assets.value_json) as Record<string, { key: string; mime: string }>)) {
      const obj = await env.FILES.get(a.key);
      const ext = a.mime.split('/')[1]?.replace('svg+xml', 'svg').replace(/[^a-z0-9]/g, '') ?? 'bin';
      if (obj) await zip.add(zipPath('brand', `${slot}.${ext}`), obj.body, now);
    }
  }
}

export const dataApi = new Hono<AppBindings>().use('*', requireOwner).get('/export', requireStepUp(), async (c) => {
  await audit(c, { action: 'data.exported' });
  const zip = new ZipWriter();
  // Not waitUntil: the writer waits on the reader (backpressure), and the
  // response body keeps the request alive while the browser downloads it.
  void writeExport(c.env, zip)
    .then(() => zip.close())
    .catch(async (err: unknown) => {
      console.error('[export] failed', err);
      await zip.abort(err).catch(() => undefined);
    });
  return new Response(zip.readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="portal-export-${new Date().toISOString().slice(0, 10)}.zip"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

/**
 * Hard delete (spec §5.9): the client, everything under it (cascading
 * deletes), its files in R2, and the accounts of client users who belong to
 * no other client (anonymised and disabled; rows elsewhere may still point
 * at them). The audit log keeps a record of the deletion.
 */
export async function deleteClient(env: AppEnv, clientId: string): Promise<{ files: number; users: number }> {
  let files = 0;
  let cursor: string | undefined;
  do {
    const list = await env.FILES.list({ prefix: `clients/${clientId}/`, cursor, limit: 1000 });
    if (list.objects.length) await env.FILES.delete(list.objects.map((o) => o.key));
    files += list.objects.length;
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  const members = await env.DB.prepare(
    `SELECT u.id FROM client_members m JOIN users u ON u.id = m.user_id
      WHERE m.client_id = ? AND u.kind = 'client' AND NOT EXISTS (SELECT 1 FROM client_members o WHERE o.user_id = u.id AND o.client_id != ?)`,
  )
    .bind(clientId, clientId)
    .all<{ id: string }>();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(clientId),
    // Links and invites that would add someone to the deleted client.
    env.DB.prepare('DELETE FROM magic_links WHERE client_id = ?').bind(clientId),
    ...members.results.flatMap((u) => [
      env.DB.prepare("UPDATE users SET email = ?, name = NULL, notif_prefs_json = NULL, disabled_at = ? WHERE id = ? AND kind = 'client'").bind(`deleted-${u.id.toLowerCase()}@invalid`, now, u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
      env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(u.id),
      env.DB.prepare('DELETE FROM user_devices WHERE user_id = ?').bind(u.id),
      env.DB.prepare('DELETE FROM calendar_feeds WHERE user_id = ?').bind(u.id),
      // Their sign-in mails aren't tied to the client, but still carry the address.
      env.DB.prepare('DELETE FROM emails WHERE to_user_id = ?').bind(u.id),
      env.DB.prepare('DELETE FROM notifications WHERE user_id = ?').bind(u.id),
    ]),
  ]);
  return { files, users: members.results.length };
}
