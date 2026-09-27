/**
 * Funding discovery behind one interface (spec §10). OpenGrants is the only
 * implementation; everything else works without it (CLAUDE.md #5). Calls are
 * cached in KV (search 6 h, grant 24 h, funder 7 d, spec §10.4), and every
 * uncached call counts against the daily request budget, which defaults to 25
 * and is set by the `OPENGRANTS_DAILY_LIMIT` var.
 */
import type { AppEnv } from '../env';
import {
  getFunder,
  getGrant,
  getContract,
  listContracts,
  listFunders,
  listGrants,
  matchGrants,
  OPENGRANTS_BASE_URL,
  type ListGrantsQuery,
  type MatchGrantsBody,
  type OpenGrantsHttp,
} from '../integrations/opengrants/client.gen';
import { listItems, listTotal, mapFunder, mapListing, mapMatch, unwrap, type FunderSummary, type OpportunityDraft } from '../integrations/opengrants/mapping';
import { sha256Hex } from '../lib/crypto';
import { decryptSecretSetting, getSetting } from '../lib/settings';

const HOUR = 3600;
const TTL = { search: 6 * HOUR, grant: 24 * HOUR, funder: 7 * 24 * HOUR, match: 6 * HOUR };
/** Below this share of the day's budget, recurring alerts pause (spec §10.4 "low-budget mode"). */
export const LOW_BUDGET_SHARE = 0.2;

export class FundingError extends Error {
  constructor(
    readonly code: 'not_configured' | 'unauthorized' | 'plan' | 'rate_limited' | 'budget_exhausted' | 'not_found' | 'upstream',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'FundingError';
  }
}

/** How a FundingError reaches the browser. The UI falls back to manual entry on any of these (spec §10.4). */
export const FUNDING_HTTP: Record<FundingError['code'], { status: 404 | 409 | 429 | 502; error: string }> = {
  not_configured: { status: 409, error: 'opengrants_not_configured' },
  unauthorized: { status: 502, error: 'opengrants_unauthorized' },
  plan: { status: 502, error: 'opengrants_plan' },
  rate_limited: { status: 429, error: 'opengrants_rate_limited' },
  budget_exhausted: { status: 429, error: 'opengrants_budget_exhausted' },
  not_found: { status: 404, error: 'not_found' },
  upstream: { status: 502, error: 'opengrants_unavailable' },
};

export interface SearchParams {
  kind: 'grant' | 'contract';
  search?: string;
  states?: string;
  includeNational?: boolean;
  minAmount?: number;
  maxAmount?: number;
  deadlineBefore?: string;
  deadlineAfter?: string;
  postedAfter?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  items: OpportunityDraft[];
  total: number | null;
  cached: boolean;
}

export interface Usage {
  used: number;
  limit: number;
  remaining: number;
  low: boolean;
  resetsAt: number;
}

export interface FundingProvider {
  search(p: SearchParams): Promise<SearchResult>;
  match(body: MatchGrantsBody): Promise<SearchResult>;
  get(kind: 'grant' | 'contract', id: string): Promise<OpportunityDraft>;
  funders(search: string): Promise<FunderSummary[]>;
  funder(id: string): Promise<FunderSummary>;
}

export async function openGrantsKey(env: AppEnv): Promise<string | null> {
  if (env.OPENGRANTS_API_KEY) return env.OPENGRANTS_API_KEY;
  const s = await getSetting(env, 'opengrants');
  return s ? decryptSecretSetting(env, 'opengrants', s.apiKeyEnc) : null;
}

export function dailyLimit(env: AppEnv): number {
  const n = Number((env as { OPENGRANTS_DAILY_LIMIT?: string }).OPENGRANTS_DAILY_LIMIT ?? '25');
  return Number.isInteger(n) && n > 0 ? n : 25;
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const usageKey = (now?: number) => `og:usage:${today(now)}`;

/** Requests used today (UTC day). Best-effort: KV counters aren't atomic (D-020). */
export async function usage(env: AppEnv, now = Date.now()): Promise<Usage> {
  const used = Number((await env.KV.get(usageKey(now))) ?? '0') || 0;
  const detected = Number((await env.KV.get('og:limit')) ?? '') || null;
  const limit = detected ?? dailyLimit(env);
  const remaining = Math.max(0, limit - used);
  const d = new Date(now);
  return { used, limit, remaining, low: remaining < limit * LOW_BUDGET_SHARE, resetsAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) };
}

async function spend(env: AppEnv, res: Response): Promise<void> {
  const key = usageKey();
  const used = Number((await env.KV.get(key)) ?? '0') || 0;
  await env.KV.put(key, String(used + 1), { expirationTtl: 2 * 86_400 });
  // Prefer the plan's own numbers when the API sends them (spec §10.4).
  const limit = Number(res.headers.get('x-ratelimit-limit') ?? '');
  if (Number.isInteger(limit) && limit > 0) await env.KV.put('og:limit', String(limit), { expirationTtl: 86_400 });
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '');
  if (Number.isInteger(remaining) && Number.isInteger(limit) && limit > 0) await env.KV.put(key, String(Math.max(used + 1, limit - remaining)), { expirationTtl: 2 * 86_400 });
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
let testFetcher: Fetcher | null = null;

