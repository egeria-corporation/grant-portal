/**
 * Cookie names and flags (spec §7.1). `__Host-` prefix: Secure, Path=/, no
 * Domain, so a sibling subdomain can't set or overwrite them.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppBindings } from '../env';

export const SESSION_COOKIE = 'session';
export const DEVICE_COOKIE = 'device';
export const CSRF_COOKIE = 'csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

type C = Context<AppBindings>;

export function readCookie(c: C, name: string): string | undefined {
  return getCookie(c, name, 'host');
}

export function writeSessionCookie(c: C, value: string, maxAgeSec: number): void {
  setCookie(c, SESSION_COOKIE, value, { prefix: 'host', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: maxAgeSec });
}

export function clearSessionCookie(c: C): void {
  deleteCookie(c, SESSION_COOKIE, { prefix: 'host', secure: true, path: '/' });
}

/** Long-lived random device id, for new-device notifications only. */
export function writeDeviceCookie(c: C, value: string): void {
  setCookie(c, DEVICE_COOKIE, value, {
    prefix: 'host',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 400 * 24 * 3600,
  });
}

/** Double-submit CSRF token: readable by the SPA (not HttpOnly), echoed in a header. */
export function writeCsrfCookie(c: C, value: string): void {
  setCookie(c, CSRF_COOKIE, value, { prefix: 'host', httpOnly: false, secure: true, sameSite: 'Lax', path: '/' });
}
