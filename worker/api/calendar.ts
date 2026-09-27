/**
 * Calendar feeds (spec §5.7): one ICS URL per person (staff: all their
 * clients or one; client users: their organization), carrying deliverable due
 * dates, document requests, grant deadlines and scheduled sends. The URL
 * holds a random token (only its hash is stored); revoking kills the URL.
 * Access is re-checked on every fetch, so losing access empties the feed.
 */
import { localParts } from '@shared/rrule';
import { Hono } from 'hono';
import { z } from 'zod';
import { authOf, clientAccessFor, requireAuth } from '../auth/guards';
import type { AppBindings, AppEnv } from '../env';
import { randomToken, sha256Hex } from '../lib/crypto';
import { HttpError, parseJson, publicOrigin } from '../lib/http';
import { newId } from '../lib/ids';
import { getSetting } from '../lib/settings';

export const calendarFeeds = new Hono<AppBindings>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT f.id, f.client_id AS clientId, c.name AS clientName, f.label, f.created_at AS createdAt, f.last_used_at AS lastUsedAt
         FROM calendar_feeds f LEFT JOIN clients c ON c.id = f.client_id
        WHERE f.user_id = ? AND f.revoked_at IS NULL ORDER BY f.created_at DESC`,
    )
      .bind(authOf(c).user.id)
      .all();
    return c.json({ feeds: rows.results });
  })
  .post('/', async (c) => {
    const auth = authOf(c);
    const body = await parseJson(c, z.object({ clientId: z.string().max(40).nullable().optional() }));
    const clientId = body.clientId ?? null;
    if (clientId) {
      if (!(await clientAccessFor(c.env, auth, clientId))) throw new HttpError(404, 'not_found');
    } else if (auth.user.kind !== 'staff') {
      throw new HttpError(422, 'invalid_input', { fields: ['clientId'] });
    }
    const token = randomToken(32);
    const id = newId('cal');
    await c.env.DB.prepare('INSERT INTO calendar_feeds (id, token_hash, user_id, client_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, await sha256Hex(token), auth.user.id, clientId, Date.now())
      .run();
    // Shown once; only the hash is kept.
    return c.json({ id, url: `${publicOrigin(c.req.raw)}/ics/${token}.ics` }, 201);
  })
  .delete('/:id', async (c) => {
    const res = await c.env.DB.prepare('UPDATE calendar_feeds SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .bind(Date.now(), c.req.param('id'), authOf(c).user.id)
      .run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    return c.json({ ok: true });
  });

/** RFC 5545 text escaping and 75-octet line folding. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

const ymd = (ms: number, tz: string) => {
  const p = localParts(ms, tz);
  return `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
};
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

interface Item {
  uid: string;
  title: string;
  at: number;
  allDay: boolean;
  url: string;
}

async function feedItems(env: AppEnv, clientIds: string[], staff: boolean, origin: string): Promise<Item[]> {
  if (!clientIds.length) return [];
  const inList = clientIds.map(() => '?').join(',');
  const now = Date.now();
  const since = now - 60 * 86_400_000;
  const base = (clientId: string) => (staff ? `${origin}/workspace/clients/${clientId}` : `${origin}/portal`);
  const [dels, reqs, opps, sched] = await Promise.all([
    env.DB.prepare(
      `SELECT d.id, d.title, d.due_at, d.client_id, c.name FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE d.client_id IN (${inList}) AND d.due_at > ? AND d.status NOT IN ('approved','done')`,
    )
      .bind(...clientIds, since)
      .all<{ id: string; title: string; due_at: number; client_id: string; name: string }>(),
    env.DB.prepare(
      `SELECT r.id, r.title, r.due_at, r.client_id, c.name FROM doc_requests r JOIN clients c ON c.id = r.client_id
        WHERE r.client_id IN (${inList}) AND r.due_at > ? AND r.status = 'open'`,
    )
      .bind(...clientIds, since)
      .all<{ id: string; title: string; due_at: number; client_id: string; name: string }>(),
    env.DB.prepare(
      `SELECT o.id, o.title, o.deadline_at, o.client_id, c.name FROM opportunities o JOIN clients c ON c.id = o.client_id
        WHERE o.client_id IN (${inList}) AND o.deadline_at > ? AND o.stage IN ('researching','preparing','submitted')`,
    )
      .bind(...clientIds, since)
      .all<{ id: string; title: string; deadline_at: number; client_id: string; name: string }>(),
    staff
      ? env.DB.prepare(
          `SELECT s.id, s.next_run_at, s.config_json, s.client_id, c.name FROM schedules s JOIN clients c ON c.id = s.client_id
            WHERE s.client_id IN (${inList}) AND s.enabled = 1 AND s.next_run_at > ?`,
        )
          .bind(...clientIds, now)
          .all<{ id: string; next_run_at: number; config_json: string | null; client_id: string; name: string }>()
      : Promise.resolve({ results: [] as { id: string; next_run_at: number; config_json: string | null; client_id: string; name: string }[] }),
  ]);
  const who = (name: string) => (staff && clientIds.length > 1 ? ` · ${name}` : '');
  return [
    ...dels.results.map((d) => ({ uid: d.id, title: `Due: ${d.title}${who(d.name)}`, at: d.due_at, allDay: true, url: `${base(d.client_id)}/deliverables/${d.id}` })),
    ...reqs.results.map((r) => ({ uid: r.id, title: `Documents due: ${r.title}${who(r.name)}`, at: r.due_at, allDay: true, url: `${base(r.client_id)}/documents` })),
    ...opps.results.map((o) => ({ uid: o.id, title: `Grant deadline: ${o.title}${who(o.name)}`, at: o.deadline_at, allDay: true, url: base(o.client_id) })),
    ...sched.results.map((s) => {
      const subject = s.config_json ? ((JSON.parse(s.config_json) as { subject?: string }).subject ?? 'Update') : 'Update';
      return { uid: `${s.id}-${s.next_run_at}`, title: `Scheduled send: ${subject}${who(s.name)}`, at: s.next_run_at, allDay: false, url: `${base(s.client_id)}/updates` };
    }),
  ];
}

