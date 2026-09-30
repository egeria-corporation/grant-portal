/**
 * Vault uploads and downloads (spec §6.3, §7.4): type allowlist checked by
 * bytes, size limits, resumable multipart, server-side SHA-256, strict
 * download headers, quarantine while scanning, and client delete rules.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runJob } from '../../worker/jobs';
import { PART_SIZE } from '../../worker/files/policy';
import { addMember, agentFor, assign, claimAsOwner, createClient, createUser, resetDb, testEnv, type Agent } from './helpers';

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadFile(agent: Agent, clientId: string, filename: string, data: Uint8Array, extra: Record<string, unknown> = {}) {
  const bytes = data as Uint8Array<ArrayBuffer>;
  const start = await agent.post(`/api/clients/${clientId}/uploads`, { filename, size: bytes.byteLength, ...extra });
  const begun = (await start.json()) as { id: string; multipart: boolean; partSize: number; parts: number; error?: string };
  if (start.status !== 201) return { status: start.status, error: begun.error, id: null as string | null };
  if (!begun.multipart) {
    const put = await agent.fetch(`/api/clients/${clientId}/uploads/${begun.id}`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
    const body = (await put.json()) as { error?: string };
    return { status: put.status, error: body.error, id: begun.id };
  }
  for (let n = 1; n <= begun.parts; n++) {
    const part = bytes.subarray((n - 1) * begun.partSize, n * begun.partSize);
    const r = await agent.fetch(`/api/clients/${clientId}/uploads/${begun.id}/parts/${n}`, { method: 'PUT', body: part });
    if (r.status !== 200) return { status: r.status, error: ((await r.json()) as { error?: string }).error, id: begun.id };
  }
  const done = await agent.post(`/api/clients/${clientId}/uploads/${begun.id}/complete`);
  return { status: done.status, error: ((await done.json()) as { error?: string }).error, id: begun.id };
}

describe('vault uploads', () => {
  let clientId: string;
  let owner: Agent;
  let admin: Agent;
  let adminId: string;

  beforeEach(async () => {
    await resetDb();
    const o = await claimAsOwner();
    clientId = await createClient('Acme');
    const a = await createUser('client_admin');
    await addMember(clientId, a.id, 'admin');
    adminId = a.id;
    owner = await agentFor(o.id);
    admin = await agentFor(a.id);
  });

  it('stores a small file with its SHA-256 and a random key, and serves it back as an attachment', async () => {
    const up = await uploadFile(admin, clientId, 'Form 990 (2025).pdf', PDF);
    expect(up.status).toBe(200);
    const row = await testEnv.DB.prepare('SELECT * FROM files WHERE id = ?').bind(up.id).first<Record<string, unknown>>();
    expect(row?.upload_status).toBe('complete');
    expect(row?.mime).toBe('application/pdf');
    expect(row?.sha256).toBe(await sha256(PDF));
    expect(String(row?.r2_key)).toMatch(new RegExp(`^clients/${clientId}/[0-9a-f-]{36}$`));
    expect(String(row?.r2_key)).not.toContain('990');

    const res = await owner.fetch(`/f/${up.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="Form 990 \(2025\)\.pdf"; filename\*=UTF-8''Form%20990%20%282025%29\.pdf$/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);

    const inline = await owner.fetch(`/f/${up.id}?inline=1`);
    expect(inline.headers.get('Content-Disposition')).toMatch(/^inline;/);
    expect(inline.headers.get('Content-Security-Policy')).toContain("default-src 'none'");

    const audit = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'file.downloaded' AND target = ?").bind(up.id).first<{ n: number }>();
    expect(audit?.n).toBe(2);
    const event = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE client_id = ? AND type = 'file.uploaded'").bind(clientId).first<{ n: number }>();
    expect(event?.n).toBe(1);
  });

  it('refuses types outside the allowlist, content that does not match the extension, and markup', async () => {
    expect((await uploadFile(admin, clientId, 'page.html', new TextEncoder().encode('<html>'))).status).toBe(415);
    expect((await uploadFile(admin, clientId, 'logo.svg', new TextEncoder().encode('<svg/>'))).status).toBe(415);
    expect((await uploadFile(admin, clientId, 'run.exe', new TextEncoder().encode('MZ'))).status).toBe(415);
    const fake = await uploadFile(admin, clientId, 'fake.pdf', new TextEncoder().encode('<script>alert(1)</script>'));
    expect(fake.status).toBe(415);
    expect(fake.error).toBe('file_content_mismatch');
    const csvHtml = await uploadFile(admin, clientId, 'list.csv', new TextEncoder().encode('<!doctype html><script>x</script>'));
    expect(csvHtml.status).toBe(415);
    expect((await uploadFile(admin, clientId, 'list.csv', new TextEncoder().encode('name,amount\nA,1\n'))).status).toBe(200);
    // Nothing from the rejected uploads is stored.
    const stored = await testEnv.FILES.list({ prefix: `clients/${clientId}/` });
    expect(stored.objects).toHaveLength(1);
  });

  it('enforces the size limit and the declared size', async () => {
    const big = await admin.post(`/api/clients/${clientId}/uploads`, { filename: 'huge.pdf', size: 101 * 1024 * 1024 });
    expect(big.status).toBe(413);
    const start = (await (await admin.post(`/api/clients/${clientId}/uploads`, { filename: 'a.pdf', size: 10 })).json()) as { id: string };
    const put = await admin.fetch(`/api/clients/${clientId}/uploads/${start.id}`, { method: 'PUT', body: PDF });
    expect(put.status).toBe(422);
  });

  it('resumes a multipart upload and hashes it in the finalize job', async () => {
    const bytes = new Uint8Array(PART_SIZE + 1234);
    bytes.set(PDF, 0);
    for (let i = PDF.length; i < bytes.length; i++) bytes[i] = i % 251;
    const start = await admin.post(`/api/clients/${clientId}/uploads`, { filename: 'audit.pdf', size: bytes.byteLength });
    const begun = (await start.json()) as { id: string; multipart: boolean; parts: number; partSize: number };
    expect(begun.multipart).toBe(true);
    expect(begun.parts).toBe(2);

    // Part 2 first, then "reconnect" and ask what's there.
    expect((await admin.fetch(`/api/clients/${clientId}/uploads/${begun.id}/parts/2`, { method: 'PUT', body: bytes.subarray(PART_SIZE) })).status).toBe(200);
    const early = await admin.post(`/api/clients/${clientId}/uploads/${begun.id}/complete`);
    expect(early.status).toBe(409);
    const status = (await (await admin.fetch(`/api/clients/${clientId}/uploads/${begun.id}`)).json()) as { parts: number[] };
    expect(status.parts).toEqual([2]);
    // A wrong-sized part is refused.
    expect((await admin.fetch(`/api/clients/${clientId}/uploads/${begun.id}/parts/1`, { method: 'PUT', body: bytes.subarray(0, 100) })).status).toBe(422);
    expect((await admin.fetch(`/api/clients/${clientId}/uploads/${begun.id}/parts/1`, { method: 'PUT', body: bytes.subarray(0, PART_SIZE) })).status).toBe(200);
    expect((await admin.post(`/api/clients/${clientId}/uploads/${begun.id}/complete`)).status).toBe(200);

    await runJob({ kind: 'file.finalize', key: 'k', fileId: begun.id }, testEnv);
    const row = await testEnv.DB.prepare('SELECT sha256, size, upload_status FROM files WHERE id = ?').bind(begun.id).first<{ sha256: string; size: number; upload_status: string }>();
    expect(row?.upload_status).toBe('complete');
    expect(row?.sha256).toBe(await sha256(bytes));
    const parts = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM file_parts WHERE file_id = ?').bind(begun.id).first<{ n: number }>();
    expect(parts?.n).toBe(0);
  });

  it('checks the first part against the extension', async () => {
    const bytes = new Uint8Array(PART_SIZE + 10);
    const begun = (await (await admin.post(`/api/clients/${clientId}/uploads`, { filename: 'x.pdf', size: bytes.byteLength })).json()) as { id: string };
    const r = await admin.fetch(`/api/clients/${clientId}/uploads/${begun.id}/parts/1`, { method: 'PUT', body: bytes.subarray(0, PART_SIZE) });
    expect(r.status).toBe(415);
  });

  it('only the uploader can continue or cancel an upload', async () => {
    const begun = (await (await admin.post(`/api/clients/${clientId}/uploads`, { filename: 'x.pdf', size: PDF.byteLength })).json()) as { id: string };
    expect((await owner.fetch(`/api/clients/${clientId}/uploads/${begun.id}`, { method: 'PUT', body: PDF })).status).toBe(404);
    expect((await owner.fetch(`/api/clients/${clientId}/uploads/${begun.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await admin.fetch(`/api/clients/${clientId}/uploads/${begun.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('clients may delete their own uploads for 24 hours; staff any time', async () => {
    const mine = await uploadFile(admin, clientId, 'mine.pdf', PDF);
    const theirs = await uploadFile(owner, clientId, 'theirs.pdf', PDF);
    expect((await admin.fetch(`/api/clients/${clientId}/files/${theirs.id}`, { method: 'DELETE' })).status).toBe(403);
    await testEnv.DB.prepare('UPDATE files SET completed_at = ? WHERE id = ?').bind(Date.now() - 25 * 3600_000, mine.id).run();
    expect((await admin.fetch(`/api/clients/${clientId}/files/${mine.id}`, { method: 'DELETE' })).status).toBe(403);
    await testEnv.DB.prepare('UPDATE files SET completed_at = ? WHERE id = ?').bind(Date.now(), mine.id).run();
    expect((await admin.fetch(`/api/clients/${clientId}/files/${mine.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await owner.fetch(`/api/clients/${clientId}/files/${theirs.id}`, { method: 'DELETE' })).status).toBe(200);
    // Bytes are gone; the row stays for the record.
    const row = await testEnv.DB.prepare('SELECT r2_key, deleted_at FROM files WHERE id = ?').bind(mine.id).first<{ r2_key: string; deleted_at: number }>();
    expect(row?.deleted_at).toBeTruthy();
    expect(await testEnv.FILES.head(row?.r2_key ?? '')).toBeNull();
    expect((await owner.fetch(`/f/${mine.id}`)).status).toBe(404);
  });

  it('staff can keep a file internal; client users cannot see or fetch it', async () => {
    const internal = await uploadFile(owner, clientId, 'notes.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), { shared: false });
    expect(internal.status).toBe(200);
    const list = (await (await admin.fetch(`/api/clients/${clientId}/files`)).json()) as { files: unknown[] };
    expect(list.files).toHaveLength(0);
    expect((await admin.fetch(`/f/${internal.id}`)).status).toBe(404);
    // A client can't mark their own upload internal.
    const mine = await uploadFile(admin, clientId, 'a.pdf', PDF, { shared: false });
    const row = await testEnv.DB.prepare('SELECT shared_with_client FROM files WHERE id = ?').bind(mine.id).first<{ shared_with_client: number }>();
    expect(row?.shared_with_client).toBe(1);
  });

  it('quarantines files until a configured scanner says they are clean', async () => {
    const calls: string[] = [];
    const env = {
      ...testEnv,
      SCANNER: {
        fetch: async (_url: string, init: RequestInit) => {
          calls.push(new Headers(init.headers).get('X-File-Id') ?? '');
          await new Response(init.body).arrayBuffer();
          return Response.json({ status: calls.length === 1 ? 'clean' : 'infected' });
        },
      },
    } as unknown as typeof testEnv;
    const start = (await (await admin.post(`/api/clients/${clientId}/uploads`, { filename: 'a.pdf', size: PDF.byteLength }, { env })).json()) as { id: string };
    await admin.fetch(`/api/clients/${clientId}/uploads/${start.id}`, { method: 'PUT', body: PDF, env });
    const pending = await owner.fetch(`/f/${start.id}`, { env });
    expect(pending.status).toBe(409);
    expect(((await pending.json()) as { error: string }).error).toBe('scan_pending');
    await runJob({ kind: 'file.finalize', key: 'k', fileId: start.id }, env);
    expect((await owner.fetch(`/f/${start.id}`, { env })).status).toBe(200);

    const second = (await (await admin.post(`/api/clients/${clientId}/uploads`, { filename: 'b.pdf', size: PDF.byteLength }, { env })).json()) as { id: string };
    await admin.fetch(`/api/clients/${clientId}/uploads/${second.id}`, { method: 'PUT', body: PDF, env });
    await runJob({ kind: 'file.finalize', key: 'k', fileId: second.id }, env);
    expect((await owner.fetch(`/f/${second.id}`, { env })).status).toBe(409);
    expect(calls).toEqual([start.id, second.id]);
  });

  it('staff organise files: folders, tags, expiry, renames keep the extension', async () => {
    const up = await uploadFile(owner, clientId, 'audit.pdf', PDF);
    const r = await owner.fetch(`/api/clients/${clientId}/files/${up.id}`, {
      method: 'PATCH',
      json: { filename: 'Audit FY2025.exe', folder: 'Financials', tags: ['audit'], expiresAt: Date.now() + 86_400_000 },
    });
    const body = (await r.json()) as { file: { filename: string; folder: string; tags: string[] } };
    expect(body.file.filename).toBe('Audit FY2025.pdf');
    expect(body.file.folder).toBe('Financials');
    const search = (await (await admin.fetch(`/api/clients/${clientId}/files?q=audit`)).json()) as { files: { id: string }[]; folders: string[] };
    expect(search.files.map((f) => f.id)).toEqual([up.id]);
    expect(search.folders).toContain('Governance');
    expect((await admin.fetch(`/api/clients/${clientId}/files/${up.id}`, { method: 'PATCH', json: { folder: 'x' } })).status).toBe(404);
  });

  it('renames are cleaned like uploads, so control and bidi-override characters cannot fake an extension', async () => {
    const up = await uploadFile(owner, clientId, 'report.pdf', PDF);
    const rename = async (filename: string) => {
      const r = await owner.fetch(`/api/clients/${clientId}/files/${up.id}`, { method: 'PATCH', json: { filename } });
      return ((await r.json()) as { file: { filename: string } }).file.filename;
    };
    const [BEL, RLO, LRI, PDI, RLM] = [0x07, 0x202e, 0x2066, 0x2069, 0x200f].map((c) => String.fromCharCode(c));
    // A right-to-left override made "contract<RLO>xcod" + ".pdf" show as "contractfdp.docx".
    expect(await rename(`contract${RLO}xcod`)).toBe('contractxcod.pdf');
    // A trailing control character hid ".exe" from the extension swap: "invoice.exe<BEL>.pdf".
    expect(await rename(`invoice.exe${BEL}`)).toBe('invoice.pdf');
    expect(await rename(`Q1${LRI} notes${PDI}`)).toBe('Q1 notes.pdf');
    expect(await rename(`${RLO}${RLM}`)).toBe('file.pdf');
    const row = await testEnv.DB.prepare('SELECT filename FROM files WHERE id = ?').bind(up.id).first<{ filename: string }>();
    expect(row?.filename).toBe('file.pdf');
  });

  it('a consultant only reaches files of assigned clients', async () => {
    const up = await uploadFile(admin, clientId, 'a.pdf', PDF);
    const cons = await createUser('consultant');
    const agent = await agentFor(cons.id);
    expect((await agent.fetch(`/f/${up.id}`)).status).toBe(404);
    await assign(clientId, cons.id);
    expect((await agent.fetch(`/f/${up.id}`)).status).toBe(200);
    void adminId;
  });
});
