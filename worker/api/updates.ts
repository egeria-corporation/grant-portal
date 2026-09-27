/**
 * Client updates and their schedules (spec §5.7). Mounted under
 * `/api/clients/:clientId/updates`. Staff compose, schedule, review and send;
 * client users read what was sent.
 */
import { describeRRule, isValidTimeZone, nextOccurrence, parseRRule, RRuleError } from '@shared/rrule';
import { Hono } from 'hono';
import { z } from 'zod';
import { accessOf, authOf, requireClientAccess } from '../auth/guards';
import type { AppBindings } from '../env';
import { eventStmts } from '../lib/events';
import { HttpError, parseJson } from '../lib/http';
import { newId } from '../lib/ids';
import { getSetting } from '../lib/settings';
import { BLOCK_KINDS, buildBlocks, sendUpdate, type UpdateConfig } from '../updates';

const anyMember = requireClientAccess();
const staffOnly = requireClientAccess({ clientRoles: 'none' });

const composeSchema = z.object({
  subject: z.string().trim().min(1).max(160),
  intro: z.string().trim().max(8000).optional(),
  blocks: z.array(z.enum(BLOCK_KINDS)).max(4),
  mode: z.enum(['now', 'later', 'repeat']),
  sendAt: z.number().int().positive().optional(),
  rrule: z.string().max(200).optional(),
  timezone: z.string().max(64).optional(),
  requiresReview: z.boolean().default(true),
});

interface UpdateRow {
  id: string;
  schedule_id: string | null;
  subject: string;
  intro: string | null;
  blocks_json: string;
  content_json: string | null;
  status: string;
  send_at: number | null;
  sent_at: number | null;
  created_at: number;
}

const toUpdate = (u: UpdateRow) => ({
  id: u.id,
  scheduleId: u.schedule_id,
  subject: u.subject,
  intro: u.intro,
  blocks: JSON.parse(u.blocks_json) as string[],
  content: u.content_json ? (JSON.parse(u.content_json) as unknown) : null,
  status: u.status,
  sendAt: u.send_at,
  sentAt: u.sent_at,
  createdAt: u.created_at,
});

