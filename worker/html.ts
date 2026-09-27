/**
 * Serves SPA HTML through the Worker so every page gets a fresh CSP nonce
 * (docs/DECISIONS.md D-004), plus the brand (D-035): the theme stylesheet,
 * favicon, manifest, title and link-preview tags are written into <head> on
 * the server, so there's no unbranded flash and link unfurlers (which don't
 * run JavaScript) see the firm's name. Non-HTML asset responses pass through
 * with the common security headers.
 */
import { modeVars } from '@shared/theme/tokens';
import { assetUrl, type BrandState, getBrandState } from './brand/state';
import { escapeHtml } from './email/templates/render';
import type { AppEnv } from './env';
import { isDev } from './env';
import { applySecurityHeaders, htmlCsp } from './lib/security-headers';

class NonceSetter implements HTMLRewriterElementContentHandlers {
  constructor(private readonly nonce: string) {}
  element(el: Element): void {
    el.setAttribute('nonce', this.nonce);
  }
}

/** `light` / `dark` from the user's toggle; absent means follow the system. */
function themePreference(request: Request): 'light' | 'dark' | null {
  const m = /(?:^|;\s*)theme=(light|dark)(?:;|$)/.exec(request.headers.get('Cookie') ?? '');
  return (m?.[1] as 'light' | 'dark' | undefined) ?? null;
}

export function brandHead(state: BrandState, origin: string, nonce: string): string {
  const v = state.version;
  const light = modeVars(state.theme, 'light');
  const title = escapeHtml(state.firmName ?? 'Client portal');
  const description = escapeHtml(state.welcome ?? `Sign in to ${state.firmName ?? 'your client portal'}.`);
  const faviconAsset = state.assets.favicon && state.assets.favicon.mime !== 'image/svg+xml' ? assetUrl(state, 'favicon') : null;
  const touchIcon = [state.assets.mark, state.assets.favicon].some((a) => a?.mime === 'image/png')
    ? assetUrl(state, state.assets.mark?.mime === 'image/png' ? 'mark' : 'favicon')
    : null;
  const tags = [
    `<link rel="stylesheet" href="/brand/theme.css?v=${v}" nonce="${nonce}">`,
    `<link rel="icon" href="/brand/icon.svg?v=${v}" type="image/svg+xml">`,
    faviconAsset ? `<link rel="alternate icon" href="${escapeHtml(faviconAsset)}">` : '',
    touchIcon ? `<link rel="apple-touch-icon" href="${escapeHtml(touchIcon)}">` : '',
    `<link rel="manifest" href="/brand/manifest.webmanifest?v=${v}">`,
    `<meta name="theme-color" content="${light['acc-solid']}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:site_name" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:image" content="${escapeHtml(origin)}/brand/og.png?v=${v}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="brand-version" content="${v}">`,
  ];
  return tags.filter(Boolean).join('');
}

export async function serveAsset(request: Request, env: AppEnv, nonce: string): Promise<Response> {
  const upstream = await env.ASSETS.fetch(request);
  const type = upstream.headers.get('Content-Type') ?? '';

  if (!type.includes('text/html')) {
    const res = new Response(upstream.body, upstream);
    applySecurityHeaders(res.headers);
    return res;
  }

  let state: BrandState | null = null;
  try {
    state = await getBrandState(env);
  } catch {
    // Migrations not applied yet: serve the unbranded shell rather than fail.
  }
  const preference = themePreference(request);
  const setter = new NonceSetter(nonce);
  let rewriter = new HTMLRewriter()
    .on('script', setter)
    .on('style', setter)
    .on('link[rel="modulepreload"]', setter)
    .on('link[rel="stylesheet"]', setter)
    .on('meta[property="csp-nonce"]', setter);

  if (state) {
    const head = brandHead(state, new URL(request.url).origin, nonce);
    const brandTitle = state.firmName;
    const compact = state.theme.density === 'compact';
    rewriter = rewriter
      .on('html', {
        element(el) {
          if (preference) el.setAttribute('data-theme', preference);
          if (compact) el.setAttribute('class', 'd-compact');
        },
      })
      .on('title', {
        element(el) {
          if (brandTitle) el.setInnerContent(brandTitle);
        },
      })
      .on('head', {
        element(el) {
          el.append(head, { html: true });
        },
      });
  }

  const rewritten = rewriter.transform(upstream);
  const res = new Response(rewritten.body, rewritten);
  res.headers.set('Content-Security-Policy', htmlCsp({ nonce, dev: isDev(env) }));
  // A nonce must never be served twice.
  res.headers.set('Cache-Control', 'no-store');
  res.headers.delete('ETag');
  applySecurityHeaders(res.headers);
  return res;
}
