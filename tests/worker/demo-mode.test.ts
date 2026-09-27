/** Demo mode (DECISIONS D-077): off by default; when on, one-click demo entry, no outbound mail, nightly reset. */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDemo } from '../../worker/demo/mode';
import { memoryOutbox } from '../../worker/email/outbox';
import type { AppEnv } from '../../worker/env';
import { Agent, agentFor, claimAsOwner, createClient, resetDb, testEnv } from './helpers';

const demoEnv = { ...testEnv, DEMO_MODE: '1' } as AppEnv;

beforeEach(async () => {
  await resetDb();
});

describe('demo mode', () => {
  it('does not exist on a normal deployment', async () => {
    await claimAsOwner();
    const r = await new Agent().post('/api/demo-mode/session', { as: 'consultant' });
    expect(r.status).toBe(404);
    const config = (await (await new Agent().fetch('/api/public/config')).json()) as { demo: boolean };
    expect(config.demo).toBe(false);
  });

  it('waits for the portal to be claimed', async () => {
    const r = await new Agent().post('/api/demo-mode/session', { as: 'consultant' }, { env: demoEnv });
    expect(r.status).toBe(409);
  });

  it('lets visitors in as a demo consultant or client, on the sample client only', async () => {
    await claimAsOwner();
    const staff = new Agent();
    const r = await staff.post('/api/demo-mode/session', { as: 'consultant' }, { env: demoEnv });
    expect(await r.json()).toEqual({ redirect: '/workspace' });
    const me = (await (await staff.fetch('/api/me', { env: demoEnv })).json()) as { user: { role: string; email: string } };
    expect(me.user).toMatchObject({ role: 'consultant', email: 'consultant@demo.invalid' });
    const list = (await (await staff.fetch('/api/clients', { env: demoEnv })).json()) as { clients: { name: string }[] };
    expect(list.clients.map((c) => c.name)).toEqual(['Sample: Riverbend Community Pantry']);
    // Not an Owner: settings stay closed.
    expect((await staff.fetch('/api/settings/overview', { env: demoEnv })).status).toBe(403);
    // Read-only (spec §14): no writes at all from demo accounts.
    const clientId = (list.clients[0] as unknown as { id: string }).id;
    const write = await staff.fetch(`/api/clients/${clientId}/messages`, { method: 'POST', json: { body: 'hi' }, env: demoEnv });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: 'demo_read_only' });
    // The Owner can still work (and can't invite anyone while demo mode is on).
    const owner = await testEnv.DB.prepare("SELECT id FROM users WHERE role = 'owner'").first<{ id: string }>();
    const inv = await (await agentFor(owner?.id ?? '')).fetch(`/api/clients/${clientId}/invites`, { method: 'POST', json: { email: 'x@example.org', role: 'admin', delivery: 'link' }, env: demoEnv });
    expect(await inv.json()).toEqual({ error: 'demo_mode' });
    // Switching demo roles and signing out still work.
    expect((await staff.fetch('/auth/signout', { method: 'POST', json: {}, env: demoEnv })).status).toBeLessThan(400);

    const client = new Agent();
    expect(await (await client.post('/api/demo-mode/session', { as: 'client' }, { env: demoEnv })).json()).toEqual({ redirect: '/portal' });
    const home = await client.fetch('/api/portal/home', { env: demoEnv });
    expect(home.status).toBe(200);
  });

  it('sends no email except the Owner’s own sign-in mail', async () => {
    const owner = await claimAsOwner();
    await new Agent().post('/api/demo-mode/session', { as: 'client' }, { env: demoEnv });
    memoryOutbox.length = 0;
    await new Agent().post('/auth/magic/request', { email: 'client@demo.invalid' }, { env: demoEnv });
    await new Agent().post('/auth/magic/request', { email: owner.email }, { env: demoEnv });
    expect(memoryOutbox.map((m) => m.to)).toEqual([owner.email]);
    const blocked = await testEnv.DB.prepare("SELECT status FROM emails WHERE to_email = 'client@demo.invalid'").first<{ status: string }>();
    expect(blocked?.status).toBe('demo');
  });

  it('resets every night: clients wiped, demo sessions ended, the sample re-seeded', async () => {
    await claimAsOwner();
    const staff = new Agent();
    await staff.post('/api/demo-mode/session', { as: 'consultant' }, { env: demoEnv });
    await createClient('Scribbled by a visitor');
    await testEnv.FILES.put('clients/x/y', 'z');
    await resetDemo(testEnv); // off: nothing happens
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM clients').first<{ n: number }>())?.n).toBe(2);
    await resetDemo(demoEnv);
    const names = await testEnv.DB.prepare('SELECT name FROM clients').all<{ name: string }>();
    expect(names.results.map((r) => r.name)).toEqual(['Sample: Riverbend Community Pantry']);
    expect((await staff.fetch('/api/me', { env: demoEnv })).status).toBe(401);
    const owner = await testEnv.DB.prepare("SELECT id FROM users WHERE role = 'owner'").first<{ id: string }>();
    expect((await (await agentFor(owner?.id ?? '')).fetch('/api/me', { env: demoEnv })).status).toBe(200);
  });
});
