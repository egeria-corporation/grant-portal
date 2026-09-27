/**
 * The OpenGrants client is generated from the committed OpenAPI spec and must
 * never call a path the spec doesn't have (CLAUDE.md non-negotiable 5).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM script without type declarations
import { generate } from '../../scripts/gen-opengrants.mjs';

const file = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

describe('generated client', () => {
  it('is up to date with the committed OpenAPI spec', () => {
    const spec = JSON.parse(file('worker/integrations/opengrants/openapi.json')) as { paths: Record<string, Record<string, { operationId: string }>> };
    expect((generate as (s: unknown) => string)(spec)).toBe(file('worker/integrations/opengrants/client.gen.ts'));
  });

  it('only calls paths that are in the spec', () => {
    const spec = JSON.parse(file('worker/integrations/opengrants/openapi.json')) as { paths: Record<string, unknown> };
    const code = file('worker/integrations/opengrants/client.gen.ts');
    const used = [...code.matchAll(/http\.request\("[A-Z]+", `([^`]+)`/g)].map((m) => (m[1] ?? '').replace(/\$\{encodeURIComponent\((\w+)\)\}/g, '{$1}'));
    expect(used.length).toBeGreaterThan(0);
    for (const p of used) expect(Object.keys(spec.paths)).toContain(p);
  });
});
