/**
 * Demo client (spec §3.3 step 7): a fictional organisation with sample
 * deliverables, a draft report, a document request, and a paused schedule so
 * a new Owner can look around. Everything is flagged `is_demo`, never emails
 * anyone, and is removed with one call (cascading deletes).
 */
import type { AppEnv } from '../env';
import { newId } from '../lib/ids';

const DAY = 86_400_000;

export async function loadDemo(env: AppEnv, ownerId: string): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM clients WHERE is_demo = 1 LIMIT 1').first<{ id: string }>();
  if (existing) return existing.id;

  const now = Date.now();
  const clientId = newId('cli');
  const opp1 = newId('opp');
  const opp2 = newId('opp');
  const reportId = newId('rep');
  const reqId = newId('dr');
  const schedId = newId('sch');
  const d = (days: number) => now + days * DAY;

  const stmts = [
    env.DB.prepare(
      `INSERT INTO clients (id, name, legal_name, status, entity_type, is_501c3, mission, focus_tags_json, budget_band,
         owner_user_id, is_demo, created_at)
       VALUES (?, 'Sample: Riverbend Community Pantry', 'Riverbend Community Pantry (sample)', 'active', 'nonprofit', 1,
         'A fictional food pantry used to show how the portal works.', '["food security","youth"]', '$250k–$1M', ?, 1, ?)`,
    ).bind(clientId, ownerId, now),
    env.DB.prepare(
      `INSERT INTO opportunities (id, client_id, source, title, funder_name, amount_min, amount_max, deadline_at, stage, created_at)
       VALUES (?, ?, 'manual', 'Sample: Community Nutrition Grant', 'Sample Family Foundation', 25000, 50000, ?, 'preparing', ?)`,
    ).bind(opp1, clientId, d(30), now),
    env.DB.prepare(
      `INSERT INTO opportunities (id, client_id, source, title, funder_name, amount_min, amount_max, deadline_at, stage, created_at)
       VALUES (?, ?, 'manual', 'Sample: Youth Programs Capacity Award', 'Sample Regional Fund', 10000, 20000, ?, 'researching', ?)`,
    ).bind(opp2, clientId, d(45), now),
    env.DB.prepare(
      `INSERT INTO reports (id, client_id, title, intro_md, status, created_by, created_at)
       VALUES (?, ?, 'Sample funding report', 'Two sample opportunities to show how reports look.', 'draft', ?, ?)`,
    ).bind(reportId, clientId, ownerId, now),
    env.DB.prepare(
      `INSERT INTO report_items (report_id, opportunity_id, position, note_md, tag) VALUES (?, ?, 0, 'Strong fit for the nutrition program.', 'recommended')`,
    ).bind(reportId, opp1),
    env.DB.prepare(
      `INSERT INTO report_items (report_id, opportunity_id, position, note_md, tag) VALUES (?, ?, 1, 'Worth a look for next cycle.', 'consider')`,
    ).bind(reportId, opp2),
    env.DB.prepare(
      `INSERT INTO deliverables (id, client_id, opportunity_id, title, side, due_at, status, created_at)
       VALUES (?, ?, ?, 'Budget narrative', 'consultant', ?, 'in_progress', ?)`,
    ).bind(newId('dlv'), clientId, opp1, d(16), now),
    env.DB.prepare(
      `INSERT INTO deliverables (id, client_id, opportunity_id, title, side, due_at, status, created_at)
       VALUES (?, ?, ?, 'Program description draft', 'consultant', ?, 'in_review', ?)`,
    ).bind(newId('dlv'), clientId, opp1, d(10), now),
    env.DB.prepare(
      `INSERT INTO deliverables (id, client_id, title, side, due_at, status, created_at)
       VALUES (?, ?, 'Board list and signatures', 'client', ?, 'not_started', ?)`,
    ).bind(newId('dlv'), clientId, d(7), now),
    env.DB.prepare(
      `INSERT INTO doc_requests (id, client_id, title, due_at, status, created_by, created_at)
       VALUES (?, ?, 'Documents for the nutrition grant', ?, 'open', ?, ?)`,
    ).bind(reqId, clientId, d(7), ownerId, now),
    ...['Latest Form 990', 'Audited financials', 'Board list', 'W-9'].map((label, i) =>
      env.DB.prepare('INSERT INTO doc_request_items (id, doc_request_id, label, required, position) VALUES (?, ?, ?, 1, ?)').bind(
        newId('dri'),
        reqId,
        label,
        i,
      ),
    ),
    // Paused so the demo can never send anything.
    env.DB.prepare(
      `INSERT INTO schedules (id, client_id, kind, rrule, config_json, requires_review, enabled, created_by, created_at)
       VALUES (?, ?, 'update', 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9', '{"sample":true}', 1, 0, ?, ?)`,
    ).bind(schedId, clientId, ownerId, now),
    env.DB.prepare(
      `INSERT INTO events (id, client_id, actor_user_id, type, payload_json, created_at) VALUES (?, ?, ?, 'demo.loaded', NULL, ?)`,
    ).bind(newId('evt'), clientId, ownerId, now),
  ];
  await env.DB.batch(stmts);
  return clientId;
}

/** Returns how many demo clients were removed (their rows cascade). */
export async function deleteDemo(env: AppEnv): Promise<number> {
  const rows = await env.DB.prepare('DELETE FROM clients WHERE is_demo = 1 RETURNING id').all();
  return rows.results.length;
}
