/**
 * Funding discovery for one client (spec §5.3, §5.7, §10): OpenGrants search
 * and matching, saved-search alerts on a schedule, and the review queue of
 * their new matches. Without OpenGrants this page says how to add
 * opportunities by hand instead.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { BellRing } from 'lucide-react';
import { useState } from 'react';
import { money } from '@/client/Funding';
import { fundingError, OpenGrantsSearch, useFundingStatus } from '@/client/OpenGrantsSearch';
import { deleteJson, errorMessage, getJson, patchJson, postJson, putJson } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { useMe } from '@/lib/session';
import type { AlertMatch, FundingAlert, FundingUsage, Opportunity } from '@/lib/types';
import { Button, Checkbox, Field, Input, Notice, Segmented, Select } from '@/ui/controls';
import { EmptyState, FitScore, Pill } from '@/ui/display';

export const Route = createFileRoute('/workspace/clients/$clientId/funding')({ component: Funding });

const DAYS = [
  ['MO', 'Monday'],
  ['TU', 'Tuesday'],
  ['WE', 'Wednesday'],
  ['TH', 'Thursday'],
  ['FR', 'Friday'],
] as const;

const LAST_STATUS: Record<string, string> = {
  ok: 'ran',
  skipped_budget: 'paused for the daily request budget',
  not_configured: 'skipped: OpenGrants not connected',
  no_profile: 'skipped: the profile has nothing to match on',
  error: 'failed; it will try again next time',
};

function AlertForm({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('Weekly new matches');
  const [source, setSource] = useState<'match' | 'search'>('match');
  const [search, setSearch] = useState('');
  const [states, setStates] = useState('');
  const [mode, setMode] = useState<'review' | 'report'>('review');
  const [freq, setFreq] = useState<'WEEKLY' | 'MONTHLY'>('WEEKLY');
  const [day, setDay] = useState('MO');
  const [review, setReview] = useState(true);
  const save = useMutation({
    mutationFn: () =>
      postJson(`/api/clients/${clientId}/alerts`, {
        name,
        query: { source, kind: 'grant', ...(source === 'search' ? { search: search || undefined, states: states.replace(/\s+/g, '') || undefined } : {}) },
        mode,
        rrule: freq === 'WEEKLY' ? `FREQ=WEEKLY;BYDAY=${day};BYHOUR=7` : `FREQ=MONTHLY;BYDAY=1${day};BYHOUR=7`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        requiresReview: review,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['alerts', clientId] });
      onDone();
    },
  });
  return (
    <form
      className="card flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name">{(p) => <Input {...p} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Segmented
        label="Find"
        value={source}
        onChange={setSource}
        options={[
          { value: 'match', label: 'Matches for the profile' },
          { value: 'search', label: 'A saved search' },
        ]}
      />
      {source === 'search' ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
          <Field label="Keywords">{(p) => <Input {...p} maxLength={200} value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
          <Field label="States" hint="e.g. CA,NV">
            {(p) => <Input {...p} maxLength={60} value={states} onChange={(e) => setStates(e.target.value.toUpperCase())} />}
          </Field>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Every">
          {(p) => (
            <Select {...p} value={freq} onChange={(e) => setFreq(e.target.value as 'WEEKLY' | 'MONTHLY')}>
              <option value="WEEKLY">Week</option>
              <option value="MONTHLY">Month (first…)</option>
            </Select>
          )}
        </Field>
        <Field label="On">
          {(p) => (
            <Select {...p} value={day} onChange={(e) => setDay(e.target.value)}>
              {DAYS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Segmented
        label="New matches"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'review', label: 'Queue for me to review' },
          { value: 'report', label: 'Draft a report for the client' },
        ]}
      />
      {mode === 'report' ? <Checkbox checked={review} onChange={setReview} label="Let me review each report before it goes out" /> : null}
      <p className="t-xs text-text2">Each run uses one OpenGrants request. Runs pause automatically when today’s budget is low.</p>
      {save.isError ? <Notice tone="warn">{fundingError(save.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={save.isPending} disabled={!name.trim()}>
          Save alert
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Alerts({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const alerts = useQuery({ queryKey: ['alerts', clientId], queryFn: () => getJson<{ alerts: FundingAlert[]; usage: FundingUsage | null }>(`/api/clients/${clientId}/alerts`) });
  const matches = useQuery({ queryKey: ['alert-matches', clientId], queryFn: () => getJson<{ matches: AlertMatch[] }>(`/api/clients/${clientId}/alerts/matches`) });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['alerts', clientId] }),
      qc.invalidateQueries({ queryKey: ['alert-matches', clientId] }),
      qc.invalidateQueries({ queryKey: ['opportunities', clientId] }),
      qc.invalidateQueries({ queryKey: ['funding-status'] }),
    ]);
  const act = useMutation({
    mutationFn: (p: { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown }) =>
      p.method === 'PATCH' ? patchJson(p.path, p.body) : p.method === 'DELETE' ? deleteJson(p.path) : postJson(p.path, p.body),
    onSuccess: refresh,
  });
  const base = `/api/clients/${clientId}/alerts`;
  const list = alerts.data?.alerts ?? [];
  const queue = matches.data?.matches ?? [];
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="t-h3 flex-1">Alerts</h2>
        {!adding ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            New alert
          </Button>
        ) : null}
      </div>
      {adding ? <AlertForm clientId={clientId} onDone={() => setAdding(false)} /> : null}
      {act.isError ? <Notice tone="warn">{fundingError(act.error)}</Notice> : null}
      {list.length ? (
        <section className="card overflow-hidden" aria-label="Alerts">
          <ul className="divide-y divide-border">
            {list.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{a.name}</span>
                  <span className="t-xs text-text2">
                    {a.query?.source === 'match' ? 'Profile matches' : `“${a.query?.search || 'all'}”${a.query?.states ? ` in ${a.query.states}` : ''}`} · {a.schedule?.description ?? 'no schedule'}
                    {a.schedule?.enabled && a.schedule.nextRunAt ? ` · next ${formatDateTime(a.schedule.nextRunAt)}` : ''}
                    {' · '}
                    {a.mode === 'report' ? (a.schedule?.requiresReview ? 'drafts a report for review' : 'sends a report automatically') : 'queues matches for review'}
                  </span>
                  {a.lastRunAt ? (
                    <span className="t-xs text-text2">
                      Last {LAST_STATUS[a.lastStatus ?? 'ok'] ?? a.lastStatus} {formatDateTime(a.lastRunAt)}
                    </span>
                  ) : null}
                </div>
                {a.newMatches ? <Pill tone="acc">{a.newMatches} new</Pill> : null}
                {a.schedule && !a.schedule.enabled ? <Pill>Paused</Pill> : null}
                <Button size="sm" variant="ghost" loading={act.isPending && act.variables?.path === `${base}/${a.id}/run`} onClick={() => act.mutate({ method: 'POST', path: `${base}/${a.id}/run` })}>
                  Run now
                </Button>
                {a.schedule ? (
                  <Button size="sm" variant="ghost" onClick={() => act.mutate({ method: 'PATCH', path: `${base}/${a.id}`, body: { enabled: !a.schedule?.enabled } })}>
                    {a.schedule.enabled ? 'Pause' : 'Resume'}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => window.confirm(`Delete the alert “${a.name}”?`) && act.mutate({ method: 'DELETE', path: `${base}/${a.id}` })}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : !adding ? (
        <EmptyState icon={BellRing} title={alerts.isPending ? 'Loading…' : 'No alerts yet'} action={<Button size="sm" onClick={() => setAdding(true)}>Create an alert</Button>}>
          An alert checks OpenGrants on a schedule and brings you only what’s new since last time.
        </EmptyState>
      ) : null}

      {queue.length ? (
        <section className="card overflow-hidden" aria-labelledby="queue-h">
          <h3 id="queue-h" className="sech">
            New matches to review <span className="ct">{queue.length}</span>
          </h3>
          <ul className="divide-y divide-border">
            {queue.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="t-xs text-text2">{m.listing.funderName ?? 'Funder not listed'}</span>
                  <span className="font-medium">{m.listing.title}</span>
                  <span className="t-xs text-text2">
                    {[money(m.listing.amountMin, m.listing.amountMax), m.listing.deadlineAt ? `due ${formatDate(m.listing.deadlineAt)}` : null, `from ${m.alertName}`].filter(Boolean).join(' · ')}
                  </span>
                  <span className="t-xs text-text3">
                    Source: OpenGrants
                    {m.listing.url ? (
                      <>
                        {' · '}
                        <a href={m.listing.url} target="_blank" rel="noopener noreferrer" className="text-acc-text underline underline-offset-2">
                          Funder listing
                        </a>
                      </>
                    ) : null}
                  </span>
                </div>
                {m.listing.fitScore !== null ? <FitScore score={m.listing.fitScore} label="fit" /> : null}
                <Button size="sm" variant="secondary" onClick={() => act.mutate({ method: 'POST', path: `${base}/matches/${m.id}/add` })}>
                  Save for client
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act.mutate({ method: 'POST', path: `${base}/matches/${m.id}/dismiss` })}>
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
          <p className="t-xs px-4 py-2 text-text2">
            Saved matches appear under Candidates on the <Link to="/workspace/clients/$clientId/pipeline" params={{ clientId }}>Pipeline</Link> tab, ready to add to a report.
          </p>
        </section>
      ) : null}
    </>
  );
}

function ConnectOpenGrants() {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: () => putJson('/api/settings/opengrants', { apiKey: key }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['funding-status'] }),
  });
  return (
    <form
      className="card flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="t-h4">Connect OpenGrants (optional)</h3>
      <p className="t-sm text-text2">
        With an OpenGrants API key you can search grants, contracts and funders, match opportunities to a client’s profile, and run alerts. The key is stored encrypted.
      </p>
      <Field label="API key">{(p) => <Input {...p} type="password" autoComplete="off" required minLength={8} value={key} onChange={(e) => setKey(e.target.value)} />}</Field>
      {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : null}
      <div>
        <Button type="submit" size="sm" loading={save.isPending} disabled={key.length < 8}>
          Save key
        </Button>
      </div>
    </form>
  );
}

function Funding() {
  const { clientId } = Route.useParams();
  const me = useMe();
  const status = useFundingStatus();
  const opps = useQuery({ queryKey: ['opportunities', clientId], queryFn: () => getJson<{ opportunities: Opportunity[] }>(`/api/clients/${clientId}/opportunities`) });
  const saved = new Set((opps.data?.opportunities ?? []).flatMap((o) => (o.ogId ? [o.ogId] : [])));
  const owner = me.data?.user?.role === 'owner';
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="t-h3 flex-1">Find funding</h2>
      </div>
      {status.data && !status.data.configured ? (
        <>
          <Notice tone="info">
            Search, matching and alerts use OpenGrants, which isn’t connected. You can still add opportunities by hand or import a CSV on the{' '}
            <Link to="/workspace/clients/$clientId/pipeline" params={{ clientId }}>
              Pipeline
            </Link>{' '}
            tab, and build reports from them.
          </Notice>
          {owner ? <ConnectOpenGrants /> : null}
        </>
      ) : (
        <>
          <section className="card p-4" aria-label="Search OpenGrants">
            <OpenGrantsSearch clientId={clientId} savedIds={saved} />
          </section>
          <Alerts clientId={clientId} />
        </>
      )}
    </>
  );
}
