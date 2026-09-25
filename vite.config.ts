import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * E2E runs (PORTAL_E2E=1, set by playwright.config.ts) use their own local
 * state directory, so each run is a fresh, unclaimed deploy, and APP_ENV=
 * development so emails go to the local outbox the tests read. Normal builds
 * are unaffected.
 */
const e2e = process.env.PORTAL_E2E === '1';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './app/routes',
      generatedRouteTree: './app/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
    cloudflare(
      e2e ? { persistState: { path: '.wrangler/e2e-state' }, config: { vars: { APP_ENV: 'development', OPENGRANTS_DAILY_LIMIT: '25' } } } : {},
    ),
  ],
  // Placeholder replaced per request by the Worker (worker/html.ts). Vite also
  // reads it from <meta property="csp-nonce"> for tags it injects at runtime.
  html: { cspNonce: 'CSP_NONCE' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./app', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    sourcemap: false,
  },
});
