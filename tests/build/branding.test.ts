/**
 * Non-negotiable #3: no maintainer branding in anything a client or consultant
 * sees. The product's placeholder name may live only in README/repo metadata
 * and infrastructure names (wrangler.jsonc), never in the shipped client bundle
 * or email templates.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLIENT_DIST = join(ROOT, 'dist', 'client');
const EMAIL_TEMPLATES = join(ROOT, 'worker', 'email', 'templates');

/** Matches the placeholder product name in any casing/spacing: grant-portal, Grant Portal, grant_portal, GrantPortal. */
const PRODUCT_NAME = /grant[\s_-]*portal/i;

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.txt', '.svg', '.webmanifest', '.xml', '.tsx', '.ts']);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function offenders(files: string[]): string[] {
  return files
    .filter((f) => TEXT_EXTENSIONS.has(extname(f)))
    .filter((f) => PRODUCT_NAME.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f));
}

beforeAll(() => {
  execSync('npx vite build', { cwd: ROOT, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'production' } });
});

describe('no maintainer branding', () => {
  it('the pattern catches the placeholder name in its common forms', () => {
    for (const s of ['grant-portal', 'Grant Portal', 'grant_portal', 'GrantPortal', 'GRANT-PORTAL']) {
      expect(PRODUCT_NAME.test(s), s).toBe(true);
    }
    expect(PRODUCT_NAME.test('grant proposal portal')).toBe(false);
  });

  it('the built client bundle never mentions the product name', () => {
    const files = walk(CLIENT_DIST);
    expect(files.length, 'client build produced no files').toBeGreaterThan(0);
    expect(offenders(files)).toEqual([]);
  });

  it('email templates never mention the product name', () => {
    // The directory exists from M0; templates arrive in M4 and are covered automatically.
    expect(existsSync(EMAIL_TEMPLATES)).toBe(true);
    expect(offenders(walk(EMAIL_TEMPLATES))).toEqual([]);
  });

  it('the static public folder never mentions the product name', () => {
    expect(offenders(walk(join(ROOT, 'public')))).toEqual([]);
  });
});
