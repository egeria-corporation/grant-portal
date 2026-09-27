/**
 * Funding alerts and recurring reports (spec §5.3, §5.7, §10.4). An alert is
 * a saved search (or a profile match) for one client with a schedule. Each
 * run keeps only listings it hasn't seen before, then either
 * - `review`: queues them for the consultant (`alert_matches`), or
 * - `report`: drafts a funding report of them, held for review when the
 *   schedule requires it (default), otherwise sent.
 * Runs pause in low-budget mode; interactive search keeps working.
 *
 * Also here: the daily deadline refresh for saved OpenGrants opportunities.
 */
import { z } from 'zod';
import type { AppEnv } from '../env';
import { matchRequest, type ClientProfileForMatch, type OpportunityDraft } from '../integrations/opengrants/mapping';
import { eventStmts } from '../lib/events';
import { newId } from '../lib/ids';
import { clientName, notify } from '../notify';
import { sendReport } from '../reports';
import { insertOpportunity } from '../api/opportunities';
import { fundingProvider, FundingError, usage, type SearchResult } from './provider';

export const ALERT_QUERY = z.object({
  /** search: the filters below. match: the client profile (spec §10.3 mapping). */
  source: z.enum(['search', 'match']).default('search'),
  kind: z.enum(['grant', 'contract']).default('grant'),
  search: z.string().trim().max(200).optional(),
  states: z
    .string()
    .trim()
    .regex(/^([A-Z]{2})(,[A-Z]{2})*$/)
    .max(160)
    .optional(),
  minAmount: z.number().int().min(0).max(1e12).optional(),
  maxAmount: z.number().int().min(0).max(1e12).optional(),
});
export type AlertQuery = z.infer<typeof ALERT_QUERY>;
export const ALERT_MODES = ['review', 'report'] as const;

const SEEN_CAP = 1000;
const RESULT_LIMIT = 25;

export interface AlertRow {
  id: string;
  client_id: string;
  query_json: string;
  schedule_id: string | null;
  last_run_at: number | null;
  last_result_ids_json: string | null;
  name: string | null;
  mode: 'review' | 'report';
  last_status: string | null;
  created_by: string | null;
  created_at: number | null;
}

export type RunStatus = 'ok' | 'skipped_budget' | 'not_configured' | 'no_profile' | 'error';

interface ProfileRow {
  mission: string | null;
  entity_type: string | null;
  is_501c3: number | null;
  geography_json: string | null;
  budget_band: string | null;
  programs_json: string | null;
  focus_tags_json: string | null;
  populations_json: string | null;
}

