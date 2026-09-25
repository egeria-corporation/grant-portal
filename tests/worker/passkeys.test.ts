import { beforeEach, describe, expect, it } from 'vitest';
import { createLink } from '../../worker/auth/magic';
import { Agent, agentFor, claimAsOwner, createUser, resetDb, testEnv } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

beforeEach(resetDb);

async function register(agent: Agent, device = new SoftAuthenticator()) {
  const opts = await (await agent.post('/auth/passkey/register/options')).json<{
    challengeId: string;
    options: { challenge: string; user: { id: string } };
  }>();
  const response = await device.register(opts.options);
  const res = await agent.post('/auth/passkey/register/verify', { challengeId: opts.challengeId, response, label: 'Laptop' });
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
    const agent = await agentFor(owner.id, { stepUp: false });
    const { device } = await register(agent);
    await testEnv.DB.prepare('UPDATE sessions SET step_up_at = NULL').run();
    const turnstile = { siteKey: '0x4AAAAAAAAAAAAA', secret: '0x4AAAAAAAAAAAAAAAAAAAAAAAAAA' };
    expect((await agent.fetch('/api/settings/turnstile', { method: 'PUT', json: turnstile })).status).toBe(403);
    const { res } = await signIn(agent, device);
    expect(await res.json()).toMatchObject({ stepUp: true });
    expect((await agent.fetch('/api/settings/turnstile', { method: 'PUT', json: turnstile })).status).toBe(200);
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
