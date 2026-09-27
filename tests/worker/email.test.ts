/**
 * M4: notifications and preferences, digests, the dispatcher's idempotency,
 * the review gate for scheduled updates, signed delivery webhooks with bounce
 * suppression, one-click unsubscribe, and calendar feeds.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../worker/email/outbox';
import { DEV_WEBHOOK_SECRET } from '../../worker/email/outbox';
import { ensureWebhook } from '../../worker/email/delivery';
import { signSvix } from '../../worker/email/webhook';
import { dispatch } from '../../worker/jobs/dispatch';
import { runJob } from '../../worker/jobs';
import { sendDigest, sendNotification } from '../../worker/notify';
import { addMember, Agent, agentFor, assign, call, claimAsOwner, createClient, createUser, resetDb, testEnv, type Agent as AgentT } from './helpers';

const DAY = 86_400_000;

let clientId: string;
let owner: AgentT;
let cons: AgentT;
let admin: AgentT;
let ids: { owner: string; cons: string; admin: string; member: string; memberEmail: string; adminEmail: string; consEmail: string };

async function drain(): Promise<void> {
  const rows = await testEnv.DB.prepare("SELECT id FROM notifications WHERE delivery = 'instant' AND emailed_at IS NULL").all<{ id: string }>();
  for (const r of rows.results) await sendNotification(testEnv, r.id);
}

const mailsTo = (to: string) => memoryOutbox.filter((m) => m.to === to);

beforeEach(async () => {
  await resetDb();
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM notifications'),
    testEnv.DB.prepare('DELETE FROM updates'),
    testEnv.DB.prepare('DELETE FROM schedules'),
    testEnv.DB.prepare('DELETE FROM job_runs'),
    testEnv.DB.prepare('DELETE FROM calendar_feeds'),
    testEnv.DB.prepare("DELETE FROM settings WHERE key IN ('email_webhook', 'origin', 'org')"),
  ]);
  await testEnv.DB.prepare("INSERT INTO settings (org_id, key, value_json, updated_at) VALUES ('org_default', 'origin', ?, ?)")
    .bind(JSON.stringify({ url: 'https://portal.test', seenAt: Date.now() }), Date.now())
    .run();
  const o = await claimAsOwner();
  clientId = await createClient('Acme');
  const c = await createUser('consultant');
  await assign(clientId, c.id);
  const a = await createUser('client_admin');
  const m = await createUser('client_member');
  await addMember(clientId, a.id, 'admin');
  await addMember(clientId, m.id, 'member');
  ids = { owner: o.id, cons: c.id, admin: a.id, member: m.id, memberEmail: m.email, adminEmail: a.email, consEmail: c.email };
  owner = await agentFor(o.id);
  cons = await agentFor(c.id);
  admin = await agentFor(a.id);
});

describe('notifications', () => {
  it('document requests email every client user, always, with the items and a portal link', async () => {
    await testEnv.DB.prepare('UPDATE users SET notif_prefs_json = ? WHERE id = ?').bind(JSON.stringify({ activity: 'off', reminders: false, updates: false }), ids.member).run();
    await cons.post(`/api/clients/${clientId}/requests`, { title: 'Grant docs', items: [{ label: 'Form 990' }, { label: 'W-9' }] });
    await drain();
    for (const to of [ids.adminEmail, ids.memberEmail]) {
      const mail = mailsTo(to).at(-1);
      expect(mail?.subject).toBe('Your consultant needs 2 documents');
      expect(mail?.text).toContain('- Form 990\n- W-9');
      expect(mail?.text).toContain('https://portal.test/portal/documents');
      // Transactional: no unsubscribe.
      expect(mail?.headers?.['List-Unsubscribe']).toBeUndefined();
      expect(mail?.html).toContain('Upload documents');
    }
    expect(mailsTo(ids.consEmail)).toHaveLength(0);
  });

  it('a new version emails the reviewing side, with one-click unsubscribe', async () => {
    const { id } = (await (await cons.post(`/api/clients/${clientId}/deliverables`, { title: 'Narrative', side: 'consultant' })).json()) as { id: string };
    await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { url: 'https://docs.example.org/1', note: 'First draft' });
    await drain();
    const mail = mailsTo(ids.adminEmail).at(-1);
    expect(mail?.subject).toBe('Ready for your review: Narrative (v1)');
    expect(mail?.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/portal\.test\/u\/usr_[^>]+\.activity\.[0-9a-f]+>$/);
    expect(mail?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail?.text).toContain(`https://portal.test/portal/deliverables/${id}`);
    // The author isn't notified about their own action.
    expect(mailsTo(ids.consEmail)).toHaveLength(0);
  });

  it('client messages go to the assigned consultant, not the Owner', async () => {
    await admin.post(`/api/clients/${clientId}/messages`, { body: 'Quick question about the budget' });
    await drain();
    expect(mailsTo(ids.consEmail).at(-1)?.text).toContain('Quick question about the budget');
    expect(memoryOutbox.some((m) => m.to === 'owner@example.org')).toBe(false);
  });

  it('daily digests collect activity and go out once, at 8:00 local', async () => {
    await testEnv.DB.prepare('UPDATE users SET notif_prefs_json = ?, timezone = ? WHERE id = ?')
      .bind(JSON.stringify({ activity: 'daily', reminders: true, updates: true }), 'America/New_York', ids.cons)
      .run();
    await admin.post(`/api/clients/${clientId}/messages`, { body: 'First' });
    await admin.post(`/api/clients/${clientId}/messages`, { body: 'Second' });
    await drain();
    expect(mailsTo(ids.consEmail)).toHaveLength(0);

    const day = new Date();
    const at = (hourUtc: number) => Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc, 5);
    await dispatch(testEnv, at(11)); // 7:05 in New York (EDT/EST either way before 8)
    let jobs = await testEnv.DB.prepare("SELECT key FROM job_runs WHERE kind = 'digest.send'").all<{ key: string }>();
    expect(jobs.results).toHaveLength(0);
    await dispatch(testEnv, at(14)); // 9:05 or 10:05 in New York
    await dispatch(testEnv, at(14) + 60_000);
    jobs = await testEnv.DB.prepare("SELECT key FROM job_runs WHERE kind = 'digest.send'").all<{ key: string }>();
    expect(jobs.results).toHaveLength(1);

    await sendDigest(testEnv, ids.cons, 'daily');
    await sendDigest(testEnv, ids.cons, 'daily');
    const digests = mailsTo(ids.consEmail);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.subject).toMatch(/daily summary .*: 2 updates$/);
    expect(digests[0]?.text).toContain('First');
    expect(digests[0]?.text).toContain('Second');
  });
});

describe('dispatcher and scheduled updates', () => {
  async function schedule(requiresReview: boolean) {
    const res = await cons.post(`/api/clients/${clientId}/updates`, {
      subject: 'Weekly update',
      intro: 'Here is where things stand.',
      blocks: ['documents', 'deadlines'],
      mode: 'repeat',
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9',
      timezone: 'UTC',
      requiresReview,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { scheduleId: string; nextRunAt: number };
  }

  async function runDue(now: number) {
    await dispatch(testEnv, now);
    const jobs = await testEnv.DB.prepare("SELECT payload_json FROM job_runs WHERE kind = 'schedule.run'").all<{ payload_json: string }>();
    for (const j of jobs.results) await runJob(JSON.parse(j.payload_json), testEnv);
  }

  it('runs each occurrence once and advances to the next Monday', async () => {
    await cons.post(`/api/clients/${clientId}/requests`, { title: 'Docs', items: [{ label: 'Audit' }] });
    const { scheduleId, nextRunAt } = await schedule(false);
    expect(new Date(nextRunAt).getUTCDay()).toBe(1);
    expect(new Date(nextRunAt).getUTCHours()).toBe(9);

    await runDue(nextRunAt + 60_000);
    await runDue(nextRunAt + 120_000); // a second cron tick in the same window
    const next = await testEnv.DB.prepare('SELECT next_run_at FROM schedules WHERE id = ?').bind(scheduleId).first<{ next_run_at: number }>();
    expect(next?.next_run_at).toBe(nextRunAt + 7 * DAY);
    const updates = await testEnv.DB.prepare("SELECT status, content_json FROM updates WHERE schedule_id = ?").bind(scheduleId).all<{ status: string; content_json: string }>();
    expect(updates.results).toHaveLength(1);
    expect(updates.results[0]?.status).toBe('sent');
    expect(updates.results[0]?.content_json).toContain('Audit');

    await drain();
    const mail = mailsTo(ids.memberEmail).find((m) => m.subject === 'Weekly update');
    expect(mail?.text).toContain('Documents we still need\n- Audit');
    expect(mail?.headers?.['List-Unsubscribe']).toContain('.updates.');
    expect(memoryOutbox.filter((m) => m.subject === 'Weekly update')).toHaveLength(2);
  });

  it('with review on, a run makes a draft and asks the consultant; the client hears nothing until it is sent', async () => {
    const { nextRunAt } = await schedule(true);
    await runDue(nextRunAt + 60_000);
    await drain();
    expect(memoryOutbox.some((m) => m.subject === 'Weekly update')).toBe(false);
    expect(mailsTo(ids.consEmail).at(-1)?.subject).toBe('Waiting for your review: Scheduled update for Acme');

    const list = (await (await cons.fetch(`/api/clients/${clientId}/updates`)).json()) as { updates: { id: string; status: string }[] };
    const draft = list.updates.find((u) => u.status === 'pending_review');
    expect(draft).toBeTruthy();
    // Clients don't see drafts.
    const forClient = (await (await admin.fetch(`/api/clients/${clientId}/updates`)).json()) as { updates: unknown[] };
    expect(forClient.updates).toHaveLength(0);

    expect((await cons.post(`/api/clients/${clientId}/updates/${draft?.id}/send`)).status).toBe(200);
    expect((await cons.post(`/api/clients/${clientId}/updates/${draft?.id}/send`)).status).toBe(409);
    await drain();
    expect(memoryOutbox.filter((m) => m.subject === 'Weekly update')).toHaveLength(2);
  });

  it('rejects rules outside the supported subset', async () => {
    const r = await cons.post(`/api/clients/${clientId}/updates`, { subject: 'x', blocks: [], mode: 'repeat', rrule: 'FREQ=YEARLY' });
    expect(r.status).toBe(422);
  });

  it('sends document reminders on the request’s cadence, once each', async () => {
    const due = Date.now() + 3 * DAY;
    await cons.post(`/api/clients/${clientId}/requests`, { title: 'Docs', dueAt: due, items: [{ label: 'Audit' }] });
    await drain();
    const before = memoryOutbox.length;
    await dispatch(testEnv, due - 3 * DAY + 60_000);
    await dispatch(testEnv, due - 3 * DAY + 120_000);
    await drain();
    const reminders = memoryOutbox.slice(before).filter((m) => m.subject.startsWith('Reminder: Docs'));
    expect(reminders.map((m) => m.to).sort()).toEqual([ids.adminEmail, ids.memberEmail].sort());
    // Turning reminders off for the client stops them.
    await cons.fetch(`/api/clients/${clientId}`, { method: 'PATCH', json: { reminders: { documents: false, approvals: true, deadlines: true } } });
    await dispatch(testEnv, due + 60_000);
    await drain();
    expect(memoryOutbox.slice(before).filter((m) => m.subject.includes('Docs'))).toHaveLength(2);
  });
});

describe('delivery webhook', () => {
  async function post(body: unknown, opts: { secret?: string; ts?: number; id?: string } = {}) {
    const raw = JSON.stringify(body);
    const id = opts.id ?? `msg_${crypto.randomUUID()}`;
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    return call('/webhooks/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': await signSvix(opts.secret ?? DEV_WEBHOOK_SECRET, id, ts, raw) },
      body: raw,
    });
  }

  it('verifies signatures, rejects replays, and suppresses hard-bounced addresses', async () => {
    expect((await post({ type: 'email.delivered', data: { email_id: 'x' } })).status).toBe(404); // not set up yet
    await ensureWebhook(testEnv, 'https://portal.test');

    await admin.post(`/api/clients/${clientId}/messages`, { body: 'hello' });
    await drain();
    const email = await testEnv.DB.prepare("SELECT id, resend_id FROM emails WHERE to_email = ? ORDER BY created_at DESC").bind(ids.consEmail).first<{ id: string; resend_id: string }>();
    expect(email?.resend_id).toBeTruthy();

    expect((await post({ type: 'email.delivered', data: { email_id: email?.resend_id } }, { secret: 'whsec_d3Jvbmctc2VjcmV0' })).status).toBe(401);
    expect((await post({ type: 'email.delivered', data: { email_id: email?.resend_id } }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await post({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: email?.resend_id, to: [ids.consEmail] } })).status).toBe(200);
    const delivered = await testEnv.DB.prepare('SELECT status, delivered_at FROM emails WHERE id = ?').bind(email?.id).first<{ status: string; delivered_at: number }>();
    expect(delivered?.status).toBe('delivered');

    const bounce = { type: 'email.bounced', data: { email_id: email?.resend_id, to: [ids.consEmail], bounce: { type: 'Permanent' } } };
    expect((await post(bounce, { id: 'msg_same' })).status).toBe(200);
    expect(((await (await post(bounce, { id: 'msg_same' })).json()) as { duplicate?: boolean }).duplicate).toBe(true);
    const user = await testEnv.DB.prepare('SELECT email_suppressed_at FROM users WHERE id = ?').bind(ids.cons).first<{ email_suppressed_at: number | null }>();
    expect(user?.email_suppressed_at).toBeTruthy();

    // Further activity mail to that address is recorded but not sent.
    const before = mailsTo(ids.consEmail).length;
    await admin.post(`/api/clients/${clientId}/messages`, { body: 'again' });
    await drain();
    expect(mailsTo(ids.consEmail)).toHaveLength(before);
    const last = await testEnv.DB.prepare('SELECT status FROM emails WHERE to_email = ? ORDER BY created_at DESC').bind(ids.consEmail).first<{ status: string }>();
    expect(last?.status).toBe('suppressed');

    // Delivery shows on the client's timeline.
    const events = await testEnv.DB.prepare("SELECT type FROM events WHERE client_id = ? AND type LIKE 'email.%'").bind(clientId).all<{ type: string }>();
    expect(events.results.map((e) => e.type)).toEqual(expect.arrayContaining(['email.delivered']));
  });
});

describe('unsubscribe', () => {
  it('one-click POST turns off that category, without cookies or CSRF', async () => {
    const { id } = (await (await cons.post(`/api/clients/${clientId}/deliverables`, { title: 'D', side: 'consultant' })).json()) as { id: string };
    await cons.post(`/api/clients/${clientId}/deliverables/${id}/versions`, { url: 'https://docs.example.org/1' });
    await drain();
    const header = mailsTo(ids.adminEmail).at(-1)?.headers?.['List-Unsubscribe'] ?? '';
    const path = new URL(header.slice(1, -1)).pathname;
    const res = await call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(res.status).toBe(200);
    const prefs = await testEnv.DB.prepare('SELECT notif_prefs_json FROM users WHERE id = ?').bind(ids.admin).first<{ notif_prefs_json: string }>();
    expect(JSON.parse(prefs?.notif_prefs_json ?? '{}')).toMatchObject({ activity: 'off' });
    // A tampered token does nothing.
    expect((await call(path.replace(/.$/, (c) => (c === '0' ? '1' : '0')), { method: 'POST' })).status).toBe(404);
    expect((await call(path.replace('.activity.', '.updates.'), { method: 'POST' })).status).toBe(404);
  });

  it('preferences can be read and changed', async () => {
    const r = await admin.fetch('/api/me/preferences', { method: 'PUT', json: { timezone: 'Europe/Berlin', preferences: { activity: 'weekly' } } });
    expect(r.status).toBe(200);
    const me = (await (await admin.fetch('/api/me')).json()) as { timezone: string; preferences: { activity: string; reminders: boolean } };
    expect(me).toMatchObject({ timezone: 'Europe/Berlin', preferences: { activity: 'weekly', reminders: true } });
    expect((await admin.fetch('/api/me/preferences', { method: 'PUT', json: { timezone: 'Mars/Olympus' } })).status).toBe(422);
  });
});

describe('calendar feeds', () => {
  it('serves due dates by token, re-checks access, and stops when revoked', async () => {
    await cons.post(`/api/clients/${clientId}/deliverables`, { title: 'Budget, narrative; v2', side: 'consultant', dueAt: Date.now() + 5 * DAY });
    const created = (await (await admin.post('/api/calendar-feeds', { clientId })).json()) as { id: string; url: string };
    const path = new URL(created.url).pathname;
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('SUMMARY:Due: Budget\\, narrative\\; v2');
    expect(body).toMatch(/DTSTART;VALUE=DATE:\d{8}/);

    // A client user can't make a feed for another client, or an all-clients feed.
    const other = await createClient('Other');
    expect((await admin.post('/api/calendar-feeds', { clientId: other })).status).toBe(404);
    expect((await admin.post('/api/calendar-feeds', {})).status).toBe(422);

    // Removed from the client: the feed empties.
    await testEnv.DB.prepare('DELETE FROM client_members WHERE user_id = ?').bind(ids.admin).run();
    expect(await (await call(path)).text()).not.toContain('VEVENT');

    expect((await admin.fetch(`/api/calendar-feeds/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(path)).status).toBe(404);
    expect((await new Agent().fetch('/ics/nope.ics')).status).toBe(404);
    void owner;
  });
});
