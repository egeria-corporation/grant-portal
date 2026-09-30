import { beforeEach, describe, expect, it } from 'vitest';
import { createLink } from '../../worker/auth/magic';
import { memoryOutbox } from '../../worker/email/outbox';
import { Agent, agentFor, claimAsOwner, createUser, lastEmailTo, resetDb, testEnv } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

beforeEach(resetDb);

const MINUTE = 60_000;

async function register(agent: Agent, device = new SoftAuthenticator(), label = 'Laptop') {
  const opts = await (await agent.post('/auth/passkey/register/options')).json<{
    challengeId: string;
    options: { challenge: string; user: { id: string } };
  }>();
  const response = await device.register(opts.options);
  const res = await agent.post('/auth/passkey/register/verify', { challengeId: opts.challengeId, response, label });
  return { res, device };
}

async function signIn(agent: Agent, device: SoftAuthenticator) {
  const opts = await (await agent.post('/auth/passkey/options')).json<{ challengeId: string; options: { challenge: string } }>();
  const response = await device.assert(opts.options);
  return { res: await agent.post('/auth/passkey/verify', { challengeId: opts.challengeId, response }), opts, response };
}

describe('passkeys', () => {
  it('staff register a passkey, then sign in with it on a fresh browser', async () => {
    const owner = await claimAsOwner();
    const agent = await agentFor(owner.id);
    const before = agent.cookies.get('__Host-session');
    const { res, device } = await register(agent);
    expect(res.status).toBe(201);
    // Registration rotates the session ID; the old one is dead.
    expect(agent.cookies.get('__Host-session')).not.toBe(before);
    const old = new Agent();
    old.cookies.set('__Host-session', before ?? '');
    expect((await old.fetch('/api/me')).status).toBe(401);

    const fresh = new Agent();
    const { res: signed } = await signIn(fresh, device);
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ redirect: '/workspace' });
    const me = await (await fresh.fetch('/api/me')).json<{ user: { id: string } }>();
    expect(me.user.id).toBe(owner.id);
  });

  it('challenges are single use: a replayed assertion fails', async () => {
    const owner = await claimAsOwner();
    const { device } = await register(await agentFor(owner.id));
    const { opts, response } = await signIn(new Agent(), device);
    const replay = await new Agent().post('/auth/passkey/verify', { challengeId: opts.challengeId, response });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'challenge_invalid' });
  });

  it('rejects an assertion from an unregistered key or the wrong origin', async () => {
    const owner = await claimAsOwner();
    const { device } = await register(await agentFor(owner.id));
    const stranger = new SoftAuthenticator();
    await stranger.register({ challenge: 'x', user: { id: 'eA' } });
    expect((await signIn(new Agent(), stranger)).res.status).toBe(400);

    const phish = Object.assign(Object.create(Object.getPrototypeOf(device)), device, { origin: 'https://evil.test' }) as SoftAuthenticator;
    expect((await signIn(new Agent(), phish)).res.status).toBe(400);
  });

  it('passkey assertion on a signed-in session is a step-up', async () => {
    const owner = await claimAsOwner();
    const agent = await agentFor(owner.id);
    const { device } = await register(agent);
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = NULL').run();
    const turnstile = { siteKey: '0x4AAAAAAAAAAAAA', secret: '0x4AAAAAAAAAAAAAAAAAAAAAAAAAA' };
    expect((await agent.fetch('/api/settings/turnstile', { method: 'PUT', json: turnstile })).status).toBe(403);
    const { res } = await signIn(agent, device);
    expect(await res.json()).toMatchObject({ stepUp: true });
    expect((await agent.fetch('/api/settings/turnstile', { method: 'PUT', json: turnstile })).status).toBe(200);
  });

  it('adding a passkey needs a recent step-up, so a stale stolen session cannot plant one', async () => {
    const owner = await claimAsOwner();
    // A stolen Owner session whose last sign-in or passkey check was 31 minutes ago.
    const stolen = await agentFor(owner.id);
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = ? WHERE user_id = ?').bind(Date.now() - 31 * MINUTE, owner.id).run();
    const opts = await stolen.post('/auth/passkey/register/options');
    expect(opts.status).toBe(403);
    expect(await opts.json()).toEqual({ error: 'step_up_required' });

    // A challenge minted by a fresh session of the same user doesn't help the stale one.
    const fresh = await agentFor(owner.id);
    const minted = await (await fresh.post('/auth/passkey/register/options')).json<{ challengeId: string; options: { challenge: string; user: { id: string } } }>();
    const response = await new SoftAuthenticator().register(minted.options);
    const verify = await stolen.post('/auth/passkey/register/verify', { challengeId: minted.challengeId, response });
    expect(verify.status).toBe(403);
    expect(await verify.json()).toEqual({ error: 'step_up_required' });

    const count = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(owner.id).first<{ n: number }>();
    expect(count?.n).toBe(0);
    // Without a planted passkey there's no way to a step-up, so Owner-sensitive actions stay shut.
    expect((await stolen.fetch('/api/data/export')).status).toBe(403);
    expect((await stolen.post('/api/team/invites', { email: 'eve@example.org', delivery: 'link' })).status).toBe(403);
  });

  it('registering a passkey does not grant a step-up of its own', async () => {
    const owner = await claimAsOwner();
    const agent = await agentFor(owner.id);
    const earlier = Date.now() - 25 * MINUTE;
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = ? WHERE user_id = ?').bind(earlier, owner.id).run();
    expect((await register(agent)).res.status).toBe(201);
    // The session still rotated (privilege change), but the step-up clock didn't restart.
    const me = await (await agent.fetch('/api/me')).json<{ session: { stepUpAt: number } }>();
    expect(me.session.stepUpAt).toBe(earlier);
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = ? WHERE user_id = ?').bind(Date.now() - 31 * MINUTE, owner.id).run();
    expect((await agent.fetch('/api/data/export')).status).toBe(403);
  });

  it('adding a passkey emails the account, without the label whoever added it typed', async () => {
    const owner = await claimAsOwner();
    memoryOutbox.length = 0;
    const { res } = await register(await agentFor(owner.id), new SoftAuthenticator(), 'Safe: see https://evil.test');
    expect(res.status).toBe(201);
    const mail = lastEmailTo(owner.email);
    expect(mail?.subject).toMatch(/^Passkey added to your .+ account$/);
    expect(mail?.text).toContain('Chrome on macOS');
    expect(mail?.text).toContain('https://portal.test/workspace/security');
    expect(`${mail?.text}${mail?.html}`).not.toContain('evil.test');
    const logged = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM emails WHERE template = 'passkey_added' AND to_user_id = ?").bind(owner.id).first<{ n: number }>();
    expect(logged?.n).toBe(1);
  });

  it('clients cannot register passkeys', async () => {
    const client = await createUser('client_admin');
    const res = await (await agentFor(client.id)).post('/auth/passkey/register/options');
    expect(res.status).toBe(403);
  });

  it('with "require passkeys", staff without one are gated and staff with one must use it', async () => {
    const owner = await claimAsOwner();
    const ownerAgent = await agentFor(owner.id);
    const { device } = await register(ownerAgent);
    expect((await ownerAgent.fetch('/api/settings/security', { method: 'PUT', json: { requirePasskeysForStaff: true } })).status).toBe(200);

    // A consultant with no passkey can sign in, but only to enroll.
    const consultant = await createUser('consultant');
    const cAgent = await agentFor(consultant.id);
    expect(await (await cAgent.fetch('/api/me')).json()).toMatchObject({ needsPasskey: true });
    expect(await (await cAgent.fetch('/api/clients')).json()).toEqual({ error: 'passkey_enrollment_required' });
    expect((await register(cAgent)).res.status).toBe(201);
    expect((await cAgent.fetch('/api/clients')).status).toBe(200);

    // The Owner has a passkey, so a magic link alone is refused.
    const { token } = await createLink(testEnv, { email: owner.email, purpose: 'signin', ttlMs: 60_000, withCode: false });
    const viaLink = await new Agent().post('/auth/link/consume', { token });
    expect(viaLink.status).toBe(403);
    expect(await viaLink.json()).toEqual({ error: 'passkey_required' });
    expect((await signIn(new Agent(), device)).res.status).toBe(200);
  });

  it('staff held at enrollment enroll right after signing in, but a stale gated session cannot', async () => {
    const owner = await claimAsOwner();
    const ownerAgent = await agentFor(owner.id);
    await register(ownerAgent);
    expect((await ownerAgent.fetch('/api/settings/security', { method: 'PUT', json: { requirePasskeysForStaff: true } })).status).toBe(200);
    const consultant = await createUser('consultant');

    // A gated session can do nothing but enroll; planting a passkey from a stale one would unlock everything.
    const stale = await agentFor(consultant.id, { stepUp: false });
    expect(await (await stale.fetch('/api/me')).json()).toMatchObject({ needsPasskey: true });
    const refused = await stale.post('/auth/passkey/register/options');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'step_up_required' });

    // The enrollment screen follows a sign-in link, which stamps the step-up.
    const { token } = await createLink(testEnv, { email: consultant.email, purpose: 'signin', ttlMs: 60_000, withCode: false });
    const fresh = new Agent();
    expect((await fresh.post('/auth/link/consume', { token })).status).toBe(200);
    expect((await register(fresh)).res.status).toBe(201);
    expect((await fresh.fetch('/api/clients')).status).toBe(200);
  });

  it('removing a passkey needs step-up and only touches your own', async () => {
    const owner = await claimAsOwner();
    const agent = await agentFor(owner.id);
    await register(agent);
    const { passkeys } = await (await agent.fetch('/api/passkeys')).json<{ passkeys: { id: string }[] }>();
    const id = passkeys[0]?.id;
    const other = await createUser('consultant');
    expect((await (await agentFor(other.id)).fetch(`/api/passkeys/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await (await agentFor(owner.id, { stepUp: false })).fetch(`/api/passkeys/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await agent.fetch(`/api/passkeys/${id}`, { method: 'DELETE' })).status).toBe(200);
  });
});
