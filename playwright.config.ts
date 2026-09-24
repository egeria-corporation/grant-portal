import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * E2E runs against `vite preview`, i.e. the production build inside workerd
 * with local D1/KV/R2 — the same artifact `wrangler deploy` uploads.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run db:migrate:local && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
