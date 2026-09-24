import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripJsonc } from '../../scripts/jsonc.mjs';

describe('stripJsonc', () => {
  it('parses wrangler.jsonc without mangling glob strings', () => {
    const cfg = JSON.parse(stripJsonc(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')));
    expect(cfg.d1_databases[0]).toMatchObject({ binding: 'DB', database_name: 'grant-portal-db' });
    expect(cfg.assets.run_worker_first).toEqual(['/*', '!/assets/*', '!/fonts/*']);
    expect(cfg.triggers.crons).toEqual(['*/15 * * * *', '0 13 * * *']);
  });

  it('keeps comment-like text inside strings', () => {
    expect(JSON.parse(stripJsonc('{"a": "x // y /* z */", /* c */ "b": 1, // d\n}'))).toEqual({
      a: 'x // y /* z */',
      b: 1,
    });
  });
});
