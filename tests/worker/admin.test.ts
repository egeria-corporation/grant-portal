/**
 * M6 Owner tools: Settings → Security (staff email domains, IP allowlist,
 * session lengths, link lifetime), Team, the audit log and its export, the
 * full data export, hard delete of a client, and retention.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createLink } from '../../worker/auth/magic';
import { memoryOutbox } from '../../worker/email/outbox';
import { purgeRetention } from '../../worker/jobs/retention';
import { crc32Update } from '../../worker/lib/zip';
import { csvCell } from '../../worker/api/data';
import { addMember, Agent, agentFor, assign, claimAsOwner, createClient, createUser, resetDb, testEnv } from './helpers';

const DAY = 86_400_000;

let owner: { id: string; email: string };
let ownerAgent: Agent;

beforeEach(async () => {
  await resetDb();
  await testEnv.DB.prepare("DELETE FROM settings WHERE key = 'security'").run();
  owner = await claimAsOwner();
  ownerAgent = await agentFor(owner.id, { stepUp: true });
});

const putSecurity = (body: unknown, agent = ownerAgent) => agent.fetch('/api/settings/security', { method: 'PUT', json: body });

describe('Settings → Security', () => {
  it('needs a step-up, validates, and merges partial updates', async () => {
    expect((await putSecurity({ staffIdleHours: 8 }, await agentFor(owner.id, { stepUp: false }))).status).toBe(403);
    expect((await putSecurity({ staffIpAllowlist: ['10.0.0.0/33'] })).status).toBe(422);
    expect((await putSecurity({ staffEmailDomains: ['not a domain'] })).status).toBe(422);
    expect((await putSecurity({ staffIdleHours: 24, staffMaxDays: 1 })).status).toBe(200);
    const r = await putSecurity({ linkMinutes: 10 });
    const { security } = (await r.json()) as { security: Record<string, unknown> };
    expect(security).toMatchObject({ staffIdleHours: 24, staffMaxDays: 1, linkMinutes: 10, requirePasskeysForStaff: false });
    expect((await putSecurity({ staffIdleHours: 12, staffMaxDays: 30, clientIdleDays: 40 })).status).toBe(422);
  });

  it('refuses a change that would lock the Owner out', async () => {
    const r = await putSecurity({ staffEmailDomains: ['elsewhere.org'] });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: 'would_lock_you_out' });
    ownerAgent.ip = '203.0.113.9';
    expect((await putSecurity({ staffIpAllowlist: ['198.51.100.0/24'] })).status).toBe(422);
    expect((await putSecurity({ staffIpAllowlist: ['198.51.100.0/24', '203.0.113.0/24'] })).status).toBe(200);
  });

  it('staff outside the allowed email domains get no sign-in email, and cannot be invited', async () => {
    expect((await putSecurity({ staffEmailDomains: ['example.org'] })).status).toBe(200);
    const outsider = await createUser('consultant', 'sam@freelance.dev');
    const client = await createUser('client_admin', 'dana@client.dev');
    memoryOutbox.length = 0;
    for (const email of [outsider.email, client.email]) {
      const r = await new Agent().post('/auth/magic/request', { email });
      expect(r.status).toBe(202); // same answer either way (no enumeration)
    }
    expect(memoryOutbox.map((m) => m.to)).toEqual([client.email]); // client users aren't restricted
    const inv = await ownerAgent.post('/api/team/invites', { email: 'new@freelance.dev', delivery: 'link' });
    expect(inv.status).toBe(422);
    expect(await inv.json()).toMatchObject({ error: 'domain_not_allowed' });
    // Subdomains of an allowed domain are fine.
    expect((await ownerAgent.post('/api/team/invites', { email: 'new@team.example.org', delivery: 'link' })).status).toBe(201);
  });

  it('staff requests from outside the IP allowlist are signed out; client users are not affected', async () => {
    ownerAgent.ip = '203.0.113.9';
    expect((await putSecurity({ staffIpAllowlist: ['203.0.113.0/24', '2001:db8::/32'] })).status).toBe(200);
    const cons = await createUser('consultant');
    const consAgent = await agentFor(cons.id);
    consAgent.ip = '198.51.100.7';
    expect((await consAgent.fetch('/api/me')).status).toBe(401);
    consAgent.ip = '2001:db8::42';
    expect((await consAgent.fetch('/api/me')).status).toBe(200);
    const client = await createUser('client_admin');
    const clientAgent = await agentFor(client.id);
    clientAgent.ip = '198.51.100.7';
    expect((await clientAgent.fetch('/api/me')).status).toBe(200);

    // Signing in from outside is refused, even with a valid link.
    const link = await createLink(testEnv, { email: cons.email, purpose: 'signin', ttlMs: 60_000, withCode: false });
    const r = await new Agent({ ip: '198.51.100.7' }).post('/auth/link/consume', { token: link.token });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'staff_signin_restricted' });
  });

  it('applies session lengths and link lifetime to new sign-ins', async () => {
    expect((await putSecurity({ staffIdleHours: 2, staffMaxDays: 3, linkMinutes: 5 })).status).toBe(200);
    const cons = await createUser('consultant');
    memoryOutbox.length = 0;
    await new Agent().post('/auth/magic/request', { email: cons.email });
    expect(memoryOutbox[0]?.text).toContain('5 minutes');
    const link = await testEnv.DB.prepare("SELECT expires_at, created_at FROM magic_links WHERE email = ? AND purpose = 'signin'").bind(cons.email).first<{ expires_at: number; created_at: number }>();
    expect((link?.expires_at ?? 0) - (link?.created_at ?? 0)).toBe(5 * 60_000);

    const fresh = await createLink(testEnv, { email: cons.email, purpose: 'signin', ttlMs: 60_000, withCode: false });
    expect((await new Agent().post('/auth/link/consume', { token: fresh.token })).status).toBe(200);
    const s = await testEnv.DB.prepare('SELECT created_at, idle_expires_at, abs_expires_at FROM sessions WHERE user_id = ?').bind(cons.id).first<{ created_at: number; idle_expires_at: number; abs_expires_at: number }>();
    expect((s?.idle_expires_at ?? 0) - (s?.created_at ?? 0)).toBe(2 * 3600_000);
    expect((s?.abs_expires_at ?? 0) - (s?.created_at ?? 0)).toBe(3 * DAY);
  });
});

describe('Team', () => {
  it('changes roles with a step-up, never leaves the portal without an Owner, and re-signs in the changed person', async () => {
    const cons = await createUser('consultant');
    const consAgent = await agentFor(cons.id);
    expect((await (await agentFor(owner.id, { stepUp: false })).fetch(`/api/team/${cons.id}`, { method: 'PATCH', json: { role: 'owner' } })).status).toBe(403);
    expect((await ownerAgent.fetch(`/api/team/${owner.id}`, { method: 'PATCH', json: { role: 'consultant' } })).status).toBe(409);
    expect((await ownerAgent.fetch(`/api/team/${cons.id}`, { method: 'PATCH', json: { allClients: true } })).status).toBe(200);
    expect((await consAgent.fetch('/api/me')).status).toBe(200); // access flag only: session kept
    expect((await ownerAgent.fetch(`/api/team/${cons.id}`, { method: 'PATCH', json: { role: 'owner' } })).status).toBe(200);
    expect((await consAgent.fetch('/api/me')).status).toBe(401);
    // Two owners now, so the first can step down.
    expect((await ownerAgent.fetch(`/api/team/${owner.id}`, { method: 'PATCH', json: { role: 'consultant' } })).status).toBe(200);
    expect((await ownerAgent.fetch('/api/me')).status).toBe(200); // their own current session survives
  });

  it('removes a member: disabled, signed out, unassigned; history stays', async () => {
    const cons = await createUser('consultant');
    const clientId = await createClient();
    await assign(clientId, cons.id);
    const consAgent = await agentFor(cons.id);
    expect((await ownerAgent.fetch(`/api/team/${owner.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await ownerAgent.fetch(`/api/team/${cons.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await consAgent.fetch('/api/me')).status).toBe(401);
    const row = await testEnv.DB.prepare('SELECT disabled_at, (SELECT COUNT(*) FROM staff_assignments WHERE user_id = users.id) AS n FROM users WHERE id = ?').bind(cons.id).first<{ disabled_at: number | null; n: number }>();
    expect(row?.disabled_at).toBeTruthy();
    expect(row?.n).toBe(0);
    const list = (await (await ownerAgent.fetch('/api/team')).json()) as { members: { id: string }[] };
    expect(list.members.map((m) => m.id)).toEqual([owner.id]);
  });

  it('resets someone’s passkeys and signs them out', async () => {
    const cons = await createUser('consultant');
    await testEnv.DB.prepare("INSERT INTO passkeys (id, user_id, credential_id, public_key, sign_count, created_at) VALUES ('pk1', ?, 'cred1', 'key', 0, ?)").bind(cons.id, Date.now()).run();
    const consAgent = await agentFor(cons.id);
    const r = await ownerAgent.fetch(`/api/team/${cons.id}/passkeys`, { method: 'DELETE' });
    expect(await r.json()).toEqual({ removed: 1 });
    expect((await consAgent.fetch('/api/me')).status).toBe(401);
  });
});

describe('Owner setup actions need a step-up', () => {
  it('inviting a consultant, the Cloudflare token and the domain refuse a stale session, and work after a fresh sign-in', async () => {
    const stale = await agentFor(owner.id, { stepUp: false });
    const actions: [string, string, unknown][] = [
      ['POST', '/api/team/invites', { email: 'new@example.org', delivery: 'link' }],
      ['PUT', '/api/settings/cloudflare-token', { token: 'x'.repeat(40) }],
      ['DELETE', '/api/settings/cloudflare-token', undefined],
      ['PUT', '/api/settings/domain', { hostname: 'clients.example.org' }],
    ];
    for (const [method, path, json] of actions) {
      const r = await stale.fetch(path, { method, json });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await r.json()).toEqual({ error: 'step_up_required' });
    }
    const none = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE purpose = 'invite'").first<{ n: number }>();
    expect(none?.n).toBe(0);

    // A sign-in link counts as the step-up (so the wizard, right after claiming, isn't interrupted).
    const { token } = await createLink(testEnv, { email: owner.email, purpose: 'signin', ttlMs: 60_000, withCode: false });
    const fresh = new Agent();
    expect((await fresh.post('/auth/link/consume', { token })).status).toBe(200);
    expect((await fresh.post('/api/team/invites', { email: 'new@example.org', delivery: 'link' })).status).toBe(201);
    // No token saved, so the domain is recorded for manual setup (no call to Cloudflare).
    const domain = await fresh.fetch('/api/settings/domain', { method: 'PUT', json: { hostname: 'clients.example.org' } });
    expect(await domain.json()).toMatchObject({ domain: { hostname: 'clients.example.org', status: 'manual' } });
    expect((await fresh.fetch('/api/settings/cloudflare-token', { method: 'DELETE' })).status).toBe(200);
  });
});

describe('audit log', () => {
  it('lists and filters by action family; CSV export needs a step-up and defuses formulas', async () => {
    // The audit log is append-only, so earlier tests' entries are still there.
    const start = Date.now();
    const cons = await createUser('consultant');
    await ownerAgent.fetch(`/api/team/${cons.id}`, { method: 'PATCH', json: { allClients: true } });
    await putSecurity({ linkMinutes: 20 });
    const all = (await (await ownerAgent.fetch(`/api/audit?after=${start}`)).json()) as { entries: { action: string; actor: { email: string } | null }[] };
    expect(all.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['team.role_changed', 'settings.updated']));
    const team = (await (await ownerAgent.fetch(`/api/audit?action=team&after=${start}`)).json()) as { entries: { action: string; actor: { email: string } }[] };
    expect(team.entries.map((e) => e.action)).toEqual(['team.role_changed']);
    expect(team.entries[0]?.actor.email).toBe(owner.email);
    expect((await ownerAgent.fetch('/api/audit?action=DROP%20TABLE')).status).toBe(422);

    expect((await (await agentFor(owner.id, { stepUp: false })).fetch('/api/audit/export')).status).toBe(403);
    const csv = await ownerAgent.fetch('/api/audit/export');
    expect(csv.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    const text = await csv.text();
    expect(text.split('\r\n')[0]).toBe('"time_utc","action","actor_email","actor_id","target","details"');
    expect(text).toContain('"team.role_changed"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('""');
    // The export itself is audited.
    const after = (await (await ownerAgent.fetch(`/api/audit?action=audit&after=${start}`)).json()) as { entries: unknown[] };
    expect(after.entries).toHaveLength(1);
  });
});

/** Reads a ZIP's central directory and checks each stored entry's CRC. */
function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const offset = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    expect(v.getUint32(offset, true)).toBe(0x04034b50);
    const start = offset + 30 + v.getUint16(offset + 26, true);
    const data = buf.subarray(start, start + size);
    expect(crc32Update(0, data), name).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

