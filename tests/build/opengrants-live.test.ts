/**
 * Live smoke test against the real OpenGrants API. Skipped unless
 * OPENGRANTS_API_KEY is set (CI has none). Spends two requests of the day's
 * budget: one grant search and one profile match. It checks that the
 * generated client's paths answer and that mapping.ts still understands the
 * responses; if it fails after an API change, mapping.ts is the file to fix.
 *
 *   OPENGRANTS_API_KEY=... npx vitest run --project build tests/build/opengrants-live.test.ts
 */
import { describe, expect, it } from 'vitest';
import { listGrants, matchGrants, OPENGRANTS_BASE_URL, type OpenGrantsHttp } from '../../worker/integrations/opengrants/client.gen';
import { listItems, mapListing, mapMatch } from '../../worker/integrations/opengrants/mapping';

const key = process.env.OPENGRANTS_API_KEY;

const http: OpenGrantsHttp = {
  async request(method, path, query, body) {
    const url = new URL(`${OPENGRANTS_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.status, `${method} ${path}`).toBe(200);
    return res.json();
  },
};

describe.skipIf(!key)('OpenGrants (live)', () => {
  it('search returns listings the mapping understands', async () => {
    const res = await listGrants(http, { search: 'youth education', limit: 5 });
    const items = listItems(res).map((r) => mapListing(r, 'grant'));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i && i.ogId && i.title)).toBe(true);
  });

  it('profile match returns scored matches', async () => {
    const res = await matchGrants(http, { profile: { mission: 'After-school STEM programs for low-income youth', applicant_type: 'nonprofit' }, limit: 3 });
    const items = (res.matches ?? []).map(mapMatch);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i && i.ogId && i.title)).toBe(true);
  });
});
