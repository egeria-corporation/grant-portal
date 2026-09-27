/**
 * `/f/:fileId` — the only way file bytes leave R2 (spec §7.4). The caller must
 * be able to reach the file's client, client users only see shared files, and
 * quarantined files (pending or failed scans) are never served. Every download
 * is written to the audit log.
 *
 * Files download as attachments by default. `?inline=1` shows PDFs and images
 * in the browser, with a strict Content-Type, nosniff, and a CSP that allows
 * nothing else to load or run.
 */
import { Hono } from 'hono';
import { clientAccessFor } from '../auth/guards';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { INLINE_MIMES } from './policy';
import { downloadable } from './scanner';
import type { FileRow } from './store';

const FILE_ID_RE = /^fil_[0-9A-HJKMNP-TV-Z]{26}$/;

/** RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const downloads = new Hono<AppBindings>().get('/:fileId', async (c) => {
  const auth = c.get('auth');
  if (!auth) return c.json({ error: 'unauthenticated' }, 401);
  const fileId = c.req.param('fileId');
  if (!FILE_ID_RE.test(fileId)) return c.json({ error: 'not_found' }, 404);

  const row = await c.env.DB.prepare("SELECT * FROM files WHERE id = ? AND upload_status = 'complete' AND deleted_at IS NULL")
    .bind(fileId)
    .first<FileRow>();
  const access = row ? await clientAccessFor(c.env, auth, row.client_id) : null;
  if (!row || !access || (access !== 'staff' && !row.shared_with_client)) return c.json({ error: 'not_found' }, 404);
  if (!downloadable(row.scan_status)) {
    return c.json({ error: row.scan_status === 'pending' ? 'scan_pending' : 'file_quarantined' }, 409);
  }

  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ error: 'not_found' }, 404);

  const inline = c.req.query('inline') === '1' && INLINE_MIMES.has(row.mime);
  await audit(c, { action: 'file.downloaded', target: row.id, meta: { clientId: row.client_id, inline } });

  const headers = new Headers({
    'Content-Type': row.mime,
    'Content-Length': String(obj.size),
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', row.filename),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    // Images get a full sandbox. Browsers refuse to render PDFs in a sandboxed
    // document, so PDFs get the same lockdown minus `sandbox` (DECISIONS D-048).
    'Content-Security-Policy':
      row.mime === 'application/pdf'
        ? "default-src 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'"
        : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
  });
  if (row.sha256) headers.set('Digest', `sha-256=${btoa(String.fromCharCode(...hexToBytes(row.sha256)))}`);
  return new Response(obj.body, { headers });
});

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}
