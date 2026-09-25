/**
 * M1 critical path: fresh deploy → claim by email → wizard → demo client →
 * Owner in the workspace → sign out → sign back in with the emailed code.
 * Emails are read from the local dev outbox (APP_ENV=development in E2E).
 */
import { expect, type APIRequestContext, test } from '@playwright/test';

interface Mail {
  to: string;
  subject: string;
  text: string;
}

async function lastMailTo(request: APIRequestContext, to: string): Promise<Mail> {
  let found: Mail | undefined;
  await expect
    .poll(async () => {
      const { messages } = (await (await request.get('/api/dev/outbox')).json()) as { messages: Mail[] };
      found = [...messages].reverse().find((m) => m.to === to);
      return Boolean(found);
    })
    .toBe(true);
  return found as Mail;
}

const OWNER = 'owner@example.org';

test('fresh deploy: claim, finish the wizard, land in the workspace, sign in again', async ({ page, context }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });

  // 1. A fresh deploy sends the first visitor to the wizard.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Claim this portal' })).toBeVisible();

  await page.getByLabel('Your email').fill(OWNER);
  await page.getByRole('button', { name: 'Email me a setup link' }).click();
  await expect(page.getByText(/Sent to/)).toBeVisible();

  // 2. Opening the emailed link shows the interstitial; only Continue signs in.
  const setupMail = await lastMailTo(page.request, OWNER);
  const link = /https?:\/\/\S+\/auth\/verify\?t=[A-Za-z0-9_-]+/.exec(setupMail.text)?.[0];
  expect(link).toBeTruthy();
  await page.goto(link ?? '');
  await expect(page.getByRole('heading', { name: 'Claim this portal' })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/verify$/); // token removed from the address bar
  await page.getByRole('button', { name: 'Continue' }).click();

  // 3. Brand.
  await expect(page.getByRole('heading', { name: 'Your brand' })).toBeVisible();
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === '__Host-session');
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

  await page.getByLabel('Firm name').fill('Northwind Grants');
  await page.getByLabel('Accent color', { exact: true }).fill('#1f5fad');
  await page.getByLabel('Welcome line for clients').fill('Welcome to Northwind.');
  await expect(page.getByText(/passes WCAG AA/)).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // 4–6. Optional steps.
  for (const heading of ['Email sender', 'Custom domain', 'Funding discovery', 'Invite your team']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
  }

  // 7. Demo client.
  await expect(page.getByRole('heading', { name: 'Add your first client' })).toBeVisible();
  await page.getByRole('button', { name: 'Load a demo client' }).click();

  // 8. Live.
  await expect(page.getByRole('heading', { name: 'Your portal is live' })).toBeVisible();
  await expect(page.getByLabel('Client sign-in address')).toHaveValue(/\/signin$/);
  await page.getByRole('button', { name: 'Go to your workspace' }).click();

  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByText(`Signed in as ${OWNER}`)).toBeVisible();
  await expect(page.getByText('Sample: Riverbend Community Pantry')).toBeVisible();
  await expect(page.getByText('Client invites and emails are paused')).toBeVisible();
  expect(await page.title()).toBe('Northwind Grants');

  // Sign out, then back in with the 6-digit code.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Welcome to Northwind.')).toBeVisible();
  await page.getByLabel('Email address').fill(OWNER);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const signInMail = await lastMailTo(page.request, OWNER);
  expect(signInMail.subject).toBe('Sign in to Northwind Grants');
  const code = /\n(\d{6})\n/.exec(signInMail.text)?.[1] ?? '';
  await page.getByLabel(/6-digit code/).fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  expect(violations).toEqual([]);
});