/** Tests swap the network for a mock OpenGrants (tests/worker/funding.test.ts). */
export function setOpenGrantsFetcherForTests(f: Fetcher | null): void {
  testFetcher = f;
}

class OpenGrantsHttpClient implements OpenGrantsHttp {
  constructor(
    private readonly env: AppEnv,
    private readonly key: string,
  ) {}

  async request(method: string, path: string, query: Record<string, string | number | boolean | undefined>, body?: unknown): Promise<unknown> {
    const u = await usage(this.env);
    if (u.remaining <= 0) throw new FundingError('budget_exhausted');
    const url = new URL(`${OPENGRANTS_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const fetcher: Fetcher = testFetcher ?? ((i, init) => fetch(i, init));
    let res: Response;
    try {
      res = await fetcher(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new FundingError('upstream', err instanceof Error ? err.message : 'network error');
    }
    await spend(this.env, res);
    if (res.status === 401) throw new FundingError('unauthorized');
    if (res.status === 403) throw new FundingError('plan');
    if (res.status === 404) throw new FundingError('not_found');
    if (res.status === 429) throw new FundingError('rate_limited');
    if (!res.ok) throw new FundingError('upstream', `OpenGrants answered ${res.status}`);
    return res.json();
  }
}

/** KV read-through cache keyed by a hash of the call; identical searches across clients share it. */
async function cached<T>(env: AppEnv, kind: keyof typeof TTL, keyMaterial: unknown, load: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
  const key = `og:cache:${kind}:${(await sha256Hex(JSON.stringify(keyMaterial))).slice(0, 32)}`;
  const hit = await env.KV.get(key, 'json');
  if (hit !== null) return { value: hit as T, cached: true };
  const value = await load();
  await env.KV.put(key, JSON.stringify(value), { expirationTtl: TTL[kind] });
  return { value, cached: false };
}

export class OpenGrantsProvider implements FundingProvider {
  private readonly http: OpenGrantsHttp;

  constructor(
    private readonly env: AppEnv,
    key: string,
  ) {
    this.http = new OpenGrantsHttpClient(env, key);
  }

  async search(p: SearchParams): Promise<SearchResult> {
    const q: ListGrantsQuery = {
      search: p.search || undefined,
      search_mode: p.search ? 'hybrid' : undefined,
      states: p.states || undefined,
      include_national: p.states ? (p.includeNational ?? true) : undefined,
      min_amount: p.minAmount,
      max_amount: p.maxAmount,
      deadline_after: p.deadlineAfter,
      deadline_before: p.deadlineBefore,
      posted_after: p.postedAfter,
      sort_by: 'deadline_date',
      order: 'asc',
      limit: Math.min(p.limit ?? 20, 50),
      offset: p.offset ?? 0,
    };
    const { value, cached: hit } = await cached(this.env, 'search', { kind: p.kind, q }, async () => {
      const res = p.kind === 'contract' ? await listContracts(this.http, q) : await listGrants(this.http, q);
      return { items: listItems(res).flatMap((r) => mapListing(r, p.kind) ?? []), total: listTotal(res) };
    });
    return { ...value, cached: hit };
  }

  async match(body: MatchGrantsBody): Promise<SearchResult> {
    const { value, cached: hit } = await cached(this.env, 'match', body, async () => {
      const res = await matchGrants(this.http, body);
      return { items: (res.matches ?? []).flatMap((m) => mapMatch(m) ?? []), total: res.count ?? null };
    });
    return { ...value, cached: hit };
  }

  async get(kind: 'grant' | 'contract', id: string): Promise<OpportunityDraft> {
    const { value } = await cached(this.env, 'grant', { kind, id }, async () => {
      const raw = unwrap(kind === 'contract' ? await getContract(this.http, id) : await getGrant(this.http, id));
      const mapped = raw ? mapListing(raw, kind) : null;
      if (!mapped) throw new FundingError('not_found');
      return mapped;
    });
    return value;
  }

  async funders(search: string): Promise<FunderSummary[]> {
    const { value } = await cached(this.env, 'search', { funders: search }, async () => listItems(await listFunders(this.http, { search, limit: 20 })).flatMap((r) => mapFunder(r) ?? []));
    return value;
  }

  async funder(id: string): Promise<FunderSummary> {
    const { value } = await cached(this.env, 'funder', { id }, async () => {
      const raw = unwrap(await getFunder(this.http, id));
      const mapped = raw ? mapFunder(raw) : null;
      if (!mapped) throw new FundingError('not_found');
      return mapped;
    });
    return value;
  }
}

export async function fundingProvider(env: AppEnv): Promise<FundingProvider | null> {
  const key = await openGrantsKey(env);
  return key ? new OpenGrantsProvider(env, key) : null;
}

export async function requireProvider(env: AppEnv): Promise<FundingProvider> {
  const p = await fundingProvider(env);
  if (!p) throw new FundingError('not_configured');
  return p;
}
