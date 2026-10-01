/**
 * /assets/* and /fonts/* are served without running the Worker (D-004), so
 * the Worker can't add its security headers there, including to the
 * index.html that single-page-application mode returns for a missing file.
 * `public/_headers` must carry the same set, with the locked-down non-HTML CSP.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripJsonc } from '../../scripts/jsonc.mjs';
import { API_CSP, COMMON_HEADERS } from '../../worker/lib/header-values';

/** `_headers` rules: an unindented path line, then indented `Name: value` lines. `#` starts a comment. */
function parseHeaders(text: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = {};
      rules.set(line.trim(), current);
      continue;
    }
    const colon = line.indexOf(':');
    if (!current || colon < 0) throw new Error(`malformed _headers line: ${line}`);
    current[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return rules;
}

const rules = parseHeaders(readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8'));

describe('static asset headers', () => {
  it('match the headers the Worker sets on non-HTML responses', () => {
    expect(rules.get('/*')).toEqual({ ...COMMON_HEADERS, 'Content-Security-Policy': API_CSP });
  });

  it('cover every path that skips the Worker', () => {
    const cfg = JSON.parse(stripJsonc(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'))) as {
      assets: { run_worker_first: string[] };
    };
    const skipped = cfg.assets.run_worker_first.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
    expect(skipped.length).toBeGreaterThan(0);
    // One catch-all rule covers them all, and any path excluded later.
    expect([...rules.keys()]).toEqual(['/*']);
  });
});
