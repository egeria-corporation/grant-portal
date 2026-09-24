import { describe, expect, it } from 'vitest';
import { call } from './helpers';

describe('/healthz', () => {
  it('reports ok once migrations are applied', async () => {
    const res = await call('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json<{ status: string; checks: { db: string }; version: string }>();
    expect(body).toEqual({ status: 'ok', version: '0.0.0-test', checks: { db: 'ok' } });
  });
});

describe('security headers', () => {
  const expectCommon = (res: Response) => {
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
  };

  it('locks down JSON responses', async () => {
    const res = await call('/healthz');
    expectCommon(res);
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('serves SPA HTML with a fresh nonce on every script and style tag', async () => {
    const res = await call('/some/deep/link', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expectCommon(res);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const csp = res.headers.get('Content-Security-Policy') ?? '';
    const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');

    const html = await res.text();
    expect(html).not.toContain('CSP_NONCE');
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBe(2);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
  });

  it('never reuses a nonce', async () => {
    const a = (await call('/')).headers.get('Content-Security-Policy');
    const b = (await call('/')).headers.get('Content-Security-Policy');
    expect(a).not.toEqual(b);
  });
});

describe('routing', () => {
  it('answers unknown API paths with JSON 404, not the SPA', async () => {
    for (const path of ['/api/nope', '/auth/nope', '/f/nope', '/brand/nope', '/webhooks/nope']) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('Content-Type'), path).toContain('application/json');
    }
  });

  it('rejects non-GET methods on page routes', async () => {
    const res = await call('/', { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('keeps Owner-only system endpoints closed without a session', async () => {
    const res = await call('/api/system/secrets');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toMatch(/SESSION_SECRET|DATA_ENCRYPTION_KEY/);
  });
});
