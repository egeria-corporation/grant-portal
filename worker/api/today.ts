/**
 * Workspace home, "Today" (spec §5.1): what's due, what arrived, and which
 * clients need attention, across every client the caller can reach.
 */
import { Hono } from 'hono';
import { authOf, requireStaff } from '../auth/guards';
import type { AppBindings } from '../env';

const DAY = 86_400_000;

export const today = new Hono<AppBindings>().get('/', requireStaff, async (c) => {
  const { user } = authOf(c);
  const all = user.role === 'owner' || user.allClients ? 1 : 0;
  const now = Date.now();
  const horizon = now + 7 * DAY;
  // The accessible clients, as a reusable SQL fragment bound to ?1 (user) and ?2 (all).
  const mine = `SELECT c.id FROM clients c WHERE c.archived_at IS NULL
    AND (?2 OR EXISTS (SELECT 1 FROM staff_assignments s WHERE s.client_id = c.id AND s.user_id = ?1))`;

  const [deadlines, uploads, messages, awaiting, attention] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM (
         SELECT 'deliverable' AS kind, d.id, d.title, d.due_at AS dueAt, d.client_id AS clientId, c.name AS clientName, d.side
           FROM deliverables d JOIN clients c ON c.id = d.client_id
          WHERE d.client_id IN (${mine}) AND d.due_at IS NOT NULL AND d.due_at < ?3 AND d.status NOT IN ('approved','done')
         UNION ALL
         SELECT 'request', r.id, r.title, r.due_at, r.client_id, c.name, NULL
           FROM doc_requests r JOIN clients c ON c.id = r.client_id
          WHERE r.client_id IN (${mine}) AND r.due_at IS NOT NULL AND r.due_at < ?3 AND r.status = 'open'
         UNION ALL
         SELECT 'opportunity', o.id, o.title, o.deadline_at, o.client_id, c.name, NULL
           FROM opportunities o JOIN clients c ON c.id = o.client_id
          WHERE o.client_id IN (${mine}) AND o.deadline_at BETWEEN ?4 AND ?3 AND o.stage IN ('researching','preparing'))
       ORDER BY dueAt LIMIT 50`,
    )
      .bind(user.id, all, horizon, now)
      .all(),
    c.env.DB.prepare(
      `SELECT f.id, f.filename, f.completed_at AS at, f.client_id AS clientId, c.name AS clientName, COALESCE(u.name, u.email) AS by
         FROM files f JOIN clients c ON c.id = f.client_id JOIN users u ON u.id = f.uploaded_by
        WHERE f.client_id IN (${mine}) AND u.kind = 'client' AND f.upload_status = 'complete' AND f.deleted_at IS NULL AND f.completed_at > ?3
        ORDER BY f.completed_at DESC LIMIT 30`,
    )
      .bind(user.id, all, now - 2 * DAY)
      .all(),
    c.env.DB.prepare(
      `SELECT m.id, substr(m.body_md, 1, 160) AS preview, m.created_at AS at, m.client_id AS clientId, c.name AS clientName,
              COALESCE(u.name, u.email) AS by, m.thread_ref AS thread
         FROM messages m JOIN clients c ON c.id = m.client_id JOIN users u ON u.id = m.author_user_id
        WHERE m.client_id IN (${mine}) AND u.kind = 'client'
          AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r
                WHERE r.client_id = m.client_id AND r.user_id = ?1 AND r.thread_ref = COALESCE(m.thread_ref, '')), 0)
        ORDER BY m.created_at DESC LIMIT 30`,
    )
      .bind(user.id, all)
      .all(),
    c.env.DB.prepare(
      `SELECT d.id, d.title, d.side, d.updated_at AS at, d.client_id AS clientId, c.name AS clientName
         FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE d.client_id IN (${mine}) AND d.status = 'in_review'
        ORDER BY d.updated_at LIMIT 50`,
    )
      .bind(user.id, all)
      .all<{ id: string; title: string; side: string; at: number; clientId: string; clientName: string }>(),
    c.env.DB.prepare(
      `SELECT c.id, c.name,
         (SELECT COUNT(*) FROM doc_requests r WHERE r.client_id = c.id AND r.status = 'open' AND r.due_at < ?3) AS overdueRequests,
         (SELECT COUNT(*) FROM deliverables d WHERE d.client_id = c.id AND d.status = 'in_review' AND d.side = 'consultant') AS awaitingClient,
         (SELECT COUNT(*) FROM deliverables d WHERE d.client_id = c.id AND d.status = 'in_review' AND d.side = 'client') AS awaitingYou,
         (SELECT COUNT(*) FROM deliverables d WHERE d.client_id = c.id AND d.due_at < ?3 AND d.status NOT IN ('approved','done')) AS overdueDeliverables
        FROM clients c WHERE c.id IN (${mine})`,
    )
      .bind(user.id, all, now)
      .all<{ id: string; name: string; overdueRequests: number; awaitingClient: number; awaitingYou: number; overdueDeliverables: number }>(),
  ]);

  const unreadByClient = new Map<string, number>();
  for (const m of messages.results as { clientId: string }[]) unreadByClient.set(m.clientId, (unreadByClient.get(m.clientId) ?? 0) + 1);
  const needsAttention = attention.results
    .map((a) => ({ ...a, unread: unreadByClient.get(a.id) ?? 0 }))
    .filter((a) => a.overdueRequests || a.awaitingClient || a.awaitingYou || a.overdueDeliverables || a.unread)
    .sort((a, b) => b.overdueRequests + b.overdueDeliverables + b.unread - (a.overdueRequests + a.overdueDeliverables + a.unread));

  return c.json(
    {
      deadlines: deadlines.results,
      uploads: uploads.results,
      messages: messages.results,
      awaitingClient: awaiting.results.filter((d) => d.side === 'consultant'),
      awaitingYou: awaiting.results.filter((d) => d.side === 'client'),
      needsAttention,
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});
