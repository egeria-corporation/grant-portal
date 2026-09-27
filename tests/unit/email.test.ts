/**
 * Email snapshots for the three sample brands (PLAN M4), plus the rules every
 * email follows: a plain-text part, no tracking pixels or remote resources
 * besides the firm's own logo, the brand's accent on the button, and the
 * firm's name (never the product's).
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_BRANDS, type SampleBrand } from '../../shared/theme/tokens';
import { inviteEmail, newDeviceEmail, signInEmail } from '../../worker/email/templates/auth';
import { sampleEmailBrand } from '../../worker/email/templates/brand';
import {
  decisionEmail,
  digestEmail,
  documentRequestEmail,
  newMessageEmail,
  reminderEmail,
  reviewRequestedEmail,
  updateEmail,
} from '../../worker/email/templates/notify';
import type { Rendered } from '../../worker/email/templates/render';

const DUE = Date.UTC(2027, 3, 15, 16);
const footer = { reason: 'You’re receiving this as a member of Riverbend Pantry.', settingsUrl: 'https://portal.example.org/portal/profile#notifications', unsubscribeUrl: 'https://portal.example.org/u/usr_x.activity.abc' };

const templates: Record<string, (b: ReturnType<typeof sampleEmailBrand>) => Promise<Rendered>> = {
  'sign-in': (b) => signInEmail(b, { link: 'https://portal.example.org/auth/verify?t=abc', code: '123456', minutes: 15 }),
  invite: (b) => inviteEmail(b, { link: 'https://portal.example.org/auth/verify?t=abc', inviter: 'Dana', hours: 72 }),
  'new-device': (b) => newDeviceEmail(b, { device: 'Chrome on macOS', when: 'Thu, 15 Apr 2027 16:00:00 GMT', securityUrl: 'https://portal.example.org/portal/security' }),
  'document-request': (b) =>
    documentRequestEmail(b, { title: 'For the arts council', message: 'The 2025 990, please.', items: ['Form 990', 'W-9'], dueAt: DUE, tz: 'America/Chicago', url: 'https://portal.example.org/portal/documents', footer: { reason: footer.reason, settingsUrl: footer.settingsUrl } }),
  reminder: (b) => reminderEmail(b, { kind: 'documents', title: 'For the arts council', lines: [{ title: 'W-9' }], dueAt: DUE, overdue: false, tz: 'America/Chicago', url: 'https://portal.example.org/portal/documents', footer }),
  'review-requested': (b) => reviewRequestedEmail(b, { title: 'Program narrative', version: 2, note: 'Tightened the outcomes section.', from: 'Dana', url: 'https://portal.example.org/portal/deliverables/dlv_x', footer }),
  'deliverable-approved': (b) => decisionEmail(b, { title: 'Program narrative', version: 2, decision: 'approved', comment: null, by: 'Sam', url: 'https://portal.example.org/workspace/clients/cli_x/deliverables/dlv_x', footer }),
  'new-message': (b) => newMessageEmail(b, { from: 'Dana', about: null, preview: 'Can you send the signed board list by Friday?', attachments: 1, url: 'https://portal.example.org/portal/messages', footer }),
  update: (b) =>
    updateEmail(b, {
      subject: 'Your April update',
      intro: 'Here’s where things stand.',
      blocks: [
        { kind: 'deadlines', title: 'Deadlines this month', items: [{ title: 'Budget narrative', detail: 'Apr 15' }], empty: 'None.' },
        { kind: 'wins', title: 'Wins', items: [], empty: 'More to come.' },
      ],
      url: 'https://portal.example.org/portal',
      footer,
    }),
  digest: (b) =>
    digestEmail(b, { period: 'daily', groups: [{ client: 'Riverbend Pantry', items: [{ title: 'Message from Dana', detail: 'See attached' }] }], url: 'https://portal.example.org/workspace', footer }),
};

for (const name of Object.keys(SAMPLE_BRANDS) as SampleBrand[]) {
  describe(`emails · ${name}`, () => {
    const brand = sampleEmailBrand(name);
    for (const [template, render] of Object.entries(templates)) {
      it(template, async () => {
        const out = await render(brand);
        expect(out.subject.length).toBeGreaterThan(0);
        expect(out.text.length).toBeGreaterThan(20);
        expect(out.html).toMatch(/^<!DOCTYPE html PUBLIC/);
        // No remote resources: no images (samples have no raster logo), stylesheets or scripts.
        expect(out.html).not.toMatch(/<img|<link|<script|url\(/i);
        expect(out.html).toContain(brand.firm.replace(/&/g, '&amp;'));
        if (/href="https:\/\/portal\.example\.org\/(auth|portal|workspace)/.test(out.html) && template !== 'new-device') {
          expect(out.html.toLowerCase()).toContain(brand.colors.accent.toLowerCase());
        }
        expect(out.html).not.toMatch(/grant-portal/i);
        await expect(`${out.subject}\n\n${out.text}\n\n${out.html}`).toMatchFileSnapshot(`./__snapshots__/email/${name}/${template}.txt`);
      });
    }
  });
}

it('escapes user-provided text in HTML', async () => {
  const out = await newMessageEmail(sampleEmailBrand('bloom'), { from: '<b>Eve</b>', about: null, preview: '<script>alert(1)</script>', attachments: 0, url: null, footer: { reason: 'x' } });
  expect(out.html).not.toContain('<script>');
  expect(out.html).toContain('&lt;script&gt;');
});
