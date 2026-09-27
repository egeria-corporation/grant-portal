/**
 * Client files in R2 (spec §6.3, §7.4). Keys are `clients/{clientId}/{uuid}`;
 * the filename lives in D1 only. Uploads go through the Worker: small files in
 * one request, larger ones as 8 MiB parts of an R2 multipart upload that can
 * resume after a dropped connection. The first bytes are checked against the
 * extension before anything is stored, and the SHA-256 is computed server-side.
 */
import { DEMO_MAX_UPLOAD, demoMode } from '../demo/mode';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/http';
import { newId } from '../lib/ids';
import { getSetting } from '../lib/settings';
import { toHex } from '../lib/crypto';
import { DEFAULT_KINDS, DEFAULT_MAX_BYTES, PART_SIZE, type FileKind, cleanFilename, matchesMagic, ruleFor } from './policy';
import { scanObject, scannerConfigured } from './scanner';

export interface FilePolicy {
  maxBytes: number;
  kinds: FileKind[];
}

export async function filePolicy(env: AppEnv): Promise<FilePolicy> {
  const s = await getSetting(env, 'files');
  const maxBytes = s?.maxBytes ?? DEFAULT_MAX_BYTES;
  return { maxBytes: demoMode(env) ? Math.min(maxBytes, DEMO_MAX_UPLOAD) : maxBytes, kinds: s?.kinds ?? DEFAULT_KINDS };
}

export interface FileRow {
  id: string;
  client_id: string;
  r2_key: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  folder: string | null;
  tags_json: string | null;
  expires_at: number | null;
  scan_status: 'none' | 'pending' | 'clean' | 'infected' | 'error';
  upload_status: 'pending' | 'complete' | 'aborted';
  shared_with_client: number;
  uploaded_by: string | null;
  multipart_upload_id: string | null;
  created_at: number;
  completed_at: number | null;
  deleted_at: number | null;
}

export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / PART_SIZE));
}

export function expectedPartSize(size: number, n: number): number {
  const parts = partCount(size);
  return n < parts ? PART_SIZE : size - PART_SIZE * (parts - 1);
}

/** Registers an upload: validates name, type and size, reserves a random key, and starts multipart for large files. */
export async function beginUpload(
  env: AppEnv,
  p: { clientId: string; userId: string; filename: string; size: number; folder: string | null; tags: string[]; shared: boolean; expiresAt: number | null },
): Promise<{ id: string; multipart: boolean; partSize: number; parts: number; filename: string }> {
  const policy = await filePolicy(env);
  const filename = cleanFilename(p.filename);
  const rule = ruleFor(filename);
  if (!filename || !rule || !policy.kinds.includes(rule.kind)) throw new HttpError(415, 'file_type_not_allowed');
  if (p.size <= 0) throw new HttpError(422, 'file_empty');
  if (p.size > policy.maxBytes) throw new HttpError(413, 'file_too_large', { maxBytes: policy.maxBytes });

  const id = newId('fil');
  const key = `clients/${p.clientId}/${crypto.randomUUID()}`;
  const multipart = p.size > PART_SIZE;
  const uploadId = multipart ? (await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: rule.mime } })).uploadId : null;

  await env.DB.prepare(
    `INSERT INTO files (id, client_id, r2_key, filename, mime, size, folder, tags_json, expires_at, scan_status, upload_status,
       shared_with_client, uploaded_by, multipart_upload_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 'pending', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      p.clientId,
      key,
      filename,
      rule.mime,
      p.size,
      p.folder,
      p.tags.length ? JSON.stringify(p.tags) : null,
      p.expiresAt,
      p.shared ? 1 : 0,
      p.userId,
      uploadId,
      Date.now(),
    )
    .run();
  return { id, multipart, partSize: PART_SIZE, parts: partCount(p.size), filename };
}

/** A pending upload owned by this user in this client, or 404. Nobody else can write to it. */
export async function pendingUpload(env: AppEnv, clientId: string, fileId: string, userId: string): Promise<FileRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM files WHERE id = ? AND client_id = ? AND uploaded_by = ? AND upload_status = 'pending' AND deleted_at IS NULL",
  )
    .bind(fileId, clientId, userId)
    .first<FileRow>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

/**
 * Reads a request body of exactly `expected` bytes. Stops reading as soon as it
 * goes over, so an oversized body never lands in memory.
 */
export async function readExactBody(req: Request, expected: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers.get('Content-Length');
  if (declared !== null && Number(declared) !== expected) throw new HttpError(422, 'size_mismatch');
  if (!req.body) throw new HttpError(422, 'size_mismatch');
  const out = new Uint8Array(expected);
  let offset = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > expected) {
      await reader.cancel();
      throw new HttpError(422, 'size_mismatch');
    }
    out.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== expected) throw new HttpError(422, 'size_mismatch');
  return out;
}

function checkMagic(row: FileRow, head: Uint8Array): void {
  const rule = ruleFor(row.filename);
  if (!rule || !matchesMagic(rule, head)) throw new HttpError(415, 'file_content_mismatch');
}

/** Single-request upload (files up to one part). Stores, hashes, and completes. */
export async function putSingle(env: AppEnv, row: FileRow, req: Request): Promise<FileRow> {
  if (row.multipart_upload_id) throw new HttpError(409, 'use_parts');
  const bytes = await readExactBody(req, row.size);
  checkMagic(row, bytes);
  const sha256 = toHex(await crypto.subtle.digest('SHA-256', bytes));
  await env.FILES.put(row.r2_key, bytes, { httpMetadata: { contentType: row.mime }, sha256 });
  return markComplete(env, row, sha256);
}

export async function putPart(env: AppEnv, row: FileRow, n: number, req: Request): Promise<{ partNumber: number }> {
  if (!row.multipart_upload_id) throw new HttpError(409, 'use_single');
  const parts = partCount(row.size);
  if (!Number.isInteger(n) || n < 1 || n > parts) throw new HttpError(422, 'invalid_part');
  const bytes = await readExactBody(req, expectedPartSize(row.size, n));
  if (n === 1) checkMagic(row, bytes);
  const upload = env.FILES.resumeMultipartUpload(row.r2_key, row.multipart_upload_id);
  const part = await upload.uploadPart(n, bytes);
  await env.DB.prepare(
    `INSERT INTO file_parts (file_id, part_number, etag, size, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (file_id, part_number) DO UPDATE SET etag = excluded.etag, size = excluded.size, created_at = excluded.created_at`,
  )
    .bind(row.id, n, part.etag, bytes.byteLength, Date.now())
    .run();
  return { partNumber: n };
}

export async function uploadedParts(env: AppEnv, fileId: string): Promise<{ partNumber: number; etag: string }[]> {
  const rows = await env.DB.prepare('SELECT part_number AS partNumber, etag FROM file_parts WHERE file_id = ? ORDER BY part_number')
    .bind(fileId)
    .all<{ partNumber: number; etag: string }>();
  return rows.results;
}

/** Finishes a multipart upload. The hash is computed afterwards by the finalize job. */
export async function completeMultipart(env: AppEnv, row: FileRow): Promise<FileRow> {
  if (!row.multipart_upload_id) throw new HttpError(409, 'use_single');
  const parts = await uploadedParts(env, row.id);
  const expected = partCount(row.size);
  if (parts.length !== expected || parts.some((p, i) => p.partNumber !== i + 1)) {
    throw new HttpError(409, 'parts_missing', { have: parts.map((p) => p.partNumber) });
  }
  const upload = env.FILES.resumeMultipartUpload(row.r2_key, row.multipart_upload_id);
  const obj = await upload.complete(parts);
  if (obj.size !== row.size) {
    await env.FILES.delete(row.r2_key);
    throw new HttpError(422, 'size_mismatch');
  }
  const done = await markComplete(env, row, null);
  await env.JOBS.send({ kind: 'file.finalize', key: `file.finalize:${row.id}`, fileId: row.id });
  return done;
}

async function markComplete(env: AppEnv, row: FileRow, sha256: string | null): Promise<FileRow> {
  const scan = scannerConfigured(env) ? 'pending' : 'none';
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE files SET upload_status = 'complete', sha256 = ?, scan_status = ?, completed_at = ?, multipart_upload_id = NULL
        WHERE id = ? AND upload_status = 'pending'`,
    ).bind(sha256, scan, now, row.id),
    env.DB.prepare('DELETE FROM file_parts WHERE file_id = ?').bind(row.id),
  ]);
  if (sha256 && scan === 'pending') {
    await env.JOBS.send({ kind: 'file.finalize', key: `file.finalize:${row.id}`, fileId: row.id });
  }
  return { ...row, upload_status: 'complete', sha256, scan_status: scan, completed_at: now, multipart_upload_id: null };
}

