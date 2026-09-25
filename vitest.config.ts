import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        // API / security tests run inside workerd with real local D1, KV, R2, Queues.
        plugins: [
          cloudflareTest(async () => ({
            main: './worker/index.ts',
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: {
                APP_ENV: 'test',
                TEST_MIGRATIONS: await readD1Migrations(root('./migrations')),
              },
              assets: { directory: root('./tests/fixtures/assets'), binding: 'ASSETS' },
            },
          })),
        ],
        define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
        resolve: { alias: { '@shared': root('./shared') } },
        test: {
          name: 'worker',
          include: ['tests/worker/**/*.test.ts'],
          setupFiles: ['./tests/worker/setup.ts'],
        },
      },
      {
        // Pure functions (theme ramp, sanitizers) that don't need the Workers runtime.
        resolve: { alias: { '@shared': root('./shared') } },
        test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        // Node-side checks over build output and source (e.g. no maintainer branding).
        test: {
          name: 'build',
          environment: 'node',
          include: ['tests/build/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
