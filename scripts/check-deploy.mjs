#!/usr/bin/env node
/**
 * Runs before `npm run deploy` (npm's `predeploy` hook). `wrangler deploy`
 * uploads whatever the last `vite build` left in dist/, and the E2E run builds
 * dist/ for development (APP_ENV=development: local email outbox, dev-only
 * endpoints). Refuse to deploy unless the build wrangler will upload was made
 * for production. The Deploy button runs `npm run build` first, so it passes.
 *
 *   node scripts/check-deploy.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Why the build in `root` must not be deployed, or null when it can be. */
export function deployProblem(root) {
  // The Cloudflare Vite plugin points `wrangler deploy` at its generated config.
  const redirect = resolve(root, '.wrangler/deploy/config.json');
  if (!existsSync(redirect)) return 'No build to deploy. Run `npm run build` first.';
  const { configPath } = JSON.parse(readFileSync(redirect, 'utf8'));
  const config = resolve(dirname(redirect), String(configPath).replace(/\\/g, '/'));
  if (!existsSync(config)) return 'No build to deploy. Run `npm run build` first.';
  const appEnv = JSON.parse(readFileSync(config, 'utf8')).vars?.APP_ENV;
  if (appEnv !== 'production') {
    return `dist/ was built with APP_ENV=${appEnv ?? '(unset)'}, not production (the E2E run builds for development). Run \`npm run build\`, then deploy again.`;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problem = deployProblem(fileURLToPath(new URL('..', import.meta.url)));
  if (problem) {
    console.error(`Refusing to deploy: ${problem}`);
    process.exit(1);
  }
}
