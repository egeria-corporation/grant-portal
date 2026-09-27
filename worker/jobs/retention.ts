/**
 * Data retention (spec §5.9 Security "data retention"), run by the daily cron.
 * Windows come from Settings → Security (DECISIONS D-076):
 * - deleted vault files: the stored object is removed; the row stays so
 *   versions and history still say a file existed;
 * - the sent-email log: rows older than the window go.
 * The audit log is append-only (a database trigger refuses deletes) and is
 * never purged; export it before it grows too large for you.
 * Each run that removes something leaves one audit entry.
 */
import type { AppEnv } from '../env';
import { auditStmt } from '../lib/audit';
import { securityPolicy } from '../lib/security';

const DAY = 86_400_000;
/** Deleted files are purged during a week-long window, so a missed day catches up without rescanning history. */
const CATCH_UP = 7 * DAY;

export async function purgeRetention(env: AppEnv, now: number): Promise<{ files: number; emails: number }> {
  const { retention } = await securityPolicy(env);
  const fileCutoff = now - retention.deletedFilesDays * DAY;
  const files = await env.DB.prepare('SELECT r2_key FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ? AND deleted_at >= ? LIMIT 1000')
    .bind(fileCutoff, fileCutoff - CATCH_UP)
    .all<{ r2_key: string }>();
  if (files.results.length) await env.FILES.delete(files.results.map((f) => f.r2_key));

  const emails = await env.DB.prepare('DELETE FROM emails WHERE created_at < ?').bind(now - retention.emailLogDays * DAY).run();
  const out = { files: files.results.length, emails: emails.meta.changes ?? 0 };
  if (out.files || out.emails) await auditStmt(env, { actor: null, action: 'retention.purged', meta: out }).run();
  return out;
}