export const updatesApi = new Hono<AppBindings>()
  .get('/', anyMember, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const staff = accessOf(c) === 'staff';
    const rows = await c.env.DB.prepare(
      `SELECT * FROM updates WHERE client_id = ? AND (? OR status = 'sent') ORDER BY COALESCE(sent_at, send_at, created_at) DESC LIMIT 100`,
    )
      .bind(clientId, staff ? 1 : 0)
      .all<UpdateRow>();
    if (!staff) return c.json({ updates: rows.results.map(toUpdate) });
    const schedules = await c.env.DB.prepare(
      "SELECT id, rrule, timezone, next_run_at, config_json, requires_review, enabled FROM schedules WHERE client_id = ? AND kind = 'update' ORDER BY created_at DESC",
    )
      .bind(clientId)
      .all<{ id: string; rrule: string; timezone: string | null; next_run_at: number | null; config_json: string | null; requires_review: number; enabled: number }>();
    return c.json({
      updates: rows.results.map(toUpdate),
      schedules: schedules.results.map((s) => {
        let description = 'Once';
        try {
          if (s.rrule) description = describeRRule(parseRRule(s.rrule));
        } catch {
          description = s.rrule;
        }
        return {
          id: s.id,
          rrule: s.rrule,
          description,
          timezone: s.timezone,
          nextRunAt: s.next_run_at,
          config: s.config_json ? (JSON.parse(s.config_json) as UpdateConfig) : null,
          requiresReview: Boolean(s.requires_review),
          enabled: Boolean(s.enabled),
        };
      }),
    });
  })

  /** The blocks as they'd look if sent now (composer preview). */
  .post('/preview', staffOnly, async (c) => {
    const body = await parseJson(c, z.object({ blocks: z.array(z.enum(BLOCK_KINDS)).max(4) }));
    const tz = (await getSetting(c.env, 'org'))?.timezone ?? 'UTC';
    return c.json({ blocks: await buildBlocks(c.env, c.req.param('clientId') as string, body.blocks, Date.now() - 30 * 86_400_000, tz) });
  })

  .post('/', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const { user } = authOf(c);
    const body = await parseJson(c, composeSchema);
    const config: UpdateConfig = { subject: body.subject, intro: body.intro || null, blocks: body.blocks };
    const now = Date.now();

    if (body.mode === 'now') {
      const id = newId('upd');
      await c.env.DB.prepare(
        `INSERT INTO updates (id, client_id, subject, intro, blocks_json, status, send_at, reviewed_by, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
      )
        .bind(id, clientId, config.subject, config.intro, JSON.stringify(config.blocks), now, user.id, user.id, now)
        .run();
      await sendUpdate(c.env, id, user.id);
      return c.json({ id, status: 'sent' }, 201);
    }

    const tz = body.timezone && isValidTimeZone(body.timezone) ? body.timezone : ((await getSetting(c.env, 'org'))?.timezone ?? 'UTC');
    let rrule = '';
    let next: number | null;
    if (body.mode === 'later') {
      if (!body.sendAt || body.sendAt < now) throw new HttpError(422, 'invalid_input', { fields: ['sendAt'] });
      next = body.sendAt;
    } else {
      try {
        const rule = parseRRule(body.rrule ?? '');
        rrule = body.rrule ?? '';
        next = nextOccurrence(rule, tz, now, now);
      } catch (err) {
        if (err instanceof RRuleError) throw new HttpError(422, 'invalid_input', { fields: ['rrule'] });
        throw err;
      }
      if (!next) throw new HttpError(422, 'invalid_input', { fields: ['rrule'] });
    }
    const id = newId('sch');
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO schedules (id, client_id, kind, rrule, timezone, next_run_at, config_json, requires_review, enabled, created_by, created_at)
         VALUES (?, ?, 'update', ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(id, clientId, rrule, tz, next, JSON.stringify(config), body.requiresReview ? 1 : 0, user.id, now),
      ...eventStmts(c.env, { clientId, actor: user.id, type: 'update.scheduled', payload: { title: config.subject, nextRunAt: next } }),
    ]);
    return c.json({ scheduleId: id, nextRunAt: next }, 201);
  })

  /** Send a draft that's waiting for review. */
  .post('/:updateId/send', staffOnly, async (c) => {
    const row = await c.env.DB.prepare('SELECT status FROM updates WHERE id = ? AND client_id = ?')
      .bind(c.req.param('updateId'), c.req.param('clientId'))
      .first<{ status: string }>();
    if (!row) throw new HttpError(404, 'not_found');
    if (row.status !== 'pending_review') throw new HttpError(409, 'update_not_sendable');
    await sendUpdate(c.env, c.req.param('updateId'), authOf(c).user.id);
    return c.json({ ok: true });
  })

  .post('/:updateId/cancel', staffOnly, async (c) => {
    const row = await c.env.DB.prepare('SELECT status FROM updates WHERE id = ? AND client_id = ?')
      .bind(c.req.param('updateId'), c.req.param('clientId'))
      .first<{ status: string }>();
    if (!row) throw new HttpError(404, 'not_found');
    const res = await c.env.DB.prepare("UPDATE updates SET status = 'cancelled' WHERE id = ? AND status IN ('scheduled', 'pending_review')")
      .bind(c.req.param('updateId'))
      .run();
    if (!res.meta.changes) throw new HttpError(409, 'update_not_sendable');
    return c.json({ ok: true });
  })

  /** Pause, resume or delete a schedule. Sent updates stay. */
  .patch('/schedules/:scheduleId', staffOnly, async (c) => {
    const body = await parseJson(c, z.object({ enabled: z.boolean().optional(), requiresReview: z.boolean().optional() }));
    const s = await c.env.DB.prepare("SELECT id, rrule, timezone, next_run_at, enabled, requires_review FROM schedules WHERE id = ? AND client_id = ? AND kind = 'update'")
      .bind(c.req.param('scheduleId'), c.req.param('clientId'))
      .first<{ id: string; rrule: string; timezone: string | null; next_run_at: number | null; enabled: number; requires_review: number }>();
    if (!s) throw new HttpError(404, 'not_found');
    let next = s.next_run_at;
    // Resuming a repeating schedule skips the runs it missed while paused.
    if (body.enabled && !s.enabled && s.rrule) next = nextOccurrence(parseRRule(s.rrule), s.timezone ?? 'UTC', Date.now(), Date.now());
    await c.env.DB.prepare('UPDATE schedules SET enabled = ?, requires_review = ?, next_run_at = ? WHERE id = ?')
      .bind(body.enabled === undefined ? s.enabled : body.enabled ? 1 : 0, body.requiresReview === undefined ? s.requires_review : body.requiresReview ? 1 : 0, next, s.id)
      .run();
    return c.json({ ok: true });
  })

  .delete('/schedules/:scheduleId', staffOnly, async (c) => {
    const res = await c.env.DB.prepare("DELETE FROM schedules WHERE id = ? AND client_id = ? AND kind = 'update'")
      .bind(c.req.param('scheduleId'), c.req.param('clientId'))
      .run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    return c.json({ ok: true });
  });
