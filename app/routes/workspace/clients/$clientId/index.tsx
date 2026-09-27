/** Client overview: what's outstanding, and the profile we match and write from (spec §5.2). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Eye, Lock } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, getJson, patchJson, postJson, putJson } from '@/lib/api';
import { formatDate, STATUS_LABEL, timeAgo } from '@/lib/format';
import type { ClientProfile, Overview } from '@/lib/types';
import { Button, Checkbox, Field, Input, Notice, Select, Textarea } from '@/ui/controls';
import { DeadlineChip, Pill } from '@/ui/display';
import { useStaffClient } from './route';

export const Route = createFileRoute('/workspace/clients/$clientId/')({ component: ClientOverview });

const csv = (xs: string[] | undefined) => (xs ?? []).join(', ');
const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const FUNDING = ['federal', 'state', 'foundation', 'corporate'] as const;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function Ein({ clientId, client }: { clientId: string; client: ClientProfile }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => putJson(`/api/clients/${clientId}/ein`, { ein: value || null }),
    onSuccess: async () => {
      setEditing(false);
      setValue('');
      setRevealed(null);
      await qc.invalidateQueries({ queryKey: ['client', clientId] });
    },
  });
  const reveal = useMutation({
    mutationFn: () => postJson<{ ein: string }>(`/api/clients/${clientId}/ein/reveal`),
    onSuccess: (r) => setRevealed(r.ein),
  });
  return (
    <div className="flex flex-col gap-2">
      <span className="label">EIN</span>
      {editing ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Input aria-label="EIN" placeholder="12-3456789" value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" autoComplete="off" className="max-w-[180px]" />
          <Button type="submit" size="sm" loading={save.isPending}>
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <span className="t-mono tabular-nums">{revealed ?? (client.einLast4 ? `••-•••${client.einLast4}` : 'Not on file')}</span>
          <Lock aria-hidden className="size-3.5 text-text3" />
          {client.hasEin && !revealed ? (
            <Button variant="ghost" size="sm" loading={reveal.isPending} onClick={() => reveal.mutate()}>
              <Eye aria-hidden className="i" /> Reveal
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            {client.hasEin ? 'Change' : 'Add'}
          </Button>
        </div>
      )}
      <span className="t-xs text-text3">Encrypted. Revealing it is recorded in the audit log.</span>
      {save.isError || reveal.isError ? <Notice tone="danger">{errorMessage(save.error ?? reveal.error)}</Notice> : null}
    </div>
  );
}

function Profile({ clientId, client }: { clientId: string; client: ClientProfile }) {
  const qc = useQueryClient();
  const [f, setF] = useState(() => ({
    name: client.name,
    legalName: client.legalName ?? '',
    status: client.status,
    entityType: client.entityType ?? '',
    is501c3: client.is501c3 ?? false,
    ntee: client.ntee ?? '',
    geography: csv(client.geography),
    budgetBand: client.budgetBand ?? '',
    fyeMonth: client.fyeMonth ? String(client.fyeMonth) : '',
    ueiSamStatus: client.ueiSamStatus ?? '',
    mission: client.mission ?? '',
    programs: csv(client.programs),
    populations: csv(client.populations),
    focusTags: csv(client.focusTags),
    target: client.fundingGoals?.targetAmount ? String(client.fundingGoals.targetAmount) : '',
    timeline: client.fundingGoals?.timeline ?? '',
    types: client.fundingGoals?.types ?? [],
    clientCanEdit: client.clientCanEdit,
  }));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () =>
      patchJson(`/api/clients/${clientId}`, {
        name: f.name,
        legalName: f.legalName || null,
        status: f.status,
        entityType: f.entityType || null,
        is501c3: f.is501c3,
        ntee: f.ntee || null,
        geography: list(f.geography),
        budgetBand: f.budgetBand || null,
        fyeMonth: f.fyeMonth ? Number(f.fyeMonth) : null,
        ueiSamStatus: f.ueiSamStatus || null,
        mission: f.mission || null,
        programs: list(f.programs),
        populations: list(f.populations),
        focusTags: list(f.focusTags),
        fundingGoals: { targetAmount: f.target ? Number(f.target.replace(/[^\d]/g, '')) : null, timeline: f.timeline || null, types: f.types },
        clientCanEdit: f.clientCanEdit,
      }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['client', clientId] }), qc.invalidateQueries({ queryKey: ['clients'] })]),
  });
  const text = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      {(p) => <Input {...p} value={String(f[k])} onChange={(e) => set(k, e.target.value as never)} />}
    </Field>
  );
  return (
    <form
      className="card grid gap-4 p-5 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="t-h4 sm:col-span-2">Profile</h2>
      {text('name', 'Display name')}
      {text('legalName', 'Legal name')}
      <Field label="Status">
        {(p) => (
          <Select {...p} value={f.status} onChange={(e) => set('status', e.target.value as ClientProfile['status'])}>
            {(['onboarding', 'active', 'paused', 'archived'] as const).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Ein clientId={clientId} client={client} />
      {text('entityType', 'Entity type', 'e.g. nonprofit, LLC, municipality')}
      <div className="flex items-end pb-2">
        <Checkbox checked={f.is501c3} onChange={(v) => set('is501c3', v)} label="501(c)(3)" />
      </div>
      {text('ntee', 'NTEE code')}
      {text('ueiSamStatus', 'UEI / SAM status')}
      {text('budgetBand', 'Annual budget', 'e.g. $250k–$1M')}
      <Field label="Fiscal year ends">
        {(p) => (
          <Select {...p} value={f.fyeMonth} onChange={(e) => set('fyeMonth', e.target.value)}>
            <option value="">Not set</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="sm:col-span-2">{text('geography', 'Geography served', 'Separate with commas')}</div>
      <div className="sm:col-span-2">
        <Field label="Mission">{(p) => <Textarea {...p} rows={3} value={f.mission} onChange={(e) => set('mission', e.target.value)} />}</Field>
      </div>
      {text('programs', 'Programs', 'Separate with commas')}
      {text('populations', 'Populations served', 'Separate with commas')}
      <div className="sm:col-span-2">{text('focusTags', 'Focus areas', 'Tags used for matching. Separate with commas.')}</div>
      <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
        <legend className="label mb-1">Funding goals</legend>
        {text('target', 'Target amount (USD)')}
        {text('timeline', 'Timeline')}
        <div className="flex flex-wrap gap-4 sm:col-span-2">
          {FUNDING.map((t) => (
            <Checkbox key={t} checked={f.types.includes(t)} onChange={(v) => set('types', v ? [...f.types, t] : f.types.filter((x) => x !== t))} label={t[0]?.toUpperCase() + t.slice(1)} />
          ))}
        </div>
      </fieldset>
      <div className="sm:col-span-2">
        <Checkbox checked={f.clientCanEdit} onChange={(v) => set('clientCanEdit', v)} label="Let the client’s admins update these org details in the portal" />
      </div>
      {save.isError ? (
        <div className="sm:col-span-2">
          <Notice tone="danger">{errorMessage(save.error)}</Notice>
        </div>
      ) : save.isSuccess ? (
        <p role="status" className="t-sm text-ok-text sm:col-span-2">
          Saved.
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" loading={save.isPending}>
          Save profile
        </Button>
      </div>
    </form>
  );
}

function ClientOverview() {
  const { clientId } = Route.useParams();
  const client = useStaffClient(clientId);
  const overview = useQuery({ queryKey: ['overview', clientId], queryFn: () => getJson<Overview>(`/api/clients/${clientId}/overview`) });
  const o = overview.data;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <span className="t-xs text-text2">Documents outstanding</span>
          <p className="t-h2 tabular-nums">{o?.openItems.length ?? '–'}</p>
          <Link to="/workspace/clients/$clientId/documents" params={{ clientId }} className="t-sm text-acc-text hover:underline">
            Open requests
          </Link>
        </div>
        <div className="card p-4">
          <span className="t-xs text-text2">Deliverables we owe</span>
          <p className="t-h2 tabular-nums">{o?.owedByCaller.length ?? '–'}</p>
          <Link to="/workspace/clients/$clientId/deliverables" params={{ clientId }} className="t-sm text-acc-text hover:underline">
            {o?.awaitingDecision.length ? `${o.awaitingDecision.length} from the client to review` : 'Open deliverables'}
          </Link>
        </div>
        <div className="card p-4">
          <span className="t-xs text-text2">Unread messages</span>
          <p className="t-h2 tabular-nums">{o?.unreadMessages ?? '–'}</p>
          <Link to="/workspace/clients/$clientId/messages" params={{ clientId }} className="t-sm text-acc-text hover:underline">
            Open messages
          </Link>
        </div>
      </div>
      {o?.deadlines.length ? (
        <section className="card overflow-hidden" aria-label="Coming up">
          <h2 className="sech">Coming up</h2>
          <ul className="divide-y divide-border">
            {o.deadlines.map((d) => (
              <li key={`${d.kind}-${d.id}`} className="flex items-center gap-3 px-4 py-3">
                <span className="flex-1">{d.title}</span>
                <span className="t-xs text-text2">{formatDate(d.dueAt, { month: 'short', day: 'numeric' })}</span>
                <DeadlineChip dueAt={d.dueAt} windowDays={30} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {client.data?.assignedStaff ? (
        <p className="t-sm text-text2">
          Consultants: {client.data.assignedStaff.length ? client.data.assignedStaff.map((s) => s.name ?? s.email).join(', ') : 'none assigned'}
          {client.data.client.lastActivityAt ? ` · last activity ${timeAgo(client.data.client.lastActivityAt)}` : ''}
          {client.data.client.isDemo ? ' · ' : ''}
          {client.data.client.isDemo ? <Pill tone="info">Demo</Pill> : null}
        </p>
      ) : null}
      {client.data ? <Profile key={client.dataUpdatedAt} clientId={clientId} client={client.data.client} /> : null}
    </>
  );
}
