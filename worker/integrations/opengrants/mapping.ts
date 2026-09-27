/**
 * The one place OpenGrants data meets this app's data (spec §10.3).
 *
 * - Client profile → `POST /match-grants-api` profile. The request and
 *   response schemas are typed in the committed spec.
 * - List and detail responses: the committed spec (v1.2.0) doesn't declare
 *   their schemas. They're read defensively. Field names come from the spec's
 *   own `sort_by` enum (`title`, `deadline_date`, `amount_min`, `amount_max`,
 *   `created_at`) and the match item shape (`funder`, `award_*_usd`,
 *   `deadline`, `url`). Anything missing becomes null, never a guess.
 *   If the live API differs, this file is the only thing to change
 *   (DECISIONS D-066).
 */
import type { MatchGrantsBody, MatchGrantsResponse } from './client.gen';

export interface OpportunityDraft {
  ogId: string;
  kind: 'grant' | 'contract';
  title: string;
  funderName: string | null;
  url: string | null;
  amountMin: number | null;
  amountMax: number | null;
  deadlineAt: number | null;
  /** 0–100 from matching, when available. */
  fitScore: number | null;
  /** Why it fits (matching) or eligibility text (listing). */
  eligibilityNotes: string | null;
  summary: string | null;
}

export interface FunderSummary {
  id: string;
  name: string;
  url: string | null;
  location: string | null;
  description: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};
const num = (o: Obj, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v));
  }
  return null;
};
/** Dates as `YYYY-MM-DD` (spec `format: date`) or full ISO; stored as local noon UTC-ish (end-of-day-safe). */
export function parseDate(v: string | null): number | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17);
}
const safeUrl = (v: string | null): string | null => (v && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : null);

/** Pulls the item array out of a paginated response, whatever its wrapper key. */
export function listItems(res: unknown): Obj[] {
  if (Array.isArray(res)) return res.filter(isObj);
  if (!isObj(res)) return [];
  for (const k of ['data', 'results', 'items', 'grants', 'contracts', 'funders']) {
    const v = res[k];
    if (Array.isArray(v)) return v.filter(isObj);
  }
  return [];
}

export function listTotal(res: unknown): number | null {
  if (!isObj(res)) return null;
  return num(res, 'total', 'count', 'total_count');
}

/** Detail endpoints may wrap the record (`{ data: {...} }`) or return it bare. */
export function unwrap(res: unknown): Obj | null {
  if (!isObj(res)) return null;
  for (const k of ['data', 'grant', 'contract', 'funder']) if (isObj(res[k])) return res[k] as Obj;
  return res;
}

export function mapListing(raw: Obj, kind: 'grant' | 'contract'): OpportunityDraft | null {
  const id = str(raw, 'id') ?? (typeof raw.id === 'number' ? String(raw.id) : null);
  const title = str(raw, 'title', 'name');
  if (!id || !title) return null;
  const funder = raw.funder;
  return {
    ogId: id,
    kind,
    title: title.slice(0, 300),
    funderName: (isObj(funder) ? str(funder, 'name') : null) ?? str(raw, 'funder', 'funder_name', 'agency', 'agency_name'),
    url: safeUrl(str(raw, 'url', 'source_url', 'link', 'application_url')),
    amountMin: num(raw, 'amount_min', 'award_min_usd', 'award_floor'),
    amountMax: num(raw, 'amount_max', 'award_max_usd', 'award_ceiling'),
    deadlineAt: parseDate(str(raw, 'deadline_date', 'deadline', 'close_date')),
    fitScore: null,
    eligibilityNotes: str(raw, 'eligibility', 'eligibility_notes')?.slice(0, 2000) ?? null,
    summary: str(raw, 'description', 'summary', 'synopsis')?.slice(0, 2000) ?? null,
  };
}

export function mapMatch(m: NonNullable<MatchGrantsResponse['matches']>[number]): OpportunityDraft | null {
  if (!m.id || !m.title) return null;
  return {
    ogId: m.id,
    kind: 'grant',
    title: m.title.slice(0, 300),
    funderName: m.funder ?? null,
    url: safeUrl(m.url ?? null),
    amountMin: m.award_min_usd ?? null,
    amountMax: m.award_max_usd ?? null,
    deadlineAt: parseDate(m.deadline ?? null),
    fitScore: typeof m.match_score === 'number' ? m.match_score : null,
    eligibilityNotes: m.why_it_fits?.slice(0, 2000) ?? null,
    summary: null,
  };
}

export function mapFunder(raw: Obj): FunderSummary | null {
  const id = str(raw, 'id') ?? (typeof raw.id === 'number' ? String(raw.id) : null);
  const name = str(raw, 'name', 'title');
  if (!id || !name) return null;
  return {
    id,
    name,
    url: safeUrl(str(raw, 'url', 'website')),
    location: str(raw, 'location', 'state', 'city'),
    description: str(raw, 'description', 'mission')?.slice(0, 2000) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Client profile → match profile
// ---------------------------------------------------------------------------

export interface ClientProfileForMatch {
  mission: string | null;
  entityType: string | null;
  is501c3: boolean | null;
  geography: string[];
  budgetBand: string | null;
  programs: string[];
  focusTags: string[];
  populations: string[];
}

type ApplicantType = NonNullable<MatchGrantsBody['profile']['applicant_type']>;

/** Free-text entity type → the spec's applicant_type enum. */
export function applicantType(entity: string | null, is501c3: boolean | null): ApplicantType | undefined {
  const e = (entity ?? '').toLowerCase();
  if (is501c3 || /non-?profit|charit|foundation|501/.test(e)) return 'nonprofit';
  if (/tribe|tribal|nation/.test(e)) return 'tribal';
  if (/city|county|town|municipal|school district|government|public agency/.test(e)) return 'municipality';
  if (/universit|college|academic|research institute/.test(e)) return 'academic';
  if (/individual|sole|person/.test(e)) return 'individual';
  if (/llc|inc|corp|company|business|for-?profit|startup/.test(e)) return 'for_profit';
  return undefined;
}

/** "$250k–$1M" → 250000 (the band's floor; the API wants one number). */
export function budgetFloor(band: string | null): number | undefined {
  if (!band) return undefined;
  const m = /\$?\s*([\d.,]+)\s*([kKmM])?/.exec(band);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  const mult = m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  return Math.round(n * mult);
}

export function matchRequest(p: ClientProfileForMatch, limit = 10): MatchGrantsBody | null {
  const mission = p.mission?.trim() || [...p.programs, ...p.focusTags].join(', ');
  if (!mission) return null;
  const type = applicantType(p.entityType, p.is501c3);
  const budget = budgetFloor(p.budgetBand);
  return {
    profile: {
      mission: mission.slice(0, 2000),
      ...(p.focusTags[0] ? { sector: p.focusTags[0] } : {}),
      ...(p.geography[0] ? { geography: p.geography[0] } : {}),
      ...(type ? { applicant_type: type } : {}),
      ...(p.is501c3 !== null ? { is_501c3: p.is501c3 } : {}),
      ...(budget !== undefined ? { annual_budget_usd: budget } : {}),
    },
    focus_keywords: [...new Set([...p.focusTags, ...p.programs, ...p.populations])].slice(0, 10),
    limit: Math.max(1, Math.min(25, limit)),
  };
}
