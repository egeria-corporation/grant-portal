import { describe, expect, it } from 'vitest';
import { describeRRule, localDate, localParts, nextOccurrence, parseRRule, RRuleError, zonedTime } from '../../shared/rrule';

const NY = 'America/New_York';

describe('time zones', () => {
  it('converts wall-clock time both ways, across DST', () => {
    // 2027-03-14 is the US spring-forward day.
    const before = zonedTime(2027, 3, 13, 9, 0, NY);
    const after = zonedTime(2027, 3, 15, 9, 0, NY);
    expect(new Date(before).toISOString()).toBe('2027-03-13T14:00:00.000Z');
    expect(new Date(after).toISOString()).toBe('2027-03-15T13:00:00.000Z');
    expect(localParts(after, NY)).toMatchObject({ y: 2027, m: 3, d: 15, hh: 9, mm: 0, weekday: 1 });
    expect(localDate(Date.UTC(2027, 0, 1, 3), NY)).toBe('2026-12-31');
  });

  it('moves times skipped by spring-forward to after the gap', () => {
    const t = zonedTime(2027, 3, 14, 2, 30, NY);
    expect(localParts(t, NY).hh).toBe(3);
  });
});

describe('RRULE subset', () => {
  it('parses and rejects', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=30')).toMatchObject({ freq: 'WEEKLY', hour: 9, minute: 30 });
    for (const bad of ['FREQ=YEARLY', 'FREQ=WEEKLY;BYSECOND=1', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=MONTHLY;BYMONTHDAY=31', 'FREQ=DAILY;BYHOUR=24', '']) {
      expect(() => parseRRule(bad), bad).toThrow(RRuleError);
    }
  });

  it('weekly on Monday at 9:00 local, advancing across DST', () => {
    const rule = parseRRule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9');
    const start = Date.UTC(2027, 2, 1, 12); // Mon 1 Mar 2027
    const runs: string[] = [];
    let t = start - 1;
    for (let i = 0; i < 3; i++) {
      const next = nextOccurrence(rule, NY, t, start);
      expect(next).not.toBeNull();
      t = next as number;
      runs.push(new Date(t).toISOString());
    }
    expect(runs).toEqual(['2027-03-01T14:00:00.000Z', '2027-03-08T14:00:00.000Z', '2027-03-15T13:00:00.000Z']);
  });

  it('every other week counts from the start week', () => {
    const rule = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=8');
    const start = Date.UTC(2027, 0, 4); // Monday
    const a = nextOccurrence(rule, 'UTC', start, start) as number;
    const b = nextOccurrence(rule, 'UTC', a, start) as number;
    expect(new Date(a).toISOString()).toBe('2027-01-06T08:00:00.000Z');
    expect(new Date(b).toISOString()).toBe('2027-01-20T08:00:00.000Z');
  });

  it('monthly: last day, first Monday, last Friday', () => {
    const start = Date.UTC(2027, 0, 1);
    const at = (r: string, after: number) => new Date(nextOccurrence(parseRRule(r), 'UTC', after, start) as number).toISOString().slice(0, 10);
    expect(at('FREQ=MONTHLY;BYMONTHDAY=-1', Date.UTC(2027, 1, 1))).toBe('2027-02-28');
    expect(at('FREQ=MONTHLY;BYDAY=1MO', Date.UTC(2027, 1, 1))).toBe('2027-02-01');
    expect(at('FREQ=MONTHLY;BYDAY=-1FR', Date.UTC(2027, 1, 1))).toBe('2027-02-26');
  });

  it('daily with an end date', () => {
    const rule = parseRRule('FREQ=DAILY;BYHOUR=7;UNTIL=20270103T235959Z');
    const start = Date.UTC(2027, 0, 1);
    expect(nextOccurrence(rule, 'UTC', Date.UTC(2027, 0, 3, 8), start)).toBeNull();
    expect(new Date(nextOccurrence(rule, 'UTC', Date.UTC(2027, 0, 2, 8), start) as number).toISOString()).toBe('2027-01-03T07:00:00.000Z');
  });

  it('describes itself', () => {
    expect(describeRRule(parseRRule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9'))).toBe('Every week on Monday at 9:00');
    expect(describeRRule(parseRRule('FREQ=MONTHLY;BYDAY=1MO;BYHOUR=8;BYMINUTE=30'))).toBe('Every month on the first Monday at 8:30');
  });
});
