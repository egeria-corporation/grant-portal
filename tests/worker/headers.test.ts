/**
 * The header set (spec §7.2, PLAN M6) on every kind of response the Worker
 * produces: HTML, JSON, errors, method-not-allowed, downloads, PDFs, the ZIP
 * export, CSV, calendar feeds, brand files and webhooks. HTML gets the nonce
 * CSP (tests/worker/http.test.ts checks it in detail); everything else gets
 * `default-src 'none'`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, Agent, agentFor, call, claimAsOwner, createClient, createUser, resetDb, testEnv } from './helpers';

const COMMON: Record<string, string | RegExp> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Permissions-Policy': /camera=\(\).*microphone=\(\).*geolocation=\(\)/,
};

function expectHeaders(res: Response, label: string, opts: { html?: boolean; corp?: string } = {}) {
  for (const [name, want] of Object.entries(COMMON)) {
    const got = res.headers.get(name);
    if (want instanceof RegExp) expect(got, `${label}: ${name}`).toMatch(want);
    else expect(got, `${label}: ${name}`).toBe(want);
  }
  expect(res.headers.get('Cross-Origin-Resource-Policy'), `${label}: CORP`).toBe(opts.corp ?? 'same-origin');
  const csp = res.headers.get('Content-Security-Policy') ?? '';
  expect(csp, `${label}: CSP`).toContain("frame-ancestors 'none'");
  if (opts.html) expect(csp, `${label}: CSP`).toMatch(/script-src 'nonce-/);
  else expect(csp, `${label}: CSP`).toContain("default-src 'none'");
  expect(res.headers.get('Server'), `${label}: no server banner`).toBeNull();
  expect(res.headers.get('X-Powered-By'), `${label}: no powered-by`).toBeNull();
}

let owner: Agent;
let admin: Agent;
let clientId: string;
let reportId: string;
let fileId: string;

beforeAll(async () => {
  await resetDb();
  const o = await claimAsOwner();
  owner = await agentFor(o.id, { stepUp: true });
  clientId = await createClient('Acme');
  const a = await createUser('client_admin');
  await addMember(clientId, a.id);
  admin = await agentFor(a.id);
  const now = Date.now();
  fileId = 'fil_01J00000000000000000000001';
  reportId = 'rpt_01J00000000000000000000001';
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO files (id, client_id, r2_key, filename, mime, size, upload_status, uploaded_by, created_at, completed_at) VALUES (?, ?, ?, 'a.pdf', 'application/pdf', 9, 'complete', ?, ?, ?)",
    ).bind(fileId, clientId, `clients/${clientId}/h`, o.id, now, now),
    testEnv.DB.prepare("INSERT INTO opportunities (id, client_id, source, title, stage, created_at) VALUES ('opp_h', ?, 'manual', 'Grant', 'none', ?)").bind(clientId, now),
    testEnv.DB.prepare("INSERT INTO reports (id, client_id, title, status, sent_at, created_at) VALUES (?, ?, 'R', 'sent', ?, ?)").bind(reportId, clientId, now, now),
    testEnv.DB.prepare("INSERT INTO report_items (report_id, opportunity_id, position) VALUES (?, 'opp_h', 0)").bind(reportId),
  ]);
  await testEnv.FILES.put(`clients/${clientId}/h`, '%PDF-1.4\n');
});

describe('every response carries the security header set', () => {
  it('HTML pages', async () => {
    expectHeaders(await call('/', { headers: { Accept: 'text/html' } }), 'GET /', { html: true });
    expectHeaders(await call('/portal/reports/x', { headers: { Accept: 'text/html' } }), 'deep link', { html: true });
  });

  it('JSON, errors and fallbacks', async () => {
    expectHeaders(await call('/healthz'), 'healthz');
    expectHeaders(await call('/api/me'), '401');
    expectHeaders(await call('/api/nope'), '404');
    expectHeaders(await owner.fetch('/api/clients', { method: 'POST', json: { nope: true } }), '422');
    expectHeaders(await new Agent().fetch('/', { method: 'PUT', body: 'x' }), '403/405 page write');
    expectHeaders(await new Agent().fetch('/auth/magic/request', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } }), '400');
  });

  it('downloads, PDF, ZIP, CSV and calendar feeds', async () => {
    const file = await admin.fetch(`/f/${fileId}`);
    expect(file.status).toBe(200);
    expectHeaders(file, 'file download');
    expect(file.headers.get('Content-Disposition')).toMatch(/^(attachment|inline)/);

    const pdf = await admin.fetch(`/api/clients/${clientId}/reports/${reportId}/pdf`);
    expect(pdf.status).toBe(200);
    expectHeaders(pdf, 'report PDF');

    const zip = await owner.fetch('/api/data/export');
    expect(zip.status).toBe(200);
    expectHeaders(zip, 'export ZIP');
    await zip.arrayBuffer();

    const csv = await owner.fetch('/api/audit/export');
    expectHeaders(csv, 'audit CSV');

    const feed = await owner.post('/api/calendar-feeds', {});
    const { url } = (await feed.json()) as { url: string };
    const ics = await call(new URL(url).pathname);
    expect(ics.status).toBe(200);
    expectHeaders(ics, 'ICS');
  });

  it('brand files (the only responses allowed cross-origin, for link unfurlers)', async () => {
    const res = await call('/brand/theme.css');
    expectHeaders(res, 'theme.css', { corp: res.headers.get('Cross-Origin-Resource-Policy') ?? 'same-origin' });
    expect(['same-origin', 'cross-origin']).toContain(res.headers.get('Cross-Origin-Resource-Policy'));
  });

  it('webhooks and unsubscribe endpoints', async () => {
    expectHeaders(await call('/webhooks/resend', { method: 'POST', body: '{}' }), 'webhook');
    expectHeaders(await call('/u/bad-token', { method: 'POST' }), 'unsubscribe');
  });
});
