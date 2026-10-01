/**
 * Generated authorization test (CLAUDE.md non-negotiable 4, spec §7.3).
 *
 * Every route registered on the app must appear in POLICY, so adding a route
 * without deciding who may call it fails this test. Each route is then called
 * as every kind of actor, and cross-client (IDOR) access is checked for every
 * client-scoped route.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker, { app } from '../../worker/index';
import type { AppEnv } from '../../worker/env';
import { newId } from '../../worker/lib/ids';
import { addMember, Agent, agentFor, assign, claimAsOwner, createClient, createUser, resetDb, testEnv } from './helpers';

/**
 * clientScoped*: reached through a client ID. `clientScoped` lets the
 * client's staff and all of its users in; `Admin` only its admins; `Staff`
 * only staff; `Owner` only the Owner. `file` is the download route.
 */
type Policy =
  | 'public'
  | 'auth'
  | 'staffAccount'
  | 'staff'
  | 'owner'
  | 'client'
  | 'clientScoped'
  | 'clientScopedAdmin'
  | 'clientScopedStaff'
  | 'clientScopedOwner'
  | 'file';

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
  'GET /api/clients/:clientId': 'clientScoped',
  'PATCH /api/clients/:clientId': 'clientScopedAdmin',
  'PUT /api/clients/:clientId/ein': 'clientScopedStaff',
  'POST /api/clients/:clientId/ein/reveal': 'clientScopedStaff',
  'PUT /api/clients/:clientId/assignments': 'clientScopedOwner',
  'GET /api/clients/:clientId/overview': 'clientScoped',
  'GET /api/clients/:clientId/timeline': 'clientScopedStaff',
  'GET /api/clients/:clientId/members': 'clientScoped',
  'POST /api/clients/:clientId/invites': 'clientScopedAdmin',
  'POST /api/clients/:clientId/members/:userId/revoke-sessions': 'clientScopedStaff',
  'GET /api/clients/:clientId/files': 'clientScoped',
  'PATCH /api/clients/:clientId/files/:fileId': 'clientScopedStaff',
  'DELETE /api/clients/:clientId/files/:fileId': 'clientScoped',
  'POST /api/clients/:clientId/uploads': 'clientScoped',
  'GET /api/clients/:clientId/uploads/:fileId': 'clientScoped',
  'PUT /api/clients/:clientId/uploads/:fileId': 'clientScoped',
  'PUT /api/clients/:clientId/uploads/:fileId/parts/:n': 'clientScoped',
  'POST /api/clients/:clientId/uploads/:fileId/complete': 'clientScoped',
  'DELETE /api/clients/:clientId/uploads/:fileId': 'clientScoped',
  'GET /api/clients/:clientId/requests': 'clientScoped',
  'POST /api/clients/:clientId/requests': 'clientScopedStaff',
  'PATCH /api/clients/:clientId/requests/:requestId': 'clientScopedStaff',
  'PUT /api/clients/:clientId/requests/:requestId/items/:itemId/file': 'clientScoped',
  'DELETE /api/clients/:clientId/requests/:requestId/items/:itemId/file': 'clientScopedStaff',
  'GET /api/clients/:clientId/deliverables': 'clientScoped',
  'POST /api/clients/:clientId/deliverables': 'clientScopedStaff',
  'POST /api/clients/:clientId/deliverables/from-template': 'clientScopedStaff',
  'GET /api/clients/:clientId/deliverables/:deliverableId': 'clientScoped',
  'PATCH /api/clients/:clientId/deliverables/:deliverableId': 'clientScopedStaff',
  'DELETE /api/clients/:clientId/deliverables/:deliverableId': 'clientScopedStaff',
  'POST /api/clients/:clientId/deliverables/:deliverableId/versions': 'clientScoped',
  'POST /api/clients/:clientId/deliverables/:deliverableId/versions/:versionId/decision': 'clientScoped',
  'GET /api/clients/:clientId/messages': 'clientScoped',
  'POST /api/clients/:clientId/messages': 'clientScoped',
  'POST /api/clients/:clientId/messages/read': 'clientScoped',
  'GET /api/clients/:clientId/updates': 'clientScoped',
  'POST /api/clients/:clientId/updates/preview': 'clientScopedStaff',
  'POST /api/clients/:clientId/updates': 'clientScopedStaff',
  'POST /api/clients/:clientId/updates/:updateId/send': 'clientScopedStaff',
  'POST /api/clients/:clientId/updates/:updateId/cancel': 'clientScopedStaff',
  'PATCH /api/clients/:clientId/updates/schedules/:scheduleId': 'clientScopedStaff',
  'DELETE /api/clients/:clientId/updates/schedules/:scheduleId': 'clientScopedStaff',
  'GET /api/today': 'staff',
  'PUT /api/me/preferences': 'auth',
  'POST /api/settings/email/webhook': 'owner',
  'PUT /api/settings/org': 'owner',
  'GET /api/system/health': 'owner',
  'POST /api/system/jobs/:key/retry': 'owner',
  'GET /api/calendar-feeds': 'auth',
  'POST /api/calendar-feeds': 'auth',
  'DELETE /api/calendar-feeds/:id': 'auth',
  'GET /ics/:file': 'public',
  'POST /u/:token': 'public',
  'POST /webhooks/resend': 'public',
  'GET /api/templates': 'staff',
  'POST /api/templates': 'staff',
  'PUT /api/templates/:id': 'staff',
  'DELETE /api/templates/:id': 'staff',
  'GET /f/:fileId': 'file',
  'POST /api/demo': 'owner',
  'DELETE /api/demo': 'owner',
  'GET /api/portal/home': 'client',
  'GET /api/system/secrets': 'owner',
  'GET /api/clients/:clientId/opportunities': 'clientScoped',
  'POST /api/clients/:clientId/opportunities': 'clientScopedStaff',
  'POST /api/clients/:clientId/opportunities/import': 'clientScopedStaff',
  'POST /api/clients/:clientId/opportunities/from-opengrants': 'clientScopedStaff',
  'GET /api/clients/:clientId/opportunities/:opportunityId': 'clientScoped',
  'PATCH /api/clients/:clientId/opportunities/:opportunityId': 'clientScopedStaff',
  'DELETE /api/clients/:clientId/opportunities/:opportunityId': 'clientScopedStaff',
  'GET /api/pipeline': 'staff',
  'GET /api/clients/:clientId/reports': 'clientScoped',
  'POST /api/clients/:clientId/reports': 'clientScopedStaff',
  'GET /api/clients/:clientId/reports/:reportId': 'clientScoped',
  'PATCH /api/clients/:clientId/reports/:reportId': 'clientScopedStaff',
  'DELETE /api/clients/:clientId/reports/:reportId': 'clientScopedStaff',
  'POST /api/clients/:clientId/reports/:reportId/items': 'clientScopedStaff',
  'PATCH /api/clients/:clientId/reports/:reportId/items/:opportunityId': 'clientScopedStaff',
  'DELETE /api/clients/:clientId/reports/:reportId/items/:opportunityId': 'clientScopedStaff',
  'PUT /api/clients/:clientId/reports/:reportId/order': 'clientScopedStaff',
  'POST /api/clients/:clientId/reports/:reportId/send': 'clientScopedStaff',
  'POST /api/clients/:clientId/reports/:reportId/items/:opportunityId/respond': 'clientScoped',
  'GET /api/clients/:clientId/reports/:reportId/pdf': 'clientScoped',
  'POST /api/clients/:clientId/funding/match': 'clientScopedStaff',
  'GET /api/clients/:clientId/alerts': 'clientScopedStaff',
  'POST /api/clients/:clientId/alerts': 'clientScopedStaff',
  'PATCH /api/clients/:clientId/alerts/:alertId': 'clientScopedStaff',
  'DELETE /api/clients/:clientId/alerts/:alertId': 'clientScopedStaff',
  'POST /api/clients/:clientId/alerts/:alertId/run': 'clientScopedStaff',
  'GET /api/clients/:clientId/alerts/matches': 'clientScopedStaff',
  'POST /api/clients/:clientId/alerts/matches/:matchId/add': 'clientScopedStaff',
  'POST /api/clients/:clientId/alerts/matches/:matchId/dismiss': 'clientScopedStaff',
  'GET /api/funding/status': 'staff',
  'GET /api/funding/search': 'staff',
  'GET /api/funding/listings/:kind/:ogId': 'staff',
  'GET /api/funding/funders': 'staff',
  'GET /api/funding/funders/:funderId': 'staff',
  'DELETE /api/clients/:clientId': 'clientScopedOwner',
  'PATCH /api/team/:userId': 'owner',
  'DELETE /api/team/:userId': 'owner',
  'DELETE /api/team/:userId/passkeys': 'owner',
  'DELETE /api/team/invites/:inviteId': 'owner',
  'GET /api/audit': 'owner',
  'GET /api/audit/export': 'owner',
  'GET /api/data/export': 'owner',
  'POST /api/demo-mode/session': 'public',
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

