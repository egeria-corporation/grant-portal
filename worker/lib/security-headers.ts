/**
 * Response security headers (spec §7.2). HTML gets a per-request nonce CSP;
 * everything else gets a locked-down `default-src 'none'` policy.
 */
import { randomBytes, toBase64Url } from './crypto';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export function newNonce(): string {
  return toBase64Url(randomBytes(18));
}

export interface CspOptions {
  nonce: string;
  /** Vite dev server needs a websocket for HMR. */
  dev?: boolean;
}

export function htmlCsp({ nonce, dev = false }: CspOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // 'strict-dynamic' lets nonce'd module scripts load their own chunks
    // (and the Turnstile script we inject) without allow-listing hosts.
    'script-src': [`'nonce-${nonce}'`, "'strict-dynamic'"],
    'style-src': ["'self'", `'nonce-${nonce}'`],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': dev ? ["'self'", 'ws:', 'wss:'] : ["'self'"],
    'frame-src': [TURNSTILE_ORIGIN],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'media-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  const policy = Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`);
  if (!dev) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const COMMON: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), ' +
    'magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=(), interest-cohort=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
};

/** Sets the common header set; does not overwrite a CSP a handler already chose. */
export function applySecurityHeaders(headers: Headers, csp: string = API_CSP): void {
  for (const [k, v] of Object.entries(COMMON)) headers.set(k, v);
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', csp);
}
