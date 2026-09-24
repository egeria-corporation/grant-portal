import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../env';

/**
 * Owner-only guard. Sessions arrive in M1; until then no request can be an
 * Owner, so every guarded route answers 401 (fail closed).
 */
export const requireOwner: MiddlewareHandler<AppBindings> = async (c) => {
  return c.json({ error: 'unauthenticated' }, 401);
};
