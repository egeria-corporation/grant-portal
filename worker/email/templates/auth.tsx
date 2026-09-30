/**
 * Sign-in, setup, invite and new-device emails. Transactional and text-first:
 * no images beyond the logo, no tracking (spec §7.6). The text part is the
 * reference; the HTML part says the same thing with the brand around it.
 */
import { A, Code, Cta, H, Layout, P, type EmailBrand } from './brand';
import { renderHtml, type Rendered } from './render';

export async function signInEmail(brand: EmailBrand, p: { link: string; code: string; minutes: number }): Promise<Rendered> {
  const subject = `Sign in to ${brand.firm}`;
  const text = [
    `Use this link to sign in to ${brand.firm}. It works once and expires in ${p.minutes} minutes.`,
    `Sign in:\n${p.link}`,
    'Or enter this code on the sign-in page:',
    p.code,
    "If you didn't ask to sign in, you can ignore this email. Nobody can sign in without this link or code.",
  ].join('\n\n');
  const html = await renderHtml(
    <Layout brand={brand} preview={`Your sign-in code is ${p.code}`}>
      <H brand={brand}>Sign in</H>
      <P brand={brand}>
        Use this button to sign in to {brand.firm}. It works once and expires in {p.minutes} minutes.
      </P>
      <Cta brand={brand} href={p.link}>
        Sign in
      </Cta>
      <P brand={brand}>Or enter this code on the sign-in page:</P>
      <Code brand={brand}>{p.code}</Code>
      <P brand={brand} muted>
        If you didn’t ask to sign in, you can ignore this email. Nobody can sign in without this link or code.
      </P>
    </Layout>,
  );
  return { subject, text, html };
}

export async function setupEmail(brand: EmailBrand, p: { link: string; code: string; minutes: number }): Promise<Rendered> {
  const subject = 'Claim your client portal';
  const text = [
    `Use this link to finish setting up your client portal. It works once and expires in ${p.minutes} minutes.`,
    `Claim this portal:\n${p.link}`,
    'Or enter this code in the setup screen:',
    p.code,
    "If you didn't start setting up a portal, ignore this email.",
  ].join('\n\n');
  const html = await renderHtml(
    <Layout brand={brand} preview="Finish setting up your client portal">
      <H brand={brand}>Claim your client portal</H>
      <P brand={brand}>Use this button to finish setting up your client portal. It works once and expires in {p.minutes} minutes.</P>
      <Cta brand={brand} href={p.link}>
        Claim this portal
      </Cta>
      <P brand={brand}>Or enter this code in the setup screen:</P>
      <Code brand={brand}>{p.code}</Code>
      <P brand={brand} muted>
        If you didn’t start setting up a portal, ignore this email.
      </P>
    </Layout>,
  );
  return { subject, text, html };
}

export async function inviteEmail(brand: EmailBrand, p: { link: string; inviter: string | null; hours: number }): Promise<Rendered> {
  const who = p.inviter ? `${p.inviter} invited you` : 'You have been invited';
  const subject = `${who} to ${brand.firm}`;
  const text = [
    `${who} to ${brand.firm}. There is no password to set up: this link signs you in.`,
    `Open ${brand.firm}:\n${p.link}`,
    `The link works once and expires in ${p.hours} hours. After that, sign in with your email address.`,
  ].join('\n\n');
  const html = await renderHtml(
    <Layout brand={brand} preview={`${who} to ${brand.firm}`}>
      <H brand={brand}>{who}</H>
      <P brand={brand}>There’s no password to set up: this button signs you in to {brand.firm}.</P>
      <Cta brand={brand} href={p.link}>
        Open {brand.firm}
      </Cta>
      <P brand={brand} muted>
        The link works once and expires in {p.hours} hours. After that, sign in with your email address.
      </P>
    </Layout>,
  );
  return { subject, text, html };
}

export async function newDeviceEmail(brand: EmailBrand, p: { device: string; when: string; securityUrl: string }): Promise<Rendered> {
  const subject = `New sign-in to ${brand.firm}`;
  const text = [
    `Your account was just used to sign in from a new device: ${p.device}, ${p.when}.`,
    'If this was you, there is nothing to do.',
    `If it wasn't you, review your sessions and sign out everywhere:\n${p.securityUrl}`,
  ].join('\n\n');
  const html = await renderHtml(
    <Layout brand={brand} preview={`New sign-in: ${p.device}`}>
      <H brand={brand}>New sign-in</H>
      <P brand={brand}>
        Your account was just used to sign in from a new device: {p.device}, {p.when}.
      </P>
      <P brand={brand}>If this was you, there’s nothing to do.</P>
      <P brand={brand}>
        <A brand={brand} href={p.securityUrl}>
          If it wasn’t you, review your sessions and sign out everywhere
        </A>
      </P>
    </Layout>,
  );
  return { subject, text, html };
}

/**
 * Sent whenever a passkey is added. A passkey outlives every session ("sign
 * out everywhere" included), so one planted from a stolen session must not go
 * unnoticed. The passkey's label is typed by whoever added it, so it stays out.
 */
export async function passkeyAddedEmail(brand: EmailBrand, p: { device: string; when: string; securityUrl: string }): Promise<Rendered> {
  const subject = `Passkey added to your ${brand.firm} account`;
  const text = [
    `A passkey was just added to your account from ${p.device}, ${p.when}. It can be used to sign in to ${brand.firm}.`,
    'If this was you, there is nothing to do.',
    `If it wasn't you, remove the passkey, then sign out everywhere. Signing out doesn't remove passkeys.\n${p.securityUrl}`,
  ].join('\n\n');
  const html = await renderHtml(
    <Layout brand={brand} preview={`Passkey added: ${p.device}`}>
      <H brand={brand}>Passkey added</H>
      <P brand={brand}>
        A passkey was just added to your account from {p.device}, {p.when}. It can be used to sign in to {brand.firm}.
      </P>
      <P brand={brand}>If this was you, there’s nothing to do.</P>
      <P brand={brand}>If it wasn’t you, remove the passkey, then sign out everywhere. Signing out doesn’t remove passkeys.</P>
      <Cta brand={brand} href={p.securityUrl}>
        Review your passkeys
      </Cta>
    </Layout>,
  );
  return { subject, text, html };
}
