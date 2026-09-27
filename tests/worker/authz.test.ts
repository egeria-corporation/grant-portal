/**
 * Generated authorization test (CLAUDE.md non-negotiable 4, spec §7.3).
 *
 * Every route registered on the app must appear in POLICY, so adding a route
 * without deciding who may call it fails this test. Each route is then called
 * as every kind of actor, and cross-client (IDOR) access is checked for every
 * client-scoped route.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../worker/index';
import type { AppEnv } from '../../worker/env';
import { addMember, Agent, agentFor, assign, claimAsOwner, createClient, createUser, resetDb, testEnv } from './helpers';

type Policy = 'public' | 'auth' | 'staffAccount' | 'staff' | 'owner' | 'client' | 'clientScopedStaff';

const POLICY: Record<string, Policy> = {
  'GET /healthz': 'public',
  'GET /brand/theme.css': 'public',
  'GET /brand/icon.svg': 'public',
  'GET /brand/manifest.webmanifest': 'public',
  'GET /brand/og.png': 'public',
  'GET /brand/asset/:slot': 'public',
  'POST /auth/magic/request': 'public',
  'POST /auth/link/peek': 'public',
  'POST /auth/link/consume': 'public',
  'POST /auth/code/verify': 'public',
  'POST /auth/passkey/options': 'public',
  'POST /auth/passkey/verify': 'public',
  'POST /auth/signout': 'public',
  'POST /auth/passkey/register/options': 'staffAccount',
  'POST /auth/passkey/register/verify': 'staffAccount',
  'POST /auth/signout-all': 'auth',
  'GET /api/public/config': 'public',
  'GET /api/dev/outbox': 'public',
  'GET /api/setup/status': 'public',
  'POST /api/setup/claim': 'public',
  'POST /api/setup/setup-code': 'public',
  'POST /api/setup/claim-with-code': 'public',
  'PUT /api/setup/steps/:step': 'owner',
  'GET /api/setup/progress': 'owner',
  'POST /api/setup/complete': 'owner',
  'GET /api/me': 'auth',
  'GET /api/sessions': 'auth',
  'DELETE /api/sessions/:id': 'auth',
  'GET /api/passkeys': 'auth',
  'DELETE /api/passkeys/:id': 'auth',
  'GET /api/settings/overview': 'owner',
  'PUT /api/settings/brand': 'owner',
  'GET /api/settings/brand': 'owner',
  'PUT /api/settings/brand/assets/:slot': 'owner',
  'DELETE /api/settings/brand/assets/:slot': 'owner',
  'GET /api/settings/email': 'owner',
  'PUT /api/settings/email': 'owner',
  'POST /api/settings/email/verify': 'owner',
  'POST /api/settings/email/cloudflare-dns': 'owner',
  'PUT /api/settings/cloudflare-token': 'owner',
  'DELETE /api/settings/cloudflare-token': 'owner',
  'PUT /api/settings/domain': 'owner',
  'PUT /api/settings/opengrants': 'owner',
  'DELETE /api/settings/opengrants': 'owner',
  'PUT /api/settings/turnstile': 'owner',
  'DELETE /api/settings/turnstile': 'owner',
  'PUT /api/settings/security': 'owner',
  'GET /api/team': 'owner',
  'POST /api/team/invites': 'owner',
  'GET /api/clients': 'staff',
  'POST /api/clients': 'staff',
  'GET /api/clients/:clientId/members': 'clientScopedStaff',
  'POST /api/clients/:clientId/invites': 'clientScopedStaff',
  'POST /api/clients/:clientId/members/:userId/revoke-sessions': 'clientScopedStaff',
  'POST /api/demo': 'owner',
  'DELETE /api/demo': 'owner',
  'GET /api/portal/home': 'client',
  'GET /api/system/secrets': 'owner',
};

/** Concrete routes from the Hono router, minus middleware and the SPA/404 fallbacks. */
function registeredRoutes(): string[] {
  const out = new Set<string>();
  for (const r of app.routes) {
    if (r.method === 'ALL') continue;
    if (r.path === '/*' || r.path.endsWith('/*')) continue;
    out.add(`${r.method} ${r.path.replace(/\/$/, '') || '/'}`);
  }
  return [...out].sort();
}

