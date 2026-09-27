/** Owner "System" page (spec §12, §13): queue health, dead jobs, email problems, delivery tracking, time zone. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { errorMessage, getJson, postJson, putJson } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useOverview } from '@/setup/steps';
import { Button, Field, Notice, Select } from '@/ui/controls';
import { Pill } from '@/ui/display';

export const Route = createFileRoute('/workspace/system')({ component: System });

interface Health {
  jobs: Record<string, number>;
  problemJobs: { key: string; kind: string; attempts: number; error: string | null; updatedAt: number }[];
  emails: Record<string, number>;
  problemEmails: { id: string; toEmail: string; template: string; status: string; error: string | null; createdAt: number; clientName: string | null }[];
  suppressed: { id: string; email: string; at: number }[];
  deliveryTracking: boolean;
}

const ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

function System() {
  const qc = useQueryClient();
  const overview = useOverview();
  const health = useQuery({ queryKey: ['system', 'health'], queryFn: () => getJson<Health>('/api/system/health'), refetchInterval: 30_000 });
  const [tz, setTz] = useState<string | null>(null);
  const retry = useMutation({ mutationFn: (key: string) => postJson(`/api/system/jobs/${encodeURIComponent(key)}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ['system'] }) });
  const tracking = useMutation({ mutationFn: () => postJson('/api/settings/email/webhook'), onSuccess: () => qc.invalidateQueries({ queryKey: ['system'] }) });
  const saveTz = useMutation({ mutationFn: () => putJson('/api/settings/org', { timezone: tz }), onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'overview'] }) });
  const h = health.data;
  const verified = overview.data?.email.verified;
  return (
    <>
      <h1 className="hd text-[26px] leading-8">System</h1>
      <section className="card flex flex-col gap-3 p-5" aria-labelledby="mail-h">
        <h2 id="mail-h" className="t-h4">
          Email delivery
        </h2>
        <p className="t-sm text-text2">
          Last 7 days:{' '}
          {h
            ? Object.entries(h.emails)
                .map(([k, v]) => `${v} ${k}`)
                .join(' · ') || 'nothing sent'
            : '…'}
        </p>
        {h?.deliveryTracking ? (
          <p className="t-sm text-ok-text">Delivery tracking is on: bounces and complaints stop further email to that address.</p>
        ) : (
          <Notice
            tone="info"
            action={
              <Button size="sm" variant="secondary" loading={tracking.isPending} disabled={!verified} onClick={() => tracking.mutate()}>
                Turn on
              </Button>
            }
          >
            {verified ? 'Turn on delivery tracking so bounces, complaints and deliveries are recorded.' : 'Delivery tracking turns on once your sending domain is verified.'}
          </Notice>
        )}
        {tracking.isError ? <Notice tone="danger">{errorMessage(tracking.error)}</Notice> : null}
        {h?.problemEmails.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {h.problemEmails.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="t-sm min-w-0 flex-1 truncate">
                  {e.toEmail} · {e.template}
                  {e.clientName ? ` · ${e.clientName}` : ''}
                </span>
                <span className="t-xs text-text2">{formatDateTime(e.createdAt)}</span>
                <Pill tone={e.status === 'suppressed' ? 'neutral' : 'danger'}>{e.status}</Pill>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card flex flex-col gap-3 p-5" aria-labelledby="jobs-h">
        <h2 id="jobs-h" className="t-h4">
          Background jobs
        </h2>
        <p className="t-sm text-text2">
          Last 7 days:{' '}
          {h
            ? Object.entries(h.jobs)
                .map(([k, v]) => `${v} ${k}`)
                .join(' · ') || 'none'
            : '…'}
        </p>
        {h?.problemJobs.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {h.problemJobs.map((j) => (
              <li key={j.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="t-sm font-medium">{j.kind}</span>
                  <span className="t-xs block truncate text-text2">
                    {j.error ?? 'Failed'} · {j.attempts} attempt{j.attempts === 1 ? '' : 's'} · {formatDateTime(j.updatedAt)}
                  </span>
                </span>
                <Button size="sm" variant="secondary" loading={retry.isPending && retry.variables === j.key} onClick={() => retry.mutate(j.key)}>
                  Retry
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-sm text-ok-text">No failed jobs.</p>
        )}
      </section>

      <section className="card flex flex-col gap-3 p-5" aria-labelledby="tz-h">
        <h2 id="tz-h" className="t-h4">
          Default time zone
        </h2>
        <p className="t-sm text-text2">Used for schedules, digests and dates in email when someone hasn’t set their own.</p>
        <Field label="Time zone">
          {(p) => (
            <Select {...p} value={tz ?? overview.data?.timezone ?? 'UTC'} onChange={(e) => setTz(e.target.value)}>
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {saveTz.isSuccess ? <p role="status" className="t-sm text-ok-text">Saved.</p> : null}
        <div>
          <Button size="sm" loading={saveTz.isPending} disabled={!tz} onClick={() => saveTz.mutate()}>
            Save
          </Button>
        </div>
      </section>
    </>
  );
}
