/**
 * Theme building blocks from docs/design/boards/01-foundations.html: neutral
 * temperatures, status colors, radius and density presets, heading fonts.
 * `themeCss()` turns a brand's choices into the semantic CSS variables every
 * component uses (spec §8.2). Values are copied from the boards, not invented.
 */
import { accentRamp, type AccentTokens, type Mode, normalizeHex } from './ramp';

export const NEUTRALS = ['cool', 'neutral', 'warm'] as const;
export const RADII = ['sharp', 'soft', 'round'] as const;
export const DENSITIES = ['comfortable', 'compact'] as const;
export const HEADINGS = ['sans', 'serif-a', 'serif-b', 'custom'] as const;

export type Neutral = (typeof NEUTRALS)[number];
export type Radius = (typeof RADII)[number];
export type Density = (typeof DENSITIES)[number];
export type Heading = (typeof HEADINGS)[number];

export interface ThemeInput {
  accent: string;
  neutral: Neutral;
  radius: Radius;
  density: Density;
  heading: Heading;
  /** Same-origin URL of an uploaded WOFF2 heading font (heading = 'custom'). */
  headingFontUrl?: string | null;
}

type Vars = Record<string, string>;

const NEUTRAL_VARS: Record<Neutral, Record<Mode, Vars>> = {
  cool: {
    light: { bg: '#f6faff', raised: '#fcfeff', overlay: '#fcfeff', sunken: '#f1f5fa', hover: '#f1f5fa', active: '#e8edf1', border: '#e0e4e9', border2: '#d4dae0', text: '#1a1e22', text2: '#5c6167', text3: '#6a6f75', binput: '#8d9398', ink: '#0e1217', skel: '#e8edf1' },
    dark: { bg: '#0e1217', raised: '#1a1e22', overlay: '#22272c', sunken: '#080c10', hover: '#22272c', active: '#2d3237', border: '#272c31', border2: '#34383e', text: '#f1f5fa', text2: '#b9bec5', text3: '#898f95', binput: '#656a6f', ink: '#080c10', skel: '#22272c' },
  },
  neutral: {
    light: { bg: '#f9f9f9', raised: '#fdfdfd', overlay: '#fdfdfd', sunken: '#f4f4f4', hover: '#f4f4f4', active: '#ececec', border: '#e4e4e4', border2: '#d9d9d9', text: '#1d1d1d', text2: '#606060', text3: '#6e6e6e', binput: '#929292', ink: '#121212', skel: '#ececec' },
    dark: { bg: '#121212', raised: '#1d1d1d', overlay: '#262626', sunken: '#0c0c0c', hover: '#262626', active: '#313131', border: '#2b2b2b', border2: '#383838', text: '#f4f4f4', text2: '#bebebe', text3: '#8e8e8e', binput: '#696969', ink: '#0c0c0c', skel: '#262626' },
  },
  warm: {
    light: { bg: '#fcf9f4', raised: '#fffdfb', overlay: '#fffdfb', sunken: '#f7f4ef', hover: '#f7f4ef', active: '#efebe7', border: '#e7e3df', border2: '#ddd8d2', text: '#201d18', text2: '#64605a', text3: '#726e68', binput: '#95918b', ink: '#15110d', skel: '#efebe7' },
    dark: { bg: '#15110d', raised: '#201d18', overlay: '#2a2621', sunken: '#0e0b07', hover: '#2a2621', active: '#35312c', border: '#2e2b26', border2: '#3b3732', text: '#f7f4ef', text2: '#c2bdb6', text3: '#948f89', binput: '#6d6964', ink: '#0e0b07', skel: '#2a2621' },
  },
};

/** System status colors (the design's default set). Brands don't change these. */
export const STATUS_VARS: Record<Mode, Vars> = {
  light: {
    ok: '#20a04e', 'ok-bg': '#e0f7e4', 'ok-text': '#006e30', 'ok-bd': '#b1dfb9',
    warn: '#f5a420', 'warn-bg': '#fff0de', 'warn-text': '#86580f', 'warn-bd': '#eeca9f',
    danger: '#ce5249', 'danger-bg': '#feebe8', 'danger-text': '#a7463e', 'danger-bd': '#fcc0b8',
    info: '#1a83db', 'info-bg': '#e6f2fe', 'info-text': '#1666aa', 'info-bd': '#afd5fe',
  },
  dark: {
    ok: '#4cb86a', 'ok-bg': '#1a321f', 'ok-text': '#89d298', 'ok-bd': '#295233',
    warn: '#f8ac3d', 'warn-bg': '#392710', 'warn-text': '#eab26b', 'warn-bd': '#5f4117',
    danger: '#e66f64', 'danger-bg': '#3f221f', 'danger-text': '#fda297', 'danger-bd': '#683833',
    info: '#4ba3f7', 'info-bg': '#192d41', 'info-text': '#8bc3fd', 'info-bd': '#284a6c',
  },
};

export const RADIUS_VARS: Record<Radius, Vars> = {
  sharp: { 'r-xs': '2px', 'r-sm': '2px', 'r-md': '3px', 'r-lg': '4px', 'r-card': '4px', 'r-btn': '3px', 'r-pill': '3px', 'r-av': '3px' },
  soft: { 'r-xs': '4px', 'r-sm': '6px', 'r-md': '8px', 'r-lg': '12px', 'r-card': '12px', 'r-btn': '8px', 'r-pill': '999px', 'r-av': '999px' },
  round: { 'r-xs': '6px', 'r-sm': '10px', 'r-md': '14px', 'r-lg': '20px', 'r-card': '20px', 'r-btn': '999px', 'r-pill': '999px', 'r-av': '999px' },
};