describe('route inventory', () => {
  it('every registered route has an authorization policy (and vice versa)', () => {
    expect(registeredRoutes()).toEqual(Object.keys(POLICY).sort());
  });
});

describe('authorization per route', () => {
  let ids: { clientA: string; clientB: string; memberA: string; owner: string; consA: string; consOther: string; adminA: string; adminB: string };

  beforeAll(async () => {
    await resetDb();
    const owner = await claimAsOwner();
    const clientA = await createClient('A');
    const clientB = await createClient('B');
    const consA = await createUser('consultant');
    const consOther = await createUser('consultant');
    await assign(clientA, consA.id);
    const adminA = await createUser('client_admin');
    const adminB = await createUser('client_admin');
    const memberA = await createUser('client_member');
    await addMember(clientA, adminA.id, 'admin');
    await addMember(clientA, memberA.id, 'member');
    await addMember(clientB, adminB.id, 'admin');
    ids = { clientA, clientB, memberA: memberA.id, owner: owner.id, consA: consA.id, consOther: consOther.id, adminA: adminA.id, adminB: adminB.id };
  });

  const concrete = (path: string, clientId: string) =>
    path
      .replace(':clientId', clientId)
      .replace(':userId', ids.memberA)
      .replace(':id', 'x_01J00000000000000000000000')
      .replace(':step', 'brand')
      .replace(':slot', 'logo-light');

  async function hit(route: string, actor: string | null, clientId = ids.clientA): Promise<number> {
    const [method = 'GET', path = '/'] = route.split(' ');
    const agent = actor ? await agentFor(actor) : new Agent();
    const res = await agent.fetch(concrete(path, clientId), { method, json: method === 'GET' ? undefined : {} });
    return res.status;
  }

  for (const [route, policy] of Object.entries(POLICY)) {
    if (policy === 'public') continue;

    it(`${route} [${policy}]`, async () => {
      expect(await hit(route, null), 'anonymous').toBe(401);

      const allowed = (s: number) => ![401, 403, 404].includes(s) || (s === 404 && !route.includes(':clientId'));
      switch (policy) {
        case 'auth':
          for (const actor of [ids.adminA, ids.consA, ids.owner]) expect(allowed(await hit(route, actor)), actor).toBe(true);
          break;
        case 'staffAccount':
        case 'staff':
          expect(await hit(route, ids.adminA), 'client user').toBe(403);
          for (const actor of [ids.consA, ids.owner]) expect(allowed(await hit(route, actor)), actor).toBe(true);
          break;
        case 'owner':
          expect(await hit(route, ids.adminA), 'client user').toBe(403);
          expect(await hit(route, ids.consA), 'consultant').toBe(403);
          expect(allowed(await hit(route, ids.owner)), 'owner').toBe(true);
          break;
        case 'client':
          expect(await hit(route, ids.owner), 'owner').toBe(403);
          expect(await hit(route, ids.consA), 'consultant').toBe(403);
          expect(allowed(await hit(route, ids.adminA)), 'client').toBe(true);
          break;
        case 'clientScopedStaff':
          // IDOR: nobody outside the client's staff reaches it, and nothing tells them it exists.
          expect(await hit(route, ids.adminA), 'client admin of A (staff-only route)').toBe(404);
          expect(await hit(route, ids.adminB), 'client admin of B').toBe(404);
          expect(await hit(route, ids.consOther), 'unassigned consultant').toBe(404);
          expect(await hit(route, ids.consA, ids.clientB), 'consultant of A on client B').toBe(404);
          expect(await hit(route, ids.consA, 'cli_01J00000000000000000000000'), 'unknown client').toBe(404);
          expect(await hit(route, ids.consA, "cli_' OR 1=1 --"), 'malformed id').toBe(404);
          expect(allowed(await hit(route, ids.consA)), 'assigned consultant').toBe(true);
          expect(allowed(await hit(route, ids.owner)), 'owner').toBe(true);
          break;
      }
    });
  }
});

describe('dev-only endpoints', () => {
  it('the dev outbox does not exist in production', async () => {
    const prod = { ...testEnv, APP_ENV: 'production' } as AppEnv;
    const res = await new Agent().fetch('/api/dev/outbox', { env: prod });
    expect(res.status).toBe(404);
  });
});
