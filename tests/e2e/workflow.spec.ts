/**
 * M3 critical path: a consultant creates a client, requests three documents
 * and sends a draft for review; the client accepts the invite, uploads the
 * three documents, and approves the draft. Runs after wizard.spec.ts, which
 * claims the portal as OWNER.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { OWNER, signInWithCode } from './helpers';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const DOCS = ['Latest Form 990', 'W-9', 'Board of directors list'];

async function contrast(page: Page) {
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).exclude('[disabled]').analyze();
  return results.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1] ?? ''}`));
}

test('client uploads three documents and approves a deliverable', async ({ page, browser }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });

  // Consultant side.
  await signInWithCode(page, OWNER);
  await expect(page).toHaveURL(/\/workspace$/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: 'New client' }).click();
  await page.getByLabel('Organization name').fill('Harbor Arts Collective');
  await page.getByLabel('Main contact’s email (optional)').fill('dana@harborarts.example');
  await page.getByText('Give me a link to send myself instead of emailing').click();
  await page.getByRole('button', { name: 'Create client' }).click();
  const invite = await page.getByLabel('Invite link').inputValue();
  expect(invite).toMatch(/\/auth\/verify\?t=/);
  await page.getByRole('link', { name: 'Open client' }).click();
  await expect(page.getByRole('heading', { name: 'Harbor Arts Collective' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Documents' }).click();
  await page.getByRole('link', { name: 'Request documents' }).first().click();
  await page.getByLabel('Title').fill('For the arts council application');
  for (const doc of DOCS) await page.getByRole('button', { name: `+ ${doc}` }).click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('heading', { name: 'For the arts council application' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Deliverables' }).click();
  await page.getByRole('button', { name: 'New deliverable' }).click();
  await page.getByLabel('Title').fill('Program narrative');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('link', { name: 'Program narrative' }).click();
  await page.getByRole('button', { name: 'Add the first version' }).click();
  await page.getByRole('radio', { name: 'Link' }).click();
  await page.getByLabel('Link').fill('https://docs.example.org/narrative-v1');
  await page.getByLabel('Note (optional)').fill('First full draft.');
  await page.getByRole('button', { name: 'Send for review' }).click();
  await expect(page.getByText('Waiting on client')).toBeVisible();

  // Client side, in a separate browser context (a different person).
  const clientCtx = await browser.newContext();
  const client = await clientCtx.newPage();
  client.on('console', (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });
  await client.goto(invite);
  await client.getByRole('button', { name: 'Continue' }).click();
  await expect(client).toHaveURL(/\/portal$/);
  await expect(client.getByRole('heading', { name: 'Harbor Arts Collective' })).toBeVisible();
  await expect(client.getByText('3 documents to upload')).toBeVisible();
  await expect(client.getByText('Review: Program narrative')).toBeVisible();
  expect(await contrast(client)).toEqual([]);

  await client.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents' }).click();
  for (const doc of DOCS) {
    const chooser = client.waitForEvent('filechooser');
    await client.getByRole('button', { name: `Upload ${doc}` }).click();
    await (await chooser).setFiles({ name: `${doc}.pdf`, mimeType: 'application/pdf', buffer: PDF });
    await expect(client.getByRole('button', { name: `Upload ${doc}` })).toBeHidden();
  }
  await expect(client.getByText('Complete', { exact: true })).toBeVisible();
  await expect(client.getByRole('link', { name: 'W-9.pdf', exact: true }).first()).toBeVisible();
  expect(await contrast(client)).toEqual([]);

  await client.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Deliverables' }).click();
  await client.getByRole('link', { name: 'Program narrative' }).click();
  await expect(client.getByText('First full draft.')).toBeVisible();
  await client.getByRole('button', { name: 'Approve' }).click();
  await expect(client.getByText(/Approved by/)).toBeVisible();
  await clientCtx.close();

  // Back on the consultant side: the uploads and the approval are on the timeline.
  await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Timeline' }).click();
  await expect(page.getByText(/approved v1 of Program narrative/)).toBeVisible();
  await expect(page.getByText(/completed For the arts council application/)).toBeVisible();
  expect(violations).toEqual([]);
});
