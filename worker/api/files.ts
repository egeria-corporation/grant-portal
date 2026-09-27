/**
 * Client vault and uploads (spec §5.6, §6.3). Mounted under
 * `/api/clients/:clientId`, behind requireClientAccess. Every query is also
 * scoped by `client_id = :clientId`, so an ID from another client is a 404.
 * Client users see only files shared with them; they may delete their own
 * uploads within 24 hours (spec §7.3).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { accessOf, authOf, requireClientAccess, type ClientAccess } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { eventStmts } from '../lib/events';
import { HttpError, parseJson } from '../lib/http';
import { acceptedExtensions } from '../files/policy';
import {
  abortUpload,
  beginUpload,
  completeMultipart,
  filePolicy,
  type FileRow,
  pendingUpload,
  putPart,
  putSingle,
  softDelete,
  uploadedParts,
} from '../files/store';

/** Folders every vault starts with (spec §5.6). Staff can use any other name too. */
export const DEFAULT_FOLDERS = ['Financials', 'Governance', 'Programs', 'Submitted Applications', 'Awards'];

const CLIENT_DELETE_WINDOW_MS = 24 * 3600_000;

const tagsField = z.array(z.string().trim().min(1).max(40)).max(12);
const folderField = z.string().trim().min(1).max(60).nullable();

export interface FileSummary {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  folder: string | null;
  tags: string[];
  expiresAt: number | null;
  scanStatus: FileRow['scan_status'];
  shared: boolean;
  uploadedBy: { id: string | null; name: string | null; kind: string | null };
  createdAt: number;
}

type Joined = FileRow & { uploader_name: string | null; uploader_email: string | null; uploader_kind: string | null };

export function toSummary(r: Joined): FileSummary {
  return {
    id: r.id,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    sha256: r.sha256,
    folder: r.folder,
    tags: r.tags_json ? (JSON.parse(r.tags_json) as string[]) : [],
    expiresAt: r.expires_at,
    scanStatus: r.scan_status,
    shared: Boolean(r.shared_with_client),
    uploadedBy: { id: r.uploaded_by, name: r.uploader_name ?? r.uploader_email, kind: r.uploader_kind },
    createdAt: r.completed_at ?? r.created_at,
  };
}

export const FILE_SELECT = `SELECT f.*, u.name AS uploader_name, u.email AS uploader_email, u.kind AS uploader_kind
  FROM files f LEFT JOIN users u ON u.id = f.uploaded_by`;

/** A completed, undeleted file of this client that the caller may see, or null. */
export async function visibleFile(env: AppEnv, clientId: string, fileId: string, access: ClientAccess): Promise<Joined | null> {
  return env.DB.prepare(
    `${FILE_SELECT} WHERE f.id = ? AND f.client_id = ? AND f.upload_status = 'complete' AND f.deleted_at IS NULL
       AND (? OR f.shared_with_client = 1)`,
  )
    .bind(fileId, clientId, access === 'staff' ? 1 : 0)
    .first<Joined>();
}

export async function visibleFiles(env: AppEnv, clientId: string, ids: string[], access: ClientAccess): Promise<Map<string, FileSummary>> {
  const out = new Map<string, FileSummary>();
  const unique = [...new Set(ids)].slice(0, 100);
  if (!unique.length) return out;
  const rows = await env.DB.prepare(
    `${FILE_SELECT} WHERE f.client_id = ? AND f.id IN (${unique.map(() => '?').join(',')})
       AND f.upload_status = 'complete' AND f.deleted_at IS NULL AND (? OR f.shared_with_client = 1)`,
  )
    .bind(clientId, ...unique, access === 'staff' ? 1 : 0)
    .all<Joined>();
  for (const r of rows.results) out.set(r.id, toSummary(r));
  return out;
}

const anyMember = requireClientAccess();
const staffOnly = requireClientAccess({ clientRoles: 'none' });

