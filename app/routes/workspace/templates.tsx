/**
 * Deliverable templates (spec §5.5): a named set of deliverables with due dates
 * relative to an anchor, e.g. "Budget narrative: deadline minus 14 days".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { LayoutList, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { deleteJson, errorMessage, getJson, postJson, putJson } from '@/lib/api';
import { Button, Field, Input, Notice, Select } from '@/ui/controls';
import { EmptyState } from '@/ui/display';

export const Route = createFileRoute('/workspace/templates')({ component: Templates });

interface Item {
  title: string;
  side: 'consultant' | 'client';
  offsetDays: number;
}
interface Template {
  id: string;
  name: string;
  description: string | null;
  items: Item[];
}

function Editor({ initial, onDone }: { initial?: Template; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? '');
  const [items, setItems] = useState<Item[]>(initial?.items ?? [{ title: '', side: 'consultant', offsetDays: -14 }]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, items: items.filter((i) => i.title.trim()) };
      return initial ? putJson(`/api/templates/${initial.id}`, body) : postJson('/api/templates', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['templates'] });
      onDone();
    },
  });
  const set = (i: number, patch: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <form
      className="card flex flex-col gap-3 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Template name">{(p) => <Input {...p} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Federal grant application" />}</Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="label mb-1">Deliverables</legend>
        {items.map((item, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label={`Deliverable ${i + 1}`} placeholder="Title" value={item.title} maxLength={160} onChange={(e) => set(i, { title: e.target.value })} className="min-w-[200px] flex-1" />
            <Select aria-label={`Who delivers ${i + 1}`} value={item.side} onChange={(e) => set(i, { side: e.target.value as Item['side'] })} className="w-auto">
              <option value="consultant">We deliver</option>
              <option value="client">Client delivers</option>
            </Select>
            <Input
              aria-label={`Days from the anchor for ${i + 1}`}
              type="number"
              min={-730}
              max={730}
              value={item.offsetDays}
              onChange={(e) => set(i, { offsetDays: Math.trunc(Number(e.target.value) || 0) })}
              className="w-24"
            />
            <span className="t-xs w-28 text-text2">{item.offsetDays === 0 ? 'on the anchor' : `${Math.abs(item.offsetDays)} days ${item.offsetDays < 0 ? 'before' : 'after'}`}</span>
            <Button variant="ghost" size="sm" icon aria-label={`Remove ${i + 1}`} disabled={items.length === 1} onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}>
              <X aria-hidden className="i" />
            </Button>
          </div>
        ))}
        <div>
          <Button variant="secondary" size="sm" onClick={() => setItems((xs) => [...xs, { title: '', side: 'consultant', offsetDays: 0 }])}>
            <Plus aria-hidden className="i" /> Add a deliverable
          </Button>
        </div>
      </fieldset>
      {save.isError ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending} disabled={!name.trim() || !items.some((i) => i.title.trim())}>
          Save template
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Templates() {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => getJson<{ templates: Template[] }>('/api/templates') });
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => deleteJson(`/api/templates/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }) });
  const list = templates.data?.templates ?? [];
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="hd text-[26px] leading-8">Templates</h1>
          <p className="mt-1 text-text2">Reusable sets of deliverables. Due dates count from an anchor date, usually the grant deadline.</p>
        </div>
        {editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden className="i" /> New template
          </Button>
        ) : null}
      </div>
      {editing ? <Editor key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} /> : null}
      {list.length ? (
        <ul className="card divide-y divide-border overflow-hidden">
          {list.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{t.name}</span>
                <span className="t-xs truncate text-text2">{t.items.map((i) => i.title).join(' · ')}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditing(t)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (window.confirm(`Delete the template “${t.name}”? Deliverables already created stay.`)) remove.mutate(t.id);
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : editing ? null : (
        <EmptyState icon={LayoutList} title={templates.isPending ? 'Loading…' : 'No templates yet'} action={<Button size="sm" onClick={() => setEditing('new')}>Create a template</Button>}>
          For example, a federal application with a budget narrative 14 days before the deadline.
        </EmptyState>
      )}
    </>
  );
}
