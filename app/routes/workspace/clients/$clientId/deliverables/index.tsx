/** A client's deliverables, with quick create and create-from-template (spec §5.5). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { DeliverableList, deliverablesKey } from '@/client/Deliverables';
import { errorMessage, getJson, postJson } from '@/lib/api';
import { fromDateInput } from '@/lib/format';
import type { Member } from '@/lib/types';
import { Button, Field, Input, Notice, Select, Textarea } from '@/ui/controls';
import { useStaffClient } from '../route';

export const Route = createFileRoute('/workspace/clients/$clientId/deliverables/')({ component: Deliverables });

interface Template {
  id: string;
  name: string;
  items: { title: string; side: string; offsetDays: number }[];
}

function NewDeliverable({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const client = useStaffClient(clientId);
  const members = useQuery({ queryKey: ['members', clientId], queryFn: () => getJson<{ members: Member[] }>(`/api/clients/${clientId}/members`) });
  const [title, setTitle] = useState('');
  const [side, setSide] = useState<'consultant' | 'client'>('consultant');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () =>
      postJson(`/api/clients/${clientId}/deliverables`, { title, side, dueAt: fromDateInput(due), assigneeUserId: assignee || null, description: description || undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: deliverablesKey(clientId) });
      onDone();
    },
  });
  const people = side === 'consultant' ? (client.data?.assignedStaff ?? []).map((s) => ({ id: s.id, label: s.name ?? s.email })) : (members.data?.members ?? []).map((m) => ({ id: m.id, label: m.name ?? m.email }));
  return (
    <form
      className="card grid gap-3 p-5 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h3 className="t-h4 sm:col-span-2">New deliverable</h3>
      <div className="sm:col-span-2">
        <Field label="Title">{(p) => <Input {...p} required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
      </div>
      <Field label="Who delivers it">
        {(p) => (
          <Select {...p} value={side} onChange={(e) => setSide(e.target.value as 'consultant' | 'client')}>
            <option value="consultant">We deliver to the client</option>
            <option value="client">The client delivers to us</option>
          </Select>
        )}
      </Field>
      <Field label="Due date">{(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
      <Field label="Assignee (optional)">
        {(p) => (
          <Select {...p} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Nobody</option>
            {people.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="sm:col-span-2">
        <Field label="Details (optional)">{(p) => <Textarea {...p} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
      {create.isError ? (
        <div className="sm:col-span-2">
          <Notice tone="danger">{errorMessage(create.error)}</Notice>
        </div>
      ) : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" loading={create.isPending}>
          Create
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FromTemplate({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => getJson<{ templates: Template[] }>('/api/templates') });
  const [templateId, setTemplateId] = useState('');
  const [anchor, setAnchor] = useState('');
  const apply = useMutation({
    mutationFn: () => postJson(`/api/clients/${clientId}/deliverables/from-template`, { templateId, anchorAt: fromDateInput(anchor) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: deliverablesKey(clientId) });
      onDone();
    },
  });
  const tpl = templates.data?.templates.find((t) => t.id === templateId);
  return (
    <form
      className="card flex flex-col gap-3 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        apply.mutate();
      }}
    >
      <h3 className="t-h4">Add from a template</h3>
      {templates.data && !templates.data.templates.length ? <Notice>No templates yet. Create one under Templates.</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Template">
          {(p) => (
            <Select {...p} required value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Choose…</option>
              {templates.data?.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.items.length})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Anchor date" hint="Usually the grant deadline. Due dates count from here.">
          {(p) => <Input {...p} type="date" required value={anchor} onChange={(e) => setAnchor(e.target.value)} />}
        </Field>
      </div>
      {tpl ? (
        <ul className="t-sm list-disc pl-5 text-text2">
          {tpl.items.map((i, n) => (
            <li key={n}>
              {i.title} — {i.offsetDays === 0 ? 'on the anchor date' : `${Math.abs(i.offsetDays)} days ${i.offsetDays < 0 ? 'before' : 'after'}`}
            </li>
          ))}
        </ul>
      ) : null}
      {apply.isError ? <Notice tone="danger">{errorMessage(apply.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" loading={apply.isPending} disabled={!templateId || !anchor}>
          Add {tpl ? tpl.items.length : ''} deliverables
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Deliverables() {
  const { clientId } = Route.useParams();
  const [mode, setMode] = useState<'none' | 'new' | 'template'>('none');
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="t-h3 flex-1">Deliverables</h2>
        <Button variant="secondary" size="sm" onClick={() => setMode('template')}>
          From template
        </Button>
        <Button size="sm" onClick={() => setMode('new')}>
          <Plus aria-hidden className="i" /> New deliverable
        </Button>
      </div>
      {mode === 'new' ? <NewDeliverable clientId={clientId} onDone={() => setMode('none')} /> : null}
      {mode === 'template' ? <FromTemplate clientId={clientId} onDone={() => setMode('none')} /> : null}
      <DeliverableList clientId={clientId} access="staff" linkTo={(d) => ({ to: '/workspace/clients/$clientId/deliverables/$deliverableId', params: { clientId, deliverableId: d.id } })} />
    </>
  );
}
