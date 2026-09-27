/** Shared E2E helpers: the local dev outbox and signing in with the emailed code. */
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** The Owner the wizard test claims the portal as; later specs sign in as them. */
export const OWNER = 'owner@example.org';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export async function lastMailTo(request: APIRequestContext, to: string, after = 0): Promise<Mail> {
  let found: Mail | undefined;
  await expect
    .poll(async () => {
      const { messages } = (await (await request.get('/api/dev/outbox')).json()) as { messages: Mail[] };
      found = messages.slice(after).reverse().find((m) => m.to === to);
      return Boolean(found);
    })
    .toBe(true);
  return found as Mail;
}

export async function outboxSize(request: APIRequestContext): Promise<number> {
  const { messages } = (await (await request.get('/api/dev/outbox')).json()) as { messages: Mail[] };
  return messages.length;
}

export async function signInWithCode(page: Page, email: string): Promise<void> {
  const before = await outboxSize(page.request);
  await page.goto('/signin');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const mail = await lastMailTo(page.request, email, before);
  const code = /\n(\d{6})\n/.exec(mail.text)?.[1] ?? '';
  await page.getByLabel(/6-digit code/).fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
