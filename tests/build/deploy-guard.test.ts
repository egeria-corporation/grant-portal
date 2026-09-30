/**
 * `npm run deploy` must never ship a development build: the E2E run leaves
 * dist/ built with APP_ENV=development (dev outbox, dev-only endpoints), and
 * `wrangler deploy` uploads whatever dist/ holds. scripts/check-deploy.mjs runs
 * as the `predeploy` hook and refuses.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deployProblem } from '../../scripts/check-deploy.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project directory laid out the way `vite build` leaves it. */
function built(vars: Record<string, string> | undefined, configPath = '../../dist/grant_portal/wrangler.json'): string {
  const root = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
  dirs.push(root);
  mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
  mkdirSync(join(root, 'dist', 'grant_portal'), { recursive: true });
  writeFileSync(join(root, '.wrangler', 'deploy', 'config.json'), JSON.stringify({ configPath, auxiliaryWorkers: [] }));
  writeFileSync(join(root, 'dist', 'grant_portal', 'wrangler.json'), JSON.stringify({ name: 'portal', vars }));
  return root;
}

describe('predeploy guard', () => {
  it('is wired to run before every `npm run deploy`', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.predeploy).toBe('node scripts/check-deploy.mjs');
  });

  it('allows a production build, whichever path separator the plugin wrote', () => {
    expect(deployProblem(built({ APP_ENV: 'production' }))).toBeNull();
    expect(deployProblem(built({ APP_ENV: 'production' }, '..\\..\\dist\\grant_portal\\wrangler.json'))).toBeNull();
  });

  it('refuses the development build the E2E run leaves behind', () => {
    expect(deployProblem(built({ APP_ENV: 'development', OPENGRANTS_DAILY_LIMIT: '25' }))).toMatch(/APP_ENV=development/);
    expect(deployProblem(built(undefined))).toMatch(/APP_ENV=\(unset\)/);
  });

  it('refuses when there is no build at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
    dirs.push(root);
    expect(deployProblem(root)).toMatch(/npm run build/);
  });
});