const arr = (json: string | null): string[] => {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export async function clientProfile(env: AppEnv, clientId: string): Promise<ClientProfileForMatch | null> {
  const r = await env.DB.prepare(
    'SELECT mission, entity_type, is_501c3, geography_json, budget_band, programs_json, focus_tags_json, populations_json FROM clients WHERE id = ?',
  )
    .bind(clientId)
    .first<ProfileRow>();
  if (!r) return null;
  return {
    mission: r.mission,
    entityType: r.entity_type,
    is501c3: r.is_501c3 === null ? null : Boolean(r.is_501c3),
    geography: arr(r.geography_json),
    budgetBand: r.budget_band,
    programs: arr(r.programs_json),
    focusTags: arr(r.focus_tags_json),
    populations: arr(r.populations_json),
  };
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Runs the alert's query. Null when a profile match has nothing to match on. */
async function fetchResults(env: AppEnv, alert: AlertRow, now: number): Promise<SearchResult | null> {
  const provider = await fundingProvider(env);
  if (!provider) throw new FundingError('not_configured');
  const q = ALERT_QUERY.parse(JSON.parse(alert.query_json));
  if (q.source === 'match') {
    const profile = await clientProfile(env, alert.client_id);
    const body = profile ? matchRequest(profile, RESULT_LIMIT) : null;
    return body ? provider.match(body) : null;
  }
  return provider.search({
    kind: q.kind,
    search: q.search,
    states: q.states,
    minAmount: q.minAmount,
    maxAmount: q.maxAmount,
    deadlineAfter: today(now),
    limit: RESULT_LIMIT,
  });
}

const line = (d: OpportunityDraft) => ({ title: d.title, ...(d.funderName ? { detail: d.funderName } : {}) });

/**
 * One run of one alert. `runAt` identifies the run: a retried queue job finds
 * the report it already drafted instead of drafting another.
 */
export async function runAlert(env: AppEnv, alertId: string, runAt: number, opts: { requiresReview: boolean; interactive?: boolean }): Promise<{ status: RunStatus; found: number }> {
  const alert = await env.DB.prepare('SELECT * FROM alerts WHERE id = ?').bind(alertId).first<AlertRow>();
  if (!alert) return { status: 'error', found: 0 };
  const now = Date.now();
  const setStatus = (status: RunStatus, seen?: string[]) =>
    env.DB.prepare('UPDATE alerts SET last_status = ?, last_run_at = ?, last_result_ids_json = COALESCE(?, last_result_ids_json) WHERE id = ?')
      .bind(status, now, seen ? JSON.stringify(seen.slice(-SEEN_CAP)) : null, alert.id)
      .run();

  // Low-budget mode pauses scheduled runs only (spec §10.4).
  if (!opts.interactive && (await usage(env)).low) {
    await setStatus('skipped_budget');
    return { status: 'skipped_budget', found: 0 };
  }
  let results: SearchResult | null;
  try {
    results = await fetchResults(env, alert, now);
  } catch (err) {
    if (err instanceof FundingError) {
      const status: RunStatus = err.code === 'not_configured' ? 'not_configured' : err.code === 'budget_exhausted' ? 'skipped_budget' : 'error';
      await setStatus(status);
      if (opts.interactive) throw err;
      return { status, found: 0 };
    }
    throw err;
  }
  if (!results) {
    await setStatus('no_profile');
    return { status: 'no_profile', found: 0 };
  }

  const seen = new Set(arr(alert.last_result_ids_json));
  const saved = await env.DB.prepare('SELECT og_id FROM opportunities WHERE client_id = ? AND og_id IS NOT NULL').bind(alert.client_id).all<{ og_id: string }>();
  for (const r of saved.results) seen.add(r.og_id);
  const queued = await env.DB.prepare('SELECT og_id FROM alert_matches WHERE alert_id = ?').bind(alert.id).all<{ og_id: string }>();
  for (const r of queued.results) seen.add(r.og_id);
  const fresh = results.items.filter((d) => !seen.has(d.ogId));
  const allSeen = [...new Set([...arr(alert.last_result_ids_json), ...results.items.map((d) => d.ogId)])];
  // `seen` is saved only after the matches are stored, so a failed run is retried in full.
  if (!fresh.length) {
    await setStatus('ok', allSeen);
    return { status: 'ok', found: 0 };
  }

  const name = alert.name || 'Funding alert';
  const cname = await clientName(env, alert.client_id);

  if (alert.mode === 'review') {
    await env.DB.batch([
      ...fresh.map((d) =>
        env.DB.prepare("INSERT OR IGNORE INTO alert_matches (id, alert_id, client_id, og_id, data_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?)").bind(
          newId('alm'),
          alert.id,
          alert.client_id,
          d.ogId,
          JSON.stringify(d),
          now,
        ),
      ),
      ...eventStmts(env, { clientId: alert.client_id, actor: null, type: 'alert.matched', payload: { alertId: alert.id, title: name, count: fresh.length } }),
    ]);
    await setStatus('ok', allSeen);
    await notify(env, {
      clientId: alert.client_id,
      audience: 'staff',
      kind: 'alert.matches',
      payload: { alertId: alert.id, alertName: name, count: fresh.length, items: fresh.slice(0, 5).map(line), clientName: cname },
    });
    return { status: 'ok', found: fresh.length };
  }

  // Recurring report: one draft per run.
  const existing = alert.schedule_id
    ? await env.DB.prepare('SELECT id, status FROM reports WHERE schedule_id = ? AND created_at = ?').bind(alert.schedule_id, runAt).first<{ id: string; status: string }>()
    : null;
  if (existing) {
    await setStatus('ok', allSeen);
    return { status: 'ok', found: fresh.length };
  }
  const reportId = newId('rpt');
  const title = `${name}: ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(runAt)}`;
  const opps = fresh.map((d) =>
    insertOpportunity(env, {
      clientId: alert.client_id,
      actor: null,
      source: 'opengrants',
      ogId: d.ogId,
      kind: d.kind,
      title: d.title,
      funderName: d.funderName,
      url: d.url,
      amountMin: d.amountMin,
      amountMax: d.amountMax,
      deadlineAt: d.deadlineAt,
      eligibilityNotes: d.eligibilityNotes,
      data: { summary: d.summary, fitScore: d.fitScore },
      now,
    }),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO reports (id, client_id, title, status, schedule_id, pending_review, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)",
    ).bind(reportId, alert.client_id, title, alert.schedule_id, opts.requiresReview ? 1 : 0, alert.created_by, runAt, now),
    ...opps.flatMap((o) => o.stmts),
    ...opps.map((o, i) => env.DB.prepare('INSERT INTO report_items (report_id, opportunity_id, position) VALUES (?, ?, ?)').bind(reportId, o.id, i)),
  ]);
  await setStatus('ok', allSeen);
  if (opts.requiresReview) {
    await notify(env, {
      clientId: alert.client_id,
      audience: 'staff',
      kind: 'report.review',
      payload: { reportId, alertId: alert.id, alertName: name, count: fresh.length, items: fresh.slice(0, 5).map(line), clientName: cname },
    });
  } else {
    await sendReport(env, reportId, alert.client_id, null);
  }
  return { status: 'ok', found: fresh.length };
}

