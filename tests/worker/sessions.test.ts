import { beforeEach, describe, expect, it } from 'vitest';
import { createLink } from '../../worker/auth/magic';
import { SESSION_POLICY } from '../../worker/auth/session';
import { memoryOutbox } from '../../worker/email/outbox';
import {
  addMember,
  Agent,
  agentFor,
  assign,
  claimAsOwner,
  createClient,
  createUser,
  resetDb,
  testEnv,
} from './helpers';

beforeEach(resetDb);

async function signInWithLink(agent: Agent, email: string) {
  const { token } = await createLink(testEnv, { email, purpose: 'signin', ttlMs: 60_000, withCode: false });
  return agent.post('/auth/link/consume', { token });
}

describe('session cookie', () => {
  it('is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain', async () => {
    await createUser('client_admin', 'c@client.org');
    const { token } = await createLink(testEnv, { email: 'c@client.org', purpose: 'signin', ttlMs: 60_000, withCode: false });
    const res = await new Agent().post('/auth/link/consume', { token });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-session='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);
    const value = cookie?.split(';')[0]?.split('=')[1] ?? '';
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
    // Only the hash is stored.
    const row = await testEnv.DB.prepare('SELECT id_hash FROM sessions').first<{ id_hash: string }>();
    expect(row?.id_hash).not.toBe(value);
    expect(row?.id_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('client and staff sessions get their own idle/absolute expiry', async () => {
    await claimAsOwner('boss@firm.org');
    await createUser('client_member', 'm@client.org');
    const before = Date.now();
    await signInWithLink(new Agent(), 'boss@firm.org');
    await signInWithLink(new Agent(), 'm@client.org');
    const rows = await testEnv.DB.prepare(
      'SELECT u.kind, s.idle_expires_at - s.created_at AS idle, s.abs_expires_at - s.created_at AS abs FROM sessions s JOIN users u ON u.id = s.user_id',
    ).all<{ kind: 'staff' | 'client'; idle: number; abs: number }>();
    for (const r of rows.results) {
      expect(r.idle).toBe(SESSION_POLICY[r.kind].idleMs);
      expect(r.abs).toBe(SESSION_POLICY[r.kind].absMs);
    }
    expect(SESSION_POLICY.staff).toEqual({ idleMs: 12 * 3600_000, absMs: 14 * 86_400_000 });
    expect(SESSION_POLICY.client).toEqual({ idleMs: 7 * 86_400_000, absMs: 30 * 86_400_000 });
    expect(before).toBeLessThanOrEqual(Date.now());
  });
});

describe('session lifecycle', () => {
  it('rejects idle-expired and absolute-expired sessions and clears the cookie', async () => {
    const user = await createUser('client_admin');
    const idle = await agentFor(user.id);
    await testEnv.DB.prepare('UPDATE sessions SET idle_expires_at = ?').bind(Date.now() - 1).run();
    const res = await idle.fetch('/api/me');
    expect(res.status).toBe(401);
    expect(idle.cookies.has('__Host-session')).toBe(false);

    const abs = await agentFor(user.id);
    await testEnv.DB.prepare('UPDATE sessions SET abs_expires_at = ? WHERE revoked_at IS NULL AND idle_expires_at > ?')
      .bind(Date.now() - 1, Date.now())
      .run();
    expect((await abs.fetch('/api/me')).status).toBe(401);
  });

  it('sign out revokes the session server-side', async () => {
    const user = await createUser('client_admin');
    const agent = await agentFor(user.id);
    const stolen = agent.cookies.get('__Host-session') ?? '';
    expect((await agent.fetch('/api/me')).status).toBe(200);
    expect((await agent.post('/auth/signout')).status).toBe(200);
    const replay = new Agent();
    replay.cookies.set('__Host-session', stolen);
    expect((await replay.fetch('/api/me')).status).toBe(401);
  });

  it('lists own sessions and revokes one by its public id', async () => {
    const user = await createUser('client_admin');
    const a = await agentFor(user.id);
    const b = await agentFor(user.id);
    const list = await (await a.fetch('/api/sessions')).json<{ sessions: { id: string; current: boolean }[] }>();
    expect(list.sessions).toHaveLength(2);
    expect(list.sessions.filter((s) => s.current)).toHaveLength(1);
    const other = list.sessions.find((s) => !s.current);
    expect((await a.fetch(`/api/sessions/${other?.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await b.fetch('/api/me')).status).toBe(401);
    expect((await a.fetch('/api/me')).status).toBe(200);
  });

  it("cannot revoke another user's session by id", async () => {
    const alice = await createUser('client_admin');
    const bob = await createUser('client_admin');
    const a = await agentFor(alice.id);
    const b = await agentFor(bob.id);
    const bobs = await (await b.fetch('/api/sessions')).json<{ sessions: { id: string }[] }>();
    expect((await a.fetch(`/api/sessions/${bobs.sessions[0]?.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await b.fetch('/api/me')).status).toBe(200);
  });

  it('sign out everywhere revokes every session of the user', async () => {
    const user = await createUser('client_admin');
    const a = await agentFor(user.id);
    const b = await agentFor(user.id);
    const res = await a.post('/auth/signout-all');
    expect(await res.json()).toMatchObject({ ok: true, revoked: 2 });
    expect((await a.fetch('/api/me')).status).toBe(401);
    expect((await b.fetch('/api/me')).status).toBe(401);
  });

  it('a new sign-in from an unknown device emails the user; the first ever sign-in does not', async () => {
    await createUser('client_admin', 'dev@client.org');
    const laptop = new Agent();
    await signInWithLink(laptop, 'dev@client.org');
    expect(memoryOutbox.filter((m) => m.subject.startsWith('New sign-in'))).toHaveLength(0);
    await signInWithLink(laptop, 'dev@client.org');
    expect(memoryOutbox.filter((m) => m.subject.startsWith('New sign-in'))).toHaveLength(0);
    await signInWithLink(new Agent(), 'dev@client.org');
    const mails = memoryOutbox.filter((m) => m.subject.startsWith('New sign-in'));
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe('dev@client.org');
    expect(mails[0]?.text).toContain('Chrome on macOS');
  });
});

describe('staff revoking client sessions', () => {
  it('owner and assigned consultant can; unassigned consultant and client users cannot', async () => {
    const owner = await claimAsOwner();
    const assigned = await createUser('consultant');
    const unassigned = await createUser('consultant');
    const clientId = await createClient();
    const otherClient = await createClient('Other');
    await assign(clientId, assigned.id);
    const member = await createUser('client_member');
    await addMember(clientId, member.id, 'member');
    const peerAdmin = await createUser('client_admin');
    await addMember(clientId, peerAdmin.id, 'admin');

    const path = `/api/clients/${clientId}/members/${member.id}/revoke-sessions`;
    await agentFor(member.id);
    expect((await (await agentFor(unassigned.id)).post(path)).status).toBe(404);
    expect((await (await agentFor(peerAdmin.id)).post(path)).status).toBe(404);
    expect((await (await agentFor(assigned.id)).post(path)).status).toBe(200);

    const victim = await agentFor(member.id);
    const res = await (await agentFor(owner.id)).post(path);
    expect(await res.json()).toEqual({ revoked: 1 });
    expect((await victim.fetch('/api/me')).status).toBe(401);

    // The user must belong to the client in the path.
    expect((await (await agentFor(owner.id)).post(`/api/clients/${otherClient}/members/${member.id}/revoke-sessions`)).status).toBe(404);
    // Staff sessions can't be revoked through a client route.
    expect((await (await agentFor(owner.id)).post(`/api/clients/${clientId}/members/${assigned.id}/revoke-sessions`)).status).toBe(404);
  });
});

describe('CSRF', () => {
  it('rejects writes without an Origin, with a foreign Origin, or without a matching token', async () => {
    const user = await createUser('client_admin');
    const agent = await agentFor(user.id);
    const noOrigin = await agent.fetch('/auth/signout-all', { method: 'POST', headers: { Origin: '' }, json: {} });
    expect(noOrigin.status).toBe(403);
    const foreign = await agent.fetch('/auth/signout-all', { method: 'POST', headers: { Origin: 'https://evil.test' }, json: {} });
    expect(await foreign.json()).toEqual({ error: 'csrf_origin' });
    const noToken = await agent.fetch('/auth/signout-all', { method: 'POST', headers: { 'X-CSRF-Token': '' }, json: {} });
    expect(await noToken.json()).toEqual({ error: 'csrf_token' });
    const mismatch = await agent.fetch('/auth/signout-all', { method: 'POST', headers: { 'X-CSRF-Token': 'other' }, json: {} });
    expect(mismatch.status).toBe(403);
    // Still signed in: none of the forged requests did anything.
    expect((await agent.fetch('/api/me')).status).toBe(200);
    expect((await agent.post('/auth/signout-all')).status).toBe(200);
  });

  it('issues a readable __Host-csrf cookie to a new browser', async () => {
    const agent = new Agent();
    agent.cookies.clear();
    const res = await agent.fetch('/api/public/config');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-csrf='));
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).not.toMatch(/HttpOnly/i);
  });

  it('applies to the sign-in endpoints too', async () => {
    const res = await new Agent().fetch('/auth/magic/request', { method: 'POST', csrf: false, json: { email: 'a@b.org' } });
    expect(res.status).toBe(403);
  });
});