export const vault = new Hono<AppBindings>()
  .get('/', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const q = c.req.query('q')?.trim().slice(0, 80) ?? '';
    const folder = c.req.query('folder')?.trim().slice(0, 60) ?? '';
    const like = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    const rows = await c.env.DB.prepare(
      `${FILE_SELECT} WHERE f.client_id = ? AND f.upload_status = 'complete' AND f.deleted_at IS NULL
         AND (? OR f.shared_with_client = 1)
         AND (? = '' OR f.filename LIKE ? ESCAPE '\\' OR f.tags_json LIKE ? ESCAPE '\\' OR f.folder LIKE ? ESCAPE '\\')
         AND (? = '' OR f.folder = ?)
       ORDER BY COALESCE(f.completed_at, f.created_at) DESC LIMIT 500`,
    )
      .bind(clientId, access === 'staff' ? 1 : 0, q, like, like, like, folder, folder)
      .all<Joined>();
    const folders = await c.env.DB.prepare(
      `SELECT DISTINCT folder FROM files WHERE client_id = ? AND folder IS NOT NULL AND deleted_at IS NULL AND upload_status = 'complete'
         AND (? OR shared_with_client = 1)`,
    )
      .bind(clientId, access === 'staff' ? 1 : 0)
      .all<{ folder: string }>();
    const policy = await filePolicy(c.env);
    return c.json({
      files: rows.results.map(toSummary),
      folders: [...new Set([...DEFAULT_FOLDERS, ...folders.results.map((f) => f.folder)])],
      policy: { maxBytes: policy.maxBytes, extensions: acceptedExtensions(policy.kinds) },
    });
  })

  .patch('/:fileId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(
      c,
      z.object({
        filename: z.string().trim().min(1).max(180).optional(),
        folder: folderField.optional(),
        tags: tagsField.optional(),
        expiresAt: z.number().int().positive().nullable().optional(),
        shared: z.boolean().optional(),
      }),
    );
    const row = await visibleFile(c.env, clientId, c.req.param('fileId'), 'staff');
    if (!row) throw new HttpError(404, 'not_found');
    // Renames keep the extension, so the stored type and the name never disagree.
    const filename = body.filename ? keepExtension(body.filename, row.filename) : row.filename;
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE files SET filename = ?, folder = ?, tags_json = ?, expires_at = ?, shared_with_client = ? WHERE id = ? AND client_id = ?').bind(
        filename,
        body.folder === undefined ? row.folder : body.folder,
        body.tags === undefined ? row.tags_json : body.tags.length ? JSON.stringify(body.tags) : null,
        body.expiresAt === undefined ? row.expires_at : body.expiresAt,
        body.shared === undefined ? row.shared_with_client : body.shared ? 1 : 0,
        row.id,
        clientId,
      ),
      ...eventStmts(c.env, { clientId, actor: authOf(c).user.id, type: 'file.updated', payload: { fileId: row.id } }),
    ]);
    const updated = await visibleFile(c.env, clientId, row.id, 'staff');
    return c.json({ file: updated ? toSummary(updated) : null });
  })

  .delete('/:fileId', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const { user } = authOf(c);
    const row = await visibleFile(c.env, clientId, c.req.param('fileId'), access);
    if (!row) throw new HttpError(404, 'not_found');
    if (access !== 'staff') {
      const own = row.uploaded_by === user.id;
      const recent = Date.now() - (row.completed_at ?? row.created_at) < CLIENT_DELETE_WINDOW_MS;
      if (!own || !recent) throw new HttpError(403, 'delete_not_allowed');
    }
    const inUse = await c.env.DB.prepare('SELECT 1 AS ok FROM deliverable_versions WHERE file_id = ? LIMIT 1').bind(row.id).first();
    if (inUse) throw new HttpError(409, 'file_in_use');

    await softDelete(c.env, row, user.id);
    // A deleted upload no longer satisfies a document request.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE doc_requests SET status = 'open' WHERE status = 'complete' AND client_id = ?
           AND id IN (SELECT doc_request_id FROM doc_request_items WHERE file_id = ?)`,
      ).bind(clientId, row.id),
      c.env.DB.prepare('UPDATE doc_request_items SET file_id = NULL, fulfilled_at = NULL WHERE file_id = ?').bind(row.id),
      ...eventStmts(c.env, { clientId, actor: user.id, type: 'file.deleted', payload: { fileId: row.id, filename: row.filename } }),
    ]);
    return c.json({ ok: true });
  });

function keepExtension(next: string, current: string): string {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(current)?.[0] ?? '';
  const base = next.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[\\/]/g, '').trim();
  return `${base || 'file'}${ext}`;
}

export const uploads = new Hono<AppBindings>()
  .use('*', anyMember)
  .post('/', async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const body = await parseJson(
      c,
      z.object({
        filename: z.string().min(1).max(400),
        size: z.number().int().positive(),
        folder: folderField.optional(),
        tags: tagsField.optional(),
        shared: z.boolean().optional(),
        expiresAt: z.number().int().positive().nullable().optional(),
      }),
    );
    const out = await beginUpload(c.env, {
      clientId,
      userId: authOf(c).user.id,
      filename: body.filename,
      size: body.size,
      folder: body.folder ?? null,
      tags: access === 'staff' ? (body.tags ?? []) : [],
      // Anything a client uploads is visible to them; staff may keep a file internal.
      shared: access === 'staff' ? (body.shared ?? true) : true,
      expiresAt: access === 'staff' ? (body.expiresAt ?? null) : null,
    });
    return c.json(out, 201);
  })

  .get('/:fileId', async (c) => {
    const row = await pendingUpload(c.env, c.req.param('clientId') as string, c.req.param('fileId'), authOf(c).user.id);
    const parts = await uploadedParts(c.env, row.id);
    return c.json({ id: row.id, size: row.size, multipart: Boolean(row.multipart_upload_id), parts: parts.map((p) => p.partNumber) });
  })

  .put('/:fileId', async (c) => {
    const clientId = c.req.param('clientId') as string;
    const row = await pendingUpload(c.env, clientId, c.req.param('fileId'), authOf(c).user.id);
    const done = await putSingle(c.env, row, c.req.raw);
    return c.json({ file: await announce(c.env, clientId, done, authOf(c).user.id, accessOf(c)) });
  })

  .put('/:fileId/parts/:n', async (c) => {
    const row = await pendingUpload(c.env, c.req.param('clientId') as string, c.req.param('fileId'), authOf(c).user.id);
    return c.json(await putPart(c.env, row, Number(c.req.param('n')), c.req.raw));
  })

  .post('/:fileId/complete', async (c) => {
    const clientId = c.req.param('clientId') as string;
    const row = await pendingUpload(c.env, clientId, c.req.param('fileId'), authOf(c).user.id);
    const done = await completeMultipart(c.env, row);
    return c.json({ file: await announce(c.env, clientId, done, authOf(c).user.id, accessOf(c)) });
  })

  .delete('/:fileId', async (c) => {
    const row = await pendingUpload(c.env, c.req.param('clientId') as string, c.req.param('fileId'), authOf(c).user.id);
    await abortUpload(c.env, row);
    return c.json({ ok: true });
  });

async function announce(env: AppEnv, clientId: string, row: FileRow, actor: string, access: ClientAccess): Promise<FileSummary | null> {
  await env.DB.batch(eventStmts(env, { clientId, actor, type: 'file.uploaded', payload: { fileId: row.id, filename: row.filename } }));
  const joined = await visibleFile(env, clientId, row.id, access);
  return joined ? toSummary(joined) : null;
}
