import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSetupCode } from '../../worker/api/setup';
import { createLink } from '../../worker/auth/magic';
import { memoryOutbox } from '../../worker/email/outbox';
import type { AppEnv } from '../../worker/env';
import { GLOBAL_LIMITS } from '../../worker/lib/rate-limit';
import { Agent, agentFor, codeFrom, lastEmailTo, resetDb, testEnv, tokenFrom } from './helpers';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** Captures the code printed to the Worker logs. */
async function logSetupCode(): Promise<string> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await issueSetupCode(testEnv, true);
  const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('setup code'));
  spy.mockRestore();
  const code = /code: ([0-9A-Z-]+)/.exec(line ?? '')?.[1];
  if (!code) throw new Error('no setup code logged');
  return code;
}

/**
 * A production env whose Resend account refuses the send, as Resend does for
 * the shared test sender and any address but the account owner's. Returns the
 * refused messages, code and link included.
 */
function resendRefuses() {
  const refused: { to: string[]; text: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${String(input)}`);
    refused.push(JSON.parse(String(init?.body)) as { to: string[]; text: string });
    return Response.json(
      { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address.' },
      { status: 403 },
    );
  });
  return { env: { ...testEnv, APP_ENV: 'production', RESEND_API_KEY: 're_test_key' } as AppEnv, refused };
}

async function liveSetupLinks(): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE purpose = 'setup' AND used_at IS NULL").first<{ n: number }>();
  return row?.n ?? 0;
}

/** A client alone in its own IPv6 /64. */
const v6Agent = (i: number) => new Agent({ ip: `2001:db8:${i.toString(16)}::1` });

describe('claim by email', () => {
  it('sends the setup email from the shared test sender, and the link makes the Owner', async () => {
    const agent = new Agent();
    expect(await (await agent.fetch('/api/setup/status')).json()).toMatchObject({ status: 'unclaimed' });
    const res = await agent.post('/api/setup/claim', { email: 'Owner@Firm.org' });
    expect(res.status).toBe(200);
    const mail = lastEmailTo('owner@firm.org');
    expect(mail?.from).toBe('Portal setup <onboarding@resend.dev>');
    expect(mail?.subject).not.toMatch(/\d{6}/);

    const consumed = await agent.post('/auth/link/consume', { token: tokenFrom(mail?.text ?? '') });
    expect(await consumed.json()).toEqual({ redirect: '/setup' });
    const me = await (await agent.fetch('/api/me')).json<{ user: { role: string; email: string } }>();
    expect(me.user).toMatchObject({ role: 'owner', email: 'owner@firm.org' });
    expect(await (await agent.fetch('/api/setup/status')).json()).toMatchObject({ status: 'claimed' });
    expect((await agent.post('/api/setup/claim', { email: 'x@y.org' })).status).toBe(409);
  });

  it('also accepts the 6-digit code from the setup email', async () => {
    const agent = new Agent();
    await agent.post('/api/setup/claim', { email: 'owner@firm.org' });
    const code = codeFrom(lastEmailTo('owner@firm.org')?.text ?? '');
    const res = await agent.post('/auth/code/verify', { email: 'owner@firm.org', code, purpose: 'setup' });
    expect(res.status).toBe(200);
  });

  it('first claimant wins when two setup links are consumed at once', async () => {
    const links = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createLink(testEnv, { email: `rival${i}@firm.org`, purpose: 'setup', ttlMs: 60_000, withCode: false }),
      ),
    );
    const results = await Promise.all(links.map((l) => new Agent().post('/auth/link/consume', { token: l.token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const owners = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").first<{ n: number }>();
    expect(owners?.n).toBe(1);
  });
});

describe('claim by email: nothing to guess unless the email is delivered', () => {
  it('a send Resend refuses leaves no link or code, even for someone holding both', async () => {
    const { env, refused } = resendRefuses();
    const attacker = new Agent();
    const res = await attacker.post('/api/setup/claim', { email: 'attacker@evil.example' }, { env });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'email_failed' });
    expect(await liveSetupLinks()).toBe(0);

    // The refused request carried the code and the link. Neither works: nothing was stored.
    const text = refused[0]?.text ?? '';
    const verify = await attacker.post('/auth/code/verify', { email: 'attacker@evil.example', code: codeFrom(text), purpose: 'setup' });
    expect(verify.status).toBe(400);
    expect((await attacker.post('/auth/link/consume', { token: tokenFrom(text) })).status).toBe(410);
    expect(await (await attacker.fetch('/api/setup/status')).json()).toMatchObject({ status: 'unclaimed' });
  });

  it('only the latest setup link is live, whoever it was for', async () => {
    await new Agent().post('/api/setup/claim', { email: 'first@firm.org' });
    await new Agent().post('/api/setup/claim', { email: 'second@firm.org' });
    const first = lastEmailTo('first@firm.org')?.text ?? '';
    expect((await new Agent().post('/auth/link/consume', { token: tokenFrom(first) })).status).toBe(410);
    expect((await new Agent().post('/auth/code/verify', { email: 'first@firm.org', code: codeFrom(first), purpose: 'setup' })).status).toBe(400);
    expect(await liveSetupLinks()).toBe(1);
    const second = lastEmailTo('second@firm.org')?.text ?? '';
    expect((await new Agent().post('/auth/link/consume', { token: tokenFrom(second) })).status).toBe(200);
  });

  it(`sends at most ${GLOBAL_LIMITS.setupEmail.limit} setup emails an hour portal-wide, however many IPs ask at once`, async () => {
    const { limit } = GLOBAL_LIMITS.setupEmail;
    const results = await Promise.all(
      Array.from({ length: limit + 5 }, (_, i) => v6Agent(i).post('/api/setup/claim', { email: `rival${i}@firm.org` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(limit);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(memoryOutbox).toHaveLength(limit);
    expect(await liveSetupLinks()).toBe(1);
  });

  it('refused sends count toward the portal-wide cap too', async () => {
    const { env } = resendRefuses();
    const { limit } = GLOBAL_LIMITS.setupEmail;
    for (let i = 0; i < limit; i++) {
      expect((await v6Agent(i).post('/api/setup/claim', { email: `x${i}@evil.example` }, { env })).status).toBe(503);
    }
    expect((await v6Agent(limit).post('/api/setup/claim', { email: 'y@evil.example' }, { env })).status).toBe(429);
  });
});

describe('claim by setup code (logs)', () => {
  it('works once with the logged code and then locks', async () => {
    const code = await logSetupCode();
    const agent = new Agent();
    const res = await agent.post('/api/setup/claim-with-code', { email: 'owner@firm.org', setupCode: code.toLowerCase() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: '/setup' });
    expect((await agent.fetch('/api/me')).status).toBe(200);
    // The code is gone and the portal is claimed.
    expect((await new Agent().post('/api/setup/claim-with-code', { email: 'b@firm.org', setupCode: code })).status).toBe(409);
    expect(memoryOutbox).toHaveLength(0);
  });

  it('wrong guesses never burn the code the Owner is copying from the logs', async () => {
    const code = await logSetupCode();
    for (let i = 0; i < 25; i++) {
      const res = await v6Agent(i).post('/api/setup/claim-with-code', { email: 'b@firm.org', setupCode: 'AAAA-AAAA-AAAA' });
      expect(res.status).toBe(400);
    }
    const res = await new Agent().post('/api/setup/claim-with-code', { email: 'owner@firm.org', setupCode: code });
    expect(res.status).toBe(200);
  });

  it(`allows ${GLOBAL_LIMITS.setupCodeAttempt.limit} guesses an hour portal-wide, even all at once from different IPs`, async () => {
    const code = await logSetupCode();
    const { limit } = GLOBAL_LIMITS.setupCodeAttempt;
    const guesses = await Promise.all(
      Array.from({ length: limit + 10 }, (_, i) =>
        v6Agent(i).post('/api/setup/claim-with-code', { email: 'b@firm.org', setupCode: 'AAAA-AAAA-AAAA' }),
      ),
    );
    expect(guesses.filter((r) => r.status === 400)).toHaveLength(limit);
    expect(guesses.filter((r) => r.status === 429)).toHaveLength(10);
    // The budget is spent for this hour, right code included. The code itself survives.
    const owner = new Agent();
    expect((await owner.post('/api/setup/claim-with-code', { email: 'owner@firm.org', setupCode: code })).status).toBe(429);
    const nextHour = Date.now() + 3600_000;
    vi.spyOn(Date, 'now').mockReturnValue(nextHour);
    expect((await owner.post('/api/setup/claim-with-code', { email: 'owner@firm.org', setupCode: code })).status).toBe(200);
  });

  it(`prints a new code at most ${GLOBAL_LIMITS.setupCodeReissue.limit} times an hour, so the latest one stays valid`, async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { limit } = GLOBAL_LIMITS.setupCodeReissue;
    for (let i = 0; i < limit; i++) expect((await v6Agent(i).post('/api/setup/setup-code')).status).toBe(200);
    expect((await v6Agent(limit).post('/api/setup/setup-code')).status).toBe(429);
    const printed = spy.mock.calls.map((c) => /code: ([0-9A-Z-]+)/.exec(String(c[0]))?.[1]).filter((c) => c !== undefined);
    spy.mockRestore();
    expect(printed).toHaveLength(limit);
    const res = await new Agent().post('/api/setup/claim-with-code', { email: 'owner@firm.org', setupCode: printed.at(-1) });
    expect(res.status).toBe(200);
  });

  it('counts IPv6 clients per /64, so rotating addresses inside one does not help', async () => {
    const guess = (ip: string) => new Agent({ ip }).post('/api/setup/claim-with-code', { email: 'b@firm.org', setupCode: 'AAAA-AAAA-AAAA' });
    await logSetupCode();
    for (let i = 1; i <= 10; i++) expect((await guess(`2001:db8:7:7::${i.toString(16)}`)).status).toBe(400);
    expect((await guess('2001:db8:7:7:ffff:ffff:ffff:ffff')).status).toBe(429);
    expect((await guess('2001:db8:7:8::1')).status).toBe(400);
  });

  it('never logs a code once the portal is claimed', async () => {
    await new Agent().post('/api/setup/claim-with-code', { email: 'o@firm.org', setupCode: await logSetupCode() });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect((await new Agent().post('/api/setup/setup-code')).status).toBe(409);
    await new Agent().fetch('/api/setup/status');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('setup code'))).toBe(false);
  });
});

describe('wizard', () => {
  async function owner() {
    const agent = new Agent();
    await agent.post('/api/setup/claim-with-code', { email: 'owner@firm.org', setupCode: await logSetupCode() });
    return agent;
  }

  it('saves brand basics and nudges an accent that would fail WCAG AA', async () => {
    const agent = await owner();
    const grey = await agent.fetch('/api/settings/brand', { method: 'PUT', json: { firmName: 'Acme Grants', accent: '#787878' } });
    expect(grey.status).toBe(200);
    const out = await grey.json<{ contrast: { adjusted: boolean; ratio: number; solid: string } }>();
    expect(out.contrast.adjusted).toBe(true);
    expect(out.contrast.ratio).toBeGreaterThanOrEqual(4.5);
    const ok = await agent.fetch('/api/settings/brand', {
      method: 'PUT',
      json: { firmName: 'Acme Grants', accent: '#1F5FAD', welcome: 'Welcome!' },
    });
    expect(ok.status).toBe(200);
    const cfg = await (await new Agent().fetch('/api/public/config')).json();
    expect(cfg).toMatchObject({ firmName: 'Acme Grants', accent: '#1f5fad', welcome: 'Welcome!', setupStatus: 'claimed' });
  });

  it('creates the sending domain and shows DNS records including DMARC', async () => {
    const agent = await owner();
    const res = await agent.fetch('/api/settings/email', {
      method: 'PUT',
      json: { fromName: 'Acme Grants', fromLocal: 'portal', domain: 'Acme.example' },
    });
    expect(res.status).toBe(200);
    const { email } = await res.json<{ email: { status: string; records: { name: string; type: string }[] } }>();
    expect(email.status).toBe('pending');
    expect(email.records.map((r) => r.name)).toContain('_dmarc.acme.example');
    expect(email.records.every((r) => r.name.endsWith('acme.example'))).toBe(true);
  });

  it('blocks emailed invites until the domain is verified, but allows a copy link', async () => {
    const agent = await owner();
    const emailed = await agent.post('/api/team/invites', { email: 'writer@firm.org', delivery: 'email' });
    expect(emailed.status).toBe(409);
    expect(await emailed.json()).toEqual({ error: 'email_domain_unverified' });

    const copy = await agent.post('/api/team/invites', { email: 'writer@firm.org', delivery: 'link' });
    expect(copy.status).toBe(201);
    const { link, expiresAt } = await copy.json<{ link: string; expiresAt: number }>();
    expect(expiresAt - Date.now()).toBeGreaterThan(71 * 3600_000);
    const token = new URL(link).searchParams.get('t') ?? '';

    const writer = new Agent();
    const accepted = await writer.post('/auth/link/consume', { token });
    expect(await accepted.json()).toEqual({ redirect: '/workspace' });
    const me = await (await writer.fetch('/api/me')).json<{ user: { role: string } }>();
    expect(me.user.role).toBe('consultant');
    expect((await new Agent().post('/auth/link/consume', { token })).status).toBe(410);
  });

  it('first client with a copy-link invite puts the contact into that client only', async () => {
    const agent = await owner();
    const res = await agent.post('/api/clients', { name: 'Hope Shelter', contact: { email: 'ed@hope.org', delivery: 'link' } });
    expect(res.status).toBe(201);
    const { id, invite } = await res.json<{ id: string; invite: { link: string } }>();
    const contact = new Agent();
    const accepted = await contact.post('/auth/link/consume', { token: new URL(invite.link).searchParams.get('t') });
    expect(await accepted.json()).toEqual({ redirect: '/portal' });
    const home = await (await contact.fetch('/api/portal/home')).json<{ clients: { id: string; role: string }[] }>();
    expect(home.clients).toEqual([{ id, name: 'Hope Shelter', role: 'admin', openItems: 0, awaitingYou: 0 }]);
  });

  it('loads and deletes the demo client', async () => {
    const agent = await owner();
    const loaded = await agent.post('/api/demo');
    expect(loaded.status).toBe(201);
    const { id } = await loaded.json<{ id: string }>();
    const deliverables = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM deliverables WHERE client_id = ?').bind(id).first<{ n: number }>();
    expect(deliverables?.n).toBe(3);
    const schedule = await testEnv.DB.prepare('SELECT enabled FROM schedules WHERE client_id = ?').bind(id).first<{ enabled: number }>();
    expect(schedule?.enabled).toBe(0);
    expect(await (await agent.fetch('/api/demo', { method: 'DELETE' })).json()).toEqual({ deleted: 1 });
    const left = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM deliverables').first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('marks steps and completes; the Owner then lands on the workspace', async () => {
    const agent = await owner();
    expect((await agent.fetch('/api/setup/steps/brand', { method: 'PUT', json: { state: 'done' } })).status).toBe(200);
    expect((await agent.fetch('/api/setup/steps/nope', { method: 'PUT', json: { state: 'done' } })).status).toBe(404);
    expect((await agent.post('/api/setup/complete')).status).toBe(200);
    expect(await (await agent.fetch('/api/setup/progress')).json()).toMatchObject({ status: 'complete', steps: { brand: 'done' } });
  });

  it('stores integration secrets encrypted, never in plain text', async () => {
    const agent = await owner();
    expect((await agent.fetch('/api/settings/opengrants', { method: 'PUT', json: { apiKey: 'og_live_secret_value' } })).status).toBe(200);
    const row = await testEnv.DB.prepare("SELECT value_json FROM settings WHERE key = 'opengrants'").first<{ value_json: string }>();
    expect(row?.value_json).not.toContain('og_live_secret_value');
    const overview = await (await agent.fetch('/api/settings/overview')).json();
    expect(JSON.stringify(overview)).not.toContain('og_live_secret_value');
  });

  it('Turnstile settings need a recent step-up', async () => {
    const o = await claimOwnerDirect();
    const stale = await agentFor(o, { stepUp: false });
    const res = await stale.fetch('/api/settings/turnstile', { method: 'PUT', json: { siteKey: '0x4AAAAAAAAAAAAA', secret: '0x4AAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    expect(await res.json()).toEqual({ error: 'step_up_required' });
    const fresh = await agentFor(o);
    expect((await fresh.fetch('/api/settings/turnstile', { method: 'PUT', json: { siteKey: '0x4AAAAAAAAAAAAA', secret: '0x4AAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status).toBe(200);
    expect(await (await new Agent().fetch('/api/public/config')).json()).toMatchObject({ turnstileSiteKey: '0x4AAAAAAAAAAAAA' });
  });

  it('requiring passkeys needs the Owner to have one first', async () => {
    const o = await claimOwnerDirect();
    const res = await (await agentFor(o)).fetch('/api/settings/security', { method: 'PUT', json: { requirePasskeysForStaff: true } });
    expect(await res.json()).toEqual({ error: 'register_passkey_first' });
  });
});

async function claimOwnerDirect(): Promise<string> {
  const agent = new Agent();
  await agent.post('/api/setup/claim-with-code', { email: 'direct@firm.org', setupCode: await logSetupCode() });
  const row = await testEnv.DB.prepare("SELECT id FROM users WHERE role = 'owner'").first<{ id: string }>();
  return row?.id ?? '';
}

describe('invites never impersonate existing users', () => {
  it('a copy-link invite for an existing client user adds them instead of minting a sign-in link', async () => {
    const o = await claimOwnerDirect();
    const agent = await agentFor(o);
    const existing = await testEnv.DB.prepare(
      "INSERT INTO users (id, email, kind, role, created_at) VALUES ('usr_01J000000000000000000EXIST', 'ceo@client.org', 'client', 'client_admin', 1) RETURNING id",
    ).first<{ id: string }>();
    const res = await agent.post('/api/clients', { name: 'Second Org', contact: { email: 'ceo@client.org', delivery: 'link' } });
    const { id, invite } = await res.json<{ id: string; invite: { link?: string; added?: boolean } }>();
    expect(invite.link).toBeUndefined();
    expect(invite.added).toBe(true);
    const member = await testEnv.DB.prepare('SELECT role FROM client_members WHERE client_id = ? AND user_id = ?')
      .bind(id, existing?.id)
      .first<{ role: string }>();
    expect(member?.role).toBe('admin');
    const links = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = 'ceo@client.org'").first<{ n: number }>();
    expect(links?.n).toBe(0);
  });

  it('a copy-link team invite for an existing team member is refused', async () => {
    const o = await claimOwnerDirect();
    const agent = await agentFor(o);
    const res = await agent.post('/api/team/invites', { email: 'direct@firm.org', delivery: 'link' });
    expect(res.status).toBe(409);
  });
});
