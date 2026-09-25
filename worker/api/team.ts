/** Team management (spec §7.3: Owner only). Full role editing lands with Settings in M6. */
import { Hono } from 'hono';
import { z } from 'zod';
import { requireOwner } from '../auth/guards';
import type { AppBindings } from '../env';
import { normalizeEmail, parseJson, emailField } from '../lib/http';
import { createInvite } from './invites';

export const team = new Hono<AppBindings>()
  .use('*', requireOwner)
  .get('/', async (c) => {
    const now = Date.now();
    const [members, invites] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, email, name, role, created_at AS createdAt FROM users
          WHERE kind = 'staff' AND disabled_at IS NULL ORDER BY created_at`,
      ).all(),
      c.env.DB.prepare(
        `SELECT id, email, expires_at AS expiresAt FROM magic_links
          WHERE purpose = 'invite' AND invite_role = 'consultant' AND used_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC LIMIT 50`,
      )
        .bind(now)
        .all(),
    ]);
    return c.json({ members: members.results, invites: invites.results });
  })
  .post('/invites', async (c) => {
    const body = await parseJson(c, z.object({ email: emailField, delivery: z.enum(['email', 'link']) }));
    const out = await createInvite(c, { email: normalizeEmail(body.email), role: 'consultant', clientId: null, delivery: body.delivery });
    return c.json(out, 201);
  });