/** One of everything client-scoped, so sub-resource routes are called with real IDs. */
interface Fixture {
  fileId: string;
  internalFileId: string;
  requestId: string;
  itemId: string;
  deliverableId: string;
  versionId: string;
  updateId: string;
  scheduleId: string;
  opportunityId: string;
  reportId: string;
  alertId: string;
  matchId: string;
}

async function fixtureFor(clientId: string, ownerId: string): Promise<Fixture> {
  const now = Date.now();
  const f = {
    fileId: newId('fil'),
    internalFileId: newId('fil'),
    requestId: newId('dr'),
    itemId: newId('dri'),
    deliverableId: newId('dlv'),
    versionId: newId('dvv'),
    updateId: newId('upd'),
    scheduleId: newId('sch'),
    opportunityId: newId('opp'),
    reportId: newId('rpt'),
    alertId: newId('alr'),
    matchId: newId('alm'),
  };
  const file = (id: string, shared: number) =>
    testEnv.DB.prepare(
      `INSERT INTO files (id, client_id, r2_key, filename, mime, size, upload_status, shared_with_client, uploaded_by, created_at, completed_at)
       VALUES (?, ?, ?, 'budget.pdf', 'application/pdf', 9, 'complete', ?, ?, ?, ?)`,
    ).bind(id, clientId, `clients/${clientId}/${id}`, shared, ownerId, now, now);
  await testEnv.DB.batch([
    file(f.fileId, 1),
    file(f.internalFileId, 0),
    testEnv.DB.prepare("INSERT INTO doc_requests (id, client_id, title, status, created_at) VALUES (?, ?, 'Docs', 'open', ?)").bind(f.requestId, clientId, now),
    testEnv.DB.prepare("INSERT INTO doc_request_items (id, doc_request_id, label) VALUES (?, ?, 'W-9')").bind(f.itemId, f.requestId),
    testEnv.DB.prepare(
      "INSERT INTO deliverables (id, client_id, title, side, status, created_at) VALUES (?, ?, 'Narrative', 'consultant', 'in_review', ?)",
    ).bind(f.deliverableId, clientId, now),
    testEnv.DB.prepare('INSERT INTO deliverable_versions (id, deliverable_id, file_id, version, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)').bind(
      f.versionId,
      f.deliverableId,
      f.fileId,
      ownerId,
      now,
    ),
    testEnv.DB.prepare(
      "INSERT INTO schedules (id, client_id, kind, rrule, timezone, next_run_at, config_json, requires_review, enabled, created_at) VALUES (?, ?, 'update', 'FREQ=WEEKLY;BYDAY=MO', 'UTC', ?, '{\"subject\":\"x\",\"intro\":null,\"blocks\":[]}', 1, 1, ?)",
    ).bind(f.scheduleId, clientId, now + 86_400_000, now),
    testEnv.DB.prepare("INSERT INTO updates (id, client_id, subject, blocks_json, status, created_at) VALUES (?, ?, 'Update', '[]', 'pending_review', ?)").bind(
      f.updateId,
      clientId,
      now,
    ),
  ]);
  const alertSchedule = newId('sch');
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO opportunities (id, client_id, source, title, stage, created_at) VALUES (?, ?, 'manual', 'Community grant', 'researching', ?)",
    ).bind(f.opportunityId, clientId, now),
    testEnv.DB.prepare("INSERT INTO reports (id, client_id, title, status, sent_at, created_at) VALUES (?, ?, 'Report', 'sent', ?, ?)").bind(f.reportId, clientId, now, now),
    testEnv.DB.prepare('INSERT INTO report_items (report_id, opportunity_id, position) VALUES (?, ?, 0)').bind(f.reportId, f.opportunityId),
    testEnv.DB.prepare(
      "INSERT INTO schedules (id, client_id, kind, rrule, timezone, next_run_at, config_json, requires_review, enabled, created_at) VALUES (?, ?, 'alert', 'FREQ=WEEKLY;BYDAY=MO', 'UTC', ?, ?, 1, 1, ?)",
    ).bind(alertSchedule, clientId, now + 86_400_000, JSON.stringify({ alertId: f.alertId }), now),
    testEnv.DB.prepare("INSERT INTO alerts (id, client_id, query_json, schedule_id, name, mode, created_at) VALUES (?, ?, '{}', ?, 'Weekly', 'review', ?)").bind(
      f.alertId,
      clientId,
      alertSchedule,
      now,
    ),
    testEnv.DB.prepare("INSERT INTO alert_matches (id, alert_id, client_id, og_id, data_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?)").bind(
      f.matchId,
      f.alertId,
      clientId,
      `og-${clientId}`,
      JSON.stringify({ ogId: `og-${clientId}`, kind: 'grant', title: 'Matched grant', funderName: null, url: null, amountMin: null, amountMax: null, deadlineAt: null, fitScore: null, eligibilityNotes: null, summary: null }),
      now,
    ),
  ]);
  await testEnv.FILES.put(`clients/${clientId}/${f.fileId}`, '%PDF-1.4\n');
  await testEnv.FILES.put(`clients/${clientId}/${f.internalFileId}`, '%PDF-1.4\n');
  return f;
}