export const DENSITY_VARS: Record<Density, Vars> = {
  comfortable: { 'row-h': '52px', 'cell-x': '16px', 'fs-row': '14px', 'gap-row': '12px' },
  compact: { 'row-h': '34px', 'cell-x': '10px', 'fs-row': '13px', 'gap-row': '8px' },
};

const SERIF_FALLBACK = "'Iowan Old Style',Georgia,serif";
export const HEADING_VARS: Record<Heading, Vars> = {
  sans: { 'font-head': "'Geist Variable','Geist',ui-sans-serif,system-ui,sans-serif", 'head-w': '600', 'head-ls': '-0.022em' },
  'serif-a': { 'font-head': `'Source Serif 4 Variable','Source Serif 4',${SERIF_FALLBACK}`, 'head-w': '500', 'head-ls': '-0.01em' },
  'serif-b': { 'font-head': `'Newsreader Variable','Newsreader',${SERIF_FALLBACK}`, 'head-w': '500', 'head-ls': '-0.012em' },
  custom: { 'font-head': `'Brand Heading',${SERIF_FALLBACK}`, 'head-w': '500', 'head-ls': '-0.01em' },
};

export const HEADING_LABELS: Record<Heading, string> = {
  sans: 'Geist (sans)',
  'serif-a': 'Source Serif',
  'serif-b': 'Newsreader',
  custom: 'Uploaded font',
};

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

function accentVars(a: AccentTokens): Vars {
  return {
    'acc-brand': a.brand,
    'acc-a50': a.a50,
    'acc-a100': a.a100,
    'acc-a200': a.a200,
    'acc-a300': a.a300,
    'acc-solid': a.solid,
    'acc-solidh': a.solidh,
    'acc-on': a.on,
    'acc-text': a.text,
    'acc-focus': a.focus,
    'acc-ring': a.ring,
  };
}

/** Variables that don't change between light and dark: radius, density, heading font. */
export function sharedVars(input: ThemeInput): Vars {
  return { ...RADIUS_VARS[input.radius], ...DENSITY_VARS[input.density], ...HEADING_VARS[input.heading] };
}

/** Every semantic variable for one mode. */
export function modeVars(input: ThemeInput, mode: Mode): Vars {
  const n = NEUTRAL_VARS[input.neutral][mode];
  const shadows: Vars =
    mode === 'light'
      ? {
          scrim: `rgba(${rgb(n.ink as string)},0.32)`,
          shadow: `0 1px 2px rgba(${rgb(n.text as string)},0.04), 0 0 0 1px rgba(${rgb(n.text as string)},0.02)`,
          pop: `0 16px 40px -12px rgba(${rgb(n.ink as string)},0.22), 0 4px 12px -4px rgba(${rgb(n.ink as string)},0.08), 0 0 0 1px rgba(${rgb(n.ink as string)},0.06)`,
        }
      : {
          scrim: `rgba(${rgb(n.ink as string)},0.6)`,
          shadow: '0 0 0 1px rgba(0,0,0,0.2)',
          pop: '0 20px 48px -12px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
        };
  const surfaces = [n.bg, n.raised, n.overlay, n.sunken, n.hover] as string[];
  return { ...n, ...shadows, knob: '#ffffff', ...accentVars(accentRamp(input.accent, mode, { surfaces })), ...STATUS_VARS[mode] };
}

const block = (vars: Vars) =>
  Object.entries(vars)
    .map(([k, v]) => `--${k}:${v};`)
    .join('');

/** Only characters that can appear in our own URLs; anything else is dropped. */
const safeUrl = (u: string) => (/^\/[A-Za-z0-9/_.?=&-]+$/.test(u) ? u : null);

export function themeCss(input: ThemeInput): string {
  const accent = normalizeHex(input.accent) ?? '#5b4fd6';
  const t = { ...input, accent };
  const shared = sharedVars(t);
  const light = modeVars(t, 'light');
  const dark = modeVars(t, 'dark');
  const font = t.heading === 'custom' && t.headingFontUrl ? safeUrl(t.headingFontUrl) : null;
  return [
    font ? `@font-face{font-family:'Brand Heading';src:url(${font}) format('woff2');font-display:swap;font-weight:100 900;}` : '',
    `:root{color-scheme:light;${block(shared)}${block(light)}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${block(dark)}}}`,
    `:root[data-theme="dark"]{color-scheme:dark;${block(dark)}}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The three sample firms from the design (boards 01 and 03). Used by the
 * kitchen sink, the contrast tests, and as wizard starting points.
 */
export type SampleBrand = 'northwind' | 'bloom' | 'evergreen';

export const SAMPLE_BRANDS: Record<SampleBrand, { name: string; short: string; theme: ThemeInput }> = {
  northwind: { name: 'Northwind Grant Partners', short: 'Northwind', theme: { accent: '#1E3A5F', neutral: 'cool', radius: 'sharp', density: 'comfortable', heading: 'serif-a' } },
  bloom: { name: 'Bloom Funding Studio', short: 'Bloom', theme: { accent: '#E8604C', neutral: 'warm', radius: 'round', density: 'comfortable', heading: 'sans' } },
  evergreen: { name: 'Evergreen Capital Advisors', short: 'Evergreen', theme: { accent: '#2F6B4F', neutral: 'neutral', radius: 'soft', density: 'comfortable', heading: 'serif-b' } },
};

export const DEFAULT_THEME: ThemeInput = { accent: '#5b4fd6', neutral: 'neutral', radius: 'soft', density: 'comfortable', heading: 'sans' };