/** Queue job entry for `schedule.run` of kind `alert`. */
export async function runAlertSchedule(env: AppEnv, schedule: { id: string; config_json: string | null; requires_review: number }, runAt: number): Promise<void> {
  const alertId = schedule.config_json ? (JSON.parse(schedule.config_json) as { alertId?: string }).alertId : undefined;
  if (!alertId) return;
  await runAlert(env, alertId, runAt, { requiresReview: Boolean(schedule.requires_review) });
}

/** Adds a queued match to the client's opportunities (no extra API call: the listing data came with the match). */
export async function acceptMatch(env: AppEnv, clientId: string, matchId: string, actor: string): Promise<string | null> {
  const m = await env.DB.prepare("SELECT id, og_id, data_json, status, opportunity_id FROM alert_matches WHERE id = ? AND client_id = ?")
    .bind(matchId, clientId)
    .first<{ id: string; og_id: string; data_json: string; status: string; opportunity_id: string | null }>();
  if (!m) return null;
  if (m.opportunity_id) return m.opportunity_id;
  const existing = await env.DB.prepare('SELECT id FROM opportunities WHERE client_id = ? AND og_id = ?').bind(clientId, m.og_id).first<{ id: string }>();
  let oppId = existing?.id;
  const stmts: D1PreparedStatement[] = [];
  if (!oppId) {
    const d = JSON.parse(m.data_json) as OpportunityDraft;
    const out = insertOpportunity(env, {
      clientId,
      actor,
      source: 'opengrants',
      ogId: m.og_id,
      kind: d.kind === 'contract' ? 'contract' : 'grant',
      title: String(d.title).slice(0, 300),
      funderName: d.funderName,
      url: d.url,
      amountMin: d.amountMin,
      amountMax: d.amountMax,
      deadlineAt: d.deadlineAt,
      eligibilityNotes: d.eligibilityNotes,
      data: { summary: d.summary, fitScore: d.fitScore },
    });
    oppId = out.id;
    stmts.push(...out.stmts);
  }
  stmts.push(env.DB.prepare("UPDATE alert_matches SET status = 'added', opportunity_id = ? WHERE id = ?").bind(oppId, m.id));
  await env.DB.batch(stmts);
  return oppId;
}

const REFRESH_PER_DAY = 10;

/**
 * Daily deadline refresh (spec §12): re-reads saved OpenGrants listings that
 * are still live, a few a day and only outside low-budget mode. Grant detail
 * is cached for 24 h, so a listing shared by clients costs one request.
 */
export async function refreshDeadlines(env: AppEnv, now: number): Promise<number> {
  const provider = await fundingProvider(env);
  if (!provider) return 0;
  const rows = await env.DB.prepare(
    `SELECT id, client_id, og_id, kind, title, deadline_at, url FROM opportunities
      WHERE source = 'opengrants' AND og_id IS NOT NULL AND stage IN ('none', 'researching', 'preparing')
        AND (deadline_at IS NULL OR deadline_at > ?) AND COALESCE(refreshed_at, 0) < ?
      ORDER BY COALESCE(refreshed_at, 0) LIMIT ?`,
  )
    .bind(now, now - 20 * 3600_000, REFRESH_PER_DAY)
    .all<{ id: string; client_id: string; og_id: string; kind: string; title: string; deadline_at: number | null; url: string | null }>();
  let changed = 0;
  for (const o of rows.results) {
    if ((await usage(env)).low) break;
    try {
      const d = await provider.get(o.kind === 'contract' ? 'contract' : 'grant', o.og_id);
      const moved = d.deadlineAt !== null && d.deadlineAt !== o.deadline_at;
      const stmts: D1PreparedStatement[] = [
        env.DB.prepare('UPDATE opportunities SET deadline_at = COALESCE(?, deadline_at), url = COALESCE(url, ?), refreshed_at = ? WHERE id = ?').bind(d.deadlineAt, d.url, now, o.id),
      ];
      if (moved) {
        changed++;
        stmts.push(
          ...eventStmts(env, { clientId: o.client_id, actor: null, type: 'opportunity.updated', payload: { opportunityId: o.id, title: o.title, deadlineFrom: o.deadline_at, deadlineTo: d.deadlineAt } }),
        );
      }
      await env.DB.batch(stmts);
    } catch (err) {
      if (err instanceof FundingError && err.code === 'not_found') {
        await env.DB.prepare('UPDATE opportunities SET refreshed_at = ? WHERE id = ?').bind(now, o.id).run();
        continue;
      }
      if (err instanceof FundingError) break;
      throw err;
    }
  }
  return changed;
}
