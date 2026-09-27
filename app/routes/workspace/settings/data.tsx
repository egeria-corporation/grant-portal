/**
 * Settings → Data (spec §5.9): export everything as a ZIP, and permanently
 * delete a client. Both need a recent step-up (30 minutes) and are audited.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { deleteJson, errorMessage, getJson } from '@/lib/api';
import { useMe } from '@/lib/session';
import { Button, Card, Field, Input, Notice, Select } from '@/ui/controls';
import { needsStepUp, StepUp } from '@/ui/PasskeyButton';

export const Route = createFileRoute('/workspace/settings/data')({ component: DataSettings });

const STEP_UP_MS = 30 * 60_000;

function Confirmed({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const qc = useQueryClient();
  const [now] = useState(() => Date.now());
  const at = me.data?.session.stepUpAt ?? 0;
  if (now - at < STEP_UP_MS) return <>{children}</>;
  return <StepUp onDone={() => void qc.invalidateQueries()} />;
}

function DeleteClient() {
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['clients', true], queryFn: () => getJson<{ clients: { id: string; name: string }[] }>('/api/clients?archived=1') });
  const [id, setId] = useState('');
  const [confirm, setConfirm] = useState('');
  const chosen = clients.data?.clients.find((c) => c.id === id);
  const del = useMutation({
    mutationFn: () => deleteJson<{ files: number; users: number }>(`/api/clients/${id}`, { confirm }),
    onSuccess: async () => {
      setId('');
      setConfirm('');
      await qc.invalidateQueries();
    },
  });
  return (
    <Card>
      <h2 className="hd text-[17px]">Delete a client permanently</h2>
      <p className="mt-1 text-text2">
        Removes the client and everything about it: documents (including stored files), deliverables, reports, messages, timeline and schedules. Their portal users who
        belong to no other client lose their accounts. This can’t be undone; export first if you might need anything. The deletion is recorded in the audit log.
      </p>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          del.mutate();
        }}
      >
        <Field label="Client">
          {(p) => (
            <Select {...p} value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choose…</option>
              {clients.data?.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {chosen ? (
          <Field label={`Type “${chosen.name}” to confirm`}>{(p) => <Input {...p} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        ) : null}
        {del.isError ? needsStepUp(del.error) ? <StepUp onDone={() => del.mutate()} /> : <Notice tone="danger">{errorMessage(del.error)}</Notice> : null}
        {del.data ? (
          <Notice tone="ok">
            Deleted, with {del.data.files} stored file{del.data.files === 1 ? '' : 's'} and {del.data.users} portal account{del.data.users === 1 ? '' : 's'}.
          </Notice>
        ) : null}
        <div>
          <Button type="submit" variant="danger" disabled={!chosen || confirm.trim() !== chosen.name} loading={del.isPending}>
            <Trash2 aria-hidden className="i" /> Delete permanently
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DataSettings() {
  return (
    <>
      <div>
        <h1 className="hd t-h1">Data</h1>
        <p className="mt-1 text-text2">Your data is yours: take all of it with you, or remove a client for good.</p>
      </div>
      <Card>
        <h2 className="hd text-[17px]">Export everything</h2>
        <p className="mt-1 text-text2">
          A ZIP with every record as JSON and every stored document, plus your brand files. Sign-in credentials and API keys are left out, and EINs are included as their
          last four digits. Large portals take a while to download.
        </p>
        <div className="mt-3">
          <Confirmed>
            <a className="btn btn-primary" href="/api/data/export" download>
              <Download aria-hidden className="i" /> Download export
            </a>
          </Confirmed>
        </div>
      </Card>
      <DeleteClient />
    </>
  );
}