export function renderIcs(name: string, items: Item[], tz: string, host: string): string {
  const now = stamp(Date.now());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//client-portal//calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(name)}`];
  for (const it of items) {
    lines.push('BEGIN:VEVENT', `UID:${esc(it.uid)}@${host}`, `DTSTAMP:${now}`);
    if (it.allDay) {
      const d = ymd(it.at, tz);
      const next = ymd(it.at + 86_400_000, tz);
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`);
    } else {
      lines.push(`DTSTART:${stamp(it.at)}`, `DTEND:${stamp(it.at + 15 * 60_000)}`);
    }
    lines.push(`SUMMARY:${esc(it.title)}`, `URL:${esc(it.url)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** `GET /ics/:token.ics` — public, authorized by the token alone. */
export const ics = new Hono<AppBindings>().get('/:file', async (c) => {
  const m = /^([A-Za-z0-9_-]{40,64})\.ics$/.exec(c.req.param('file'));
  if (!m?.[1]) return c.json({ error: 'not_found' }, 404);
  const feed = await c.env.DB.prepare(
    `SELECT f.id, f.client_id, f.last_used_at, u.id AS user_id, u.kind, u.role, u.all_clients, u.email, u.name, u.timezone
       FROM calendar_feeds f JOIN users u ON u.id = f.user_id
      WHERE f.token_hash = ? AND f.revoked_at IS NULL AND u.disabled_at IS NULL`,
  )
    .bind(await sha256Hex(m[1]))
    .first<{ id: string; client_id: string | null; last_used_at: number | null; user_id: string; kind: 'staff' | 'client'; role: string; all_clients: number; email: string; name: string | null; timezone: string | null }>();
  if (!feed) return c.json({ error: 'not_found' }, 404);

  // Re-check access now: a removed consultant or client user gets an empty calendar.
  const auth = {
    user: { id: feed.user_id, email: feed.email, name: feed.name, kind: feed.kind, role: feed.role as 'owner', allClients: Boolean(feed.all_clients) },
    session: { idHash: '', publicId: '', createdAt: 0, stepUpAt: null, absExpiresAt: 0 },
    needsPasskey: false,
  };
  let clientIds: string[];
  if (feed.client_id) {
    clientIds = (await clientAccessFor(c.env, auth, feed.client_id)) ? [feed.client_id] : [];
  } else if (feed.kind === 'staff') {
    const all = feed.role === 'owner' || feed.all_clients;
    const rows = await c.env.DB.prepare(
      `SELECT c.id FROM clients c WHERE c.archived_at IS NULL AND (? OR EXISTS (SELECT 1 FROM staff_assignments s WHERE s.client_id = c.id AND s.user_id = ?))`,
    )
      .bind(all ? 1 : 0, feed.user_id)
      .all<{ id: string }>();
    clientIds = rows.results.map((r) => r.id);
  } else {
    clientIds = [];
  }
  const origin = publicOrigin(c.req.raw);
  const tz = feed.timezone ?? (await getSetting(c.env, 'org'))?.timezone ?? 'UTC';
  const firm = (await getSetting(c.env, 'brand'))?.firmName ?? 'Deadlines';
  const body = renderIcs(firm, await feedItems(c.env, clientIds, feed.kind === 'staff', origin), tz, new URL(origin).host);
  if (!feed.last_used_at || Date.now() - feed.last_used_at > 3600_000) {
    c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE calendar_feeds SET last_used_at = ? WHERE id = ?').bind(Date.now(), feed.id).run().then(() => undefined));
  }
  return new Response(body, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline; filename="calendar.ics"' },
  });
});
