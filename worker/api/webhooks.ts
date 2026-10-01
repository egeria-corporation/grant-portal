/** `/webhooks/*`: signed callbacks from outside services. CSRF-exempt; authenticated by signature. */
import { Hono } from 'hono';
import { applyDeliveryEvent, webhookSecret } from '../email/delivery';
import { parseDeliveryEvent, verifySvix } from '../email/webhook';
import type { AppBindings } from '../env';
import { readBodyCapped } from '../lib/http';

const MAX_BODY = 256 * 1024;

export const webhooks = new Hono<AppBindings>().post('/resend', async (c) => {
  const secret = await webhookSecret(c.env);
  if (!secret) return c.json({ error: 'not_found' }, 404);
  // Unauthenticated until the signature checks out: never read more than the cap.
  const body = new TextDecoder().decode(await readBodyCapped(c.req.raw, MAX_BODY));
  const id = c.req.header('svix-id') ?? null;
  const ok = await verifySvix(secret, { id, timestamp: c.req.header('svix-timestamp') ?? null, signature: c.req.header('svix-signature') ?? null }, body);
  if (!ok || !id) return c.json({ error: 'invalid_signature' }, 401);

  // Svix retries until it gets a 2xx; each message ID is applied once.
  const seen = `wh:${id.slice(0, 100)}`;
  if (await c.env.KV.get(seen)) return c.json({ ok: true, duplicate: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const event = parseDeliveryEvent(parsed);
  if (event) await applyDeliveryEvent(c.env, event);
  await c.env.KV.put(seen, '1', { expirationTtl: 7 * 86_400 });
  return c.json({ ok: true });
});
