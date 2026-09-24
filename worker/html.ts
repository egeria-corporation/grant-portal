/**
 * Serves SPA HTML through the Worker so every page gets a fresh CSP nonce
 * (docs/DECISIONS.md D-004). Non-HTML asset responses pass through with the
 * common security headers.
 */
import type { AppEnv } from './env';
import { isDev } from './env';
import { applySecurityHeaders, htmlCsp } from './lib/security-headers';

class NonceSetter implements HTMLRewriterElementContentHandlers {
  constructor(private readonly nonce: string) {}
  element(el: Element): void {
    el.setAttribute('nonce', this.nonce);
  }
}

export async function serveAsset(request: Request, env: AppEnv, nonce: string): Promise<Response> {
  const upstream = await env.ASSETS.fetch(request);
  const type = upstream.headers.get('Content-Type') ?? '';

  if (!type.includes('text/html')) {
    const res = new Response(upstream.body, upstream);
    applySecurityHeaders(res.headers);
    return res;
  }

  const setter = new NonceSetter(nonce);
  const rewritten = new HTMLRewriter()
    .on('script', setter)
    .on('style', setter)
    .on('link[rel="modulepreload"]', setter)
    .on('link[rel="stylesheet"]', setter)
    .on('meta[property="csp-nonce"]', setter)
    .transform(upstream);

  const res = new Response(rewritten.body, rewritten);
  res.headers.set('Content-Security-Policy', htmlCsp({ nonce, dev: isDev(env) }));
  // A nonce must never be served twice.
  res.headers.set('Cache-Control', 'no-store');
  res.headers.delete('ETag');
  applySecurityHeaders(res.headers);
  return res;
}
