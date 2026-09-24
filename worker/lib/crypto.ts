/** Small WebCrypto helpers. No dependencies. */
const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Random opaque token, URL-safe. 32 bytes = 256 bits (spec §7.1). */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Constant-time comparison for equal-length strings (hashes, tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Field encryption (spec §7.5): AES-256-GCM with a key derived by HKDF from the
// data-encryption secret. Ciphertext format: `v1.<kid>.<iv>.<ct>` (base64url).
// `kid` identifies the secret so data survives moving a generated key into a
// Worker secret, and so decryption can pick among several known keys.
// ---------------------------------------------------------------------------

const FIELD_INFO = enc.encode('field-encryption/v1');

export async function keyId(secret: string): Promise<string> {
  return (await sha256Hex(`kid:${secret}`)).slice(0, 12);
}

async function fieldKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: FIELD_INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** `aad` binds the ciphertext to its location (e.g. `clients.ein_enc:<clientId>`). */
export async function encryptField(secret: string, plaintext: string, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    await fieldKey(secret),
    enc.encode(plaintext),
  );
  return ['v1', await keyId(secret), toBase64Url(iv), toBase64Url(ct)].join('.');
}

export async function decryptField(secrets: string[], ciphertext: string, aad: string): Promise<string> {
  const [version, kid, ivPart, ctPart] = ciphertext.split('.');
  if (version !== 'v1' || !kid || !ivPart || !ctPart) throw new Error('Unrecognised ciphertext format');
  for (const secret of secrets) {
    if ((await keyId(secret)) !== kid) continue;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(ivPart), additionalData: enc.encode(aad) },
      await fieldKey(secret),
      fromBase64Url(ctPart),
    );
    return dec.decode(pt);
  }
  throw new Error('No key available for this ciphertext');
}
