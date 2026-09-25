/**
 * /brand/* — public, cacheable brand output (spec §4.2, §8.2):
 *   theme.css              semantic CSS variables for this brand
 *   icon.svg               favicon: uploaded mark/favicon SVG, or generated initials
 *   manifest.webmanifest   PWA manifest with the firm's name and colors
 *   og.png                 link-preview image: uploaded, or a generated accent card
 *   asset/:slot            uploaded logos, mark, favicon, OG image, heading font
 *
 * Requests carrying the current `?v=` get a year-long immutable cache; any
 * other request gets a short one, so an old URL can't pin a stale brand.
 * Rendered CSS and the generated OG card are also kept in KV per version.
 */
import { themeCss } from '@shared/theme/tokens';
import { modeVars } from '@shared/theme/tokens';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { escapeHtml } from '../email/templates/render';
import { isSlot } from './assets';
import { cardPng } from './png';
import { assetUrl, type BrandState, getBrandState, initials } from './state';
import { SVG_HEADERS } from './svg';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=60, must-revalidate';

function cacheFor(requested: string | undefined, current: string): string {
  return requested === current ? IMMUTABLE : SHORT;
}

/** Brand files are public and may be embedded by email clients and link unfurlers. */
const PUBLIC_RESOURCE = { 'Cross-Origin-Resource-Policy': 'cross-origin' };

export function generatedIcon(state: BrandState): string {
  const v = modeVars(state.theme, 'light');
  const text = escapeHtml(initials(state.shortName ?? state.firmName));
  const size = text.length > 1 ? 26 : 32;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${v['acc-solid']}"/>` +
    `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,Segoe UI,sans-serif" ` +
    `font-size="${size}" font-weight="600" fill="${v['acc-on']}">${text}</text></svg>`
  );
}

async function storedObject(c: { env: AppBindings['Bindings'] }, key: string) {
  const obj = await c.env.FILES.get(key);
  return obj ? { body: obj.body, type: obj.httpMetadata?.contentType ?? 'application/octet-stream' } : null;
}

/**
 * Edge cache for versioned URLs. A `?v=` URL's content never changes, so a
 * hit is served without touching D1; only responses marked immutable (the
 * version matched) are stored.
 */
async function edgeCache(c: Context<AppBindings>, next: Next) {
  if (c.req.method !== 'GET' || !c.req.query('v') || typeof caches === 'undefined') return next();
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(c.req.raw);
  if (hit) {
    c.res = new Response(hit.body, hit);
    return;
  }
  await next();
  if (c.res.status === 200 && c.res.headers.get('Cache-Control')?.includes('immutable')) {
    c.executionCtx.waitUntil(cache.put(c.req.raw, c.res.clone()));
  }
}

export const brand = new Hono<AppBindings>()
  .use('*', edgeCache)
  .get('/theme.css', async (c) => {
    const state = await getBrandState(c.env);
    const kvKey = `brand:css:${state.version}`;
    let css = await c.env.KV.get(kvKey);
    if (!css) {
      css = themeCss(state.theme);
      c.executionCtx.waitUntil(c.env.KV.put(kvKey, css, { expirationTtl: 30 * 86_400 }));
    }
    return c.body(css, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': cacheFor(c.req.query('v'), state.version),
      ...PUBLIC_RESOURCE,
    });
  })

  .get('/icon.svg', async (c) => {
    const state = await getBrandState(c.env);
    const uploaded = [state.assets.favicon, state.assets.mark].find((a) => a?.mime === 'image/svg+xml');
    const stored = uploaded ? await storedObject(c, uploaded.key) : null;
    return c.body(stored ? stored.body : generatedIcon(state), 200, {
      ...SVG_HEADERS,
      'Cache-Control': cacheFor(c.req.query('v'), state.version),
      ...PUBLIC_RESOURCE,
    });
  })

  .get('/manifest.webmanifest', async (c) => {
    const state = await getBrandState(c.env);
    const light = modeVars(state.theme, 'light');
    const icons: { src: string; sizes: string; type: string; purpose?: string }[] = [
      { src: `/brand/icon.svg?v=${state.version}`, sizes: 'any', type: 'image/svg+xml' },
    ];
    for (const slot of ['mark', 'favicon'] as const) {
      const a = state.assets[slot];
      const url = assetUrl(state, slot);
      if (a && url && a.mime === 'image/png') icons.push({ src: url, sizes: '512x512', type: 'image/png', purpose: 'any' });
    }
    const name = state.firmName ?? 'Client portal';
    return c.json(
      {
        name,
        short_name: state.shortName ?? name.slice(0, 24),
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: light.bg,
        theme_color: light['acc-solid'],
        icons,
      },
      200,
      { 'Content-Type': 'application/manifest+json', 'Cache-Control': cacheFor(c.req.query('v'), state.version), ...PUBLIC_RESOURCE },
    );
  })

  .get('/og.png', async (c) => {
    const state = await getBrandState(c.env);
    const headers = { 'Cache-Control': cacheFor(c.req.query('v'), state.version), ...PUBLIC_RESOURCE };
    const uploaded = state.assets.og;
    if (uploaded) {
      const stored = await storedObject(c, uploaded.key);
      if (stored) return c.body(stored.body, 200, { ...headers, 'Content-Type': stored.type });
    }
    const kvKey = `brand:og:${state.version}`;
    let png = await c.env.KV.get(kvKey, 'arrayBuffer');
    if (!png) {
      const v = modeVars(state.theme, 'light');
      const bytes = await cardPng({ width: 1200, height: 630, fill: v['acc-solid'] as string, band: v['acc-a300'] as string, bandHeight: 24 });
      png = bytes.slice().buffer;
      c.executionCtx.waitUntil(c.env.KV.put(kvKey, png, { expirationTtl: 30 * 86_400 }));
    }
    return c.body(png, 200, { ...headers, 'Content-Type': 'image/png' });
  })

  .get('/asset/:slot', async (c) => {
    const slot = c.req.param('slot');
    if (!isSlot(slot)) return c.json({ error: 'not_found' }, 404);
    const state = await getBrandState(c.env);
    const a = state.assets[slot];
    const stored = a ? await storedObject(c, a.key) : null;
    if (!a || !stored) return c.json({ error: 'not_found' }, 404);
    const headers: Record<string, string> = {
      'Content-Type': a.mime,
      'Cache-Control': c.req.query('v') === a.sha256.slice(0, 12) ? IMMUTABLE : SHORT,
      'Content-Disposition': 'inline',
      ...PUBLIC_RESOURCE,
    };
    return c.body(stored.body, 200, a.mime === 'image/svg+xml' ? { ...headers, ...SVG_HEADERS } : headers);
  });
