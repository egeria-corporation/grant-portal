/** Request helpers shared by route modules: client IP, UA labels, JSON body parsing. */
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../env';
import { getSecret } from './secrets';
import { hmacSha256Hex } from './crypto';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 503,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

/** Cloudflare sets CF-Connecting-IP at the edge; tests and local dev may not. */
export function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
}

/**
 * Keyed hash for IPs, emails in rate-limit keys, and similar low-entropy values.
 * Plain SHA-256 of an IPv4 address is reversible by enumeration; HMAC with the
 * session secret is not (without the secret).
 */
export async function keyedHash(c: Context<AppBindings>, purpose: string, value: string): Promise<string> {
  const secret = await getSecret(c.env, 'SESSION_SECRET');
  return (await hmacSha256Hex(secret, `${purpose}:${value}`)).slice(0, 32);
}

/** "Chrome on macOS" — enough for a session list, without storing the raw UA. */
export function uaLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'unknown OS';
  return `${browser} on ${os}`;
}

const MAX_JSON_BYTES = 64 * 1024;

/** Parses and validates a JSON body. Errors are 400/413/422 with no echo of input. */
export async function parseJson<S extends z.ZodType>(c: Context<AppBindings>, schema: S): Promise<z.infer<S>> {
  const type = c.req.header('Content-Type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(400, 'expected_json');
  const text = await c.req.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, 'body_too_large');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, 'invalid_input', {
      fields: parsed.error.issues.map((i) => i.path.join('.')).filter(Boolean),
    });
  }
  return parsed.data;
}

/** Lower-cased, trimmed email. Validation happens in the Zod schema. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Canonical origin of this deployment for links in email (the request's own origin). */
export function publicOrigin(req: Request): string {
  return new URL(req.url).origin;
}

/** Email input: trimmed and lower-cased before validation, so "Jane@Org.org " works. */
export const emailField = z.string().max(320).trim().toLowerCase().pipe(z.email().max(254));
