/** Document request composer (spec §5.6): items, due date, reminder cadence. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { requestsKey } from '@/client/Requests';
import { errorMessage, postJson } from '@/lib/api';
import { fromDateInput } from '@/lib/format';
import { Button, Checkbox, Field, Input, Notice, Textarea } from '@/ui/controls';

export const Route = createFileRoute('/workspace/clients/$clientId/requests/new')({ component: NewRequest });

/** Common asks, one click to add. Consultants edit freely. */
const SUGGESTIONS = ['Latest Form 990', 'Audited financial statements', 'Board of directors list', 'W-9', 'IRS determination letter', 'Current operating budget', 'Organizational chart'];

const days = (s: string) =>
  s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 60)
    .slice(0, 5);

function NewRequest() {
  const { clientId } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('Documents we need');
  const [message, setMessage] = useState('');
  const [due, setDue] = useState('');
  const [items, setItems] = useState<{ label: string; required: boolean; hint: string }[]>([{ label: '', required: true, hint: '' }]);
  const [before, setBefore] = useState('3');
  const [onDue, setOnDue] = useState(true);
  const [after, setAfter] = useState('2');

  const create = useMutation({
    mutationFn: () =>
      postJson(`/api/clients/${clientId}/requests`, {
        title,
        message: message || undefined,
        dueAt: fromDateInput(due),
        items: items.filter((i) => i.label.trim()).map((i) => ({ label: i.label.trim(), required: i.required, hint: i.hint.trim() || undefined })),
        reminders: { beforeDays: days(before), onDue, afterDays: days(after) },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: requestsKey(clientId) });
      await navigate({ to: '/workspace/clients/$clientId/documents', params: { clientId } });
    },
  });

  const set = (i: number, patch: Partial<(typeof items)[number]>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  /** Fills the empty row if there is one, otherwise adds a row. */
  const add = (label: string) =>
    setItems((xs) => {
      const empty = xs.findIndex((x) => !x.label.trim());
      return empty >= 0 ? xs.map((x, j) => (j === empty ? { ...x, label } : x)) : [...xs, { label, required: true, hint: '' }];
    });

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="t-h3">Request documents</h2>
      <div className="card flex flex-col gap-4 p-5">
        <Field label="Title">{(p) => <Input {...p} required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Message to the client (optional)">{(p) => <Textarea {...p} rows={3} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
        <Field label="Due date (optional)">{(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} className="max-w-[200px]" />}</Field>
      </div>

      <fieldset className="card flex flex-col gap-3 p-5">
        <legend className="t-h4 px-1">Items</legend>
        {items.map((item, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label={`Item ${i + 1}`} placeholder="e.g. Latest Form 990" value={item.label} maxLength={160} onChange={(e) => set(i, { label: e.target.value })} className="min-w-[200px] flex-1" />
            <Input aria-label={`Hint for item ${i + 1}`} placeholder="Hint (optional)" value={item.hint} maxLength={400} onChange={(e) => set(i, { hint: e.target.value })} className="min-w-[160px] flex-1" />
            <Checkbox checked={item.required} onChange={(v) => set(i, { required: v })} label="Required" />
            <Button variant="ghost" size="sm" icon aria-label={`Remove item ${i + 1}`} disabled={items.length === 1} onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}>
              <X aria-hidden className="i" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setItems((xs) => [...xs, { label: '', required: true, hint: '' }])}>
            <Plus aria-hidden className="i" /> Add item
          </Button>
          {SUGGESTIONS.filter((s) => !items.some((i) => i.label === s)).map((s) => (
            <button key={s} type="button" className="tag hover:bg-hover" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="card flex flex-col gap-3 p-5">
        <legend className="t-h4 px-1">Reminders</legend>
        <p className="t-sm text-text2">Sent to the client while items are outstanding. Separate several with commas.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Days before due">{(p) => <Input {...p} inputMode="numeric" value={before} onChange={(e) => setBefore(e.target.value)} />}</Field>
          <div className="flex items-end pb-2">
            <Checkbox checked={onDue} onChange={setOnDue} label="On the due date" />
          </div>
          <Field label="Days after due">{(p) => <Input {...p} inputMode="numeric" value={after} onChange={(e) => setAfter(e.target.value)} />}</Field>
        </div>
      </fieldset>

      {create.isError ? <Notice tone="danger">{errorMessage(create.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" loading={create.isPending} disabled={!items.some((i) => i.label.trim())}>
          Send request
        </Button>
        <Link to="/workspace/clients/$clientId/documents" params={{ clientId }} className="btn btn-ghost">
          Cancel
        </Link>
      </div>
    </form>
  );
}
