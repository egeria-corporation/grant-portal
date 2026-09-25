/**
 * Passkeys (WebAuthn) for staff (spec §7.1) via SimpleWebAuthn. Discoverable
 * credentials with user verification required, so a passkey is both a
 * possession and a biometric/PIN factor. The RP ID is the request's hostname:
 * passkeys made on *.workers.dev won't work on a custom domain (docs/security.md).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { AppEnv, AuthUser } from '../env';
import { HttpError } from '../lib/http';
import { newId } from '../lib/ids';

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface Relying {
  rpID: string;
  origin: string;
  rpName: string;
}

export function relyingParty(req: Request, rpName: string): Relying {
  const url = new URL(req.url);
  return { rpID: url.hostname, origin: url.origin, rpName };
}

async function storeChallenge(env: AppEnv, challenge: string, purpose: 'register' | 'authenticate', userId: string | null) {
  const id = newId('wac');
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, challenge, purpose, userId, now + CHALLENGE_TTL_MS, now)
    .run();
  return id;
}

/** Atomic single use; registration challenges are bound to the user who asked for them. */
async function takeChallenge(env: AppEnv, id: string, purpose: 'register' | 'authenticate', userId: string | null) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE webauthn_challenges SET used_at = ?
      WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? AND user_id IS ?
      RETURNING challenge`,
  )
    .bind(now, id, purpose, now, userId)
    .first<{ challenge: string }>();
  if (!row) throw new HttpError(400, 'challenge_invalid');
  return row.challenge;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: ArrayBuffer | number[];
  sign_count: number;
  transports: string | null;
}

const bytes = (v: ArrayBuffer | number[]): Uint8Array<ArrayBuffer> =>
  Array.isArray(v) ? new Uint8Array(v) : new Uint8Array(v);

const parseTransports = (t: string | null): AuthenticatorTransportFuture[] | undefined =>
  t ? (JSON.parse(t) as AuthenticatorTransportFuture[]) : undefined;

export async function registrationOptions(env: AppEnv, rp: Relying, user: AuthUser) {
  const existing = await env.DB.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?')
    .bind(user.id)
    .all<{ credential_id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    userID: new Uint8Array(new TextEncoder().encode(user.id)),
    attestationType: 'none',
    excludeCredentials: existing.results.map((r) => ({ id: r.credential_id, transports: parseTransports(r.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = await storeChallenge(env, options.challenge, 'register', user.id);
  return { challengeId, options };
}

export async function verifyRegistration(
  env: AppEnv,
  rp: Relying,
  user: AuthUser,
  challengeId: string,
  response: RegistrationResponseJSON,
  label: string | null,
): Promise<{ id: string }> {
  const expectedChallenge = await takeChallenge(env, challengeId, 'register', user.id);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch {
    throw new HttpError(400, 'passkey_invalid');
  }
  if (!verification.verified) throw new HttpError(400, 'passkey_invalid');
  const { credential } = verification.registrationInfo;
  const id = newId('pk');
  const res = await env.DB.prepare(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, sign_count, transports, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (credential_id) DO NOTHING`,
  )
    .bind(
      id,
      user.id,
      credential.id,
      credential.publicKey,
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      label,
      Date.now(),
    )
    .run();
  if (!res.meta.changes) throw new HttpError(409, 'passkey_exists');
  return { id };
}

export async function authenticationOptions(env: AppEnv, rp: Relying) {
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required' });
  const challengeId = await storeChallenge(env, options.challenge, 'authenticate', null);
  return { challengeId, options };
}

/** Returns the user id the assertion proves. */
export async function verifyAuthentication(
  env: AppEnv,
  rp: Relying,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<string> {
  const expectedChallenge = await takeChallenge(env, challengeId, 'authenticate', null);
  const pk = await env.DB.prepare(
    'SELECT id, user_id, credential_id, public_key, sign_count, transports FROM passkeys WHERE credential_id = ?',
  )
    .bind(response.id)
    .first<PasskeyRow>();
  if (!pk) throw new HttpError(400, 'passkey_invalid');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: pk.credential_id,
        publicKey: bytes(pk.public_key),
        counter: pk.sign_count,
        transports: parseTransports(pk.transports),
      },
    });
  } catch {
    throw new HttpError(400, 'passkey_invalid');
  }
  if (!verification.verified) throw new HttpError(400, 'passkey_invalid');
  await env.DB.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?')
    .bind(verification.authenticationInfo.newCounter, Date.now(), pk.id)
    .run();
  return pk.user_id;
}
