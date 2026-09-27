/**
 * Branded PDF export of a funding report (spec §5.3 "branded PDF export",
 * DECISIONS D-068). Workers have no headless browser or canvas, so this is a
 * small PDF 1.4 writer: the standard Helvetica fonts (WinAnsi, no embedding),
 * flate-compressed page streams, the firm's raster logo (JPEG as-is; 8-bit
 * non-interlaced PNG decoded to RGB + alpha), link annotations for listing
 * URLs, and the brand accent. No scripts, forms or external references.
 * Nothing about this product appears in the file (CLAUDE.md #3).
 */

export interface PdfImage {
  width: number;
  height: number;
  /** PDF image dictionary entries except Width/Height/Length/SMask. */
  dict: string;
  data: Uint8Array;
  alpha: Uint8Array | null;
}

export interface PdfReportItem {
  tag: 'recommended' | 'consider' | 'fyi' | null;
  title: string;
  funderName: string | null;
  url: string | null;
  amountMin: number | null;
  amountMax: number | null;
  deadlineAt: number | null;
  note: string | null;
  eligibility: string | null;
}

export interface PdfReport {
  firm: string;
  colors: { accent: string; text: string; text2: string; border: string };
  logo: PdfImage | null;
  title: string;
  clientName: string;
  date: number;
  tz: string;
  intro: string | null;
  items: PdfReportItem[];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Helvetica advance widths (1/1000 em) for ASCII 32–126, from the standard AFM. */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667,
  667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500,
  556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

/** One WinAnsi code per character; anything the standard fonts can't show becomes '?'. */
export function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.replace(/[\t\u00a0]/g, ' ')) {
    const cp = ch.codePointAt(0) ?? 63;
    if (cp >= 32 && cp <= 126) out.push(cp);
    else if (cp >= 0xa1 && cp <= 0xff) out.push(cp);
    else if (WIN_ANSI[ch] !== undefined) out.push(WIN_ANSI[ch]);
    else if (cp >= 32) out.push(63);
  }
  return out;
}

