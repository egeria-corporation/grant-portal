/**
 * Activity, reminder, update and digest emails (spec §9 template set). Each
 * returns a text part (the reference) and branded HTML. Links go to portal
 * pages, never to files (spec §7.4). No tracking pixels or rewritten links.
 */
import { A, Cta, H, Layout, List, P, Rule, type EmailBrand } from './brand';
import { renderHtml, type Rendered } from './render';

export interface Footer {
  /** One-click unsubscribe for this category (non-transactional mail only). */
  unsubscribeUrl?: string | null;
  /** Where the recipient manages notification settings. */
  settingsUrl?: string | null;
  reason: string;
}

function footerText(f: Footer): string {
  const lines = [f.reason];
  if (f.settingsUrl) lines.push(`Notification settings: ${f.settingsUrl}`);
  if (f.unsubscribeUrl) lines.push(`Unsubscribe: ${f.unsubscribeUrl}`);
  return lines.join('\n');
}

function FooterLinks({ brand, f }: { brand: EmailBrand; f: Footer }) {
  return (
    <>
      {f.reason}
      {f.settingsUrl ? (
        <>
          {' · '}
          <A brand={brand} href={f.settingsUrl}>
            Notification settings
          </A>
        </>
      ) : null}
      {f.unsubscribeUrl ? (
        <>
          {' · '}
          <A brand={brand} href={f.unsubscribeUrl}>
            Unsubscribe
          </A>
        </>
      ) : null}
    </>
  );
}

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join('\n\n');

export function formatDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(ms);
}

// ---------------------------------------------------------------------------

export async function documentRequestEmail(
  brand: EmailBrand,
  p: { title: string; message: string | null; items: string[]; dueAt: number | null; tz: string; url: string | null; footer: Footer },
): Promise<Rendered> {
  const due = p.dueAt ? ` by ${formatDay(p.dueAt, p.tz)}` : '';
  const subject = `${brand.firm} needs ${p.items.length === 1 ? 'a document' : `${p.items.length} documents`}${due}`;
  const text = join(
    `${brand.firm} asked for the following${due}:`,
    p.items.map((i) => `- ${i}`).join('\n'),
    p.message,
    p.url ? `Upload them here:\n${p.url}` : null,
    footerText(p.footer),
  );
  const html = await renderHtml(
    <Layout brand={brand} preview={p.title} footer={<FooterLinks brand={brand} f={p.footer} />}>
      <H brand={brand}>{p.title}</H>
      <P brand={brand}>
        {brand.firm} asked for the following{due}:
      </P>
      <List brand={brand} items={p.items.map((title) => ({ title }))} />
      {p.message ? <P brand={brand}>{p.message}</P> : null}
      {p.url ? (
        <Cta brand={brand} href={p.url}>
          Upload documents
        </Cta>
      ) : null}
    </Layout>,
  );
  return { subject, text, html };
}

export type ReminderKind = 'documents' | 'approval' | 'deadline';