/** Errors that mean "the authorization layer said no", as opposed to a handler's business rule. */
const DENIED = new Set(['unauthenticated', 'forbidden', 'not_found', 'passkey_enrollment_required']);

describe('authorization per route', () => {
  let ids: { clientA: string; clientB: string; memberA: string; owner: string; consA: string; consOther: string; adminA: string; adminB: string };
  let fx: { A: Fixture; B: Fixture };

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
    fx = { A: await fixtureFor(clientA, owner.id), B: await fixtureFor(clientB, owner.id) };
  });

  /** Fills route params. `res` picks whose sub-resources to use (defaults to the client's own). */
  const concrete = (path: string, clientId: string, res?: Fixture) => {
    const r = res ?? (clientId === ids.clientB ? fx.B : fx.A);
    return path
      .replace(':clientId', clientId)
      .replace(':userId', ids.memberA)
      .replace(':fileId', r.fileId)
      .replace(':requestId', r.requestId)
      .replace(':itemId', r.itemId)
      .replace(':deliverableId', r.deliverableId)
      .replace(':versionId', r.versionId)
      .replace(':updateId', r.updateId)
      .replace(':scheduleId', r.scheduleId)
      .replace(':opportunityId', r.opportunityId)
      .replace(':reportId', r.reportId)
      .replace(':alertId', r.alertId)
      .replace(':matchId', r.matchId)
      .replace(':kind', 'grant')
      .replace(':ogId', 'og-1')
      .replace(':funderId', 'f-1')
      .replace(':inviteId', 'mlk_01J00000000000000000000000')
      .replace(':key', 'x')
      .replace(':n', '1')
      .replace(':id', 'x_01J00000000000000000000000')
      .replace(':step', 'brand')
      .replace(':slot', 'logo-light');
  };

  async function hit(
    route: string,
    actor: string | null,
    clientId = ids.clientA,
    res?: Fixture,
    json: unknown = {},
  ): Promise<{ status: number; error: string | null }> {
    const [method = 'GET', path = '/'] = route.split(' ');
    const agent = actor ? await agentFor(actor) : new Agent();
    const r = await agent.fetch(concrete(path, clientId, res), { method, json: method === 'GET' ? undefined : json });
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return { status: r.status, error: typeof body.error === 'string' ? body.error : null };
  }

  /**
   * Allowed = the authorization layer let the call through (a handler may still
   * reject the empty body or apply a business rule). A not-found is tolerated
   * only where the route legitimately has nothing to find for this actor:
   * routes without a client ID, uploads (owned by their uploader), and deletes
   * (an earlier actor may have removed the fixture).
   */
  function allowed(route: string, r: { status: number; error: string | null }): boolean {
    if (r.status === 401 || (r.status === 403 && r.error && DENIED.has(r.error))) return false;
    if (r.status === 404) return !route.includes(':clientId') || route.includes('/uploads/') || route.startsWith('DELETE ');
    return true;
  }

  // Deletes run last so the fixtures they remove are still there for everything else.
  const ordered = Object.entries(POLICY).sort(([a], [b]) => Number(a.startsWith('DELETE ')) - Number(b.startsWith('DELETE ')));

  for (const [route, policy] of ordered) {
    if (policy === 'public') continue;

    it(`${route} [${policy}]`, async () => {
      expect((await hit(route, null)).status, 'anonymous').toBe(401);
      const expectAllowed = async (actor: string, label: string, clientId?: string) => {
        const r = await hit(route, actor, clientId);
        expect(allowed(route, r), `${label} got ${r.status} ${r.error}`).toBe(true);
      };
      const expectHidden = async (actor: string, label: string, clientId = ids.clientA) => {
        expect((await hit(route, actor, clientId)).status, label).toBe(404);
      };

      switch (policy) {
        case 'auth':
          for (const actor of [ids.adminA, ids.consA, ids.owner]) await expectAllowed(actor, actor);
          break;
        case 'staffAccount':
        case 'staff':
          expect((await hit(route, ids.adminA)).status, 'client user').toBe(403);
          for (const actor of [ids.consA, ids.owner]) await expectAllowed(actor, actor);
          break;
        case 'owner':
          expect((await hit(route, ids.adminA)).status, 'client user').toBe(403);
          expect((await hit(route, ids.consA)).status, 'consultant').toBe(403);
          await expectAllowed(ids.owner, 'owner');
          break;
        case 'client':
          expect((await hit(route, ids.owner)).status, 'owner').toBe(403);
          expect((await hit(route, ids.consA)).status, 'consultant').toBe(403);
          await expectAllowed(ids.adminA, 'client');
          break;
        case 'clientScopedOwner':
          expect((await hit(route, ids.adminA)).status, 'client admin').toBe(403);
          expect((await hit(route, ids.consA)).status, 'assigned consultant').toBe(403);
          await expectHidden(ids.owner, 'owner, unknown client', 'cli_01J00000000000000000000000');
          await expectAllowed(ids.owner, 'owner');
          break;
        case 'clientScoped':
        case 'clientScopedAdmin':
        case 'clientScopedStaff':
          // IDOR: nobody outside the client reaches it, and nothing tells them it exists.
          await expectHidden(ids.adminB, 'client admin of B');
          await expectHidden(ids.consOther, 'unassigned consultant');
          await expectHidden(ids.consA, 'consultant of A on client B', ids.clientB);
          await expectHidden(ids.consA, 'unknown client', 'cli_01J00000000000000000000000');
          await expectHidden(ids.consA, 'malformed id', "cli_' OR 1=1 --");
          if (policy === 'clientScopedStaff') await expectHidden(ids.adminA, 'client admin of A (staff-only route)');
          if (policy !== 'clientScoped') await expectHidden(ids.memberA, 'client member of A');
          if (policy === 'clientScoped') await expectAllowed(ids.memberA, 'client member of A');
          if (policy !== 'clientScopedStaff') await expectAllowed(ids.adminA, 'client admin of A');
          await expectAllowed(ids.consA, 'assigned consultant');
          await expectAllowed(ids.owner, 'owner');
          break;
        case 'file':
          await expectHidden(ids.adminB, 'client admin of B');
          await expectHidden(ids.consOther, 'unassigned consultant');
          await expectAllowed(ids.adminA, 'client admin of A');
          await expectAllowed(ids.consA, 'assigned consultant');
          break;
      }
    });
  }

  describe('cross-client sub-resources', () => {
    // Every route that names a row inside a client, called with client A's ID
    // but client B's row. Scoping only by the URL's client would leak B here.
    const nested = Object.entries(POLICY).filter(
      ([route, p]) => p.startsWith('clientScoped') && /:(fileId|requestId|itemId|deliverableId|versionId|updateId|scheduleId|opportunityId|reportId|alertId|matchId)/.test(route),
    );
    // Valid bodies, so validation can't answer before the lookup does.
    const body = (route: string): unknown => {
      if (route.endsWith('/items/:itemId/file')) return { fileId: fx.A.fileId };
      if (route.endsWith('/versions')) return { url: 'https://docs.example.org/v' };
      if (route.endsWith('/decision')) return { decision: 'approved' };
      if (route.endsWith('/respond')) return { response: 'pursue' };
      if (route.endsWith('/reports/:reportId/items')) return { opportunityId: fx.A.opportunityId };
      if (route.endsWith('/order')) return { opportunityIds: [] };
      if (route.startsWith('PATCH ')) return { title: 'x' };
      return {};
    };
    for (const [route] of nested) {
      it(`${route} with another client's row is not found`, async () => {
        for (const actor of [ids.consA, ids.owner, ids.adminA]) {
          const r = await hit(route, actor, ids.clientA, fx.B, body(route));
          expect([403, 404], `${actor}: ${r.status} ${r.error}`).toContain(r.status);
          if (r.status === 403) expect(DENIED.has(r.error ?? ''), `${actor} leaked ${r.error}`).toBe(true);
        }
      });
    }

    it('body references to another client\'s rows are not found', async () => {
      const owner = await agentFor(ids.owner);
      const A = ids.clientA;
      const cases: [string, string, unknown][] = [
        ['PUT', `/api/clients/${A}/requests/${fx.A.requestId}/items/${fx.A.itemId}/file`, { fileId: fx.B.fileId }],
        ['POST', `/api/clients/${A}/deliverables/${fx.A.deliverableId}/versions`, { fileId: fx.B.fileId }],
        ['POST', `/api/clients/${A}/messages`, { body: 'hi', attachments: [fx.B.fileId] }],
        ['POST', `/api/clients/${A}/messages`, { body: 'hi', thread: fx.B.deliverableId }],
        ['GET', `/api/clients/${A}/messages?thread=${fx.B.deliverableId}`, undefined],
      ];
      for (const [method, path, json] of cases) {
        const r = await owner.fetch(path, { method, json });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
    });

    it('client users never see internal files, directly or by ID', async () => {
      const admin = await agentFor(ids.adminA);
      const list = (await (await admin.fetch(`/api/clients/${ids.clientA}/files`)).json()) as { files: { id: string }[] };
      expect(list.files.map((f) => f.id)).toContain(fx.A.fileId);
      expect(list.files.map((f) => f.id)).not.toContain(fx.A.internalFileId);
      expect((await admin.fetch(`/f/${fx.A.internalFileId}`)).status).toBe(404);
      expect((await admin.fetch(`/f/${fx.B.fileId}`)).status).toBe(404);
      const r = await admin.fetch(`/api/clients/${ids.clientA}/messages`, { method: 'POST', json: { body: 'x', attachments: [fx.A.internalFileId] } });
      expect(r.status).toBe(404);
    });
  });
});

describe('dev-only endpoints', () => {
  it('the dev outbox does not exist in production', async () => {
    const prod = { ...testEnv, APP_ENV: 'production' } as AppEnv;
    const res = await new Agent().fetch('/api/dev/outbox', { env: prod });
    expect(res.status).toBe(404);
  });

  it('a development build that reached a real deployment still keeps the outbox closed', async () => {
    const outbox = async (url: string, env: AppEnv) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(url), env, ctx);
      await waitOnExecutionContext(ctx);
      return res.status;
    };
    const dev = { ...testEnv, APP_ENV: 'development' } as AppEnv;
    expect(await outbox('http://localhost:4173/api/dev/outbox', dev)).toBe(200);
    expect(await outbox('http://127.0.0.1:5173/api/dev/outbox', dev)).toBe(200);
    // Served on a real hostname, or with a Resend key set: a deployment, not a laptop.
    expect(await outbox('https://portal.example.workers.dev/api/dev/outbox', dev)).toBe(404);
    expect(await outbox('https://clients.example.com/api/dev/outbox', dev)).toBe(404);
    expect(await outbox('http://localhost:4173/api/dev/outbox', { ...dev, RESEND_API_KEY: 're_live_key' })).toBe(404);
  });
});
