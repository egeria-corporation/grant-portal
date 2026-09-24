import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../worker/index';
import { describe, expect, it } from 'vitest';

describe('audit_log', () => {
  it('is append-only at the database level', async () => {
    await env.DB.prepare(
      "INSERT INTO audit_log (id, action, created_at) VALUES ('aud_1', 'test.event', 1)",
    ).run();
    await expect(env.DB.prepare("UPDATE audit_log SET action = 'x' WHERE id = 'aud_1'").run()).rejects.toThrow(
      /append-only/,
    );
    await expect(env.DB.prepare("DELETE FROM audit_log WHERE id = 'aud_1'").run()).rejects.toThrow(/append-only/);
  });
});

describe('scheduled + queue handlers', () => {
  it('daily cron purges expired magic links and sessions', async () => {
    const now = Date.now();
    const insertLink = `INSERT INTO magic_links (id, email, token_hash, expires_at, purpose, created_at)
      VALUES (?, 'a@example.org', ?, ?, 'signin', ?)`;
    const insertSession = `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, abs_expires_at)
      VALUES (?, 'usr_1', 0, 0, ?, ?)`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, kind, role, created_at) VALUES ('usr_1', 'a@example.org', 'client', 'client_member', ?)`,
      ).bind(now),
      env.DB.prepare(insertLink).bind('ml_old', 'h1', now - 2 * 86_400_000, now),
      env.DB.prepare(insertLink).bind('ml_new', 'h2', now + 60_000, now),
      env.DB.prepare(insertSession).bind('s_old', now - 1, now + 1000),
      env.DB.prepare(insertSession).bind('s_live', now + 60_000, now + 60_000),
    ]);

    const ctrl = createScheduledController({ cron: '0 13 * * *', scheduledTime: now });
    const ctx = createExecutionContext();
    await worker.scheduled(ctrl, env, ctx);
    await waitOnExecutionContext(ctx);

    const links = await env.DB.prepare('SELECT id FROM magic_links').all<{ id: string }>();
    expect(links.results.map((r) => r.id)).toEqual(['ml_new']);
    const sessions = await env.DB.prepare('SELECT id_hash FROM sessions').all<{ id_hash: string }>();
    expect(sessions.results.map((r) => r.id_hash)).toEqual(['s_live']);
  });

  it('queue consumer acks known and malformed jobs', async () => {
    const batch = createMessageBatch<unknown>('grant-portal-jobs', [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: { kind: 'noop', key: 'k' } },
      { id: 'm2', timestamp: new Date(), attempts: 1, body: 'garbage' },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect([...result.explicitAcks].sort()).toEqual(['m1', 'm2']);
    expect(result.retryMessages).toEqual([]);
  });
});
