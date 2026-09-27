/**
 * Client updates (spec §5.7): compose a branded update with live blocks, send
 * it now, once later, or on a schedule; review drafts that schedules produce.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { deleteJson, errorMessage, getJson, patchJson, postJson } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { BlockList } from '@/client/BlockList';
import type { ClientUpdate, UpdateBlock, UpdateSchedule } from '@/lib/types';
import { Button, Checkbox, Field, Input, Notice, Segmented, Select, Textarea } from '@/ui/controls';
import { EmptyState, Pill } from '@/ui/display';

export const Route = createFileRoute('/workspace/clients/$clientId/updates')({ component: Updates });

const BLOCKS = [
  { kind: 'deadlines', label: 'Deadlines this month' },
  { kind: 'opportunities', label: 'New opportunities' },
  { kind: 'documents', label: 'Documents we still need' },
  { kind: 'wins', label: 'Wins' },
] as const;
const DAYS = [
  ['MO', 'Monday'],
  ['TU', 'Tuesday'],
  ['WE', 'Wednesday'],
  ['TH', 'Thursday'],
  ['FR', 'Friday'],
] as const;

function Composer({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState('Your funding update');
  const [intro, setIntro] = useState('');
  const [blocks, setBlocks] = useState<string[]>(['deadlines', 'documents', 'wins']);
  const [mode, setMode] = useState<'now' | 'later' | 'repeat'>('now');
  const [sendAt, setSendAt] = useState('');
  const [freq, setFreq] = useState<'WEEKLY' | 'MONTHLY'>('WEEKLY');
  const [day, setDay] = useState('MO');
  const [hour, setHour] = useState('9');
  const [review, setReview] = useState(true);
  const preview = useQuery({
    queryKey: ['update-preview', clientId, blocks.join(',')],
    queryFn: () => postJson<{ blocks: UpdateBlock[] }>(`/api/clients/${clientId}/updates/preview`, { blocks }),
  });
  const rrule = freq === 'WEEKLY' ? `FREQ=WEEKLY;BYDAY=${day};BYHOUR=${hour}` : `FREQ=MONTHLY;BYDAY=1${day};BYHOUR=${hour}`;
  const send = useMutation({
    mutationFn: () =>
      postJson(`/api/clients/${clientId}/updates`, {
        subject,
        intro: intro || undefined,
        blocks,
        mode,
        sendAt: mode === 'later' ? new Date(sendAt).getTime() : undefined,
        rrule: mode === 'repeat' ? rrule : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        requiresReview: review,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['updates', clientId] });
      onDone();
    },
  });
  return (
    <form
      className="grid gap-5 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (mode === 'now' && !window.confirm('Send this update to everyone at this client now?')) return;
        send.mutate();
      }}
    >
      <div className="card flex flex-col gap-4 p-5">
        <Field label="Subject">{(p) => <Input {...p} required maxLength={160} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <Field label="Message" hint="Plain text. Appears above the blocks.">
          {(p) => <Textarea {...p} rows={5} maxLength={8000} value={intro} onChange={(e) => setIntro(e.target.value)} />}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="label mb-1">Live blocks (filled in when it’s sent)</legend>
          {BLOCKS.map((b) => (
            <Checkbox key={b.kind} checked={blocks.includes(b.kind)} onChange={(v) => setBlocks((xs) => (v ? [...xs, b.kind] : xs.filter((x) => x !== b.kind)))} label={b.label} />
          ))}
        </fieldset>
        <Segmented
          label="When"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'now', label: 'Send now' },
            { value: 'later', label: 'Later' },
            { value: 'repeat', label: 'Repeat' },
          ]}
        />
        {mode === 'later' ? <Field label="Send at">{(p) => <Input {...p} type="datetime-local" required value={sendAt} onChange={(e) => setSendAt(e.target.value)} />}</Field> : null}
        {mode === 'repeat' ? (
          <div className="grid gap-3 sm:grid-cols-3">
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
            <Field label="At">
              {(p) => (
                <Select {...p} value={hour} onChange={(e) => setHour(e.target.value)}>
                  {Array.from({ length: 16 }, (_, i) => i + 6).map((h) => (
                    <option key={h} value={h}>
                      {h}:00
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ) : null}
        {mode !== 'now' ? <Checkbox checked={review} onChange={setReview} label="Let me review each one before it goes out" /> : null}
        {send.isError ? <Notice tone="danger">{errorMessage(send.error)}</Notice> : null}
        <div className="flex gap-2">
          <Button type="submit" loading={send.isPending} disabled={!subject.trim()}>
            <Send aria-hidden className="i" /> {mode === 'now' ? 'Send update' : 'Schedule'}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
      <div className="card flex flex-col gap-3 p-5" aria-label="Preview">
        <span className="t-xs text-text2">Preview, with today’s data</span>
        <p className="t-h4">{subject}</p>
        {intro ? <p className="whitespace-pre-line">{intro}</p> : null}
        {preview.data ? <BlockList blocks={preview.data.blocks} /> : null}
      </div>
    </form>
  );
}

const STATUS: Record<ClientUpdate['status'], { label: string; tone: 'ok' | 'warn' | 'neutral' | 'info' }> = {
  sent: { label: 'Sent', tone: 'ok' },
  pending_review: { label: 'Waiting for your review', tone: 'warn' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

function Updates() {
  const { clientId } = Route.useParams();
  const qc = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const data = useQuery({ queryKey: ['updates', clientId], queryFn: () => getJson<{ updates: ClientUpdate[]; schedules: UpdateSchedule[] }>(`/api/clients/${clientId}/updates`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['updates', clientId] });
  const act = useMutation({
    mutationFn: (p: { path: string; method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }) =>
      p.method === 'PATCH' ? patchJson(p.path, p.body) : p.method === 'DELETE' ? deleteJson(p.path) : postJson(p.path, p.body),
    onSuccess: refresh,
  });
  const base = `/api/clients/${clientId}/updates`;
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="t-h3 flex-1">Updates</h2>
        {!composing ? (
          <Button size="sm" onClick={() => setComposing(true)}>
            New update
          </Button>
        ) : null}
      </div>
      {composing ? <Composer clientId={clientId} onDone={() => setComposing(false)} /> : null}
      {act.isError ? <Notice tone="danger">{errorMessage(act.error)}</Notice> : null}

      {data.data?.schedules.length ? (
        <section className="card overflow-hidden" aria-label="Schedules">
          <h3 className="sech">Schedules</h3>
          <ul className="divide-y divide-border">
            {data.data.schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{s.config?.subject ?? 'Update'}</span>
                  <span className="t-xs text-text2">
                    {s.description}
                    {s.timezone ? ` (${s.timezone.replace(/_/g, ' ')})` : ''}
                    {s.enabled && s.nextRunAt ? ` · next ${formatDateTime(s.nextRunAt)}` : ''}
                    {s.requiresReview ? ' · reviewed before sending' : ' · sends automatically'}
                  </span>
                </div>
                {!s.enabled ? <Pill>{s.nextRunAt || s.rrule ? 'Paused' : 'Done'}</Pill> : null}
                {s.rrule ? (
                  <Button variant="ghost" size="sm" onClick={() => act.mutate({ path: `${base}/schedules/${s.id}`, method: 'PATCH', body: { enabled: !s.enabled } })}>
                    {s.enabled ? 'Pause' : 'Resume'}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => window.confirm('Delete this schedule? Sent updates stay.') && act.mutate({ path: `${base}/schedules/${s.id}`, method: 'DELETE' })}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.data?.updates.length ? (
        <section className="card overflow-hidden" aria-label="Updates">
          <ul className="divide-y divide-border">
            {data.data.updates.map((u) => (
              <li key={u.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" className="min-w-0 flex-1 text-left font-medium hover:underline" onClick={() => setOpen(open === u.id ? null : u.id)} aria-expanded={open === u.id}>
                    {u.subject}
                  </button>
                  <span className="t-xs text-text2">{formatDateTime(u.sentAt ?? u.sendAt ?? u.createdAt)}</span>
                  <Pill tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Pill>
                  {u.status === 'pending_review' ? (
                    <>
                      <Button size="sm" onClick={() => act.mutate({ path: `${base}/${u.id}/send` })}>
                        Send
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => act.mutate({ path: `${base}/${u.id}/cancel` })}>
                        Skip
                      </Button>
                    </>
                  ) : null}
                </div>
                {open === u.id ? (
                  <div className="rounded-md bg-sunken p-3">
                    {u.intro ? <p className="mb-3 whitespace-pre-line">{u.intro}</p> : null}
                    {u.content ? <BlockList blocks={u.content} /> : <p className="t-sm text-text3">Blocks are filled in when it’s sent.</p>}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : !composing ? (
        <EmptyState icon={Send} title={data.isPending ? 'Loading…' : 'No updates yet'} action={<Button size="sm" onClick={() => setComposing(true)}>Write an update</Button>}>
          Send a branded update now, or schedule one that fills in deadlines, documents and wins automatically.
        </EmptyState>
      ) : null}
    </>
  );
}
