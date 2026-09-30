/**
 * Calendar feeds under the staff rules (D-079). Making a staff feed needs the
 * passkey the Owner requires, a recent step-up, and an allowed network;
 * fetching one re-applies the passkey requirement and the staff IP allowlist.
 * Client users' feeds are never restricted by those rules (D-075).
 * Token scoping and revocation are covered in authz.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { setSetting, SETTINGS } from '../../worker/lib/settings';
import { addMember, Agent, agentFor, assign, claimAsOwner, createClient, createUser, resetDb, testEnv } from './helpers';

const OFFICE = '203.0.113.0/24';
const IN_OFFICE = '203.0.113.20';
/** Somewhere else, e.g. a calendar service's servers or a phone on mobile data. */
const OUTSIDE = '198.51.100.7';

let clientId: string;
let ids: { cons: string; admin: string };

beforeEach(async () => {
  await resetDb();
  await claimAsOwner();
  clientId = await createClient('Acme');
  const cons = await createUser('consultant');
  await assign(clientId, cons.id);
  const admin = await createUser('client_admin');
  await addMember(clientId, admin.id);
  ids = { cons: cons.id, admin: admin.id };
});

const allowlist = (list: string[]) => setSetting(testEnv, 'security', SETTINGS.security.parse({ staffIpAllowlist: list }));
const requirePasskey = (userId: string) => testEnv.DB.prepare('UPDATE users SET passkey_required = 1 WHERE id = ?').bind(userId).run();

async function feedPath(agent: Agent, forClient: string | null = null): Promise<string> {
  const r = await agent.post('/api/calendar-feeds', { clientId: forClient });
  expect(r.status).toBe(201);
  return new URL(((await r.json()) as { url: string }).url).pathname;
}

describe('making a staff feed', () => {
  it('follows the passkey requirement, like every staff API; revoking stays open', async () => {
    await requirePasskey(ids.cons);
    const cons = await agentFor(ids.cons);
    for (const scope of [null, clientId]) {
      const r = await cons.post('/api/calendar-feeds', { clientId: scope });
      expect(r.status, String(scope)).toBe(403);
      expect(await r.json()).toEqual({ error: 'passkey_enrollment_required' });
    }
    expect(await (await cons.fetch('/api/calendar-feeds')).json()).toEqual({ error: 'passkey_enrollment_required' });
    expect((await cons.fetch('/api/calendar-feeds/cal_01J00000000000000000000000', { method: 'DELETE' })).status).toBe(404);
  });

  it('needs a recent step-up from staff, since the URL outlives the session; client users need none', async () => {
    const stale = await agentFor(ids.cons, { stepUp: false });
    for (const scope of [null, clientId]) {
      const r = await stale.post('/api/calendar-feeds', { clientId: scope });
      expect(r.status, String(scope)).toBe(403);
      expect(await r.json()).toEqual({ error: 'step_up_required' });
    }
    await feedPath(await agentFor(ids.cons));
    await feedPath(await agentFor(ids.admin, { stepUp: false }), clientId);
  });

  it('is refused from outside the staff IP allowlist, and says when the feed will only load in the office', async () => {
    await allowlist([OFFICE]);
    const cons = await agentFor(ids.cons);
    cons.ip = OUTSIDE;
    expect((await cons.post('/api/calendar-feeds', {})).status).toBe(401);
    cons.ip = IN_OFFICE;
    const r = await cons.post('/api/calendar-feeds', {});
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ ipRestricted: true });

    const admin = await agentFor(ids.admin);
    admin.ip = OUTSIDE;
    const c = await admin.post('/api/calendar-feeds', { clientId });
    expect(c.status).toBe(201);
    expect(await c.json()).toMatchObject({ ipRestricted: false });
  });
});

describe('fetching a staff feed', () => {
  it('is refused from outside the staff IP allowlist; client feeds are not', async () => {
    const staffFeed = await feedPath(await agentFor(ids.cons));
    const clientFeed = await feedPath(await agentFor(ids.admin), clientId);
    await allowlist([OFFICE]);

    const outside = await new Agent({ ip: OUTSIDE }).fetch(staffFeed);
    expect(outside.status).toBe(403);
    expect(outside.headers.get('Content-Type')).not.toMatch(/calendar/);
    expect(await outside.text()).not.toContain('Acme');
    expect((await new Agent({ ip: IN_OFFICE }).fetch(staffFeed)).status).toBe(200);
    expect((await new Agent({ ip: OUTSIDE }).fetch(clientFeed)).status).toBe(200);

    // Held back, not revoked: without the allowlist it loads from anywhere again.
    await allowlist([]);
    expect((await new Agent({ ip: OUTSIDE }).fetch(staffFeed)).status).toBe(200);
  });

  it('stops while its owner has to enroll a passkey, and works again once they have', async () => {
    const all = await feedPath(await agentFor(ids.cons));
    const one = await feedPath(await agentFor(ids.cons), clientId);
    await requirePasskey(ids.cons);
    for (const path of [all, one]) {
      const r = await new Agent().fetch(path);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'passkey_enrollment_required' });
    }
    await testEnv.DB.prepare("INSERT INTO passkeys (id, user_id, credential_id, public_key, sign_count, created_at) VALUES ('pk_01J00000000000000000000000', ?, 'cred-1', x'01', 0, ?)")
      .bind(ids.cons, Date.now())
      .run();
    for (const path of [all, one]) expect((await new Agent().fetch(path)).status).toBe(200);
  });
});
