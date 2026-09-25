/**
 * CSRF (spec §7.2): SameSite=Lax session cookie, plus on every state-changing
 * request an exact Origin match and a double-submit token (cookie == header).
 * Webhooks are exempt; they authenticate by signature (M4).
 */
import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../env';
import { randomToken, timingSafeEqual } from '../lib/crypto';
import { CSRF_HEADER, readCookie, writeCsrfCookie } from './cookies';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export const csrf: MiddlewareHandler<AppBindings> = async (c, next) => {
  const cookie = readCookie(c, 'csrf');

  if (!SAFE.has(c.req.method) && !c.req.path.startsWith('/webhooks/')) {
    const origin = c.req.header('Origin');
    if (!origin || origin !== new URL(c.req.url).origin) {
      return c.json({ error: 'csrf_origin' }, 403);
    }
    const header = c.req.header(CSRF_HEADER);
    if (!cookie || !header || !timingSafeEqual(cookie, header)) {
      return c.json({ error: 'csrf_token' }, 403);
    }
  }

  await next();

  if (!cookie) writeCsrfCookie(c, randomToken(24));
};