export async function reminderEmail(
  brand: EmailBrand,
  p: { kind: ReminderKind; title: string; lines: { title: string; detail?: string }[]; dueAt: number | null; overdue: boolean; tz: string; url: string | null; footer: Footer },
): Promise<Rendered> {
  const when = p.dueAt ? formatDay(p.dueAt, p.tz) : null;
  const subject =
    p.kind === 'documents'
      ? p.overdue
        ? `Overdue: ${p.title}`
        : `Reminder: ${p.title}${when ? ` (due ${when})` : ''}`
      : p.kind === 'approval'
        ? `Waiting for your review: ${p.title}`
        : `Deadline ${when ? `${when}: ` : ''}${p.title}`;
  const lead =
    p.kind === 'documents'
      ? p.overdue
        ? `These documents for ${brand.firm} are past due${when ? ` (${when})` : ''}:`
        : `A reminder: ${brand.firm} still needs these${when ? ` by ${when}` : ''}:`
      : p.kind === 'approval'
        ? `${p.title} is ready for your review.`
        : `The deadline for ${p.title} is ${when ?? 'coming up'}.`;
  const action = p.kind === 'documents' ? 'Upload documents' : p.kind === 'approval' ? 'Review it' : 'Open the portal';
  const text = join(lead, p.lines.length ? p.lines.map((l) => `- ${l.title}${l.detail ? ` (${l.detail})` : ''}`).join('\n') : null, p.url ? `${action}:\n${p.url}` : null, footerText(p.footer));
  const html = await renderHtml(
    <Layout brand={brand} preview={lead} footer={<FooterLinks brand={brand} f={p.footer} />}>
      <H brand={brand}>{subject}</H>
      <P brand={brand}>{lead}</P>
      {p.lines.length ? <List brand={brand} items={p.lines} /> : null}
      {p.url ? (
        <Cta brand={brand} href={p.url}>
          {action}
        </Cta>
      ) : null}
    </Layout>,
  );
  return { subject, text, html };
}

export async function reviewRequestedEmail(brand: EmailBrand, p: { title: string; version: number; note: string | null; from: string; url: string | null; footer: Footer }): Promise<Rendered> {
  const subject = `Ready for your review: ${p.title} (v${p.version})`;
  const text = join(`${p.from} shared version ${p.version} of ${p.title} for your review.`, p.note ? `“${p.note}”` : null, p.url ? `Review it:\n${p.url}` : null, footerText(p.footer));
  const html = await renderHtml(
    <Layout brand={brand} preview={`${p.from} shared v${p.version} of ${p.title}`} footer={<FooterLinks brand={brand} f={p.footer} />}>
      <H brand={brand}>{p.title}</H>
      <P brand={brand}>
        {p.from} shared version {p.version} for your review.
      </P>
      {p.note ? (
        <P brand={brand} muted>
          “{p.note}”
        </P>
      ) : null}
      {p.url ? (
        <Cta brand={brand} href={p.url}>
          Review it
        </Cta>
      ) : null}
    </Layout>,
  );
  return { subject, text, html };
}

export async function decisionEmail(
  brand: EmailBrand,
  p: { title: string; version: number; decision: 'approved' | 'changes'; comment: string | null; by: string; url: string | null; footer: Footer },
): Promise<Rendered> {
  const approved = p.decision === 'approved';
  const subject = approved ? `Approved: ${p.title}` : `Changes requested: ${p.title}`;
  const lead = approved ? `${p.by} approved version ${p.version} of ${p.title}.` : `${p.by} asked for changes to version ${p.version} of ${p.title}.`;
  const text = join(lead, p.comment ? `“${p.comment}”` : null, p.url ? `Open it:\n${p.url}` : null, footerText(p.footer));
  const html = await renderHtml(
    <Layout brand={brand} preview={lead} footer={<FooterLinks brand={brand} f={p.footer} />}>
      <H brand={brand}>{subject}</H>
      <P brand={brand}>{lead}</P>
      {p.comment ? <P brand={brand}>“{p.comment}”</P> : null}
      {p.url ? (
        <Cta brand={brand} href={p.url}>
          Open it
        </Cta>
      ) : null}
    </Layout>,
  );
  return { subject, text, html };
}

