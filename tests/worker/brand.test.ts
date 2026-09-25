import { beforeEach, describe, expect, it } from 'vitest';
import { Agent, agentFor, claimAsOwner, createUser, resetDb, testEnv } from './helpers';

beforeEach(async () => {
  await resetDb();
  await testEnv.DB.prepare("DELETE FROM settings WHERE key IN ('brand', 'brand_assets')").run();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0, 0, 0, 0]);

async function owner() {
  const o = await claimAsOwner();
  return agentFor(o.id);
}

async function upload(agent: Agent, slot: string, body: Uint8Array | string, type = 'application/octet-stream') {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return agent.fetch(`/api/settings/brand/assets/${slot}`, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes });
}

async function setBrand(agent: Agent, extra: Record<string, unknown> = {}) {
  return agent.fetch('/api/settings/brand', { method: 'PUT', json: { firmName: 'Northwind Grant Partners', shortName: 'Northwind', accent: '#1E3A5F', neutral: 'cool', radius: 'sharp', heading: 'serif-a', ...extra } });
}

describe('/brand/theme.css', () => {
  it('serves the default theme before a brand exists', async () => {
    const res = await new Agent().fetch('/brand/theme.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/css');
    expect(await res.text()).toContain('--acc-brand:#5b4fd6');
  });

  it('reflects the brand, is immutable only at the current version, and changes version on update', async () => {
    const agent = await owner();
    const first = await (await setBrand(agent)).json<{ version: string }>();
    const css = await new Agent().fetch(`/brand/theme.css?v=${first.version}`);
    const text = await css.text();
    expect(text).toContain('--acc-brand:#1e3a5f');
    expect(text).toContain('--bg:#f6faff'); // cool neutrals
    expect(text).toContain('--r-card:4px'); // sharp
    expect(text).toContain("'Source Serif 4 Variable'");
    expect(css.headers.get('Cache-Control')).toContain('immutable');
    expect(css.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');

    const stale = await new Agent().fetch('/brand/theme.css?v=old');
    expect(stale.headers.get('Cache-Control')).not.toContain('immutable');

    const second = await (await setBrand(agent, { accent: '#E8604C', neutral: 'warm' })).json<{ version: string }>();
    expect(second.version).not.toBe(first.version);
    expect(await (await new Agent().fetch(`/brand/theme.css?v=${second.version}`)).text()).toContain('--bg:#fcf9f4');
  });
});

describe('branded HTML shell', () => {
  it('writes the brand into <head>: title, theme link with nonce, icon, manifest, OG tags', async () => {
    const agent = await owner();
    const { version } = await (await setBrand(agent, { welcome: 'Welcome to <Northwind>' })).json<{ version: string }>();
    const res = await new Agent().fetch('/signin', { headers: { Accept: 'text/html' } });
    const html = await res.text();
    const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(res.headers.get('Content-Security-Policy') ?? '')?.[1];
    expect(html).toContain('<title>Northwind Grant Partners</title>');
    expect(html).toContain(`<link rel="stylesheet" href="/brand/theme.css?v=${version}" nonce="${nonce}">`);
    expect(html).toContain(`href="/brand/icon.svg?v=${version}"`);
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('<meta property="og:title" content="Northwind Grant Partners">');
    expect(html).toContain('content="Welcome to &lt;Northwind&gt;"');
    expect(html).toContain(`content="https://portal.test/brand/og.png?v=${version}"`);
    expect(html).not.toMatch(/grant[-_ ]?portal/i);
  });

  it('applies the light/dark preference cookie and compact density on the server', async () => {
    const agent = await owner();
    await setBrand(agent, { density: 'compact' });
    const viewer = new Agent();
    viewer.cookies.set('theme', 'dark');
    const dark = await viewer.fetch('/', { headers: { Accept: 'text/html' } });
    expect(await dark.text()).toMatch(/<html[^>]*data-theme="dark"[^>]*class="d-compact"|<html[^>]*class="d-compact"[^>]*data-theme="dark"/);
    const attacker = new Agent();
    attacker.cookies.set('theme', '"><script>');
    const bogus = await attacker.fetch('/', { headers: { Accept: 'text/html' } });
    expect(await bogus.text()).not.toContain('data-theme');
  });
});

describe('brand asset uploads', () => {
  it('accepts a PNG logo, serves it publicly with an immutable versioned URL', async () => {
    const agent = await owner();
    const res = await upload(agent, 'logo-light', PNG, 'image/png');
    expect(res.status).toBe(201);
    const { url } = await res.json<{ url: string }>();
    const served = await new Agent().fetch(url);
    expect(served.status).toBe(200);
    expect(served.headers.get('Content-Type')).toBe('image/png');
    expect(served.headers.get('Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it('detects the type from the bytes, not the declared Content-Type', async () => {
    const agent = await owner();
    const res = await upload(agent, 'logo-light', '<html><script>alert(1)</script></html>', 'image/png');
    expect(res.status).toBe(415);
  });

  it('sanitizes SVG logos and serves them with a sandbox CSP', async () => {
    const agent = await owner();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10"><script>alert(2)</script><rect width="10" height="10" fill="#1e3a5f"/></svg>';
    const res = await upload(agent, 'mark', svg, 'image/svg+xml');
    expect(res.status).toBe(201);
    const { url } = await res.json<{ url: string }>();
    const served = await new Agent().fetch(url);
    const body = await served.text();
    expect(body).not.toContain('script');
    expect(body).not.toContain('onload');
    expect(body).toContain('<rect width="10" height="10" fill="#1e3a5f"/>');
    expect(served.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(served.headers.get('Content-Type')).toBe('image/svg+xml');
    // The uploaded SVG mark becomes the favicon.
    expect(await (await new Agent().fetch('/brand/icon.svg')).text()).toContain('fill="#1e3a5f"');
  });

  it('rejects SVGs it cannot make safe', async () => {
    const agent = await owner();
    for (const bad of [
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[x]]></svg>',
    ]) {
      const res = await upload(agent, 'logo-light', bad);
      expect([415, 422], bad).toContain(res.status);
    }
    expect((await testEnv.FILES.list({ prefix: 'brand/' })).objects).toHaveLength(0);
  });

  it('enforces per-slot types and size caps', async () => {
    const agent = await owner();
    expect((await upload(agent, 'og', WOFF2)).status).toBe(415);
    expect((await upload(agent, 'font-heading', WOFF2, 'font/woff2')).status).toBe(201);
    const big = new Uint8Array(300 * 1024);
    big.set(PNG);
    expect((await upload(agent, 'favicon', big)).status).toBe(413);
    expect((await upload(agent, 'nope', PNG)).status).toBe(404);
  });

  it('an uploaded heading font is wired into theme.css when chosen', async () => {
    const agent = await owner();
    await upload(agent, 'font-heading', WOFF2, 'font/woff2');
    await setBrand(agent, { heading: 'custom' });
    const css = await (await new Agent().fetch('/brand/theme.css')).text();
    expect(css).toMatch(/@font-face\{font-family:'Brand Heading';src:url\(\/brand\/asset\/font-heading\?v=[0-9a-f]{12}\)/);
  });

  it('replacing and deleting an asset removes the old R2 object', async () => {
    const agent = await owner();
    await upload(agent, 'logo-dark', PNG);
    const firstKeys = await testEnv.FILES.list({ prefix: 'brand/' });
    await upload(agent, 'logo-dark', PNG);
    const secondKeys = await testEnv.FILES.list({ prefix: 'brand/' });
    expect(secondKeys.objects).toHaveLength(1);
    expect(secondKeys.objects[0]?.key).not.toBe(firstKeys.objects[0]?.key);
    expect((await agent.fetch('/api/settings/brand/assets/logo-dark', { method: 'DELETE' })).status).toBe(200);
    expect((await testEnv.FILES.list({ prefix: 'brand/' })).objects).toHaveLength(0);
    expect((await new Agent().fetch('/brand/asset/logo-dark')).status).toBe(404);
  });

  it('only the Owner can upload', async () => {
    await claimAsOwner();
    const consultant = await createUser('consultant');
    expect((await upload(await agentFor(consultant.id), 'logo-light', PNG)).status).toBe(403);
    expect((await upload(new Agent(), 'logo-light', PNG)).status).toBe(401);
  });
});

describe('generated brand files', () => {
  it('icon.svg shows the firm initials on the accent', async () => {
    const agent = await owner();
    await setBrand(agent);
    const res = await new Agent().fetch('/brand/icon.svg');
    const svg = await res.text();
    expect(svg).toContain('>N</text>');
    expect(svg).toContain('fill="#1e3a5f"');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
  });

  it('manifest names the firm and uses its colors', async () => {
    const agent = await owner();
    await setBrand(agent);
    const m = await (await new Agent().fetch('/brand/manifest.webmanifest')).json<Record<string, unknown>>();
    expect(m).toMatchObject({ name: 'Northwind Grant Partners', short_name: 'Northwind', theme_color: '#1e3a5f', background_color: '#f6faff' });
  });

  it('og.png is a valid 1200×630 PNG', async () => {
    const res = await new Agent().fetch('/brand/og.png');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const b = new Uint8Array(await res.arrayBuffer());
    expect([...b.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(b.buffer);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
    expect(b.length).toBeLessThan(50_000);
  });
});

describe('edge cache', () => {
  it('serves a versioned theme.css from the edge cache without re-reading the brand', async () => {
    const agent = await owner();
    const { version } = await (await setBrand(agent)).json<{ version: string }>();
    const first = await new Agent().fetch(`/brand/theme.css?v=${version}`);
    expect(first.status).toBe(200);
    // Change the stored brand behind the cache's back: the versioned URL must keep its content.
    await testEnv.DB.prepare("UPDATE settings SET value_json = json_set(value_json, '$.accent', '#e8604c') WHERE key = 'brand'").run();
    const second = await new Agent().fetch(`/brand/theme.css?v=${version}`);
    expect(await second.text()).toContain('--acc-brand:#1e3a5f');
    expect(second.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // An unversioned request sees the new brand immediately.
    expect(await (await new Agent().fetch('/brand/theme.css')).text()).toContain('--acc-brand:#e8604c');
  });
});
