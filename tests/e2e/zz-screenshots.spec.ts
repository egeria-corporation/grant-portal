/**
 * README screenshots (spec §14): branded login, consultant home, client home.
 * Skipped unless SCREENSHOTS=1, so CI never rewrites them. Runs last (file
 * name order) to reuse the data the other specs create.
 *
 *   SCREENSHOTS=1 npm run test:e2e
 */
import { expect, test } from '@playwright/test';
import { OWNER, signInWithCode } from './helpers';

test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to refresh the README screenshots');

const out = (name: string) => `docs/screenshots/${name}.png`;

test('README screenshots', async ({ browser }) => {
  const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' as const };
  const login = await (await browser.newContext(desktop)).newPage();
  await login.goto('/signin');
  await expect(login.getByLabel('Email address')).toBeVisible();
  await login.screenshot({ path: out('login') });

  const staff = await (await browser.newContext(desktop)).newPage();
  await signInWithCode(staff, OWNER);
  await expect(staff).toHaveURL(/\/workspace$/);
  await staff.waitForLoadState('networkidle');
  // This test deployment is unconfigured (no verified domain, generated secrets, no
  // passkey), so Today shows setup prompts a configured portal doesn't. Hide them.
  await staff.evaluate(() => {
    for (const el of document.querySelectorAll('main > *')) {
      if (/SESSION_SECRET|sending domain|Turnstile|Sign in faster with a passkey/.test(el.textContent ?? '')) (el as HTMLElement).style.display = 'none';
    }
  });
  await staff.screenshot({ path: out('consultant-home') });

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' })).newPage();
  await signInWithCode(phone, 'dana@harborarts.example');
  await expect(phone).toHaveURL(/\/portal$/);
  await phone.waitForLoadState('networkidle');
  await phone.screenshot({ path: out('client-home') });
});