describe('data export', () => {
  it('is a valid ZIP of the tables and files, without secrets', async () => {
    const clientId = await createClient('Acme');
    await testEnv.DB.batch([
      testEnv.DB.prepare("UPDATE clients SET ein_enc = 'SECRET-CIPHERTEXT', ein_last4 = '6789' WHERE id = ?").bind(clientId),
      testEnv.DB.prepare(
        "INSERT INTO files (id, client_id, r2_key, filename, mime, size, upload_status, uploaded_by, created_at) VALUES ('fil_1', ?, ?, 'W-9.pdf', 'application/pdf', 9, 'complete', ?, ?)",
      ).bind(clientId, `clients/${clientId}/abc`, owner.id, Date.now()),
      testEnv.DB.prepare("INSERT INTO settings (org_id, key, value_json, updated_at) VALUES ('org_default', 'opengrants', ?, ?)").bind(JSON.stringify({ apiKeyEnc: 'x', savedAt: 1 }), Date.now()),
    ]);
    await testEnv.FILES.put(`clients/${clientId}/abc`, '%PDF-1.4\n');

    expect((await (await agentFor(owner.id, { stepUp: false })).fetch('/api/data/export')).status).toBe(403);
    const res = await ownerAgent.fetch('/api/data/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    const zip = readZip(new Uint8Array(await res.arrayBuffer()));
    const names = [...zip.keys()];
    expect(names).toEqual(expect.arrayContaining(['README.txt', 'data/clients.json', 'data/audit_log.json', 'settings.json', `files/${clientId}/fil_1-W-9.pdf`]));
    expect(names.some((n) => /sessions|magic_links|passkeys|calendar_feeds/.test(n))).toBe(false);
    const clients = JSON.parse(new TextDecoder().decode(zip.get('data/clients.json'))) as Record<string, unknown>[];
    expect(clients[0]).toMatchObject({ name: 'Acme', ein_last4: '6789' });
    expect(clients[0]).not.toHaveProperty('ein_enc');
    const settings = new TextDecoder().decode(zip.get('settings.json'));
    expect(settings).not.toContain('opengrants');
    expect(settings).not.toMatch(/Enc"/);
    expect(new TextDecoder().decode(zip.get(`files/${clientId}/fil_1-W-9.pdf`))).toBe('%PDF-1.4\n');
  });
});

describe('hard delete', () => {
  it('removes the client, its files and its only-here users; needs the name typed and a step-up', async () => {
    const clientId = await createClient('Acme');
    const other = await createClient('Other');
    const onlyHere = await createUser('client_admin', 'only@acme.test');
    const both = await createUser('client_member', 'both@acme.test');
    await addMember(clientId, onlyHere.id);
    await addMember(clientId, both.id, 'member');
    await addMember(other, both.id, 'member');
    await testEnv.FILES.put(`clients/${clientId}/a`, 'x');
    await testEnv.FILES.put(`clients/${other}/b`, 'y');
    await testEnv.DB.prepare("INSERT INTO opportunities (id, client_id, source, title, stage, created_at) VALUES ('opp_1', ?, 'manual', 'Grant', 'none', ?)").bind(clientId, Date.now()).run();
    const onlyAgent = await agentFor(onlyHere.id);
    await testEnv.DB.prepare("INSERT INTO emails (id, to_user_id, to_email, template, subject, status, created_at) VALUES ('eml_signin', ?, 'only@acme.test', 'magic_link', 'Sign in', 'sent', ?)")
      .bind(onlyHere.id, Date.now())
      .run();

    expect((await (await agentFor(owner.id, { stepUp: false })).fetch(`/api/clients/${clientId}`, { method: 'DELETE', json: { confirm: 'Acme' } })).status).toBe(403);
    expect((await ownerAgent.fetch(`/api/clients/${clientId}`, { method: 'DELETE', json: { confirm: 'acme' } })).status).toBe(422);
    const r = await ownerAgent.fetch(`/api/clients/${clientId}`, { method: 'DELETE', json: { confirm: 'Acme' } });
    expect(await r.json()).toEqual({ ok: true, files: 1, users: 1 });

    expect(await testEnv.DB.prepare('SELECT id FROM clients WHERE id = ?').bind(clientId).first()).toBeNull();
    expect(await testEnv.DB.prepare('SELECT id FROM opportunities WHERE client_id = ?').bind(clientId).first()).toBeNull();
    expect(await testEnv.FILES.head(`clients/${clientId}/a`)).toBeNull();
    expect(await testEnv.FILES.head(`clients/${other}/b`)).not.toBeNull();
    const gone = await testEnv.DB.prepare('SELECT email, disabled_at FROM users WHERE id = ?').bind(onlyHere.id).first<{ email: string; disabled_at: number | null }>();
    expect(gone?.email).toMatch(/^deleted-.*@invalid$/);
    expect(gone?.disabled_at).toBeTruthy();
    expect((await onlyAgent.fetch('/api/me')).status).toBe(401);
    expect(await testEnv.DB.prepare("SELECT id FROM emails WHERE to_email = 'only@acme.test'").first()).toBeNull();
    const kept = await testEnv.DB.prepare('SELECT email, disabled_at FROM users WHERE id = ?').bind(both.id).first<{ email: string; disabled_at: number | null }>();
    expect(kept).toEqual({ email: 'both@acme.test', disabled_at: null });
    const log = await testEnv.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'client.deleted'").first<{ meta_json: string }>();
    expect(JSON.parse(log?.meta_json ?? '{}')).toMatchObject({ name: 'Acme', files: 1, users: 1 });
  });
});

describe('retention', () => {
  it('purges old deleted files and the email log by the configured windows; the audit log is never purged', async () => {
    const now = Date.now();
    const clientId = await createClient();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO files (id, client_id, r2_key, filename, mime, size, upload_status, created_at, deleted_at) VALUES ('f_old', ?, 'clients/x/old', 'a.pdf', 'application/pdf', 1, 'complete', ?, ?)",
      ).bind(clientId, now - 60 * DAY, now - 31 * DAY),
      testEnv.DB.prepare(
        "INSERT INTO files (id, client_id, r2_key, filename, mime, size, upload_status, created_at, deleted_at) VALUES ('f_new', ?, 'clients/x/new', 'b.pdf', 'application/pdf', 1, 'complete', ?, ?)",
      ).bind(clientId, now - 10 * DAY, now - 2 * DAY),
      testEnv.DB.prepare("INSERT INTO emails (id, to_email, template, subject, status, created_at) VALUES ('e_old', 'a@b.c', 't', 's', 'sent', ?), ('e_new', 'a@b.c', 't', 's', 'sent', ?)").bind(now - 400 * DAY, now - DAY),
      testEnv.DB.prepare("INSERT INTO audit_log (id, action, created_at) VALUES ('a_old', 'auth.signin', ?)").bind(now - 3000 * DAY),
    ]);
    await testEnv.FILES.put('clients/x/old', 'x');
    await testEnv.FILES.put('clients/x/new', 'y');
    expect(await purgeRetention(testEnv, now)).toEqual({ files: 1, emails: 1 });
    expect(await testEnv.DB.prepare("SELECT id FROM audit_log WHERE id = 'a_old'").first()).not.toBeNull();
    expect(await testEnv.FILES.head('clients/x/old')).toBeNull();
    expect(await testEnv.FILES.head('clients/x/new')).not.toBeNull();
    const left = await testEnv.DB.prepare('SELECT id FROM emails').all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual(['e_new']);
    const entry = await testEnv.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'retention.purged'").first<{ meta_json: string }>();
    expect(JSON.parse(entry?.meta_json ?? '{}')).toEqual({ files: 1, emails: 1 });
  });
});
