import { beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../worker/email/outbox';
import { createLink } from '../../worker/auth/magic';
import { TEST_KEYS } from '../../worker/lib/turnstile';
import {
  Agent,
  claimAsOwner,
  codeFrom,
  createUser,
  lastEmailTo,
  resetDb,
  testEnv,
  tokenFrom,
} from './helpers';

beforeEach(resetDb);

async function requestLink(agent: Agent, email: string) {
  return agent.post('/auth/magic/request', { email });
}

describe('magic link request', () => {
  it('answers identically for known and unknown emails, and only emails the known one', async () => {
    await claimAsOwner();
    const known = await createUser('client_admin', 'jane@client.org');
    const a = await requestLink(new Agent(), known.email);
    const b = await requestLink(new Agent(), 'nobody@client.org');
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(await a.json()).toEqual(await b.json());
    expect(memoryOutbox.map((m) => m.to)).toEqual(['jane@client.org']);
    // Nothing is stored for the unknown address.
    const rows = await testEnv.DB.prepare('SELECT email FROM magic_links').all<{ email: string }>();
    expect(rows.results.map((r) => r.email)).toEqual(['jane@client.org']);
  });

  it('stores only hashes, never the token or code', async () => {
    const user = await createUser('client_admin', 'hash@client.org');
    await requestLink(new Agent(), user.email);
    const email = lastEmailTo(user.email);
    const token = tokenFrom(email?.text ?? '');
    const code = codeFrom(email?.text ?? '');
    const row = await testEnv.DB.prepare('SELECT * FROM magic_links').first<Record<string, unknown>>();
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(code);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.expires_at as number).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(row?.expires_at as number).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  });

  it('limits requests to 5 per hour per email', async () => {
    await createUser('client_admin', 'limit@client.org');
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await requestLink(new Agent(), 'limit@client.org')).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('limits requests to 20 per hour per IP', async () => {
    const agent = new Agent({ ip: '203.0.113.9' });
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await requestLink(agent, `u${i}@client.org`)).status);
    expect(statuses.slice(0, 20).every((s) => s === 202)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('requires a passing Turnstile token once Turnstile is configured', async () => {
    const pass = { ...testEnv, TURNSTILE_SITE_KEY: TEST_KEYS.alwaysPass.siteKey, TURNSTILE_SECRET_KEY: TEST_KEYS.alwaysPass.secret };
    const fail = { ...testEnv, TURNSTILE_SITE_KEY: TEST_KEYS.alwaysFail.siteKey, TURNSTILE_SECRET_KEY: TEST_KEYS.alwaysFail.secret };
    const agent = new Agent();
    expect((await agent.post('/auth/magic/request', { email: 'x@client.org' }, { env: pass })).status).toBe(403);
    expect((await agent.post('/auth/magic/request', { email: 'x@client.org', turnstileToken: 'tok' }, { env: pass })).status).toBe(202);
    expect((await agent.post('/auth/magic/request', { email: 'x@client.org', turnstileToken: 'tok' }, { env: fail })).status).toBe(403);
  });

  it('rejects malformed input without echoing it', async () => {
    const res = await new Agent().post('/auth/magic/request', { email: 'not-an-email<script>' });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain('<script>');
  });
});

describe('magic link consumption', () => {
  async function linkFor(email: string) {
    await createUser('client_admin', email);
    const out = await createLink(testEnv, { email, purpose: 'signin', ttlMs: 15 * 60_000, withCode: true });
    return out;
  }

  it('GET only renders the interstitial; it never consumes the token', async () => {
    const { token } = await linkFor('scan@client.org');
    const agent = new Agent();
    const page = await agent.fetch(`/auth/verify?t=${token}`, { headers: { Accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toContain('text/html');
    expect(agent.cookies.has('__Host-session')).toBe(false);
    const row = await testEnv.DB.prepare('SELECT used_at FROM magic_links').first<{ used_at: number | null }>();
    expect(row?.used_at).toBeNull();

    const peek = await agent.post('/auth/link/peek', { token });
    expect(peek.status).toBe(200);
    expect(await peek.json()).toMatchObject({ purpose: 'signin', email: 'scan@client.org' });

    const res = await agent.post('/auth/link/consume', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: '/portal' });
    expect(agent.cookies.has('__Host-session')).toBe(true);
  });

  it('is single-use under concurrency: exactly one of 10 parallel POSTs wins', async () => {
    const { token } = await linkFor('race@client.org');
    const results = await Promise.all(Array.from({ length: 10 }, () => new Agent().post('/auth/link/consume', { token })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 410)).toHaveLength(9);
    const sessions = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  it('cannot be reused', async () => {
    const { token } = await linkFor('reuse@client.org');
    expect((await new Agent().post('/auth/link/consume', { token })).status).toBe(200);
    expect((await new Agent().post('/auth/link/consume', { token })).status).toBe(410);
  });

  it('expires after 15 minutes', async () => {
    const { token } = await linkFor('late@client.org');
    await testEnv.DB.prepare('UPDATE magic_links SET expires_at = ?').bind(Date.now() - 1).run();
    expect((await new Agent().post('/auth/link/consume', { token })).status).toBe(410);
    expect((await new Agent().post('/auth/link/peek', { token })).status).toBe(410);
  });

  it('a newer request supersedes older ones for the same email', async () => {
    const user = await createUser('client_admin', 'twice@client.org');
    await requestLink(new Agent(), user.email);
    const first = tokenFrom(lastEmailTo(user.email)?.text ?? '');
    await requestLink(new Agent(), user.email);
    const second = tokenFrom(lastEmailTo(user.email)?.text ?? '');
    expect((await new Agent().post('/auth/link/consume', { token: first })).status).toBe(410);
    expect((await new Agent().post('/auth/link/consume', { token: second })).status).toBe(200);
  });

  it('refuses a disabled user', async () => {
    const { token } = await linkFor('gone@client.org');
    await testEnv.DB.prepare("UPDATE users SET disabled_at = 1 WHERE email = 'gone@client.org'").run();
    expect((await new Agent().post('/auth/link/consume', { token })).status).toBe(410);
  });
});

describe('6-digit code', () => {
  async function codeFor(email: string) {
    await createUser('client_admin', email);
    await requestLink(new Agent(), email);
    return codeFrom(lastEmailTo(email)?.text ?? '');
  }

  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  it('signs in with the right code', async () => {
    const code = await codeFor('code@client.org');
    const agent = new Agent();
    const res = await agent.post('/auth/code/verify', { email: 'CODE@client.org ', code });
    expect(res.status).toBe(200);
    expect(agent.cookies.has('__Host-session')).toBe(true);
  });

  it('allows 5 attempts, then invalidates the request (link included)', async () => {
    const email = 'brute@client.org';
    const code = await codeFor(email);
    const token = tokenFrom(lastEmailTo(email)?.text ?? '');
    const agent = new Agent();
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await agent.post('/auth/code/verify', { email, code: wrong(code) })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 410]);
    expect((await agent.post('/auth/code/verify', { email, code })).status).not.toBe(200);
    expect((await agent.post('/auth/link/consume', { token })).status).toBe(410);
  });

  it('caps attempts under concurrency', async () => {
    const email = 'burst@client.org';
    const code = await codeFor(email);
    await Promise.all(Array.from({ length: 12 }, () => new Agent().post('/auth/code/verify', { email, code: wrong(code) })));
    const row = await testEnv.DB.prepare('SELECT attempts, used_at FROM magic_links WHERE email = ?')
      .bind(email)
      .first<{ attempts: number; used_at: number | null }>();
    expect(row?.attempts).toBe(5);
    expect(row?.used_at).not.toBeNull();
    expect((await new Agent().post('/auth/code/verify', { email, code })).status).not.toBe(200);
  });

  it('gives the same answer for an unknown email', async () => {
    const res = await new Agent().post('/auth/code/verify', { email: 'nobody@client.org', code: '123456' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'code_invalid' });
  });

  it('records failed codes in the audit log', async () => {
    const code = await codeFor('audit@client.org');
    await new Agent().post('/auth/code/verify', { email: 'audit@client.org', code: wrong(code) });
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.code_failed'").first<{ n: number }>();
    expect(row?.n).toBeGreaterThan(0);
  });
});
