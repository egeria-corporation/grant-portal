/**
 * Funding discovery (spec §5.3, §10). Everything here is staff-only.
 *
 * - `/api/funding`: status + usage meter, search, listing detail, funders.
 * - `/api/clients/:clientId/funding`: profile match for one client.
 * - `/api/clients/:clientId/alerts`: saved searches with schedules, and the
 *   review queue of their new matches.
 *
 * Without an OpenGrants key the status route says so and the others answer
 * 409 `opengrants_not_configured`; the builder then offers manual entry.
 */
import { describeRRule, isValidTimeZone, nextOccurrence, parseRRule, RRuleError } from '@shared/rrule';
import { Hono } from 'hono';
import { z } from 'zod';
import { authOf, requireClientAccess, requireStaff } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { acceptMatch, ALERT_MODES, ALERT_QUERY, clientProfile, runAlert, type AlertRow } from '../funding/alerts';
import { fundingProvider, requireProvider, usage } from '../funding/provider';
import { matchRequest } from '../integrations/opengrants/mapping';
import { HttpError, parseJson } from '../lib/http';
import { newId } from '../lib/ids';
import { getSetting } from '../lib/settings';

const staffOnly = requireClientAccess({ clientRoles: 'none' });

const searchQuery = z.object({
  kind: z.enum(['grant', 'contract']).default('grant'),
  q: z.string().trim().max(200).optional(),
  states: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{2})(,[A-Z]{2})*$/)
    .max(160)
    .optional()
    .or(z.literal('')),
  national: z.enum(['0', '1']).optional(),
  min: z.coerce.number().int().min(0).max(1e12).optional(),
  max: z.coerce.number().int().min(0).max(1e12).optional(),
  deadlineAfter: z.iso.date().optional(),
  deadlineBefore: z.iso.date().optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

function queryOf<S extends z.ZodType>(c: { req: { query: () => Record<string, string> } }, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new HttpError(422, 'invalid_input', { fields: parsed.error.issues.map((i) => i.path.join('.')).filter(Boolean) });
  return parsed.data;
}

const ogId = z.string().trim().min(1).max(100);

export const fundingApi = new Hono<AppBindings>()
  .use(requireStaff)
  .get('/status', async (c) => {
    const configured = Boolean(await fundingProvider(c.env));
    return c.json({ configured, usage: configured ? await usage(c.env) : null });
  })

  .get('/search', async (c) => {
    const q = queryOf(c, searchQuery);
    const provider = await requireProvider(c.env);
    const result = await provider.search({
      kind: q.kind,
      search: q.q,
      states: q.states || undefined,
      includeNational: q.national !== '0',
      minAmount: q.min,
      maxAmount: q.max,
      deadlineAfter: q.deadlineAfter ?? new Date().toISOString().slice(0, 10),
      deadlineBefore: q.deadlineBefore,
      offset: q.offset,
      limit: 20,
    });
    return c.json({ ...result, usage: await usage(c.env) });
  })

  .get('/listings/:kind/:ogId', async (c) => {
    const kind = z.enum(['grant', 'contract']).safeParse(c.req.param('kind'));
    const id = ogId.safeParse(c.req.param('ogId'));
    if (!kind.success || !id.success) throw new HttpError(404, 'not_found');
    return c.json({ listing: await (await requireProvider(c.env)).get(kind.data, id.data) });
  })

  .get('/funders', async (c) => {
    const { q } = queryOf(c, z.object({ q: z.string().trim().min(2).max(200) }));
    return c.json({ funders: await (await requireProvider(c.env)).funders(q), usage: await usage(c.env) });
  })

  .get('/funders/:funderId', async (c) => {
    const id = ogId.safeParse(c.req.param('funderId'));
    if (!id.success) throw new HttpError(404, 'not_found');
    return c.json({ funder: await (await requireProvider(c.env)).funder(id.data) });
  });

