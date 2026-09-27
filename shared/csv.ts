/**
 * Small RFC 4180 CSV reader for opportunity import (spec §5.3 "CSV import").
 * Handles quoted fields, doubled quotes, CRLF/LF, and a BOM. No dependency.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** `$25,000` / `25k` / `1.5M` → whole dollars, or null. */
export function parseAmount(v: string): number | null {
  const m = /^\$?\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?$/.exec(v.trim());
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  return Math.round(n * mult);
}

/** `2026-10-31`, `10/31/2026` (US order) → 17:00 UTC that day, or null. */
export function parseDay(v: string): number | null {
  const s = v.trim();
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [y, mo, d] = [Number(us[3]), Number(us[1]), Number(us[2])];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const at = Date.UTC(y, mo - 1, d, 17);
  return new Date(at).getUTCDate() === d ? at : null;
}
