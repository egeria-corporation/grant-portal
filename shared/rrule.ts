/**
 * The RRULE subset schedules use (spec §12), evaluated in a named time zone
 * so "every Monday at 9:00" stays 9:00 local across daylight-saving changes.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY (MO…SU; for MONTHLY
 * also 1MO…4MO and -1MO), BYMONTHDAY (1–28, -1 for the last day), BYHOUR,
 * BYMINUTE, UNTIL (UTC, e.g. 20271231T000000Z). Anything else is rejected by
 * `parseRRule`, so a schedule can never silently mean something else.
 */

const DAY = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface RRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  byDay: { day: Weekday; nth: number | null }[];
  byMonthDay: number[];
  hour: number;
  minute: number;
  until: number | null;
}

export class RRuleError extends Error {}

export function parseRRule(input: string): RRule {
  const rule: RRule = { freq: 'WEEKLY', interval: 1, byDay: [], byMonthDay: [], hour: 9, minute: 0, until: null };
  let freq: string | null = null;
  for (const part of input.replace(/^RRULE:/i, '').split(';').filter(Boolean)) {
    const [k, v = ''] = part.split('=');
    switch (k?.toUpperCase()) {
      case 'FREQ':
        freq = v.toUpperCase();
        break;
      case 'INTERVAL':
        rule.interval = int(v, 1, 52);
        break;
      case 'BYDAY':
        rule.byDay = v.split(',').map((d) => {
          const m = /^([+-]?[1-4])?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim());
          if (!m?.[2]) throw new RRuleError(`bad BYDAY ${d}`);
          return { day: m[2].toUpperCase() as Weekday, nth: m[1] ? Number(m[1]) : null };
        });
        break;
      case 'BYMONTHDAY':
        rule.byMonthDay = v.split(',').map((d) => {
          const n = Number(d);
          if (!(Number.isInteger(n) && ((n >= 1 && n <= 28) || n === -1))) throw new RRuleError(`bad BYMONTHDAY ${d}`);
          return n;
        });
        break;
      case 'BYHOUR':
        rule.hour = int(v, 0, 23);
        break;
      case 'BYMINUTE':
        rule.minute = int(v, 0, 59);
        break;
      case 'UNTIL': {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(v);
        if (!m) throw new RRuleError('bad UNTIL');
        rule.until = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 23), Number(m[5] ?? 59), Number(m[6] ?? 59));
        break;
      }
      case 'WKST':
        break;
      default:
        throw new RRuleError(`unsupported ${k}`);
    }
  }
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') throw new RRuleError('FREQ must be DAILY, WEEKLY or MONTHLY');
  rule.freq = freq;
  if (rule.freq !== 'MONTHLY' && rule.byDay.some((d) => d.nth !== null)) throw new RRuleError('ordinal BYDAY needs FREQ=MONTHLY');
  return rule;
}

function int(v: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new RRuleError(`value out of range: ${v}`);
  return n;
}

// ---------------------------------------------------------------------------
// Time zones via Intl (no tz database shipped).
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of `utc` in `tz`. */
export function localParts(utc: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; weekday: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(utc).map((x) => [x.type, x.value]));
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  return { y, m, d, hh: Number(p.hour) % 24, mm: Number(p.minute), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** Offset of `tz` from UTC at instant `utc`, in ms (positive east of UTC). */
function offsetAt(utc: number, tz: string): number {
  const p = localParts(utc, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, Math.floor((utc / 1000) % 60));
  return asUtc - Math.floor(utc / 1000) * 1000;
}

/** The instant a wall-clock time happens in `tz`. Times skipped by DST move forward by the gap. */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - offsetAt(wall, tz);
  const second = wall - offsetAt(first, tz);
  for (const t of [second, first]) {
    const p = localParts(t, tz);
    if (p.hh === hh && p.mm === mm && p.d === d) return t;
  }
  // The wall time doesn't exist (spring forward): the later candidate lands just after the gap.
  return Math.max(first, second);
}

/** YYYY-MM-DD of `utc` in `tz`. */
export function localDate(utc: number, tz: string): string {
  const p = localParts(utc, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function matchesDay(rule: RRule, y: number, m: number, d: number, weekday: number, dtstart: { y: number; m: number; d: number }): boolean {
  const civil = Date.UTC(y, m - 1, d);
  const start = Date.UTC(dtstart.y, dtstart.m - 1, dtstart.d);
  if (civil < start) return false;
  if (rule.freq === 'DAILY') {
    return Math.round((civil - start) / DAY) % rule.interval === 0;
  }
  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length ? rule.byDay.map((b) => WEEKDAYS.indexOf(b.day)) : [new Date(start).getUTCDay()];
    if (!days.includes(weekday)) return false;
    // Weeks start on Monday for INTERVAL counting.
    const monday = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
    return Math.round((monday(civil) - monday(start)) / (7 * DAY)) % rule.interval === 0;
  }
  // MONTHLY
  const months = (y - dtstart.y) * 12 + (m - dtstart.m);
  if (months % rule.interval !== 0) return false;
  const last = daysInMonth(y, m);
  if (rule.byMonthDay.length) return rule.byMonthDay.some((n) => (n === -1 ? d === last : d === n));
  if (rule.byDay.length) {
    return rule.byDay.some((b) => {
      if (WEEKDAYS.indexOf(b.day) !== weekday) return false;
      if (b.nth === null) return true;
      return b.nth > 0 ? Math.ceil(d / 7) === b.nth : d > last - 7;
    });
  }
  return d === Math.min(dtstart.d, last);
}

/**
 * First occurrence strictly after `after`, or null. `dtstart` anchors
 * INTERVAL counting and is the earliest possible occurrence.
 */
export function nextOccurrence(rule: RRule, tz: string, after: number, dtstart: number): number | null {
  const s = localParts(dtstart, tz);
  const from = localParts(Math.max(after, dtstart - DAY), tz);
  let civil = Date.UTC(from.y, from.m - 1, from.d);
  for (let i = 0; i < 800; i++, civil += DAY) {
    const date = new Date(civil);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!matchesDay(rule, y, m, d, date.getUTCDay(), s)) continue;
    const at = zonedTime(y, m, d, rule.hour, rule.minute, tz);
    if (at <= after || at < dtstart) continue;
    if (rule.until !== null && at > rule.until) return null;
    return at;
  }
  return null;
}

/** "Every week on Monday at 9:00", for review screens. */
export function describeRRule(rule: RRule): string {
  const names: Record<Weekday, string> = { SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday' };
  const time = `${rule.hour}:${String(rule.minute).padStart(2, '0')}`;
  const every = (unit: string) => (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`);
  const ord = (n: number) => (n === -1 ? 'last' : ['first', 'second', 'third', 'fourth'][n - 1]);
  if (rule.freq === 'DAILY') return `${every('day')} at ${time}`;
  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.map((b) => names[b.day]).join(', ');
    return `${every('week')}${days ? ` on ${days}` : ''} at ${time}`;
  }
  if (rule.byMonthDay.length) return `${every('month')} on day ${rule.byMonthDay.map((d) => (d === -1 ? 'last' : d)).join(', ')} at ${time}`;
  if (rule.byDay.length) return `${every('month')} on the ${rule.byDay.map((b) => `${b.nth ? `${ord(b.nth)} ` : ''}${names[b.day]}`).join(', ')} at ${time}`;
  return `${every('month')} at ${time}`;
}
