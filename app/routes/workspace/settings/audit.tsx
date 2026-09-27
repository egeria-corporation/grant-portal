/** Settings → Audit log (spec §5.9, §7.3): who did what, when. Read-only; the log can't be edited or deleted. */
import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, getJson } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Button, Notice, Select } from '@/ui/controls';

export const Route = createFileRoute('/workspace/settings/audit')({ component: AuditLog });

interface Entry {
  id: string;
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: number;
  actor: { id: string; email: string | null; name: string | null } | null;
}

const FAMILIES = [
  ['', 'Everything'],
  ['auth', 'Sign-ins'],
  ['passkey', 'Passkeys'],
  ['session', 'Sessions'],
  ['settings', 'Settings'],
  ['team', 'Team'],
  ['invite', 'Invites'],
  ['client', 'Clients'],
  ['file', 'Files'],
  ['deliverable', 'Deliverables'],
  ['data', 'Data export'],
  ['audit', 'Audit export'],
  ['retention', 'Retention'],
] as const;

const details = (meta: unknown) => {
  if (!meta || typeof meta !== 'object') return '';
  return Object.entries(meta as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)}`)
    .join(' · ')
    .slice(0, 200);
};

function AuditLog() {
  const [family, setFamily] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', family],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (family) p.set('action', family);
      if (pageParam) p.set('before', String(pageParam));
      return getJson<{ entries: Entry[] }>(`/api/audit?${p}`);
    },
    getNextPageParam: (last) => (last.entries.length === 100 ? last.entries.at(-1)?.createdAt : undefined),
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="hd t-h1">Audit log</h1>
          <p className="mt-1 text-text2">Every sign-in, setting change, export and deletion. Entries can’t be changed or removed.</p>
        </div>
        <Select aria-label="Show" className="w-auto" value={family} onChange={(e) => setFamily(e.target.value)}>
          {FAMILIES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <a className="btn btn-secondary btn-sm" href={`/api/audit/export${family ? `?action=${family}` : ''}`} download>
          <Download aria-hidden className="i" /> Export CSV
        </a>
      </div>
      <p className="t-xs text-text2">Exporting needs a recent sign-in or passkey confirmation; if the download fails, confirm on the Data tab and try again.</p>
      {q.isError ? <Notice tone="danger">{errorMessage(q.error)}</Notice> : null}
      <section className="card overflow-x-auto" aria-label="Audit entries">
        <table className="w-full text-left text-[13px]">
          <thead className="text-text2">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Who</th>
              <th className="px-4 py-2 font-medium">What</th>
              <th className="px-4 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text2">{formatDateTime(e.createdAt)}</td>
                <td className="px-4 py-2">{e.actor ? (e.actor.name ?? e.actor.email ?? e.actor.id) : 'System'}</td>
                <td className="px-4 py-2 font-mono text-[12px]">{e.action}</td>
                <td className="px-4 py-2 text-text2">{[e.target, details(e.meta)].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
            {!entries.length ? (
              <tr>
                <td colSpan={4} className="px-4 py-3 text-text2">
                  {q.isPending ? 'Loading…' : 'Nothing yet.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
      {q.hasNextPage ? (
        <div>
          <Button variant="ghost" size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Show older
          </Button>
        </div>
      ) : null}
    </>
  );
}
