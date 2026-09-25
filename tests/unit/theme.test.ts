import { describe, expect, it } from 'vitest';
import { accentRamp, contrast, type Mode } from '../../shared/theme/ramp';
import { DENSITIES, HEADINGS, modeVars, NEUTRALS, RADII, SAMPLE_BRANDS, themeCss } from '../../shared/theme/tokens';

/** Token table copied verbatim from docs/design/boards/01-foundations.html (`toks()`). */
const DESIGN = {
  northwind: {
    light: { a50: '#f2f7ff', a100: '#e2eefe', a200: '#cddef5', a300: '#b0c6e4', solid: '#1E3A5F', solidh: '#112d51', on: '#ffffff', text: '#1E3A5F', ring: 'rgba(30,58,95,0.28)' },
    dark: { a50: '#1d2229', a100: '#242c37', a200: '#303b4b', a300: '#485970', solid: '#45628a', solidh: '#506e97', on: '#ffffff', text: '#6483ad', ring: 'rgba(100,131,173,0.38)' },
  },
  bloom: {
    light: { a50: '#fef4f2', a100: '#ffe7e2', a200: '#fdd0c8', a300: '#fcad9e', solid: '#cf4936', solidh: '#bd3827', on: '#ffffff', text: '#c94331', ring: 'rgba(201,67,49,0.28)' },
    dark: { a50: '#321a16', a100: '#43201a', a200: '#5b2a23', a300: '#874034', solid: '#cf4937', solidh: '#c53f2d', on: '#ffffff', text: '#e8604c', ring: 'rgba(232,96,76,0.38)' },
  },
  evergreen: {
    light: { a50: '#edfbf3', a100: '#def3e7', a200: '#c7e5d4', a300: '#a8cfb9', solid: '#2F6B4F', solidh: '#1f5d41', on: '#ffffff', text: '#2F6B4F', ring: 'rgba(47,107,79,0.28)' },
    dark: { a50: '#1a241f', a100: '#202f27', a200: '#2b4035', a300: '#416050', solid: '#306c50', solidh: '#3c785b', on: '#ffffff', text: '#538f71', ring: 'rgba(83,143,113,0.38)' },
  },
  custom: {
    light: { a50: '#f5f6ff', a100: '#e9ebfe', a200: '#d6d9fe', a300: '#b9befc', solid: '#5B4FD6', solidh: '#4f3ec5', on: '#ffffff', text: '#5B4FD6', ring: 'rgba(91,79,214,0.28)' },
    dark: { a50: '#1e1f36', a100: '#26274a', a200: '#333465', a300: '#4e4e96', solid: '#5b4fd6', solidh: '#655ce4', on: '#ffffff', text: '#766ff9', ring: 'rgba(118,111,249,0.38)' },
  },
} as const;

const ACCENTS = { northwind: '#1E3A5F', bloom: '#E8604C', evergreen: '#2F6B4F', custom: '#5B4FD6' } as const;

describe('accent ramp matches the design', () => {
  for (const [firm, modes] of Object.entries(DESIGN)) {
    for (const mode of ['light', 'dark'] as Mode[]) {
      it(`${firm} / ${mode}`, () => {
        const t = accentRamp(ACCENTS[firm as keyof typeof ACCENTS], mode);
        const expected = modes[mode];
        for (const [k, v] of Object.entries(expected)) {
          expect(String(t[k as keyof typeof t]).toLowerCase(), k).toBe(v.toLowerCase());
        }
      });
    }
  }
});

/** A spread of hard cases: near-white, near-black, pure primaries, neon, greys. */
const EXTREMES = [
  '#ffffff', '#000000', '#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ff0000', '#0000ff',
  '#f5f5dc', '#777777', '#808080', '#111111', '#fafafa', '#ffd700', '#7fffd4', '#39ff14',
  '#1e3a5f', '#e8604c', '#2f6b4f', '#5b4fd6', '#c0c0c0', '#8b4513', '#ffa500', '#4b0082',
];

describe('accent ramp always meets WCAG AA', () => {
  for (const hex of EXTREMES) {
    for (const mode of ['light', 'dark'] as Mode[]) {
      it(`${hex} / ${mode}`, () => {
        const t = accentRamp(hex, mode);
        const bg = mode === 'dark' ? '#121212' : '#f9f9f9';
        // Button text on the solid accent.
        expect(contrast(t.solid, t.on)).toBeGreaterThanOrEqual(4.5);
        // Accent-colored text (links) on the page background.
        expect(contrast(t.text, bg)).toBeGreaterThanOrEqual(4.5);
        if (mode === 'dark') expect(contrast(t.solid, bg)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe('every theme combination is AA across all neutral surfaces', () => {
  const combos = Object.values(SAMPLE_BRANDS).map((b) => b.theme);
  for (const theme of combos) {
    for (const neutral of NEUTRALS) {
      for (const mode of ['light', 'dark'] as Mode[]) {
        it(`${theme.accent} on ${neutral} / ${mode}`, () => {
          const v = modeVars({ ...theme, neutral }, mode);
          for (const surface of ['bg', 'raised', 'sunken']) {
            expect(contrast(v.text as string, v[surface] as string), `text on ${surface}`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(v.text2 as string, v[surface] as string), `text2 on ${surface}`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(v['acc-text'] as string, v[surface] as string), `acc-text on ${surface}`).toBeGreaterThanOrEqual(4.5);
          }
          for (const tint of ['acc-a50', 'acc-a100']) {
            expect(contrast(v['acc-text'] as string, v[tint] as string), `acc-text on ${tint}`).toBeGreaterThanOrEqual(4.5);
          }
          for (const s of ['ok', 'warn', 'danger', 'info']) {
            expect(contrast(v[`${s}-text`] as string, v[`${s}-bg`] as string), s).toBeGreaterThanOrEqual(4.5);
          }
          expect(contrast(v['acc-solid'] as string, v['acc-on'] as string)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

describe('themeCss', () => {
  it('emits light, system-dark and forced-dark blocks for every preset', () => {
    for (const radius of RADII)
      for (const density of DENSITIES)
        for (const heading of HEADINGS) {
          const css = themeCss({ accent: '#1e3a5f', neutral: 'cool', radius, density, heading });
          expect(css).toContain(':root{color-scheme:light;');
          expect(css).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme="light"])');
          expect(css).toContain(':root[data-theme="dark"]');
          expect(css).toContain('--acc-solid:');
        }
  });

  it('never lets a bad accent or font URL break out of the stylesheet', () => {
    const css = themeCss({
      accent: 'red;}body{display:none',
      neutral: 'neutral',
      radius: 'soft',
      density: 'compact',
      heading: 'custom',
      headingFontUrl: "/x) ;}*{background:url('https://evil.test/')",
    });
    expect(css).not.toContain('evil');
    expect(css).not.toContain('display:none');
    expect(css).not.toContain('@font-face');
    expect(css).toContain('--acc-brand:#5b4fd6');
  });
});