/** PDF literal string: ASCII only, with escapes, so the content stream stays 7-bit. */
function lit(codes: number[]): string {
  let s = '(';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += `\\${String.fromCharCode(c)}`;
    else if (c < 32 || c > 126) s += `\\${c.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(c);
  }
  return `${s})`;
}

type Font = 'F1' | 'F2';

export function textWidth(s: string, size: number, font: Font = 'F1'): number {
  let w = 0;
  for (const c of winAnsi(s)) w += c >= 32 && c <= 126 ? (HELV[c - 32] ?? 556) : 556;
  // Helvetica-Bold runs wider; this over-estimates slightly, so wrapped lines never overflow.
  return ((font === 'F2' ? w * 1.12 : w) * size) / 1000;
}

export function wrap(text: string, size: number, maxWidth: number, font: Font = 'F1'): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, font) <= maxWidth) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      // A single word longer than the line is broken by characters.
      let rest = word;
      while (textWidth(rest, size, font) > maxWidth) {
        let n = rest.length;
        while (n > 1 && textWidth(rest.slice(0, n), size, font) > maxWidth) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** Light markdown clean-up: the builder's notes are plain text with the odd `**`. */
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)');

const rgb = (hex: string): string => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  if (!Number.isFinite(n)) return '0 0 0';
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(' ');
};

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const MAX_PIXELS = 4_000_000;

function jpegImage(b: Uint8Array): PdfImage | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    const len = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((b[i + 5] ?? 0) << 8) | (b[i + 6] ?? 0);
      const width = ((b[i + 7] ?? 0) << 8) | (b[i + 8] ?? 0);
      const comps = b[i + 9];
      if (!width || !height || (comps !== 1 && comps !== 3)) return null;
      return { width, height, dict: `/ColorSpace /${comps === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode`, data: b, alpha: null };
    }
    i += 2 + len;
  }
  return null;
}

async function pngImage(b: Uint8Array): Promise<PdfImage | null> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let type = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= b.length) {
    const len = view.getUint32(pos);
    const name = String.fromCharCode(...b.subarray(pos + 4, pos + 8));
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const depth = b[pos + 16];
      type = b[pos + 17] ?? -1;
      if (depth !== 8 || b[pos + 20] !== 0) return null; // 8-bit, non-interlaced only
    } else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || !width || !height || width * height > MAX_PIXELS || (type === 3 && !palette)) return null;
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of idat) {
    joined.set(d, o);
    o += d.length;
  }
  const raw = await inflate(joined);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (px[dst + x - channels] ?? 0) : 0;
      const up = y ? (px[dst - stride + x] ?? 0) : 0;
      const ul = y && x >= channels ? (px[dst - stride + x - channels] ?? 0) : 0;
      const v = raw[src + x] ?? 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - ul;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      }
      px[dst + x] = (v + pred) & 255;
    }
  }
  const n = width * height;
  const gray = type === 0 || type === 4;
  const color = new Uint8Array(n * (gray ? 1 : 3));
  const hasAlpha = type === 4 || type === 6 || (type === 3 && trns !== null);
  let alpha: Uint8Array | null = hasAlpha ? new Uint8Array(n) : null;
  const a = alpha ?? new Uint8Array(0);
  const pal = palette ?? new Uint8Array(0);
  const tr = trns ?? new Uint8Array(0);
  for (let i = 0; i < n; i++) {
    if (type === 0) color[i] = px[i] ?? 0;
    else if (type === 4) {
      color[i] = px[i * 2] ?? 0;
      a[i] = px[i * 2 + 1] ?? 255;
    } else if (type === 2) color.set(px.subarray(i * 3, i * 3 + 3), i * 3);
    else if (type === 6) {
      color.set(px.subarray(i * 4, i * 4 + 3), i * 3);
      a[i] = px[i * 4 + 3] ?? 255;
    } else {
      const idx = px[i] ?? 0;
      color.set(pal.subarray(idx * 3, idx * 3 + 3), i * 3);
      if (hasAlpha) a[i] = tr[idx] ?? 255;
    }
  }
  if (alpha?.every((v) => v === 255)) alpha = null;
  return {
    width,
    height,
    dict: `/ColorSpace /${gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode`,
    data: await deflate(color),
    alpha: alpha ? await deflate(alpha) : null,
  };
}

/** A logo the PDF can show, or null (SVG and unusual PNGs fall back to the firm name). */
export async function pdfImage(bytes: Uint8Array, mime: string): Promise<PdfImage | null> {
  try {
    if (mime === 'image/jpeg') return jpegImage(bytes);
    if (mime === 'image/png') return await pngImage(bytes);
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const W = 612; // US Letter
const H = 792;
const M = 54;
const CW = W - 2 * M;
const BOTTOM = M + 24;

const TAG_LABEL = { recommended: 'RECOMMENDED', consider: 'CONSIDER', fyi: 'FYI' } as const;

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
export function amountLabel(min: number | null, max: number | null): string | null {
  if (min && max && min !== max) return `${usd(min)}–${usd(max)}`;
  if (max) return min === max ? usd(max) : `Up to ${usd(max)}`;
  if (min) return `From ${usd(min)}`;
  return null;
}

interface Page {
  ops: string[];
  links: { rect: [number, number, number, number]; uri: string }[];
}

class Layout {
  pages: Page[] = [];
  y = 0;
  constructor(private readonly colors: PdfReport['colors']) {
    this.newPage();
  }

  get page(): Page {
    return this.pages[this.pages.length - 1] as Page;
  }

  newPage(): void {
    this.pages.push({ ops: [], links: [] });
    this.y = H - M;
  }

  ensure(h: number): void {
    if (this.y - h < BOTTOM) this.newPage();
  }

  text(s: string, x: number, y: number, size: number, font: Font, color: string): void {
    this.page.ops.push(`BT /${font} ${size} Tf ${rgb(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} Td ${lit(winAnsi(s))} Tj ET`);
  }

  /** Wrapped paragraph at the cursor; breaks across pages. */
  para(s: string, size: number, font: Font, color: string, opts: { indent?: number; lead?: number; link?: string } = {}): void {
    const x = M + (opts.indent ?? 0);
    const lead = opts.lead ?? size * 1.4;
    for (const line of wrap(s, size, CW - (opts.indent ?? 0) - 4, font)) {
      this.ensure(lead);
      this.y -= lead;
      if (line) this.text(line, x, this.y, size, font, color);
      if (opts.link && line) this.page.links.push({ rect: [x, this.y - 2, x + textWidth(line, size, font), this.y + size], uri: opts.link });
    }
  }

  rule(color = this.colors.border): void {
    this.page.ops.push(`${rgb(color)} RG 0.75 w ${M} ${this.y.toFixed(2)} m ${W - M} ${this.y.toFixed(2)} l S`);
  }

  gap(h: number): void {
    this.y -= h;
  }
}

function formatDate(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

export async function renderReportPdf(r: PdfReport): Promise<Uint8Array> {
  const L = new Layout(r.colors);
  const { accent, text, text2 } = r.colors;

  // Header: logo (or firm name), then a thin accent rule.
  const logoH = 36;
  if (r.logo) {
    const w = Math.min(180, (r.logo.width / r.logo.height) * logoH);
    const h = (w / r.logo.width) * r.logo.height;
    L.page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${M} ${(L.y - h).toFixed(2)} cm /Im1 Do Q`);
    L.gap(logoH + 8);
  } else {
    L.gap(16);
    L.text(r.firm, M, L.y, 16, 'F2', accent);
    L.gap(10);
  }
  L.page.ops.push(`${rgb(accent)} rg ${M} ${(L.y - 3).toFixed(2)} ${CW} 3 re f`);
  L.gap(14);

  L.para(r.title, 22, 'F2', text, { lead: 28 });
  L.para(`Prepared for ${r.clientName} by ${r.firm} · ${formatDate(r.date, r.tz)}`, 10, 'F1', text2);
  if (r.intro?.trim()) {
    L.gap(8);
    L.para(plain(r.intro.trim()), 11, 'F1', text, { lead: 16 });
  }
  L.gap(12);
  L.para(`${r.items.length} opportunit${r.items.length === 1 ? 'y' : 'ies'}`, 9, 'F2', text2);
  L.gap(6);

  for (const item of r.items) {
    L.ensure(80);
    L.rule();
    L.gap(4);
    if (item.tag) L.para(TAG_LABEL[item.tag], 8, 'F2', accent, { lead: 14 });
    L.para(item.title, 13, 'F2', text, { lead: 18 });
    const facts = [item.funderName, amountLabel(item.amountMin, item.amountMax), item.deadlineAt ? `Deadline ${formatDate(item.deadlineAt, r.tz)}` : null].filter(Boolean).join('  ·  ');
    if (facts) L.para(facts, 10, 'F1', text2);
    if (item.note?.trim()) {
      L.gap(4);
      L.para(plain(item.note.trim()), 11, 'F1', text, { lead: 15 });
    }
    if (item.eligibility?.trim()) {
      L.gap(2);
      L.para(`Eligibility: ${plain(item.eligibility.trim())}`, 9, 'F1', text2, { lead: 13 });
    }
    if (item.url) L.para(item.url, 9, 'F1', accent, { lead: 13, link: item.url });
    L.gap(10);
  }

  // Objects: 1 catalog, 2 pages, 3–4 fonts, 5–6 logo (+ mask), then page + content pairs.
  const objects: (Uint8Array | string)[] = [];
  // push() returns the new length, which is the 1-based object number.
  const add = (o: Uint8Array | string) => objects.push(o);
  const stream = (dict: string, data: Uint8Array) => {
    const head = enc.encode(`<< ${dict} /Length ${data.length} >>\nstream\n`);
    const tail = enc.encode('\nendstream');
    const out = new Uint8Array(head.length + data.length + tail.length);
    out.set(head);
    out.set(data, head.length);
    out.set(tail, head.length + data.length);
    return out;
  };

  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // pages, filled below
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  let xobj = '';
  if (r.logo) {
    let smask = '';
    if (r.logo.alpha) {
      const m = add(stream(`/Type /XObject /Subtype /Image /Width ${r.logo.width} /Height ${r.logo.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, r.logo.alpha));
      smask = ` /SMask ${m} 0 R`;
    }
    const im = add(stream(`/Type /XObject /Subtype /Image /Width ${r.logo.width} /Height ${r.logo.height} ${r.logo.dict}${smask}`, r.logo.data));
    xobj = ` /XObject << /Im1 ${im} 0 R >>`;
  }

  const total = L.pages.length;
  const kids: number[] = [];
  for (const [i, page] of L.pages.entries()) {
    const footY = M - 6;
    page.ops.push(`BT /F1 8 Tf ${rgb(text2)} rg ${M} ${footY} Td ${lit(winAnsi(`${r.firm} · ${r.title}`.slice(0, 110)))} Tj ET`);
    const num = `Page ${i + 1} of ${total}`;
    page.ops.push(`BT /F1 8 Tf ${rgb(text2)} rg ${(W - M - textWidth(num, 8)).toFixed(2)} ${footY} Td ${lit(winAnsi(num))} Tj ET`);
    const content = add(stream('/Filter /FlateDecode', await deflate(enc.encode(page.ops.join('\n')))));
    const annots = page.links.map((l) =>
      add(`<< /Type /Annot /Subtype /Link /Rect [${l.rect.map((v) => v.toFixed(2)).join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${lit(winAnsi(l.uri))} >> >>`),
    );
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj} >> /Contents ${content} 0 R${
          annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''
        } >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${lit(winAnsi(r.title))} /Author ${lit(winAnsi(r.firm))} >>`);

  const header = enc.encode('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const parts: Uint8Array[] = [header];
  let offset = header.length;
  const offsets: number[] = [];
  for (const [i, o] of objects.entries()) {
    offsets.push(offset);
    const body = typeof o === 'string' ? enc.encode(o) : o;
    const chunk = [enc.encode(`${i + 1} 0 obj\n`), body, enc.encode('\nendobj\n')];
    for (const c of chunk) {
      parts.push(c);
      offset += c.length;
    }
  }
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(enc.encode(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
