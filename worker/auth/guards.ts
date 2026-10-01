/**
 * Authorization middleware (spec §7.3). Routes declare who may call them here,
 * never only inside handlers. Every route is also covered by the generated
 * authz test in tests/worker/authz.test.ts.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AppBindings, AppEnv, AuthState, Role } from '../env';
import { HttpError } from '../lib/http';

type C = Context<AppBindings>;

function denyUnauthenticated(c: C) {
  return c.json({ error: 'unauthenticated' }, 401);
}

/** Any signed-in user. Deliberately skips the passkey-enrollment gate (see requireStaff). */
export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get('auth')) return denyUnauthenticated(c);
  await next();
};

function gateStaff(c: C, auth: AuthState | null) {
  if (!auth) return denyUnauthenticated(c);
  if (auth.user.kind !== 'staff') return c.json({ error: 'forbidden' }, 403);
  if (auth.needsPasskey) return c.json({ error: 'passkey_enrollment_required' }, 403);
  return null;
}

/** Owner or Consultant, with a passkey if the Owner requires one. */
export const requireStaff: MiddlewareHandler<AppBindings> = async (c, next) => {
  const denied = gateStaff(c, c.get('auth'));
  if (denied) return denied;
  await next();
};

export const requireOwner: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get('auth');
  const denied = gateStaff(c, auth);
  if (denied) return denied;
  if (auth?.user.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
  await next();
};

/** Staff account, before the passkey-enrollment gate (used to enroll a passkey). */
export const requireStaffAccount: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth) return denyUnauthenticated(c);
  if (auth.user.kind !== 'staff') return c.json({ error: 'forbidden' }, 403);
  await next();
};

export const requireClientUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth) return denyUnauthenticated(c);
  if (auth.user.kind !== 'client') return c.json({ error: 'forbidden' }, 403);
  await next();
};

/**
 * Sensitive actions need a recent strong authentication: a passkey assertion
 * or a fresh magic-link sign-in within `maxAgeMs` (spec §7.1 step-up).
 */
export function requireStepUp(maxAgeMs = 30 * 60_000): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return denyUnauthenticated(c);
    if (!auth.session.stepUpAt || Date.now() - auth.session.stepUpAt > maxAgeMs) {
      return c.json({ error: 'step_up_required' }, 403);
    }
    await next();
  };
}

/** Which way the caller reaches a client: as staff, or as one of its client users. */
export type ClientAccess = 'staff' | 'admin' | 'member';

const CLIENT_ID_RE = /^cli_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * How `auth` may reach `clientId`, or null. Owner: any client. Consultant:
 * assigned clients, or all when the Owner granted it. Client users: clients
 * they are a member of, while the client isn't archived (staff keep access to
 * archived clients so they can review, export, un-archive or delete them;
 * DECISIONS D-081). Used by requireClientAccess and by routes that find the
 * client through another row (file downloads, calendar feeds).
 */
export async function clientAccessFor(env: AppEnv, auth: AuthState, clientId: string): Promise<ClientAccess | null> {
  if (!CLIENT_ID_RE.test(clientId)) return null;
  if (auth.user.kind === 'staff') {
    if (auth.needsPasskey) return null;
    const row =
      auth.user.role === 'owner' || auth.user.allClients
        ? await env.DB.prepare('SELECT 1 AS ok FROM clients WHERE id = ?').bind(clientId).first()
        : await env.DB.prepare('SELECT 1 AS ok FROM staff_assignments WHERE client_id = ? AND user_id = ?')
            .bind(clientId, auth.user.id)
            .first();
    return row ? 'staff' : null;
  }
  const member = await env.DB.prepare(
    `SELECT m.role FROM client_members m JOIN clients c ON c.id = m.client_id
      WHERE m.client_id = ? AND m.user_id = ? AND c.archived_at IS NULL`,
  )
    .bind(clientId, auth.user.id)
    .first<{ role: 'admin' | 'member' }>();
  return member?.role ?? null;
}

/**
 * Scopes a route to one client (`:clientId` param) and records how the caller
 * reaches it (`c.get('clientAccess')`). `clientRoles` limits which client
 * users may pass: 'none' makes the route staff-only. Anything not allowed gets
 * 404, so client IDs can't be probed.
 */
export function requireClientAccess(opts: { param?: string; clientRoles?: ('admin' | 'member')[] | 'none' } = {}): MiddlewareHandler<AppBindings> {
  const param = opts.param ?? 'clientId';
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return denyUnauthenticated(c);
    const clientId = c.req.param(param);
    if (!clientId || !CLIENT_ID_RE.test(clientId)) return c.json({ error: 'not_found' }, 404);
    if (auth.user.kind === 'staff' && auth.needsPasskey) return c.json({ error: 'passkey_enrollment_required' }, 403);

    const access = await clientAccessFor(c.env, auth, clientId);
    let allowed = access !== null;
    if (access && access !== 'staff') {
      allowed = opts.clientRoles !== 'none' && (!opts.clientRoles || opts.clientRoles.includes(access));
    }
    if (!allowed || !access) return c.json({ error: 'not_found' }, 404);
    c.set('clientAccess', access);
    await next();
  };
}

/** How the caller reaches the route's client. Only valid behind requireClientAccess. */
export function accessOf(c: C): ClientAccess {
  const access = c.get('clientAccess');
  if (!access) throw new HttpError(404, 'not_found');
  return access;
}

export function hasRole(auth: AuthState | null, ...roles: Role[]): boolean {
  return Boolean(auth && roles.includes(auth.user.role));
}

/** The signed-in user inside a handler already behind requireAuth/requireStaff/requireOwner. */
export function authOf(c: C): AuthState {
  const auth = c.get('auth');
  if (!auth) throw new HttpError(401, 'unauthenticated');
  return auth;
}