/** Profile match for one client (spec §10.1 "Match to client"). */
export const clientFundingApi = new Hono<AppBindings>().post('/match', staffOnly, async (c) => {
  const body = await parseJson(c, z.object({ limit: z.number().int().min(1).max(25).default(10) }));
  const profile = await clientProfile(c.env, c.req.param('clientId') as string);
  const req = profile ? matchRequest(profile, body.limit) : null;
  if (!req) throw new HttpError(422, 'profile_incomplete', { fields: ['mission', 'programs', 'focusTags'] });
  const provider = await requireProvider(c.env);
  const result = await provider.match(req);
  return c.json({ ...result, usage: await usage(c.env) });
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const alertBody = z.object({
  name: z.string().trim().min(1).max(120),
  query: ALERT_QUERY,
  mode: z.enum(ALERT_MODES).default('review'),
  rrule: z.string().max(200),
  timezone: z.string().max(64).optional(),
  requiresReview: z.boolean().default(true),
});

interface ScheduleRow {
  id: string;
  rrule: string;
  timezone: string | null;
  next_run_at: number | null;
  requires_review: number;
  enabled: number;
  created_at: number;
}

function nextRun(rrule: string, tz: string, now: number): number {
  try {
    const next = nextOccurrence(parseRRule(rrule), tz, now, now);
    if (!next) throw new HttpError(422, 'invalid_input', { fields: ['rrule'] });
    return next;
  } catch (err) {
    if (err instanceof RRuleError) throw new HttpError(422, 'invalid_input', { fields: ['rrule'] });
    throw err;
  }
}

async function alertWithSchedule(env: AppEnv, clientId: string, alertId: string): Promise<{ alert: AlertRow; schedule: ScheduleRow | null }> {
  const alert = await env.DB.prepare('SELECT * FROM alerts WHERE id = ? AND client_id = ?').bind(alertId, clientId).first<AlertRow>();
  if (!alert) throw new HttpError(404, 'not_found');
  const schedule = alert.schedule_id
    ? await env.DB.prepare("SELECT id, rrule, timezone, next_run_at, requires_review, enabled, created_at FROM schedules WHERE id = ? AND client_id = ? AND kind = 'alert'")
        .bind(alert.schedule_id, clientId)
        .first<ScheduleRow>()
    : null;
  return { alert, schedule };
}

const toAlert = (a: AlertRow & { new_count?: number }, s: ScheduleRow | null) => {
  let description = s?.rrule ?? '';
  try {
    if (s?.rrule) description = describeRRule(parseRRule(s.rrule));
  } catch {
    // keep the raw rule
  }
  return {
    id: a.id,
    name: a.name ?? 'Funding alert',
    query: ALERT_QUERY.safeParse(JSON.parse(a.query_json)).data ?? null,
    mode: a.mode,
    lastRunAt: a.last_run_at,
    lastStatus: a.last_status,
    newMatches: a.new_count ?? 0,
    schedule: s ? { id: s.id, rrule: s.rrule, description, timezone: s.timezone, nextRunAt: s.next_run_at, requiresReview: Boolean(s.requires_review), enabled: Boolean(s.enabled) } : null,
  };
};

export const alertsApi = new Hono<AppBindings>()
  .get('/', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const rows = await c.env.DB.prepare(
      `SELECT a.*, (SELECT COUNT(*) FROM alert_matches m WHERE m.alert_id = a.id AND m.status = 'new') AS new_count
         FROM alerts a WHERE a.client_id = ? ORDER BY a.created_at DESC`,
    )
      .bind(clientId)
      .all<AlertRow & { new_count: number }>();
    const schedules = await c.env.DB.prepare("SELECT id, rrule, timezone, next_run_at, requires_review, enabled, created_at FROM schedules WHERE client_id = ? AND kind = 'alert'")
      .bind(clientId)
      .all<ScheduleRow>();
    const byId = new Map(schedules.results.map((s) => [s.id, s]));
    return c.json({ alerts: rows.results.map((a) => toAlert(a, a.schedule_id ? (byId.get(a.schedule_id) ?? null) : null)), usage: (await fundingProvider(c.env)) ? await usage(c.env) : null });
  })

  .post('/', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, alertBody);
    await requireProvider(c.env); // recurring alerts need OpenGrants (spec §5.3)
    const tz = body.timezone && isValidTimeZone(body.timezone) ? body.timezone : ((await getSetting(c.env, 'org'))?.timezone ?? 'UTC');
    const now = Date.now();
    const next = nextRun(body.rrule, tz, now);
    const { user } = authOf(c);
    const alertId = newId('alr');
    const scheduleId = newId('sch');
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO schedules (id, client_id, kind, rrule, timezone, next_run_at, config_json, requires_review, enabled, created_by, created_at)
         VALUES (?, ?, 'alert', ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(scheduleId, clientId, body.rrule, tz, next, JSON.stringify({ alertId }), body.requiresReview ? 1 : 0, user.id, now),
      c.env.DB.prepare('INSERT INTO alerts (id, client_id, query_json, schedule_id, name, mode, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        alertId,
        clientId,
        JSON.stringify(body.query),
        scheduleId,
        body.name,
        body.mode,
        user.id,
        now,
      ),
    ]);
    return c.json({ id: alertId, nextRunAt: next }, 201);
  })

  .patch('/:alertId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, alertBody.partial().extend({ enabled: z.boolean().optional() }));
    const { alert, schedule } = await alertWithSchedule(c.env, clientId, c.req.param('alertId'));
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('UPDATE alerts SET name = ?, query_json = ?, mode = ? WHERE id = ? AND client_id = ?').bind(
        body.name ?? alert.name,
        body.query ? JSON.stringify(body.query) : alert.query_json,
        body.mode ?? alert.mode,
        alert.id,
        clientId,
      ),
    ];
    if (schedule) {
      const tz = body.timezone && isValidTimeZone(body.timezone) ? body.timezone : (schedule.timezone ?? 'UTC');
      const rrule = body.rrule ?? schedule.rrule;
      const enabled = body.enabled ?? Boolean(schedule.enabled);
      const now = Date.now();
      // A new rule, or resuming, recomputes the next run (runs missed while paused are skipped).
      const next = body.rrule || body.timezone || (enabled && !schedule.enabled) ? nextRun(rrule, tz, now) : schedule.next_run_at;
      stmts.push(
        c.env.DB.prepare('UPDATE schedules SET rrule = ?, timezone = ?, next_run_at = ?, requires_review = ?, enabled = ? WHERE id = ?').bind(
          rrule,
          tz,
          next,
          body.requiresReview === undefined ? schedule.requires_review : body.requiresReview ? 1 : 0,
          enabled ? 1 : 0,
          schedule.id,
        ),
      );
    }
    await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  })

  .delete('/:alertId', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const { alert } = await alertWithSchedule(c.env, clientId, c.req.param('alertId'));
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM alerts WHERE id = ? AND client_id = ?').bind(alert.id, clientId),
      c.env.DB.prepare("DELETE FROM schedules WHERE id = ? AND client_id = ? AND kind = 'alert'").bind(alert.schedule_id, clientId),
    ]);
    return c.json({ ok: true });
  })

  /** Run now (spends budget; allowed in low-budget mode because a person asked). */
  .post('/:alertId/run', staffOnly, async (c) => {
    const clientId = c.req.param('clientId') as string;
    const { alert, schedule } = await alertWithSchedule(c.env, clientId, c.req.param('alertId'));
    const result = await runAlert(c.env, alert.id, Date.now(), { requiresReview: schedule ? Boolean(schedule.requires_review) : true, interactive: true });
    return c.json(result);
  })

  /** The review queue: new matches from every alert for this client. */
  .get('/matches', staffOnly, async (c) => {
    const status = z.enum(['new', 'added', 'dismissed']).catch('new').parse(c.req.query('status'));
    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.alert_id, m.og_id, m.data_json, m.status, m.opportunity_id, m.created_at, a.name AS alert_name
         FROM alert_matches m JOIN alerts a ON a.id = m.alert_id
        WHERE m.client_id = ? AND m.status = ? ORDER BY m.created_at DESC LIMIT 200`,
    )
      .bind(c.req.param('clientId'), status)
      .all<{ id: string; alert_id: string; og_id: string; data_json: string; status: string; opportunity_id: string | null; created_at: number; alert_name: string | null }>();
    return c.json({
      matches: rows.results.map((m) => ({
        id: m.id,
        alertId: m.alert_id,
        alertName: m.alert_name ?? 'Funding alert',
        status: m.status,
        opportunityId: m.opportunity_id,
        createdAt: m.created_at,
        listing: JSON.parse(m.data_json) as unknown,
      })),
    });
  })

  .post('/matches/:matchId/add', staffOnly, async (c) => {
    const id = await acceptMatch(c.env, c.req.param('clientId') as string, c.req.param('matchId'), authOf(c).user.id);
    if (!id) throw new HttpError(404, 'not_found');
    return c.json({ opportunityId: id });
  })

  .post('/matches/:matchId/dismiss', staffOnly, async (c) => {
    const res = await c.env.DB.prepare("UPDATE alert_matches SET status = 'dismissed' WHERE id = ? AND client_id = ? AND status = 'new'")
      .bind(c.req.param('matchId'), c.req.param('clientId'))
      .run();
    if (!res.meta.changes) {
      const exists = await c.env.DB.prepare('SELECT 1 AS ok FROM alert_matches WHERE id = ? AND client_id = ?').bind(c.req.param('matchId'), c.req.param('clientId')).first();
      if (!exists) throw new HttpError(404, 'not_found');
    }
    return c.json({ ok: true });
  });
