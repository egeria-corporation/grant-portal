/**
 * OpenGrants search and "Match to client" (spec §5.3 "With OpenGrants").
 * Results can be saved to the client in one click. Any failure falls back
 * to manual entry with a notice (spec §10.4).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { ApiError, errorMessage, getJson, postJson } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { FundingUsage, OpportunityDraft } from '@/lib/types';
import { Button, Checkbox, Field, Input, Notice, Segmented } from '@/ui/controls';
import { FitScore } from '@/ui/display';
import { money, UsageMeter } from './Funding';

export interface FundingStatus {
  configured: boolean;
  usage: FundingUsage | null;
}

export const useFundingStatus = () => useQuery({ queryKey: ['funding-status'], queryFn: () => getJson<FundingStatus>('/api/funding/status') });

const FALLBACK: Record<string, string> = {
  opengrants_budget_exhausted: 'Today’s OpenGrants requests are used up. Add opportunities by hand meanwhile.',
  opengrants_rate_limited: 'OpenGrants is busy. Try again in a minute, or add the opportunity by hand.',
  opengrants_unauthorized: 'OpenGrants didn’t accept the API key. The Owner can update it; add opportunities by hand meanwhile.',
  opengrants_plan: 'Your OpenGrants plan doesn’t include this. Add opportunities by hand meanwhile.',
  opengrants_unavailable: 'OpenGrants didn’t answer. Add opportunities by hand meanwhile.',
  profile_incomplete: 'Add a mission, programs or focus areas to the client profile first; that’s what matching uses.',
};

export function fundingError(err: unknown): string {
  return err instanceof ApiError && FALLBACK[err.code] ? (FALLBACK[err.code] as string) : errorMessage(err);
}

interface Results {
  items: OpportunityDraft[];
  total: number | null;
  cached: boolean;
  usage: FundingUsage;
}

export function OpenGrantsSearch({ clientId, savedIds, onAdded }: { clientId: string; savedIds: Set<string>; onAdded?: (opportunityId: string) => void }) {
  const qc = useQueryClient();
  const status = useFundingStatus();
  const [kind, setKind] = useState<'grant' | 'contract'>('grant');
  const [q, setQ] = useState('');
  const [states, setStates] = useState('');
  const [national, setNational] = useState(true);
  const [results, setResults] = useState<{ label: string; data: Results } | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const done = async (label: string, data: Results) => {
    setResults({ label, data });
    qc.setQueryData(['funding-status'], { configured: true, usage: data.usage });
  };
  const search = useMutation({
    mutationFn: () => {
      const p = new URLSearchParams({ kind, q });
      if (states.trim()) p.set('states', states.replace(/\s+/g, ''));
      if (!national) p.set('national', '0');
      return getJson<Results>(`/api/funding/search?${p}`);
    },
    onSuccess: (d) => done(`Results for “${q || 'all'}”`, d),
  });
  const match = useMutation({
    mutationFn: () => postJson<Results>(`/api/clients/${clientId}/funding/match`, { limit: 15 }),
    onSuccess: (d) => done('Matches for this client’s profile', d),
  });
  const add = useMutation({
    mutationFn: (d: OpportunityDraft) => postJson<{ id: string }>(`/api/clients/${clientId}/opportunities/from-opengrants`, { kind: d.kind, ogId: d.ogId }),
    onSuccess: async (r, d) => {
      setAdded((s) => new Set(s).add(d.ogId));
      await qc.invalidateQueries({ queryKey: ['opportunities', clientId] });
      onAdded?.(r.id);
    },
  });

  if (status.isPending) return null;
  if (!status.data?.configured) {
    return (
      <Notice tone="info">
        OpenGrants isn’t connected, so search and matching are off. Everything else works: add opportunities by hand or import a CSV.
      </Notice>
    );
  }
  const err = search.error ?? match.error ?? add.error;
  return (
    <div className="flex flex-col gap-4">
      {status.data.usage ? <UsageMeter usage={status.data.usage} /> : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          search.mutate();
        }}
      >
        <Segmented
          label="Search"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'grant', label: 'Grants' },
            { value: 'contract', label: 'Contracts' },
          ]}
        />
        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
          <Field label="Keywords">{(p) => <Input {...p} maxLength={200} placeholder="e.g. youth arts education" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
          <Field label="States" hint="e.g. CA,NV">
            {(p) => <Input {...p} maxLength={60} value={states} onChange={(e) => setStates(e.target.value.toUpperCase())} />}
          </Field>
        </div>
        {states.trim() ? <Checkbox checked={national} onChange={setNational} label="Include national opportunities" /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={search.isPending}>
            <Search aria-hidden className="i" /> Search
          </Button>
          <Button size="sm" variant="secondary" loading={match.isPending} onClick={() => match.mutate()}>
            <Sparkles aria-hidden className="i" /> Match to client
          </Button>
        </div>
      </form>
      {err ? <Notice tone="warn">{fundingError(err)}</Notice> : null}
      {results ? (
        <section aria-label={results.label} className="flex flex-col gap-2">
          <h3 className="t-sm font-medium">
            {results.label}
            <span className="t-xs ml-2 font-normal text-text2">
              {results.data.total !== null ? `${results.data.total} found` : `${results.data.items.length} shown`}
              {results.data.cached ? ' · from cache' : ''}
            </span>
          </h3>
          {results.data.items.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {results.data.items.map((d) => {
                const saved = savedIds.has(d.ogId) || added.has(d.ogId);
                return (
                  <li key={d.ogId} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="t-xs text-text2">{d.funderName ?? 'Funder not listed'}</span>
                      <span className="font-medium">{d.title}</span>
                      <span className="t-xs text-text2">
                        {[money(d.amountMin, d.amountMax), d.deadlineAt ? `due ${formatDate(d.deadlineAt)}` : 'no deadline listed'].filter(Boolean).join(' · ')}
                      </span>
                      {d.eligibilityNotes ? <span className="t-xs text-text2">{d.eligibilityNotes.slice(0, 200)}</span> : null}
                      <span className="t-xs text-text3">
                        Source: OpenGrants
                        {d.url ? (
                          <>
                            {' · '}
                            <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-acc-text underline underline-offset-2">
                              Funder listing
                            </a>
                          </>
                        ) : null}
                      </span>
                    </div>
                    {d.fitScore !== null ? <FitScore score={d.fitScore} label="fit" /> : null}
                    <Button size="sm" variant={saved ? 'ghost' : 'secondary'} disabled={saved} loading={add.isPending && add.variables?.ogId === d.ogId} onClick={() => add.mutate(d)}>
                      {saved ? 'Saved' : (
                        <>
                          <Plus aria-hidden className="i" /> Add
                        </>
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="t-sm text-text2">Nothing found. Try fewer keywords or another state.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