export async function newMessageEmail(brand: EmailBrand, p: { from: string; about: string | null; preview: string; attachments: number; url: string | null; footer: Footer }): Promise<Rendered> {
  const subject = `New message from ${p.from}${p.about ? ` about ${p.about}` : ''}`;
  const extra = p.attachments ? `${p.attachments} attachment${p.attachments === 1 ? '' : 's'}` : null;
  // v1 doesn't process email replies (spec §5.8), so say so.
  const text = join(`${p.from} wrote:`, p.preview, extra, p.url ? `Reply in the portal:\n${p.url}` : null, 'Replies to this email are not delivered.', footerText(p.footer));
  const html = await renderHtml(
    <Layout brand={brand} preview={p.preview.slice(0, 120)} footer={<FooterLinks brand={brand} f={p.footer} />}>
      <H brand={brand}>{p.from} sent you a message</H>
      <P brand={brand}>{p.preview}</P>
      {extra ? (
        <P brand={brand} muted>
          {extra}
        </P>
      ) : null}
      {p.url ? (
        <Cta brand={brand} href={p.url}>
          Reply in the portal
        </Cta>
      ) : null}
      <P brand={brand} muted>
        Replies to this email are not delivered.
      </P>
    </Layout>,
  );
  return { subject, text, html };
}

export interface UpdateBlock {
  kind: 'deadlines' | 'opportunities' | 'documents' | 'wins';
  title: string;
  items: { title: string; detail?: string }[];
  empty: string;
}

export async function updateEmail(brand: EmailBrand, p: { subject: string; intro: string | null; blocks: UpdateBlock[]; url: string | null; footer: Footer }): Promise<Rendered> {
  const text = join(
    p.intro,
    ...p.blocks.map((b) => `${b.title}\n${b.items.length ? b.items.map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ''}`).join('\n') : b.empty}`),
    p.url ? `Open your portal:\n${p.url}` : null,
    footerText(p.footer),
  );
  const html = await renderHtml(
    <Layout brand={brand} preview={p.intro?.slice(0, 120) ?? p.subject} footer={<FooterLinks brand={brand} f={p.footer} />}>
      <H brand={brand}>{p.subject}</H>
      {p.intro ? <P brand={brand}>{p.intro}</P> : null}
      {p.blocks.map((b) => (
        <div key={b.kind}>
          <Rule brand={brand} />
          <P brand={brand}>
            <strong>{b.title}</strong>
          </P>
          {b.items.length ? (
            <List brand={brand} items={b.items} />
          ) : (
            <P brand={brand} muted>
              {b.empty}
            </P>
          )}
        </div>
      ))}
      {p.url ? (
        <Cta brand={brand} href={p.url}>
          Open your portal
        </Cta>
      ) : null}
    </Layout>,
  );
  return { subject: p.subject, text, html };
}

export interface DigestGroup {
  client: string;
  items: { title: string; detail?: string }[];
}

export async function digestEmail(brand: EmailBrand, p: { period: 'daily' | 'weekly'; groups: DigestGroup[]; url: string | null; footer: Footer }): Promise<Rendered> {
  const count = p.groups.reduce((n, g) => n + g.items.length, 0);
  const subject = `Your ${p.period} summary from ${brand.firm}: ${count} update${count === 1 ? '' : 's'}`;
  const multi = p.groups.length > 1;
  const text = join(
    `Here's what happened ${p.period === 'daily' ? 'since yesterday' : 'this week'}.`,
    ...p.groups.map((g) => `${multi ? `${g.client}\n` : ''}${g.items.map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ''}`).join('\n')}`),
    p.url ? `Open the portal:\n${p.url}` : null,
    footerText(p.footer),
  );
  const html = await renderHtml(
    <Layout brand={brand} preview={`${count} update${count === 1 ? '' : 's'}`} footer={<FooterLinks brand={brand} f={p.footer} />}>
      <H brand={brand}>Your {p.period} summary</H>
      <P brand={brand}>Here’s what happened {p.period === 'daily' ? 'since yesterday' : 'this week'}.</P>
      {p.groups.map((g) => (
        <div key={g.client}>
          {multi ? (
            <P brand={brand}>
              <strong>{g.client}</strong>
            </P>
          ) : null}
          <List brand={brand} items={g.items} />
        </div>
      ))}
      {p.url ? (
        <Cta brand={brand} href={p.url}>
          Open the portal
        </Cta>
      ) : null}
    </Layout>,
  );
  return { subject, text, html };
}
