/**
 * Owner "System" page (spec §12, §13): generated-secret status, queue health,
 * dead-lettered jobs (with retry), and email failures and bounces.
 */
import { Hono } from 'hono';
import { requireOwner } from '../auth/guards';
import type { AppBindings } from '../env';
import { isJob } from '../jobs/types';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/http';
import { secretsStatus } from '../lib/secrets';

export const system = new Hono<AppBindings>()
  .use('*', requireOwner)
  .get('/secrets', async (c) => c.json({ secrets: await secretsStatus(c.env) }))

  .get('/health', async (c) => {
    const since = Date.now() - 7 * 86_400_000;
    const [jobs, dead, emails, problems, webhook] = await Promise.all([
      c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM job_runs WHERE updated_at > ? GROUP BY status').bind(since).all<{ status: string; n: number }>(),
      c.env.DB.prepare("SELECT key, kind, attempts, error, updated_at AS updatedAt FROM job_runs WHERE status IN ('dead', 'failed') ORDER BY updated_at DESC LIMIT 50").all(),
      c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM emails WHERE created_at > ? GROUP BY status').bind(since).all<{ status: string; n: number }>(),
      c.env.DB.prepare(
        `SELECT e.id, e.to_email AS toEmail, e.template, e.status, e.error, e.created_at AS createdAt, c.name AS clientName
           FROM emails e LEFT JOIN clients c ON c.id = e.client_id
          WHERE e.status IN ('failed', 'bounced', 'complained', 'suppressed') ORDER BY e.created_at DESC LIMIT 50`,
      ).all(),
      c.env.DB.prepare("SELECT 1 AS ok FROM settings WHERE key = 'email_webhook'").first(),
    ]);
    const suppressed = await c.env.DB.prepare('SELECT id, email, email_suppressed_at AS at FROM users WHERE email_suppressed_at IS NOT NULL ORDER BY email_suppressed_at DESC LIMIT 50').all();
    return c.json(
      {
        jobs: Object.fromEntries(jobs.results.map((r) => [r.status, r.n])),
        problemJobs: dead.results,
        emails: Object.fromEntries(emails.results.map((r) => [r.status, r.n])),
        problemEmails: problems.results,
        suppressed: suppressed.results,
        deliveryTracking: Boolean(webhook),
      },
      200,
      { 'Cache-Control': 'no-store' },
    );
  })

  /** Re-queue a dead or failed job. Jobs are idempotent, so a retry can't double-send. */
  .post('/jobs/:key/retry', async (c) => {
    const key = c.req.param('key');
    const row = await c.env.DB.prepare("SELECT payload_json FROM job_runs WHERE key = ? AND status IN ('dead', 'failed')").bind(key).first<{ payload_json: string | null }>();
    const job = row?.payload_json ? (JSON.parse(row.payload_json) as unknown) : null;
    if (!isJob(job)) throw new HttpError(404, 'not_found');
    await c.env.DB.prepare("UPDATE job_runs SET status = 'running', updated_at = ? WHERE key = ?").bind(Date.now(), key).run();
    await c.env.JOBS.send(job);
    await audit(c, { action: 'settings.updated', target: `job.retry:${key.slice(0, 80)}` });
    return c.json({ ok: true });
  });
