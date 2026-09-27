/**
 * M3 critical path: a consultant creates a client, requests three documents
 * and sends a draft for review; the client accepts the invite, uploads the
 * three documents, and approves the draft. Runs after wizard.spec.ts, which
 * claims the portal as OWNER.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { lastMailTo, OWNER, outboxSize, signInWithCode } from './helpers';

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

  // M4: a branded update with live blocks, sent now, lands in the client's inbox.
  await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Updates' }).click();
  await page.getByRole('button', { name: 'New update' }).click();
  await page.getByLabel('Subject').fill('Your April update');
  await page.getByLabel('Message').fill('Thanks for the documents.');
  await expect(page.getByLabel('Preview').getByText('Documents we still need')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Send update' }).click();
  await expect(page.getByText('Sent', { exact: true })).toBeVisible();
  const mail = await lastMailTo(page.request, 'dana@harborarts.example');
  expect(mail.subject).toBe('Your April update');
  expect(mail.text).toContain('Thanks for the documents.');
  expect(violations).toEqual([]);
});

/**
 * M5 critical path, without OpenGrants: the consultant builds a funding report
 * by hand and sends it; the client pursues one opportunity and asks about
 * another; the pursued one lands on the pipeline.
 */
test('consultant sends a funding report; the client pursues an opportunity', async ({ page, browser }) => {
  await signInWithCode(page, OWNER);
  await expect(page).toHaveURL(/\/workspace$/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: 'Harbor Arts Collective' }).click();
  const tabs = page.getByRole('navigation', { name: 'Client sections' });

  await tabs.getByRole('link', { name: 'Funding' }).click();
  await expect(page.getByText(/OpenGrants, which isn’t connected/)).toBeVisible();

  await tabs.getByRole('link', { name: 'Reports' }).click();
  await page.getByRole('button', { name: 'New report' }).click();
  await page.getByLabel('Title').fill('Spring funding picks');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Spring funding picks' })).toBeVisible();

  for (const [title, funder] of [
    ['Youth arts access grant', 'City Arts Council'],
    ['Capacity building fund', 'Harbor Community Foundation'],
  ] as const) {
    await page.getByRole('radio', { name: 'By hand' }).click();
    const form = page.getByRole('region', { name: 'Add opportunities' });
    await form.getByLabel('Title').fill(title);
    await form.getByLabel('Funder').fill(funder);
    await form.getByLabel('Listing URL').fill('https://funder.example.org/listing');
    await form.getByLabel('Deadline').fill('2027-03-01');
    await form.getByLabel('Amount up to').fill('25000');
    await form.getByRole('button', { name: 'Add to report' }).click();
    await expect(page.getByRole('region', { name: 'Opportunities' }).getByText(title)).toBeVisible();
  }
  await page.getByLabel('Tag for Youth arts access grant').selectOption('recommended');
  await page.getByLabel('Your note on Youth arts access grant').fill('Strong fit: they fund youth arts in your county.');
  await page.getByLabel('Your note on Youth arts access grant').blur();
  await page.getByRole('button', { name: 'Move Capacity building fund up' }).click();
  await page.getByRole('radio', { name: 'Client preview' }).click();
  await expect(page.getByText('Strong fit: they fund youth arts in your county.')).toBeVisible();
  const before = await outboxSize(page.request);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/^Sent /)).toBeVisible();
  const mail = await lastMailTo(page.request, 'dana@harborarts.example', before);
  expect(mail.subject).toContain('Spring funding picks');

  // The client answers in the portal.
  const clientCtx = await browser.newContext();
  const client = await clientCtx.newPage();
  await signInWithCode(client, 'dana@harborarts.example');
  await expect(client).toHaveURL(/\/portal$/);
  await client.getByRole('link', { name: /Spring funding picks/ }).click();
  await expect(client.getByRole('heading', { name: 'Spring funding picks' })).toBeVisible();
  expect(await contrast(client)).toEqual([]);
  const cards = client.locator('article.opp');
  await expect(cards.first()).toContainText('Capacity building fund');
  const youth = cards.filter({ hasText: 'Youth arts access grant' });
  await youth.getByRole('button', { name: 'Pursue' }).click();
  await expect(youth.getByText(/You chose to pursue this/)).toBeVisible();
  const capacity = cards.filter({ hasText: 'Capacity building fund' });
  await capacity.getByRole('button', { name: 'Ask a question' }).click();
  await capacity.getByLabel(/Your question about/).fill('Does general operating support count?');
  await capacity.getByRole('button', { name: 'Send question' }).click();
  await expect(capacity.getByText(/You asked/)).toBeVisible();
  await client.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Funding' }).click();
  await expect(client.getByRole('region', { name: 'Researching' }).getByText('Youth arts access grant')).toBeVisible();
  expect(await contrast(client)).toEqual([]);
  await clientCtx.close();

  // The consultant sees the answers and the pipeline.
  await page.reload();
  await expect(page.getByText('“Does general operating support count?”')).toBeVisible();
  await tabs.getByRole('link', { name: 'Pipeline' }).click();
  await expect(page.getByRole('region', { name: 'Researching' }).getByText('Youth arts access grant')).toBeVisible();
});

