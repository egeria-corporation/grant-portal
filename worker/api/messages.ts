/**
 * Messages (spec §5.8, §6.6): one thread per client, plus optional threads
 * per deliverable. Bodies are plain text (rendered as text, never HTML).
 * Attachments are vault files of the same client that the author can see.
 * Mounted under `/api/clients/:clientId/messages`. Email notifications are M4.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { accessOf, authOf, requireClientAccess } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { eventStmts } from '../lib/events';
import { HttpError, parseJson } from '../lib/http';
import { newId } from '../lib/ids';
import { clientName, notify } from '../notify';
import { visibleFiles } from './files';

const threadField = z
  .string()
  .regex(/^(dlv_[0-9A-HJKMNP-TV-Z]{26})?$/)
  .default('');

async function checkThread(env: AppEnv, clientId: string, thread: string): Promise<void> {
  if (!thread) return;
  const ok = await env.DB.prepare('SELECT 1 AS ok FROM deliverables WHERE id = ? AND client_id = ?').bind(thread, clientId).first();
  if (!ok) throw new HttpError(404, 'not_found');
}

function markReadStmt(env: AppEnv, clientId: string, userId: string, thread: string, at: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO message_reads (client_id, user_id, thread_ref, last_read_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (client_id, user_id, thread_ref) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
  ).bind(clientId, userId, thread, at);
}

/** Unread messages for a user in a client (all threads), written by someone else. */
export async function unreadCount(env: AppEnv, clientId: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m
      WHERE m.client_id = ?1 AND COALESCE(m.author_user_id, '') != ?2
        AND m.created_at > COALESCE((SELECT r.last_read_at FROM message_reads r
              WHERE r.client_id = ?1 AND r.user_id = ?2 AND r.thread_ref = COALESCE(m.thread_ref, '')), 0)`,
  )
    .bind(clientId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const anyMember = requireClientAccess();

export const messages = new Hono<AppBindings>()
  .use('*', anyMember)
  .get('/', async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const { user } = authOf(c);
    const parsed = threadField.safeParse(c.req.query('thread') ?? '');
    if (!parsed.success) throw new HttpError(404, 'not_found');
    const thread = parsed.data;
    await checkThread(c.env, clientId, thread);
    const rows = await c.env.DB.prepare(
      `SELECT * FROM (
         SELECT m.id, m.body_md, m.attachments_json, m.created_at, m.author_user_id, u.name, u.email, u.kind
           FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
          WHERE m.client_id = ? AND COALESCE(m.thread_ref, '') = ? ORDER BY m.created_at DESC LIMIT 200)
       ORDER BY created_at ASC`,
    )
      .bind(clientId, thread)
      .all<{ id: string; body_md: string; attachments_json: string | null; created_at: number; author_user_id: string | null; name: string | null; email: string | null; kind: string | null }>();
    const read = await c.env.DB.prepare('SELECT last_read_at FROM message_reads WHERE client_id = ? AND user_id = ? AND thread_ref = ?')
      .bind(clientId, user.id, thread)
      .first<{ last_read_at: number }>();
    const attachmentIds = rows.results.flatMap((r) => (r.attachments_json ? (JSON.parse(r.attachments_json) as string[]) : []));
    const files = await visibleFiles(c.env, clientId, attachmentIds, access);
    return c.json({
      thread,
      lastReadAt: read?.last_read_at ?? 0,
      messages: rows.results.map((r) => ({
        id: r.id,
        body: r.body_md,
        createdAt: r.created_at,
        mine: r.author_user_id === user.id,
        author: { name: r.name ?? r.email, kind: r.kind },
        // Attachments the viewer can't see (deleted, or internal) simply don't appear.
        attachments: (r.attachments_json ? (JSON.parse(r.attachments_json) as string[]) : []).flatMap((id) => {
          const f = files.get(id);
          return f ? [f] : [];
        }),
      })),
    });
  })

  .post('/', async (c) => {
    const clientId = c.req.param('clientId') as string;
    const access = accessOf(c);
    const { user } = authOf(c);
    const body = await parseJson(
      c,
      z.object({
        body: z.string().trim().min(1).max(10_000),
        thread: threadField,
        attachments: z.array(z.string().max(40)).max(10).default([]),
      }),
    );
    await checkThread(c.env, clientId, body.thread);
    const files = await visibleFiles(c.env, clientId, body.attachments, access);
    if (files.size !== new Set(body.attachments).size) throw new HttpError(404, 'not_found');
    // Staff attachments must be visible to the client they're talking to.
    if ([...files.values()].some((f) => !f.shared)) throw new HttpError(409, 'file_not_shared');
    const id = newId('msg');
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO messages (id, client_id, thread_ref, author_user_id, body_md, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, clientId, body.thread || null, user.id, body.body, body.attachments.length ? JSON.stringify([...new Set(body.attachments)]) : null, now),
      markReadStmt(c.env, clientId, user.id, body.thread, now),
      ...eventStmts(c.env, { clientId, actor: user.id, type: 'message.posted', payload: { messageId: id, thread: body.thread || null } }),
    ]);
    c.executionCtx.waitUntil(
      (async () => {
        const about = body.thread
          ? ((await c.env.DB.prepare('SELECT title FROM deliverables WHERE id = ?').bind(body.thread).first<{ title: string }>())?.title ?? null)
          : null;
        await notify(c.env, {
          clientId,
          audience: access === 'staff' ? 'client' : 'staff',
          kind: 'message',
          actorId: user.id,
          payload: { messageId: id, thread: body.thread || null, about, from: user.name ?? user.email, clientName: await clientName(c.env, clientId) },
        });
      })().catch((err) => console.error('[notify] message', err)),
    );
    return c.json({ id, createdAt: now }, 201);
  })

  .post('/read', async (c) => {
    const clientId = c.req.param('clientId') as string;
    const body = await parseJson(c, z.object({ thread: threadField }));
    await checkThread(c.env, clientId, body.thread);
    await markReadStmt(c.env, clientId, authOf(c).user.id, body.thread, Date.now()).run();
    return c.json({ ok: true });
  });
