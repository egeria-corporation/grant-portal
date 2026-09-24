/**
 * ULIDs (spec §11): 48-bit ms timestamp + 80 bits of randomness, Crockford base32.
 * Monotonic within an isolate so IDs minted in the same millisecond still sort.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 base32 chars.
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

function increment(bytes: Uint8Array): Uint8Array {
  const next = new Uint8Array(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] === 255) {
      next[i] = 0;
    } else {
      next[i] = (next[i] ?? 0) + 1;
      return next;
    }
  }
  throw new Error('ULID random component overflow');
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = now;
    lastRandom = crypto.getRandomValues(new Uint8Array(10));
  }
  return encodeTime(lastTime) + encodeRandom(lastRandom);
}

/** Prefixed IDs make logs and audit entries self-describing: `cli_01J…`. */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
