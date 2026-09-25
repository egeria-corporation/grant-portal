/**
 * CLAUDE.md: "No hardcoded colors in components — only semantic tokens."
 * Scans app source for literal colors in styling positions. Token definitions
 * (app/styles/tokens.css) and data values (e.g. a color picker's fallback)
 * are not styling and are allowed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = join(ROOT, 'app');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC = /\b(?:rgba?|hsla?|oklch|lab|lch)\(\s*\d/;

describe('no literal colors in components', () => {
  it('Tailwind classes never use arbitrary color values', () => {
    const offenders: string[] = [];
    for (const f of walk(APP).filter((p) => /\.(tsx?|css)$/.test(p))) {
      const src = readFileSync(f, 'utf8');
      const m = src.match(/\b(?:bg|text|border|fill|stroke|outline|ring|from|via|to|decoration|caret|accent|divide)-\[(?:#|rgb|hsl|oklch)[^\]]*\]/g);
      if (m) offenders.push(`${relative(ROOT, f)}: ${m.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('style props never set literal colors', () => {
    const offenders: string[] = [];
    for (const f of walk(APP).filter((p) => p.endsWith('.tsx'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/style=\{\{([^}]*)\}\}/g)) {
        if (HEX.test(m[1] ?? '') || FUNC.test(m[1] ?? '')) offenders.push(`${relative(ROOT, f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('stylesheets other than the token definitions contain no literal colors', () => {
    const offenders: string[] = [];
    for (const f of walk(join(APP, 'styles')).filter((p) => p.endsWith('.css') && !p.endsWith('tokens.css'))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (HEX.test(line) || FUNC.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
