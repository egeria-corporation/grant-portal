import { Hono } from 'hono';
import { requireOwner } from '../auth/guards';
import type { AppBindings } from '../env';
import { secretsStatus } from '../lib/secrets';

/** Owner "System" surface: generated-secret banner now; queue health etc. in M4. */
export const system = new Hono<AppBindings>()
  .use('*', requireOwner)
  .get('/secrets', async (c) => c.json({ secrets: await secretsStatus(c.env) }));