/** WCAG 2.1 AA via axe: every rule, not just contrast. */
async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1] ?? ''}`));
}

/** M6: axe on every portal screen and the sign-in screens (PLAN M6), plus a render check of the Owner settings. */
test('portal and sign-in screens pass axe (WCAG 2.1 AA)', async ({ page, browser }) => {
  const anon = await (await browser.newContext()).newPage();
  await anon.goto('/signin');
  await expect(anon.getByLabel('Email address')).toBeVisible();
  expect(await axe(anon)).toEqual([]);
  await anon.getByLabel('Email address').fill('nobody@example.org');
  await anon.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(anon.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(await axe(anon)).toEqual([]);
  await anon.goto('/auth/verify?t=not-a-real-token');
  await expect(anon.locator('main, [role="main"], body').first()).toBeVisible();
  await anon.waitForLoadState('networkidle');
  expect(await axe(anon)).toEqual([]);

  const client = await (await browser.newContext()).newPage();
  await signInWithCode(client, 'dana@harborarts.example');
  await expect(client).toHaveURL(/\/portal$/);
  const nav = client.getByRole('navigation', { name: 'Main' });
  const screens: [string, () => Promise<void>][] = [
    ['home', async () => {}],
    ['documents', () => nav.getByRole('link', { name: 'Documents' }).click()],
    ['deliverables', () => nav.getByRole('link', { name: 'Deliverables' }).click()],
    ['deliverable', () => client.getByRole('link', { name: 'Program narrative' }).click()],
    ['funding', () => nav.getByRole('link', { name: 'Funding' }).click()],
    ['report', () => client.getByRole('link', { name: /Spring funding picks/ }).click()],
    ['messages', () => nav.getByRole('link', { name: 'Messages' }).click()],
    ['updates', () => nav.getByRole('link', { name: 'Updates' }).click()],
    ['profile', () => nav.getByRole('link', { name: 'Profile' }).click()],
    ['security', () => nav.getByRole('link', { name: 'Security' }).click()],
  ];
  for (const [name, go] of screens) {
    await go();
    await client.waitForLoadState('networkidle');
    await expect(client.locator('h1').first(), name).toBeVisible();
    expect(await axe(client), name).toEqual([]);
  }

  // Owner settings screens render.
  await signInWithCode(page, OWNER);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  for (const [tab, heading] of [
    ['Security', 'Security'],
    ['Team', 'Team'],
    ['Audit log', 'Audit log'],
    ['Data', 'Data'],
    ['Brand', 'Brand'],
  ] as const) {
    await tabs.getByRole('link', { name: tab }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
});
