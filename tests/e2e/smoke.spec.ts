import { expect, test } from '@playwright/test';

test('healthz is ok', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok', checks: { db: 'ok' } });
});

test('the SPA boots under the strict CSP with no violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });

  const res = await page.goto('/signin');
  expect(res?.headers()['content-security-policy']).toContain("'strict-dynamic'");

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(violations).toEqual([]);
});

test('deep links fall back to the SPA', async ({ page }) => {
  await page.goto('/this/does/not/exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
