/**
 * One-click unsubscribe (RFC 8058, spec §9). Mail providers POST
 * `List-Unsubscribe=One-Click` to the URL; the portal's page POSTs the same
 * after a confirm button. The signed token is the only authorization, and all
 * it can do is turn one category of email off. GET serves the SPA page.
 */
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { applyUnsubscribe, verifyUnsubscribeToken } from '../notify';

export const unsubscribe = new Hono<AppBindings>().post('/:token', async (c) => {
  const token = c.req.param('token');
  const ok = token.length < 200 ? await verifyUnsubscribeToken(c.env, token) : null;
  if (!ok) return c.json({ error: 'not_found' }, 404);
  await applyUnsubscribe(c.env, ok.userId, ok.category);
  return c.json({ ok: true, category: ok.category });
});
