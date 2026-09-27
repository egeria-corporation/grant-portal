/**
 * One client's opportunities (spec §5.3, §5.4): the pipeline board, the
 * candidates that aren't on it yet, manual entry and CSV import (so the app
 * works fully without OpenGrants), and "plan deliverables from a template"
 * once an opportunity is being pursued.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { KanbanSquare, Upload } from 'lucide-react';
import { useState } from 'react';
import { money, OpportunityForm, PipelineBoard, SourceLine, STAGE_LABEL, type OpportunityInput } from '@/client/Funding';
import { deleteJson, errorMessage, getJson, patchJson, postJson } from '@/lib/api';
import { formatDate, toDateInput } from '@/lib/format';
import type { Opportunity, Stage } from '@/lib/types';
import { Button, Field, Input, Notice, Select, Textarea } from '@/ui/controls';
import { EmptyState } from '@/ui/display';

export const Route = createFileRoute('/workspace/clients/$clientId/pipeline')({ component: Pipeline });

interface Template {
  id: string;
  name: string;
  items: unknown[];
}

function PlanDeliverables({ clientId, opp, onDone }: { clientId: string; opp: Opportunity; onDone: () => void }) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => getJson<{ templates: Template[] }>('/api/templates') });
  const [templateId, setTemplateId] = useState('');
  const [anchor, setAnchor] = useState(toDateInput(opp.deadlineAt));
  const create = useMutation({
    mutationFn: () => postJson(`/api/clients/${clientId}/deliverables/from-template`, { templateId, anchorAt: new Date(`${anchor}T17:00:00Z`).getTime(), opportunityId: opp.id }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['opportunities', clientId] });
      await qc.invalidateQueries({ queryKey: ['deliverables', clientId] });
      onDone();
    },
  });
  const list = templates.data?.templates ?? [];
  if (templates.isSuccess && !list.length) {
    return (
      <p className="t-xs text-text2">
        No templates yet. <Link to="/workspace/templates">Create one</Link> to add a set of deliverables in one step.
      </p>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Select aria-label="Deliverable template" required value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
        <option value="">Choose a template…</option>
        {list.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.items.length})
          </option>
        ))}
      </Select>
      <Field label="Due dates count back from">{(p) => <Input {...p} type="date" required value={anchor} onChange={(e) => setAnchor(e.target.value)} />}</Field>
      {create.isError ? <Notice tone="danger">{errorMessage(create.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button size="sm" type="submit" loading={create.isPending} disabled={!templateId || !anchor}>
          Add deliverables
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CsvImport({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const run = useMutation({
    mutationFn: () => postJson<{ imported: number; errors: { line: number; error: string }[] }>(`/api/clients/${clientId}/opportunities/import`, { csv }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['opportunities', clientId] }),
  });
  const ERR: Record<string, string> = {
    missing_title: 'no title',
    bad_deadline: 'deadline isn’t a date (use 2026-11-30 or 11/30/2026)',
    bad_amount: 'amount isn’t a number',
    bad_url: 'URL must start with https://',
    too_many_rows: 'only the first 500 rows are imported',
    missing_title_column: 'the first row needs a “Title” column',
  };
  return (
    <div className="card flex flex-col gap-3 p-4">
      <p className="t-sm text-text2">
        Columns: <b>Title</b> (required), Funder, URL, Deadline, Amount, Amount min, Eligibility, Notes. The first row is the header.
      </p>
      <Input
        type="file"
        accept=".csv,text/csv"
        aria-label="CSV file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void f.text().then(setCsv);
        }}
      />
      <Field label="Or paste CSV">{(p) => <Textarea {...p} rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} />}</Field>
      {run.data ? (
        <Notice tone={run.data.errors.length ? 'warn' : 'ok'}>
          Imported {run.data.imported} opportunit{run.data.imported === 1 ? 'y' : 'ies'}.
          {run.data.errors.length ? (
            <ul className="mt-1 list-disc pl-5">
              {run.data.errors.slice(0, 10).map((e) => (
                <li key={e.line}>
                  Line {e.line}: {ERR[e.error] ?? e.error}
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {run.isError ? <Notice tone="danger">{errorMessage(run.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button size="sm" loading={run.isPending} disabled={!csv.trim()} onClick={() => run.mutate()}>
          <Upload aria-hidden className="i" /> Import
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </div>
  );
}

function Pipeline() {
  const { clientId } = Route.useParams();
  const qc = useQueryClient();
  const [panel, setPanel] = useState<'add' | 'import' | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  const opps = useQuery({ queryKey: ['opportunities', clientId], queryFn: () => getJson<{ opportunities: Opportunity[] }>(`/api/clients/${clientId}/opportunities`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['opportunities', clientId] });
  const base = `/api/clients/${clientId}/opportunities`;
  const add = useMutation({
    mutationFn: (v: OpportunityInput) => postJson(base, { ...v, stage: 'researching' }),
    onSuccess: async () => {
      await refresh();
      setPanel(null);
    },
  });
  const save = useMutation({
    mutationFn: (p: { id: string; body: Partial<OpportunityInput> & { stage?: Stage } }) => patchJson(`${base}/${p.id}`, p.body),
    onSuccess: async () => {
      await refresh();
      setEditing(null);
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteJson(`${base}/${id}`), onSuccess: refresh });

  const all = opps.data?.opportunities ?? [];
  const board = all.filter((o) => o.stage !== 'none');
  const candidates = all.filter((o) => o.stage === 'none');
  const edited = all.find((o) => o.id === editing);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="t-h3 flex-1">Pipeline</h2>
        <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'import' ? null : 'import')}>
          Import CSV
        </Button>
        <Button size="sm" onClick={() => setPanel(panel === 'add' ? null : 'add')}>
          Add opportunity
        </Button>
      </div>
      {panel === 'add' ? (
        <div className="card p-4">
          <OpportunityForm submitLabel="Add to pipeline" busy={add.isPending} error={add.isError ? errorMessage(add.error) : null} onSubmit={(v) => add.mutate(v)} onCancel={() => setPanel(null)} />
        </div>
      ) : null}
      {panel === 'import' ? <CsvImport clientId={clientId} onDone={() => setPanel(null)} /> : null}
      {edited ? (
        <div className="card flex flex-col gap-3 p-4">
          <h3 className="t-h4">Edit {edited.title}</h3>
          <SourceLine o={edited} />
          <OpportunityForm
            key={edited.id}
            initial={edited}
            submitLabel="Save"
            busy={save.isPending}
            error={save.isError ? errorMessage(save.error) : null}
            onSubmit={(v) => save.mutate({ id: edited.id, body: v })}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : null}
      {save.isError && !edited ? <Notice tone="danger">{errorMessage(save.error)}</Notice> : null}

      {board.length ? (
        <PipelineBoard
          items={board}
          onMove={(o, stage) => save.mutate({ id: o.id, body: { stage } })}
          actions={(o) => (
            <div className="flex flex-col gap-2">
              {planning === o.id ? (
                <PlanDeliverables clientId={clientId} opp={o} onDone={() => setPlanning(null)} />
              ) : (
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(o.id)}>
                    Edit
                  </Button>
                  {(o.stage === 'researching' || o.stage === 'preparing') && !o.deliverables?.total ? (
                    <Button size="sm" variant="ghost" onClick={() => setPlanning(o.id)}>
                      Plan deliverables
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          )}
        />
      ) : (
        <EmptyState icon={KanbanSquare} title={opps.isPending ? 'Loading…' : 'Nothing in the pipeline yet'}>
          Opportunities land here when the client chooses Pursue in a report, or when you add one.
        </EmptyState>
      )}

      {candidates.length ? (
        <section className="card overflow-hidden" aria-labelledby="cand-h">
          <h3 id="cand-h" className="sech">
            Candidates <span className="ct">{candidates.length}</span>
          </h3>
          <p className="t-xs px-4 pb-2 text-text2">Saved for this client but not being pursued. Add them to a report, or straight to the pipeline.</p>
          <ul className="divide-y divide-border">
            {candidates.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{o.title}</span>
                  <span className="t-xs text-text2">
                    {[o.funderName, money(o.amountMin, o.amountMax), o.deadlineAt ? `due ${formatDate(o.deadlineAt)}` : null].filter(Boolean).join(' · ')}
                  </span>
                  <SourceLine o={o} />
                </div>
                <Button size="sm" variant="secondary" onClick={() => save.mutate({ id: o.id, body: { stage: 'researching' } })}>
                  {STAGE_LABEL.researching}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(o.id)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => window.confirm(`Delete “${o.title}”? It’s also removed from any report.`) && remove.mutate(o.id)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
