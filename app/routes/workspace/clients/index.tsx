/** Client list (spec §5.2): status, consultants, next deadline, last activity. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { deleteJson, errorMessage, getJson, postJson } from '@/lib/api';
import { formatDate, STATUS_LABEL, timeAgo } from '@/lib/format';
import { useMe } from '@/lib/session';
import { Button, Checkbox, CopyField, Field, Input, Notice, Select } from '@/ui/controls';
import { EmptyState, OrgMark, Pill, type PillTone } from '@/ui/display';

export const Route = createFileRoute('/workspace/clients/')({
  component: Clients,
  validateSearch: (s: Record<string, unknown>): { new?: boolean } => (s.new === true || s.new === 'true' ? { new: true } : {}),
});

interface ClientRow {
  id: string;
  name: string;
  status: 'onboarding' | 'active' | 'paused' | 'archived';
  isDemo: number;
  lastActivityAt: number | null;
  consultants: string | null;
  nextDeadline: number | null;
  overdueRequests: number;
  awaitingClient: number;
  unread: number;
}

const TONE: Record<ClientRow['status'], PillTone> = { onboarding: 'info', active: 'ok', paused: 'warn', archived: 'neutral' };

function NewClient({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [delivery, setDelivery] = useState<'email' | 'link'>('email');
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      postJson<{ id: string; invite: { link?: string } | null }>('/api/clients', { name, contact: email ? { email, delivery } : undefined }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['clients'] });
      if (res.invite?.link) setLink({ id: res.id, url: res.invite.link });
      else await navigate({ to: '/workspace/clients/$clientId', params: { clientId: res.id } });
    },
  });
  if (link) {
    return (
      <div className="card flex flex-col gap-3 p-5">
        <h2 className="t-h4">Client created</h2>
        <p className="t-sm text-text2">Send this single-use invite link to your contact over a channel you trust. It works once, for 72 hours.</p>
        <CopyField value={link.url} label="Invite link" />
        <div>
          <Link to="/workspace/clients/$clientId" params={{ clientId: link.id }} className="btn btn-primary btn-sm">
            Open client
          </Link>
        </div>
      </div>
    );
  }
  return (
    <form
      className="card flex flex-col gap-3 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="t-h4">New client</h2>
      <Field label="Organization name">{(p) => <Input {...p} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
      <Field label="Main contact’s email (optional)" hint="They’ll be the client admin and can invite colleagues.">
        {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      {email ? <Checkbox checked={delivery === 'link'} onChange={(v) => setDelivery(v ? 'link' : 'email')} label="Give me a link to send myself instead of emailing" /> : null}
      {create.isError ? <Notice tone="danger">{errorMessage(create.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" loading={create.isPending}>
          Create client
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Clients() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const me = useMe();
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const clients = useQuery({
    queryKey: ['clients', showArchived],
    queryFn: () => getJson<{ clients: ClientRow[] }>(`/api/clients${showArchived ? '?archived=1' : ''}`),
  });
  const removeDemo = useMutation({ mutationFn: () => deleteJson('/api/demo'), onSuccess: () => qc.invalidateQueries({ queryKey: ['clients'] }) });
  const rows = useMemo(
    () => (clients.data?.clients ?? []).filter((c) => (!status || c.status === status) && (!q || c.name.toLowerCase().includes(q.toLowerCase()))),
    [clients.data, q, status],
  );
  const closeNew = () => void navigate({ to: '/workspace/clients', search: {} });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="hd flex-1 text-[26px] leading-8">Clients</h1>
        {!search.new ? (
          <Link to="/workspace/clients" search={{ new: true }} className="btn btn-primary btn-sm">
            <Plus aria-hidden className="i" /> New client
          </Link>
        ) : null}
      </div>
      {search.new ? <NewClient onClose={closeNew} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Search clients" placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">All statuses</option>
          {(['onboarding', 'active', 'paused', 'archived'] as const).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Checkbox checked={showArchived} onChange={setShowArchived} label="Include archived" />
        {me.data?.user.role === 'owner' && clients.data?.clients.some((c) => c.isDemo) ? (
          <Button variant="ghost" size="sm" className="ml-auto" loading={removeDemo.isPending} onClick={() => removeDemo.mutate()}>
            Delete demo client
          </Button>
        ) : null}
      </div>
      {rows.length ? (
        <ul className="card divide-y divide-border overflow-hidden">
          {rows.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <OrgMark name={c.name} />
              <div className="flex min-w-0 flex-1 flex-col">
                <Link to="/workspace/clients/$clientId" params={{ clientId: c.id }} className="truncate font-medium text-text hover:text-acc-text hover:underline">
                  {c.name}
                </Link>
                <span className="t-xs text-text2">
                  {c.consultants ?? 'Unassigned'}
                  {c.lastActivityAt ? ` · active ${timeAgo(c.lastActivityAt)}` : ''}
                </span>
              </div>
              {c.isDemo ? <Pill tone="info">Demo</Pill> : null}
              {c.overdueRequests ? <Pill tone="danger">{c.overdueRequests} overdue</Pill> : null}
              {c.unread ? <Pill tone="info">{c.unread} unread</Pill> : null}
              {c.nextDeadline ? <span className="t-xs tabular-nums text-text2">Next: {formatDate(c.nextDeadline, { month: 'short', day: 'numeric' })}</span> : null}
              <Pill tone={TONE[c.status]}>{STATUS_LABEL[c.status]}</Pill>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={Building2} title={clients.isPending ? 'Loading…' : q || status ? 'No clients match' : 'No clients yet'}>
          {q || status ? 'Try a different search.' : 'Add your first client to start requesting documents and sharing work.'}
        </EmptyState>
      )}
    </>
  );
}
