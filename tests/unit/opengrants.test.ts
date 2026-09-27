/**
 * OpenGrants mapping (spec §10.3) and the CSV reader used for opportunity
 * import. The generated client's freshness is checked in tests/build.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount, parseCsv, parseDay } from '@shared/csv';
import { applicantType, budgetFloor, listItems, listTotal, mapFunder, mapListing, matchRequest, parseDate, unwrap } from '../../worker/integrations/opengrants/mapping';

describe('mapping', () => {
  it('reads list responses whatever the wrapper', () => {
    expect(listItems([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(listItems({ data: [{ id: 'a' }], total: 7 })).toEqual([{ id: 'a' }]);
    expect(listItems({ results: [{ id: 'b' }, 'junk'] })).toEqual([{ id: 'b' }]);
    expect(listItems('nope')).toEqual([]);
    expect(listTotal({ total: 7 })).toBe(7);
    expect(listTotal({ count: '12' })).toBe(12);
    expect(unwrap({ data: { id: 'x' } })).toEqual({ id: 'x' });
    expect(unwrap({ id: 'y' })).toEqual({ id: 'y' });
  });

  it('maps a listing without guessing missing fields', () => {
    expect(mapListing({ id: 42, title: 'T', agency_name: 'EPA', deadline_date: '2026-10-31', amount_max: '50000', url: 'javascript:x' }, 'grant')).toEqual({
      ogId: '42',
      kind: 'grant',
      title: 'T',
      funderName: 'EPA',
      url: null,
      amountMin: null,
      amountMax: 50000,
      deadlineAt: Date.UTC(2026, 9, 31, 17),
      fitScore: null,
      eligibilityNotes: null,
      summary: null,
    });
    expect(mapListing({ title: 'no id' }, 'grant')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(mapFunder({ id: 'f', name: 'F', website: 'https://f.org' })).toMatchObject({ id: 'f', url: 'https://f.org' });
  });

  it('turns a client profile into a match request', () => {
    expect(applicantType('501(c)(3) public charity', null)).toBe('nonprofit');
    expect(applicantType('County government', false)).toBe('municipality');
    expect(applicantType('LLC', false)).toBe('for_profit');
    expect(applicantType('', null)).toBeUndefined();
    expect(budgetFloor('$250k–$1M')).toBe(250000);
    expect(budgetFloor('Under $100,000')).toBe(100000);
    expect(budgetFloor(null)).toBeUndefined();
    const empty = { mission: null, entityType: null, is501c3: null, geography: [], budgetBand: null, programs: [], focusTags: [], populations: [] };
    expect(matchRequest(empty)).toBeNull();
    expect(matchRequest({ ...empty, programs: ['After-school'], populations: ['Youth'], is501c3: true }, 99)).toEqual({
      profile: { mission: 'After-school', applicant_type: 'nonprofit', is_501c3: true },
      focus_keywords: ['After-school', 'Youth'],
      limit: 25,
    });
  });
});

describe('CSV', () => {
  it('handles quotes, CRLF, BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n1,\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['1', ''],
    ]);
    expect(parseCsv('"multi\nline",z')).toEqual([['multi\nline', 'z']]);
  });

  it('parses amounts and days', () => {
    expect(parseAmount('$25,000')).toBe(25000);
    expect(parseAmount('1.5M')).toBe(1_500_000);
    expect(parseAmount('ten')).toBeNull();
    expect(parseDay('2026-02-29')).toBeNull();
    expect(parseDay('11/15/2026')).toBe(Date.UTC(2026, 10, 15, 17));
    expect(parseDay('2026-11-15')).toBe(Date.UTC(2026, 10, 15, 17));
  });
});
