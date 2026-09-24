import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, randomToken, sha256Hex, timingSafeEqual } from '../../worker/lib/crypto';
import { ulid } from '../../worker/lib/ids';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

describe('field encryption (AES-GCM)', () => {
  it('round-trips and never emits plaintext', async () => {
    const ct = await encryptField(KEY_A, '12-3456789', 'clients.ein:cli_1');
    expect(ct).toMatch(/^v1\.[0-9a-f]{12}\.[\w-]+\.[\w-]+$/);
    expect(ct).not.toContain('3456789');
    expect(await decryptField([KEY_A], ct, 'clients.ein:cli_1')).toBe('12-3456789');
  });

  it('uses a fresh IV each time', async () => {
    const a = await encryptField(KEY_A, 'same', 'x');
    const b = await encryptField(KEY_A, 'same', 'x');
    expect(a).not.toBe(b);
  });

  it('refuses ciphertext moved to another row (AAD mismatch)', async () => {
    const ct = await encryptField(KEY_A, '12-3456789', 'clients.ein:cli_1');
    await expect(decryptField([KEY_A], ct, 'clients.ein:cli_2')).rejects.toThrow();
  });

  it('refuses tampered ciphertext', async () => {
    const ct = await encryptField(KEY_A, '12-3456789', 'aad');
    const parts = ct.split('.');
    const body = parts[3] ?? '';
    parts[3] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    await expect(decryptField([KEY_A], parts.join('.'), 'aad')).rejects.toThrow();
  });

  it('picks the right key by id among several', async () => {
    const ct = await encryptField(KEY_B, 'secret', 'aad');
    expect(await decryptField([KEY_A, KEY_B], ct, 'aad')).toBe('secret');
    await expect(decryptField([KEY_A], ct, 'aad')).rejects.toThrow(/No key/);
  });
});

describe('tokens and hashing', () => {
  it('makes 256-bit url-safe tokens', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('ulid', () => {
  it('is 26 Crockford base32 chars and sorts by creation', () => {
    const ids = Array.from({ length: 1000 }, () => ulid());
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
