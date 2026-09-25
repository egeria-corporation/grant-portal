/**
 * Accent ramp (spec §8.1): from one brand color, build the accent tokens for
 * light or dark mode, nudging the solid and text shades until they meet WCAG
 * AA. A faithful port of `calc()` in docs/design/boards/01-foundations.html
 * (OKLCH with gamut clipping). tests/worker/theme.test.ts checks it reproduces
 * the design's Northwind / Bloom / Evergreen / Custom token tables exactly.
 */
export type Mode = 'light' | 'dark';

export interface AccentTokens {
  brand: string;
  a50: string;
  a100: string;
  a200: string;
  a300: string;
  solid: string;
  solidh: string;
  on: string;
  text: string;
  focus: string;
  ring: string;
  /** Contrast of `on` text over `solid`. */
  contrast: number;
  /** True when `solid` had to move away from the brand color to pass AA. */
  adjusted: boolean;
}

type Vec = [number, number, number];

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const delin = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export function normalizeHex(hex: string): string | null {
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(h) ? `#${h.toLowerCase()}` : null;
}

function hexToLinear(hex: string): Vec {
  const n = parseInt((normalizeHex(hex) ?? '#5b4fd6').slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => lin(v / 255)) as Vec;
}

function toLch([r, g, b]: Vec): Vec {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function rawRgb(L: number, C: number, H: number): Vec {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** In-gamut color at (L, C, H), reducing chroma until it fits sRGB. */
function inGamut(L: number, C: number, H: number): Vec {
  let c = C;
  for (let i = 0; i < 60; i++) {
    const v = rawRgb(L, c, H);
    if (v.every((x) => x >= -0.0005 && x <= 1.0005)) return v.map(clamp01) as Vec;
    c *= 0.92;
  }
  return rawRgb(L, 0, H).map(clamp01) as Vec;
}

const toHex = (v: Vec) => '#' + v.map((x) => Math.round(delin(clamp01(x)) * 255).toString(16).padStart(2, '0')).join('');
const luminance = (v: Vec) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

function ratio(a: Vec, b: Vec): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** WCAG contrast ratio between two hex colors. */
export function contrast(a: string, b: string): number {
  return ratio(hexToLinear(a), hexToLinear(b));
}

const WHITE: Vec = [1, 1, 1];

const quantize = (v: Vec): Vec => hexToLinear(toHex(v));

export interface RampOptions {
  /**
   * Extra surfaces the accent text must reach 4.5:1 on (e.g. the brand's raised
   * and sunken neutrals). The design's `calc()` only checks the page
   * background; passing the real surfaces keeps links AA on cards too.
   */
  surfaces?: string[];
}

export function accentRamp(hex: string, mode: Mode, opts: RampOptions = {}): AccentTokens {
  const base = hexToLinear(hex);
  const [L, C, H] = toLch(base);
  const bg = hexToLinear(mode === 'dark' ? '#121212' : '#f9f9f9');
  const ink = hexToLinear('#121212');
  const ok = inGamut;
  const t: Partial<AccentTokens> = { brand: '#' + hex.replace('#', '') };

  if (mode !== 'dark') {
    t.a50 = toHex(ok(0.975, Math.min(C, 0.12) * 0.22, H));
    t.a100 = toHex(ok(0.945, C * 0.34, H));
    t.a200 = toHex(ok(0.895, C * 0.5, H));
    t.a300 = toHex(ok(0.82, C * 0.66, H));
    if (ratio(base, ink) >= 4.5 && L > 0.72) {
      t.solid = t.brand;
      t.on = '#121212';
      t.solidh = toHex(ok(L - 0.04, C, H));
    } else {
      let s = L;
      while (ratio(ok(s, C, H), WHITE) < 4.5 && s > 0.15) s -= 0.004;
      t.solid = toHex(ok(s, C, H));
      t.on = '#ffffff';
      t.solidh = toHex(ok(s - 0.05, C, H));
    }
    let x = L;
    while (ratio(ok(x, C, H), bg) < 4.6 && x > 0.1) x -= 0.004;
    t.text = toHex(ok(x, C, H));
  } else {
    t.a50 = toHex(ok(0.25, C * 0.22, H));
    t.a100 = toHex(ok(0.29, C * 0.32, H));
    t.a200 = toHex(ok(0.35, C * 0.42, H));
    t.a300 = toHex(ok(0.46, C * 0.58, H));
    let best: number | null = null;
    for (let i = 0; i <= 125; i++) {
      const x = 0.3 + i * 0.004;
      // Judge the color as it will ship: rounded to 8-bit hex.
      const s = quantize(ok(x, C, H));
      if (ratio(s, bg) >= 3 && ratio(s, WHITE) >= 4.5) {
        if (best === null || Math.abs(x - L) < Math.abs(best - L)) best = x;
      }
    }
    if (best !== null) {
      t.solid = toHex(ok(best, C, H));
      t.on = '#ffffff';
      // From the design's dark token table: hover lightens by 0.04, unless the
      // solid had to be darkened below the brand, in which case it darkens.
      t.solidh = toHex(ok(best < L ? best - 0.03 : best + 0.04, C, H));
    } else {
      let x = Math.max(L, 0.6);
      while ((ratio(ok(x, C, H), ink) < 4.5 || ratio(ok(x, C, H), bg) < 3) && x < 0.98) x += 0.004;
      t.solid = toHex(ok(x, C, H));
      t.on = '#121212';
      t.solidh = toHex(ok(x + 0.03, C, H));
    }
    let x = Math.max(L, 0.6);
    while (ratio(ok(x, C, H), bg) < 4.8 && x < 0.98) x += 0.004;
    t.text = toHex(ok(x, C, H));
  }

  // Final checks on the rounded hex values: 8-bit rounding can pull a
  // just-passing color under 4.5:1, and callers may add surfaces.
  const dir = mode === 'dark' ? 1 : -1;
  const [s0L, sC, sH] = toLch(hexToLinear(t.solid as string));
  let sL = s0L;
  const onV = hexToLinear(t.on as string);
  const solidDir = t.on === '#ffffff' ? -1 : 1;
  for (let i = 0; i < 200 && ratio(quantize(ok(sL, sC, sH)), onV) < 4.5; i++) sL += solidDir * 0.002;
  if (ratio(hexToLinear(t.solid as string), onV) < 4.5) t.solid = toHex(ok(sL, sC, sH));

  // With real surfaces supplied, accent text must also read on its own tints
  // (the "Recommended" pill: acc-text on acc-a100; selected rows on a50).
  const tints = opts.surfaces ? [t.a50 as string, t.a100 as string] : [];
  const surfaces = [mode === 'dark' ? '#121212' : '#f9f9f9', ...(opts.surfaces ?? []), ...tints].map(hexToLinear);
  const [x0L, xC, xH] = toLch(hexToLinear(t.text as string));
  let xL = x0L;
  const textOk = (v: Vec) => surfaces.every((sf) => ratio(v, sf) >= 4.5);
  if (!textOk(hexToLinear(t.text as string))) {
    for (let i = 0; i < 400 && !textOk(quantize(ok(xL, xC, xH))); i++) xL += dir * 0.002;
    t.text = toHex(ok(xL, xC, xH));
  }

  const text = t.text as string;
  const solid = t.solid as string;
  const on = t.on as string;
  const tl = hexToLinear(text).map((v) => Math.round(delin(v) * 255));
  return {
    ...(t as AccentTokens),
    focus: text,
    ring: `rgba(${tl.join(',')},${mode === 'dark' ? 0.38 : 0.28})`,
    contrast: Math.round(ratio(hexToLinear(solid), hexToLinear(on)) * 100) / 100,
    adjusted: solid.toLowerCase() !== (t.brand as string).toLowerCase(),
  };
}
