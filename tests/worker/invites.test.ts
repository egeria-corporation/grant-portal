/**
 * Invite hardening (DECISIONS D-080): copied links can't take over or attach
 * existing accounts, joining another client resets an account's sessions,
 * responses don't reveal what account an address has, invites are rate-limited
 * and superseded, and the inviter's free-text name stays out of the subject.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../worker/email/outbox';
import { setSetting } from '../../worker/lib/settings';
import { addMember, Agent, agentFor, assign, claimAsOwner, createClient, createUser, lastEmailTo, resetDb, testEnv, tokenFrom } from './helpers';

let clientA: string;
let clientB: string;
let ids: { owner: string; consA: string; consB: string; adminB: string };

beforeEach(async () => {
  await resetDb();
  const owner = await claimAsOwner();
  // Client invites go by email only once the sending domain is verified (spec §3.4).
  await setSetting(testEnv, 'email', { status: 'verified', domain: 'firm.example', fromLocal: 'portal', records: [] });
  clientA = await createClient('A');
  clientB = await createClient('B');
  const consA = await createUser('consultant');
  const consB = await createUser('consultant');
  await assign(clientA, consA.id);
  await assign(clientB, consB.id);
  const adminB = await createUser('client_admin');
  await addMember(clientB, adminB.id, 'admin');
  ids = { owner: owner.id, consA: consA.id, consB: consB.id, adminB: adminB.id };
});

type Invite = { emailed: boolean; link?: string; expiresAt: number };

async function invite(actor: Agent, clientId: string, email: string, delivery: 'email' | 'link', role: 'admin' | 'member' = 'member') {
  return actor.post(`/api/clients/${clientId}/invites`, { email, role, delivery });
}

const tokenOf = (link: string) => new URL(link).searchParams.get('t') ?? '';

async function copyLink(actor: Agent, clientId: string, email: string): Promise<string> {
  const res = await invite(actor, clientId, email, 'link');
  expect(res.status).toBe(201);
  return tokenOf((await res.json<Invite>()).link ?? '');
}

async function isMember(clientId: string, email: string): Promise<boolean> {
  const row = await testEnv.DB.prepare('SELECT 1 AS ok FROM client_members m JOIN users u ON u.id = m.user_id WHERE m.client_id = ? AND u.email = ?')
    .bind(clientId, email)
    .first();
  return Boolean(row);
}

describe('copied invite links and existing accounts', () => {
  it('a consultant cannot pre-create a contact’s account and ride its session into another client', async () => {
    const consA = await agentFor(ids.consA);
    // A consultant on client A mints a copy link for client B's CFO and opens it themselves.
    const attacker = new Agent();
    expect(await (await attacker.post('/auth/link/consume', { token: await copyLink(consA, clientA, 'cfo@clientb.org') })).json()).toEqual({ redirect: '/portal' });
    expect((await attacker.fetch(`/api/clients/${clientA}`)).status).toBe(200);

    // Later, client B's consultant invites the real CFO by email, and the CFO accepts.
    const sent = await invite(await agentFor(ids.consB), clientB, 'cfo@clientb.org', 'email');
    expect(sent.status).toBe(201);
    const cfo = new Agent();
    const accepted = await cfo.post('/auth/link/consume', { token: tokenFrom(lastEmailTo('cfo@clientb.org')?.text ?? '') });
    expect(await accepted.json()).toEqual({ redirect: '/portal' });
    expect((await cfo.fetch(`/api/clients/${clientB}`)).status).toBe(200);

    // The session opened from the copied link was revoked when the account joined B.
    expect((await attacker.fetch(`/api/clients/${clientB}`)).status).toBe(401);
    expect((await attacker.fetch('/api/me')).status).toBe(401);
  });

  it('a copied link for an address that has an account signs nobody in and adds nothing', async () => {
    const existing = await createUser('client_admin', 'ceo@clienta.org');
    await addMember(clientA, existing.id, 'admin');
    const token = await copyLink(await agentFor(ids.consB), clientB, 'ceo@clienta.org');

    const opener = new Agent();
    const res = await opener.post('/auth/link/consume', { token });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'invite_account_exists' });
    expect((await opener.fetch('/api/me')).status).toBe(401);
    expect(await isMember(clientB, 'ceo@clienta.org')).toBe(false);
    const refused = await testEnv.DB.prepare("SELECT target FROM audit_log WHERE action = 'invite.refused'").first<{ target: string }>();
    expect(refused?.target).toBe(clientB);
    // Spent either way.
    expect((await new Agent().post('/auth/link/consume', { token })).status).toBe(410);
  });

  it('a copied link minted before the account existed is refused once it does', async () => {
    const stale = await copyLink(await agentFor(ids.consA), clientA, 'new@clientb.org');
    await invite(await agentFor(ids.consB), clientB, 'new@clientb.org', 'email');
    const real = new Agent();
    await real.post('/auth/link/consume', { token: tokenFrom(lastEmailTo('new@clientb.org')?.text ?? '') });
    expect((await real.fetch(`/api/clients/${clientB}`)).status).toBe(200);

    const attacker = new Agent();
    const res = await attacker.post('/auth/link/consume', { token: stale });
    expect(res.status).toBe(409);
    expect((await attacker.fetch('/api/me')).status).toBe(401);
    expect(await isMember(clientA, 'new@clientb.org')).toBe(false);
    // The real person's session is untouched.
    expect((await real.fetch(`/api/clients/${clientB}`)).status).toBe(200);
  });

  it('a copied link for staff is refused too, and never becomes a staff session', async () => {
    const staff = await testEnv.DB.prepare('SELECT email FROM users WHERE id = ?').bind(ids.consA).first<{ email: string }>();
    const token = await copyLink(await agentFor(ids.consB), clientB, staff?.email ?? '');
    const opener = new Agent();
    expect((await opener.post('/auth/link/consume', { token })).status).toBe(409);
    expect((await opener.fetch('/api/me')).status).toBe(401);
  });

  it('a brand-new address still works with a copied link (spec §3.4)', async () => {
    const token = await copyLink(await agentFor(ids.consA), clientA, 'fresh@clienta.org');
    const person = new Agent();
    expect(await (await person.post('/auth/link/consume', { token })).json()).toEqual({ redirect: '/portal' });
    expect(await isMember(clientA, 'fresh@clienta.org')).toBe(true);
  });

  it('an emailed invite for someone already in this client is refused as already a member', async () => {
    const x = await createUser('client_member', 'x@clientb.org');
    await addMember(clientB, x.id, 'member');
    for (const delivery of ['email', 'link'] as const) {
      const res = await invite(await agentFor(ids.consB), clientB, 'x@clientb.org', delivery);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'already_member' });
    }
  });
});

describe('invite responses do not reveal accounts', () => {
  it('a client admin gets the same answer for a new address, a client user elsewhere, staff, and a disabled account', async () => {
    const elsewhere = await createUser('client_member', 'elsewhere@clienta.org');
    await addMember(clientA, elsewhere.id, 'member');
    const staff = await testEnv.DB.prepare('SELECT email FROM users WHERE id = ?').bind(ids.consA).first<{ email: string }>();
    const gone = await createUser('consultant', 'gone@firm.example');
    await testEnv.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').bind(Date.now(), gone.id).run();

    const admin = await agentFor(ids.adminB);
    const addresses = ['nobody@clientb.org', 'elsewhere@clienta.org', staff?.email ?? '', 'gone@firm.example'];
    const answers: { status: number; body: Record<string, unknown> }[] = [];
    for (const email of addresses) {
      const res = await invite(admin, clientB, email, 'email');
      answers.push({ status: res.status, body: await res.json() });
    }
    for (const a of answers) {
      expect(a.status).toBe(201);
      expect(Object.keys(a.body).sort()).toEqual(['emailed', 'expiresAt']);
      expect(a.body.emailed).toBe(true);
    }
    // Every one shows up as a pending invite; only addresses that can accept get mail.
    const pending = await testEnv.DB.prepare("SELECT email FROM magic_links WHERE purpose = 'invite' AND client_id = ? AND used_at IS NULL").bind(clientB).all<{ email: string }>();
    expect(pending.results.map((r) => r.email).sort()).toEqual([...addresses].sort());
    expect(memoryOutbox.map((m) => m.to).sort()).toEqual(['elsewhere@clienta.org', 'nobody@clientb.org']);
  });

  it('a consultant’s copy link for an existing client user looks like any other and attaches nobody', async () => {
    const elsewhere = await createUser('client_member', 'elsewhere@clienta.org');
    await addMember(clientA, elsewhere.id, 'member');
    const consB = await agentFor(ids.consB);
    const known = await invite(consB, clientB, 'elsewhere@clienta.org', 'link');
    const unknown = await invite(consB, clientB, 'nobody@clientb.org', 'link');
    expect(known.status).toBe(201);
    const [k, u] = [await known.json<Invite>(), await unknown.json<Invite>()];
    expect(Object.keys(k).sort()).toEqual(Object.keys(u).sort());
    expect(k.emailed).toBe(false);
    expect(k.link).toMatch(/\/auth\/verify\?t=/);
    expect(await isMember(clientB, 'elsewhere@clienta.org')).toBe(false);
  });
});

describe('invite supersede and rate limits', () => {
  it('a new invite cancels earlier ones for the same address and client, not other clients’', async () => {
    const owner = await agentFor(ids.owner);
    const first = await copyLink(owner, clientA, 'twice@example.org');
    const onB = await copyLink(owner, clientB, 'twice@example.org');
    const second = await copyLink(owner, clientA, 'twice@example.org');
    expect((await new Agent().post('/auth/link/peek', { token: first })).status).toBe(410);
    expect((await new Agent().post('/auth/link/peek', { token: second })).status).toBe(200);
    expect((await new Agent().post('/auth/link/peek', { token: onB })).status).toBe(200);
  });

  it('caps invites to one address per client', async () => {
    const admin = await agentFor(ids.adminB);
    for (let i = 0; i < 5; i++) expect((await invite(admin, clientB, 'target@example.org', 'email')).status).toBe(201);
    const blocked = await invite(admin, clientB, 'target@example.org', 'email');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });
    expect(memoryOutbox.filter((m) => m.to === 'target@example.org')).toHaveLength(5);
    // Another client's invite to the same person isn't affected.
    expect((await invite(await agentFor(ids.owner), clientA, 'target@example.org', 'email')).status).toBe(201);
  });

  it('caps invites per inviter', async () => {
    const consB = await agentFor(ids.consB);
    for (let i = 0; i < 30; i++) expect((await invite(consB, clientB, `p${i}@example.org`, 'link')).status).toBe(201);
    expect((await invite(consB, clientB, 'p30@example.org', 'link')).status).toBe(429);
    // Someone else can still invite.
    expect((await invite(await agentFor(ids.owner), clientB, 'p30@example.org', 'link')).status).toBe(201);
  });
});

describe('invite email', () => {
  it('keeps the inviter’s self-chosen name out of the subject and preview, and escapes it in the body', async () => {
    const admin = await agentFor(ids.adminB);
    expect((await admin.fetch('/api/me/preferences', { method: 'PUT', json: { name: 'URGENT wire funds <b>now</b>' } })).status).toBe(200);
    expect((await invite(admin, clientB, 'target@example.org', 'email')).status).toBe(201);
    const mail = lastEmailTo('target@example.org');
    expect(mail?.subject).toMatch(/^You have been invited to /);
    expect(mail?.subject).not.toContain('URGENT');
    const preview = /data-skip-in-text="true">([^<]*)/.exec(mail?.html ?? '')?.[1] ?? '';
    expect(preview).toBe(mail?.subject);
    expect(mail?.html).not.toContain('<b>now</b>');
    expect(mail?.html).toContain('&lt;b&gt;now&lt;/b&gt;');
    expect(mail?.text).toContain('URGENT wire funds <b>now</b> invited you');
  });
});
