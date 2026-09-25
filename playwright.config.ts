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
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Optional: point at a preinstalled Chromium instead of Playwright's download.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
      },
    },
  ],
  webServer: {
    // A fresh local state directory per run: the wizard test needs an unclaimed portal.
    command:
      `rm -rf .wrangler/e2e-state && PORTAL_E2E=1 npm run build && ` +
      `node scripts/d1-migrate.mjs --local --persist-to .wrangler/e2e-state && ` +
      `PORTAL_E2E=1 npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
