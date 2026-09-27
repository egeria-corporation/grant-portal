/**
 * Demo entry (worker/demo/mode.ts): one click signs a visitor in as the demo
 * consultant or the demo client user. 404 unless DEMO_MODE is on, so a
 * normal deployment has no such door.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createSession, revokeCurrent } from '../auth/session';
import { demoMode, ensureDemo } from '../demo/mode';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { clientIp, HttpError, parseJson } from '../lib/http';
import { enforce, LIMITS } from '../lib/rate-limit';

export const demoModeApi = new Hono<AppBindings>().post('/session', async (c) => {
  if (!demoMode(c.env)) throw new HttpError(404, 'not_found');
  await enforce(c, LIMITS.demoPerIp, clientIp(c.req.raw));
  const body = await parseJson(c, z.object({ as: z.enum(['consultant', 'client']) }));
  const demo = await ensureDemo(c.env);
  if (!demo) throw new HttpError(409, 'not_ready');
  if (c.get('auth')) await revokeCurrent(c);
  const userId = body.as === 'consultant' ? demo.consultantId : demo.clientUserId;
  await createSession(c, { id: userId, kind: body.as === 'consultant' ? 'staff' : 'client' }, { stepUp: false });
  await audit(c, { actor: userId, action: 'auth.signin', target: userId, meta: { method: 'demo' } });
  return c.json({ redirect: body.as === 'consultant' ? '/workspace' : '/portal' });
});
