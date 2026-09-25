/** Sign-in, setup, invite, and new-device emails. Text-first; see render.ts. */
import { render, type Rendered } from './render';

export function signInEmail(p: { firm: string; link: string; code: string; minutes: number }): Rendered {
  return render(`Sign in to ${p.firm}`, [
    { p: `Use this link to sign in to ${p.firm}. It works once and expires in ${p.minutes} minutes.` },
    { link: { href: p.link, label: 'Sign in' } },
    { p: 'Or enter this code on the sign-in page:' },
    { code: p.code },
    { small: "If you didn't ask to sign in, you can ignore this email. Nobody can sign in without this link or code." },
  ]);
}

export function setupEmail(p: { link: string; code: string; minutes: number }): Rendered {
  return render(`Claim your client portal`, [
    { p: `Use this link to finish setting up your client portal. It works once and expires in ${p.minutes} minutes.` },
    { link: { href: p.link, label: 'Claim this portal' } },
    { p: 'Or enter this code in the setup screen:' },
    { code: p.code },
    { small: "If you didn't start setting up a portal, ignore this email." },
  ]);
}

export function inviteEmail(p: { firm: string; link: string; inviter: string | null; hours: number }): Rendered {
  const who = p.inviter ? `${p.inviter} invited you` : 'You have been invited';
  return render(`${who} to ${p.firm}`, [
    { p: `${who} to ${p.firm}. There is no password to set up: this link signs you in.` },
    { link: { href: p.link, label: `Open ${p.firm}` } },
    { small: `The link works once and expires in ${p.hours} hours. After that, sign in with your email address.` },
  ]);
}

export function newDeviceEmail(p: { firm: string; device: string; when: string; securityUrl: string }): Rendered {
  return render(`New sign-in to ${p.firm}`, [
    { p: `Your account was just used to sign in from a new device: ${p.device}, ${p.when}.` },
    { p: 'If this was you, there is nothing to do.' },
    { link: { href: p.securityUrl, label: "If it wasn't you, review your sessions and sign out everywhere" } },
  ]);
}