export async function abortUpload(env: AppEnv, row: FileRow): Promise<void> {
  if (row.multipart_upload_id) {
    await env.FILES.resumeMultipartUpload(row.r2_key, row.multipart_upload_id)
      .abort()
      .catch(() => undefined);
  }
  await env.DB.prepare('DELETE FROM files WHERE id = ? AND upload_status = ?').bind(row.id, 'pending').run();
}

/**
 * Queue job after a multipart upload (or when a scanner is bound): streams the
 * object once to compute its SHA-256, then runs the scanner hook. Idempotent.
 */
export async function finalizeFile(env: AppEnv, fileId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND upload_status = 'complete' AND deleted_at IS NULL")
    .bind(fileId)
    .first<FileRow>();
  if (!row) return;

  if (!row.sha256) {
    const obj = await env.FILES.get(row.r2_key);
    if (!obj) return;
    const digest = new crypto.DigestStream('SHA-256');
    await obj.body.pipeTo(digest);
    const sha256 = toHex(await digest.digest);
    await env.DB.prepare('UPDATE files SET sha256 = ? WHERE id = ?').bind(sha256, row.id).run();
  }

  if (row.scan_status === 'pending' && scannerConfigured(env)) {
    const obj = await env.FILES.get(row.r2_key);
    if (!obj) return;
    const result = await scanObject(env, row, obj.body);
    await env.DB.prepare("UPDATE files SET scan_status = ? WHERE id = ? AND scan_status = 'pending'").bind(result, row.id).run();
    if (result === 'error') throw new Error(`scan failed for ${row.id}`);
  }
}

/** Removes the stored bytes and marks the row deleted. The row stays for the timeline and audit trail. */
export async function softDelete(env: AppEnv, row: Pick<FileRow, 'id' | 'r2_key'>, actor: string): Promise<void> {
  await env.DB.prepare('UPDATE files SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(Date.now(), actor, row.id)
    .run();
  await env.FILES.delete(row.r2_key);
}

/** Uploads abandoned for a week: abort multipart and forget the reservation (daily cron). */
export async function purgeStaleUploads(env: AppEnv, now: number): Promise<number> {
  const stale = await env.DB.prepare("SELECT * FROM files WHERE upload_status = 'pending' AND created_at < ? LIMIT 200")
    .bind(now - 7 * 86_400_000)
    .all<FileRow>();
  for (const row of stale.results) await abortUpload(env, row);
  return stale.results.length;
}
