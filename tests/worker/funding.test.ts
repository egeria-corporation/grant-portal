/**
 * M5: opportunities, pipeline, funding reports, the OpenGrants provider
 * (against a mock of the committed spec's endpoints), alerts and the review
 * queue, deadline refresh, and the PDF export.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../worker/email/outbox';
import { acceptMatch, refreshDeadlines, runAlert } from '../../worker/funding/alerts';
import { setOpenGrantsFetcherForTests, usage } from '../../worker/funding/provider';
import { dueSchedules } from '../../worker/jobs/dispatch';
import { runJob } from '../../worker/jobs';
import { sendNotification } from '../../worker/notify';
import { amountLabel, renderReportPdf, textWidth, winAnsi, wrap } from '../../worker/reports/pdf';
import { parseOpportunityCsv } from '../../worker/api/opportunities';
import { addMember, agentFor, assign, claimAsOwner, createClient, createUser, resetDb, testEnv, type Agent } from './helpers';

const DAY = 86_400_000;

let clientId: string;
let otherClient: string;
let owner: Agent;
let cons: Agent;
let admin: Agent;
let ids: { owner: string; cons: string; admin: string; adminEmail: string; consEmail: string };

async function drain(): Promise<void> {
  const rows = await testEnv.DB.prepare("SELECT id FROM notifications WHERE delivery = 'instant' AND emailed_at IS NULL").all<{ id: string }>();
  for (const r of rows.results) await sendNotification(testEnv, r.id);
}
const mailsTo = (to: string) => memoryOutbox.filter((m) => m.to === to);

// ---------------------------------------------------------------------------
// Mock OpenGrants: only the paths in the committed spec.
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  url: URL;
  body: unknown;
  auth: string | null;
}
let calls: Call[] = [];
let mockStatus = 200;
let grants: Record<string, unknown>[] = [];

const grant = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Grant ${id}`,
  funder: { name: 'Community Foundation' },
  url: `https://funder.example.org/${id}`,
  amount_min: 10000,
  amount_max: 50000,
  deadline_date: '2026-12-01',
  eligibility: '501(c)(3) in CA',
  description: 'Supports youth programs.',
  ...over,
});

function mock(input: string, init: RequestInit): Promise<Response> {
  const url = new URL(input);
  calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get('Authorization') });
  const headers = { 'Content-Type': 'application/json', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': String(100 - calls.length) };
  if (mockStatus !== 200) return Promise.resolve(new Response('{}', { status: mockStatus, headers }));
  const path = url.pathname.replace('/functions/v1', '');
  const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { headers }));
  if (path === '/grants-api') return json({ data: grants, total: grants.length });
  if (path.startsWith('/grants-api/')) {
    const g = grants.find((x) => x.id === decodeURIComponent(path.split('/')[2] ?? ''));
    return g ? json({ data: g }) : Promise.resolve(new Response('{}', { status: 404, headers }));
  }
  if (path === '/funders-api') return json({ data: [{ id: 'f1', name: 'Community Foundation', website: 'https://cf.example.org', state: 'CA' }] });
  if (path === '/match-grants-api') {
    return json({
      count: 1,
      matches: [{ id: 'm1', title: 'Matched grant', funder: 'Arts Council', match_score: 87, why_it_fits: 'Youth arts focus', award_max_usd: 25000, deadline: '2026-11-15', url: 'https://arts.example.org/m1' }],
    });
  }
  return Promise.resolve(new Response('{}', { status: 404, headers }));
}

async function configureOpenGrants(): Promise<void> {
  const r = await (await agentFor(ids.owner, { stepUp: true })).fetch('/api/settings/opengrants', { method: 'PUT', json: { apiKey: 'og_test_key_123' } });
  expect(r.status).toBe(200);
}

beforeEach(async () => {
  await resetDb();
  const kv = await testEnv.KV.list({ prefix: 'og:' });
  await Promise.all(kv.keys.map((k) => testEnv.KV.delete(k.name)));
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM job_runs'),
    testEnv.DB.prepare("DELETE FROM settings WHERE key IN ('origin', 'org', 'opengrants')"),
    testEnv.DB.prepare("INSERT INTO settings (org_id, key, value_json, updated_at) VALUES ('org_default', 'origin', ?, ?)").bind(
      JSON.stringify({ url: 'https://portal.test', seenAt: Date.now() }),
      Date.now(),
    ),
  ]);
  calls = [];
  mockStatus = 200;
  grants = [grant('g1'), grant('g2', { funder: null, agency_name: 'Dept. of Arts', deadline_date: null })];
  setOpenGrantsFetcherForTests(mock);
  const o = await claimAsOwner();
  clientId = await createClient('Acme');
  otherClient = await createClient('Other');
  const c = await createUser('consultant');
  await assign(clientId, c.id);
  const a = await createUser('client_admin');
  await addMember(clientId, a.id, 'admin');
  ids = { owner: o.id, cons: c.id, admin: a.id, adminEmail: a.email, consEmail: c.email };
  owner = await agentFor(o.id);
  cons = await agentFor(c.id);
  admin = await agentFor(a.id);
});

afterEach(() => setOpenGrantsFetcherForTests(null));

const base = () => `/api/clients/${clientId}`;

async function newOpportunity(agent: Agent, body: Record<string, unknown> = {}): Promise<string> {
  const r = await agent.post(`${base()}/opportunities`, { title: 'Youth arts grant', funderName: 'Arts Council', url: 'https://arts.example.org/a', deadlineAt: Date.now() + 40 * DAY, ...body });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

// ---------------------------------------------------------------------------

describe('opportunities and pipeline', () => {
  it('works without OpenGrants: manual entry, stages, and the client sees only its pipeline', async () => {
    const id = await newOpportunity(cons, { notes: 'Call the PO first' });
    let list = (await (await admin.fetch(`${base()}/opportunities`)).json()) as { opportunities: Record<string, unknown>[] };
    expect(list.opportunities).toHaveLength(0); // candidates stay internal until sent or pursued
    expect((await admin.fetch(`${base()}/opportunities/${id}`)).status).toBe(404);

    const r = await cons.fetch(`${base()}/opportunities/${id}`, { method: 'PATCH', json: { stage: 'preparing' } });
    expect(r.status).toBe(200);
    list = (await (await admin.fetch(`${base()}/opportunities`)).json()) as { opportunities: Record<string, unknown>[] };
    expect(list.opportunities).toHaveLength(1);
    // Consultant-only fields never reach client users (§10.5).
    expect(list.opportunities[0]).not.toHaveProperty('notes');
    expect(list.opportunities[0]).not.toHaveProperty('source');
    expect(list.opportunities[0]?.url).toBe('https://arts.example.org/a');

    await cons.fetch(`${base()}/opportunities/${id}`, { method: 'PATCH', json: { stage: 'awarded' } });
    const events = await testEnv.DB.prepare('SELECT type FROM events WHERE client_id = ? ORDER BY created_at').bind(clientId).all<{ type: string }>();
    expect(events.results.map((e) => e.type)).toEqual(expect.arrayContaining(['opportunity.created', 'opportunity.stage_changed', 'opportunity.awarded']));
  });

  it('rejects non-http URLs and client users writing', async () => {
    expect((await cons.post(`${base()}/opportunities`, { title: 'x', url: 'javascript:alert(1)' })).status).toBe(422);
    expect((await admin.post(`${base()}/opportunities`, { title: 'x' })).status).toBe(404);
  });

  it('cross-client pipeline shows only the clients a consultant can reach', async () => {
    await newOpportunity(cons, { stage: 'researching' });
    await owner.post(`/api/clients/${otherClient}/opportunities`, { title: 'Other grant', stage: 'submitted' });
    const mine = (await (await cons.fetch('/api/pipeline')).json()) as { opportunities: { clientName: string }[] };
    expect(mine.opportunities.map((o) => o.clientName)).toEqual(['Acme']);
    const all = (await (await owner.fetch('/api/pipeline')).json()) as { opportunities: unknown[] };
    expect(all.opportunities).toHaveLength(2);
  });

  it('imports CSV rows and reports bad lines', async () => {
    const csv = 'Title,Funder,Deadline,Amount,URL\n"Arts, Youth",Arts Council,2026-11-30,"$25,000",https://a.example.org\nNo date,X,31/31/2026,,\n,Missing title,,,\nSmall grant,Y,11/15/2026,5k,ftp://nope\n';
    const r = await cons.post(`${base()}/opportunities/import`, { csv });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { imported: number; errors: { line: number; error: string }[] };
    expect(body.imported).toBe(1);
    expect(body.errors).toEqual([
      { line: 3, error: 'bad_deadline' },
      { line: 4, error: 'missing_title' },
      { line: 5, error: 'bad_url' },
    ]);
    const row = await testEnv.DB.prepare('SELECT title, funder_name, amount_max, source FROM opportunities WHERE client_id = ?').bind(clientId).first();
    expect(row).toEqual({ title: 'Arts, Youth', funder_name: 'Arts Council', amount_max: 25000, source: 'csv' });
    expect(parseOpportunityCsv('Funder\nX').errors).toEqual([{ line: 1, error: 'missing_title_column' }]);
  });
});

describe('funding reports', () => {
  async function draftWith(n: number): Promise<{ reportId: string; opps: string[] }> {
    const opps: string[] = [];
    for (let i = 0; i < n; i++) opps.push(await newOpportunity(cons, { title: `Opportunity ${i + 1}` }));
    const r = await cons.post(`${base()}/reports`, { title: 'October opportunities', intro: 'Three strong fits this month.', opportunityIds: opps.slice(0, 1) });
    const { id } = (await r.json()) as { id: string };
    for (const o of opps.slice(1)) expect((await cons.post(`${base()}/reports/${id}/items`, { opportunityId: o, tag: 'consider' })).status).toBe(201);
    return { reportId: id, opps };
  }

  it('builds, reorders and sends; the client reads it, answers, and Pursue joins the pipeline', async () => {
    const { reportId, opps } = await draftWith(3);
    const [o1, o2, o3] = opps as [string, string, string];
    expect((await admin.fetch(`${base()}/reports/${reportId}`)).status).toBe(404); // drafts are internal

    await cons.fetch(`${base()}/reports/${reportId}/items/${o1}`, { method: 'PATCH', json: { note: 'Strong fit.', tag: 'recommended' } });
    expect((await cons.fetch(`${base()}/reports/${reportId}/order`, { method: 'PUT', json: { opportunityIds: [o3, o1] } })).status).toBe(422);
    expect((await cons.fetch(`${base()}/reports/${reportId}/order`, { method: 'PUT', json: { opportunityIds: [o3, o1, o2] } })).status).toBe(200);

    expect((await cons.post(`${base()}/reports/${reportId}/send`)).status).toBe(200);
    expect((await cons.post(`${base()}/reports/${reportId}/send`)).status).toBe(409); // once
    expect((await cons.fetch(`${base()}/reports/${reportId}`, { method: 'PATCH', json: { title: 'x' } })).status).toBe(409);

    await drain();
    const mail = mailsTo(ids.adminEmail).at(-1);
    expect(mail?.subject).toContain('October opportunities');
    expect(mail?.text).toContain(`https://portal.test/portal/reports/${reportId}`);
    expect(mail?.headers?.['List-Unsubscribe']).toBeTruthy();

    const view = (await (await admin.fetch(`${base()}/reports/${reportId}`)).json()) as { items: { opportunity: Record<string, unknown>; note: string | null; tag: string }[] };
    expect(view.items.map((i) => i.opportunity.id)).toEqual([o3, o1, o2]);
    expect(view.items[1]).toMatchObject({ note: 'Strong fit.', tag: 'recommended' });
    expect(view.items[0]?.opportunity).not.toHaveProperty('source');

    // Staff don't answer for the client; a question needs words.
    expect((await cons.post(`${base()}/reports/${reportId}/items/${o1}/respond`, { response: 'pursue' })).status).toBe(403);
    expect((await admin.post(`${base()}/reports/${reportId}/items/${o2}/respond`, { response: 'question' })).status).toBe(422);

    const r = await admin.post(`${base()}/reports/${reportId}/items/${o1}/respond`, { response: 'pursue' });
    expect(await r.json()).toEqual({ ok: true, stage: 'researching' });
    await admin.post(`${base()}/reports/${reportId}/items/${o2}/respond`, { response: 'question', comment: 'Do we qualify with a fiscal sponsor?' });
    const stage = await testEnv.DB.prepare('SELECT stage FROM opportunities WHERE id = ?').bind(o1).first<{ stage: string }>();
    expect(stage?.stage).toBe('researching');

    await drain();
    const staffMail = mailsTo(ids.consEmail);
    expect(staffMail.some((m) => m.subject.startsWith('Pursue: Opportunity 1'))).toBe(true);
    expect(staffMail.some((m) => m.text.includes('fiscal sponsor'))).toBe(true);

    const list = (await (await admin.fetch(`${base()}/reports`)).json()) as { reports: { answeredCount: number; pursueCount: number }[] };
    expect(list.reports[0]).toMatchObject({ answeredCount: 2, pursueCount: 1 });
  });

  it('an empty report cannot be sent', async () => {
    const r = await cons.post(`${base()}/reports`, { title: 'Empty' });
    const { id } = (await r.json()) as { id: string };
    expect((await cons.post(`${base()}/reports/${id}/send`)).status).toBe(409);
  });

  it("a report can't include another client's opportunity", async () => {
    const other = (await (await owner.post(`/api/clients/${otherClient}/opportunities`, { title: 'Theirs' })).json()) as { id: string };
    expect((await cons.post(`${base()}/reports`, { title: 'x', opportunityIds: [other.id] })).status).toBe(422);
    const { id } = (await (await cons.post(`${base()}/reports`, { title: 'x' })).json()) as { id: string };
    expect((await cons.post(`${base()}/reports/${id}/items`, { opportunityId: other.id })).status).toBe(422);
  });

  it('exports a valid, branded PDF without private notes', async () => {
    const { reportId, opps } = await draftWith(2);
    await cons.fetch(`${base()}/opportunities/${opps[0]}`, { method: 'PATCH', json: { notes: 'SECRET-INTERNAL-NOTE' } });
    await cons.post(`${base()}/reports/${reportId}/send`);
    const res = await admin.fetch(`${base()}/reports/${reportId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="October opportunities.pdf"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Title (October opportunities)');
    expect(text).not.toContain('SECRET-INTERNAL-NOTE');
    expect(text).not.toMatch(/grant-portal|OpenGrants/i);
    // Every xref offset points at its object.
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    const entries = text.slice(xrefAt).split('\n').slice(2).filter((l) => / n $/.test(l));
    entries.forEach((e, i) => expect(text.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
});

describe('PDF writer', () => {
  it('encodes text for the standard fonts and wraps within the width', () => {
    expect(winAnsi('A’é€☃')).toEqual([65, 0x92, 0xe9, 0x80, 63]);
    const lines = wrap('The quick brown fox jumps over the lazy dog '.repeat(6), 11, 200);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(textWidth(l, 11)).toBeLessThanOrEqual(200);
    expect(wrap('x'.repeat(300), 11, 100).every((l) => textWidth(l, 11) <= 100)).toBe(true);
    expect(amountLabel(10000, 50000)).toBe('$10,000–$50,000');
    expect(amountLabel(null, 50000)).toBe('Up to $50,000');
    expect(amountLabel(null, null)).toBeNull();
  });

  it('escapes PDF string delimiters so text cannot inject operators', async () => {
    const pdf = await renderReportPdf({
      firm: 'Firm (x) \\ y',
      colors: { accent: '#0055aa', text: '#111111', text2: '#555555', border: '#dddddd' },
      logo: null,
      title: 'Evil) Tj /F9 99 Tf (',
      clientName: 'Acme',
      date: Date.UTC(2026, 9, 1),
      tz: 'UTC',
      intro: null,
      items: [],
    });
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text).toContain('/Title (Evil\\) Tj /F9 99 Tf \\()');
    expect(text).toContain('/Author (Firm \\(x\\) \\\\ y)');
  });
});

describe('OpenGrants provider', () => {
  it('is optional: without a key, status says so and search answers 409', async () => {
    expect(await (await cons.fetch('/api/funding/status')).json()).toEqual({ configured: false, usage: null });
    const r = await cons.fetch('/api/funding/search?q=youth');
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'opengrants_not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('searches through the generated client, caches in KV, and counts the budget', async () => {
    await configureOpenGrants();
    const r = await cons.fetch('/api/funding/search?q=youth%20arts&states=ca');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { ogId: string; funderName: string | null; deadlineAt: number | null }[]; cached: boolean; usage: { used: number; limit: number } };
    expect(body.items.map((i) => i.ogId)).toEqual(['g1', 'g2']);
    expect(body.items[1]?.funderName).toBe('Dept. of Arts');
    expect(body.items[1]?.deadlineAt).toBeNull();
    expect(body.cached).toBe(false);
    expect(body.usage).toMatchObject({ used: 1, limit: 100 }); // plan limit detected from headers
    expect(calls[0]?.auth).toBe('Bearer og_test_key_123');
    expect(calls[0]?.url.pathname).toBe('/functions/v1/grants-api');
    expect(calls[0]?.url.searchParams.get('states')).toBe('CA');
    expect(calls[0]?.url.searchParams.get('search_mode')).toBe('hybrid');

    const again = (await (await owner.fetch('/api/funding/search?q=youth%20arts&states=ca')).json()) as { cached: boolean };
    expect(again.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('stops at the daily budget and maps upstream errors', async () => {
    await configureOpenGrants();
    await testEnv.KV.put(`og:usage:${new Date().toISOString().slice(0, 10)}`, '25');
    let r = await cons.fetch('/api/funding/search?q=a');
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'opengrants_budget_exhausted' });
    expect(calls).toHaveLength(0);

    await testEnv.KV.put(`og:usage:${new Date().toISOString().slice(0, 10)}`, '0');
    mockStatus = 401;
    r = await cons.fetch('/api/funding/search?q=b');
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'opengrants_unauthorized' });
    mockStatus = 429;
    expect((await cons.fetch('/api/funding/search?q=c')).status).toBe(429);
  });

  it('adds a listing to a client once, keeping its OpenGrants ID and source URL', async () => {
    await configureOpenGrants();
    const r = await cons.post(`${base()}/opportunities/from-opengrants`, { kind: 'grant', ogId: 'g1' });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const again = await cons.post(`${base()}/opportunities/from-opengrants`, { kind: 'grant', ogId: 'g1' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, created: false });
    const staffView = (await (await cons.fetch(`${base()}/opportunities/${id}`)).json()) as { opportunity: Record<string, unknown> };
    expect(staffView.opportunity).toMatchObject({ source: 'opengrants', ogId: 'g1', url: 'https://funder.example.org/g1', funderName: 'Community Foundation', amountMax: 50000 });
    expect((await cons.post(`${base()}/opportunities/from-opengrants`, { kind: 'grant', ogId: 'nope' })).status).toBe(404);
  });

  it('matches from the client profile', async () => {
    await configureOpenGrants();
    let r = await cons.post(`${base()}/funding/match`, {});
    expect(r.status).toBe(422); // nothing to match on yet
    expect(calls).toHaveLength(0);
    await testEnv.DB.prepare("UPDATE clients SET mission = 'Arts education for youth', entity_type = 'Nonprofit', focus_tags_json = '[\"arts\"]', geography_json = '[\"CA\"]', budget_band = '$250k–$1M' WHERE id = ?")
      .bind(clientId)
      .run();
    r = await cons.post(`${base()}/funding/match`, { limit: 5 });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { ogId: string; fitScore: number; eligibilityNotes: string }[] };
    expect(body.items[0]).toMatchObject({ ogId: 'm1', fitScore: 87, eligibilityNotes: 'Youth arts focus' });
    expect(calls[0]?.body).toEqual({
      profile: { mission: 'Arts education for youth', sector: 'arts', geography: 'CA', applicant_type: 'nonprofit', annual_budget_usd: 250000 },
      focus_keywords: ['arts'],
      limit: 5,
    });
  });

  it('looks up funders', async () => {
    await configureOpenGrants();
    const r = await cons.fetch('/api/funding/funders?q=community');
    expect(((await r.json()) as { funders: unknown[] }).funders).toEqual([
      { id: 'f1', name: 'Community Foundation', url: 'https://cf.example.org', location: 'CA', description: null },
    ]);
  });
});

describe('alerts and the review queue', () => {
  async function createAlert(body: Record<string, unknown> = {}): Promise<string> {
    const r = await cons.post(`${base()}/alerts`, { name: 'Weekly arts', query: { search: 'arts' }, rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9', ...body });
    expect(r.status).toBe(201);
    return ((await r.json()) as { id: string }).id;
  }

  it('need OpenGrants', async () => {
    const r = await cons.post(`${base()}/alerts`, { name: 'x', query: {}, rrule: 'FREQ=WEEKLY' });
    expect(r.status).toBe(409);
  });

  it('queue only new matches for review, and adding one makes an opportunity', async () => {
    await configureOpenGrants();
    const alertId = await createAlert();
    const first = await runAlert(testEnv, alertId, Date.now(), { requiresReview: true });
    expect(first).toEqual({ status: 'ok', found: 2 });
    await drain();
    expect(mailsTo(ids.consEmail).some((m) => m.subject === '2 new matches for Acme')).toBe(true);

    grants.push(grant('g3'));
    await testEnv.KV.list({ prefix: 'og:cache:' }).then((l) => Promise.all(l.keys.map((k) => testEnv.KV.delete(k.name))));
    expect(await runAlert(testEnv, alertId, Date.now(), { requiresReview: true })).toEqual({ status: 'ok', found: 1 });

    const queue = (await (await cons.fetch(`${base()}/alerts/matches`)).json()) as { matches: { id: string; listing: { ogId: string } }[] };
    expect(queue.matches.map((m) => m.listing.ogId).sort()).toEqual(['g1', 'g2', 'g3']);
    const pick = queue.matches.find((m) => m.listing.ogId === 'g1');
    const before = calls.length;
    const added = (await (await cons.post(`${base()}/alerts/matches/${pick?.id}/add`)).json()) as { opportunityId: string };
    expect(calls.length).toBe(before); // no extra API call
    const opp = await testEnv.DB.prepare('SELECT og_id, source FROM opportunities WHERE id = ?').bind(added.opportunityId).first();
    expect(opp).toEqual({ og_id: 'g1', source: 'opengrants' });
    expect(await acceptMatch(testEnv, clientId, pick?.id ?? '', ids.cons)).toBe(added.opportunityId); // idempotent

    const other = queue.matches.find((m) => m.listing.ogId === 'g2');
    expect((await cons.post(`${base()}/alerts/matches/${other?.id}/dismiss`)).status).toBe(200);
    const left = (await (await cons.fetch(`${base()}/alerts/matches`)).json()) as { matches: unknown[] };
    expect(left.matches).toHaveLength(1);
  });

  it('pause in low-budget mode (but a person can still run one)', async () => {
    await configureOpenGrants();
    const alertId = await createAlert();
    await testEnv.KV.put(`og:usage:${new Date().toISOString().slice(0, 10)}`, '21'); // 4 of 25 left < 20%
    expect((await usage(testEnv)).low).toBe(true);
    expect(await runAlert(testEnv, alertId, Date.now(), { requiresReview: true })).toEqual({ status: 'skipped_budget', found: 0 });
    expect(calls).toHaveLength(0);
    const r = await cons.post(`${base()}/alerts/${alertId}/run`);
    expect(await r.json()).toEqual({ status: 'ok', found: 2 });
  });

  it('recurring reports draft for review by default, or send themselves', async () => {
    await configureOpenGrants();
    const reviewed = await createAlert({ mode: 'report' });
    const runAt = Date.now();
    await runAlert(testEnv, reviewed, runAt, { requiresReview: true });
    await runAlert(testEnv, reviewed, runAt, { requiresReview: true }); // a retried job
    const drafts = await testEnv.DB.prepare("SELECT id, status, pending_review FROM reports WHERE client_id = ?").bind(clientId).all<{ id: string; status: string; pending_review: number }>();
    expect(drafts.results).toHaveLength(1);
    expect(drafts.results[0]).toMatchObject({ status: 'draft', pending_review: 1 });
    await drain();
    expect(mailsTo(ids.consEmail).some((m) => m.subject === 'Report draft ready for review: Acme')).toBe(true);
    expect(mailsTo(ids.adminEmail)).toHaveLength(0);

    grants = [grant('g9')];
    const auto = await createAlert({ mode: 'report', name: 'Auto', requiresReview: false, query: { search: 'other' } });
    const schedule = await testEnv.DB.prepare('SELECT schedule_id FROM alerts WHERE id = ?').bind(auto).first<{ schedule_id: string }>();
    await runJob({ kind: 'schedule.run', key: 'k1', scheduleId: schedule?.schedule_id ?? '', runAt: Date.now() }, testEnv);
    const sent = await testEnv.DB.prepare("SELECT title FROM reports WHERE client_id = ? AND status = 'sent'").bind(clientId).all<{ title: string }>();
    expect(sent.results).toHaveLength(1);
    await drain();
    expect(mailsTo(ids.adminEmail).some((m) => m.subject.includes('funding report'))).toBe(true);
  });

  it('are spread across dispatcher ticks', async () => {
    await configureOpenGrants();
    for (let i = 0; i < 5; i++) await createAlert({ name: `A${i}` });
    await testEnv.DB.prepare("UPDATE schedules SET next_run_at = ? WHERE kind = 'alert'").bind(Date.now() - 1000).run();
    await dueSchedules(testEnv, Date.now());
    const first = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE kind = 'schedule.run'").first<{ n: number }>();
    expect(first?.n).toBe(3);
    await dueSchedules(testEnv, Date.now());
    const second = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE kind = 'schedule.run'").first<{ n: number }>();
    expect(second?.n).toBe(5);
  });
});

describe('deadline refresh', () => {
  it('pulls new deadlines for saved listings, within budget', async () => {
    await configureOpenGrants();
    const { id } = (await (await cons.post(`${base()}/opportunities/from-opengrants`, { kind: 'grant', ogId: 'g1' })).json()) as { id: string };
    await cons.fetch(`${base()}/opportunities/${id}`, { method: 'PATCH', json: { stage: 'researching' } });
    await testEnv.DB.prepare('UPDATE opportunities SET refreshed_at = 0 WHERE id = ?').bind(id).run();
    grants[0] = grant('g1', { deadline_date: '2027-01-15' });
    await testEnv.KV.list({ prefix: 'og:cache:' }).then((l) => Promise.all(l.keys.map((k) => testEnv.KV.delete(k.name))));
    expect(await refreshDeadlines(testEnv, Date.now())).toBe(1);
    const row = await testEnv.DB.prepare('SELECT deadline_at FROM opportunities WHERE id = ?').bind(id).first<{ deadline_at: number }>();
    expect(new Date(row?.deadline_at ?? 0).toISOString().slice(0, 10)).toBe('2027-01-15');
    // Refreshed rows wait a day.
    const n = calls.length;
    await refreshDeadlines(testEnv, Date.now());
    expect(calls.length).toBe(n);
  });
});
