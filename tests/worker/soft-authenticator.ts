/**
 * A tiny software WebAuthn authenticator (ES256, "none" attestation) so the
 * passkey flows can be tested end to end against the real verifier.
 */
import { fromBase64Url, sha256Hex, toBase64Url } from '../../worker/lib/crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | Record<string, unknown>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function cbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (v: Cbor): void => {
    if (typeof v === 'number') out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    else if (typeof v === 'string') {
      const b = new TextEncoder().encode(v);
      out.push(...head(3, b.length), ...b);
    } else if (v instanceof Uint8Array) out.push(...head(2, v.length), ...v);
    else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      v.forEach(enc);
    } else if (v instanceof Map) {
      out.push(...head(5, v.size));
      for (const [k, val] of v) {
        enc(k);
        enc(val);
      }
    } else {
      const entries = Object.entries(v);
      out.push(...head(5, entries.length));
      for (const [k, val] of entries) {
        enc(k);
        enc(val as Cbor);
      }
    }
  };
  enc(value);
  return new Uint8Array(out);
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);

/** Raw r||s (64 bytes) → ASN.1 DER, which WebAuthn signatures use. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if ((v[0] ?? 0) & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export class SoftAuthenticator {
  private keys!: CryptoKeyPair;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  userHandle: Uint8Array = new Uint8Array();

  constructor(
    readonly origin = 'https://portal.test',
    readonly rpId = 'portal.test',
  ) {}

  get id(): string {
    return toBase64Url(this.credentialId);
  }

  private async rpIdHash() {
    return hexToBytes(await sha256Hex(this.rpId));
  }

  private clientData(type: string, challenge: string) {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  async register(options: { challenge: string; user: { id: string } }) {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    this.userHandle = fromBase64Url(options.user.id);
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64Url(jwk.x ?? '')],
        [-3, fromBase64Url(jwk.y ?? '')],
      ]),
    );
    const credLen = new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 255]);
    const authData = concat(
      await this.rpIdHash(),
      new Uint8Array([0x01 | 0x04 | 0x40]), // UP | UV | AT
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array(16), // AAGUID
      credLen,
      this.credentialId,
      cose,
    );
    const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(this.clientData('webauthn.create', options.challenge)),
        attestationObject: toBase64Url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  async assert(options: { challenge: string }) {
    this.counter++;
    const c = this.counter;
    const authData = concat(await this.rpIdHash(), new Uint8Array([0x01 | 0x04]), new Uint8Array([c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255]));
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const digest = hexToBytes(await sha256Hex(new Uint8Array(clientDataJSON)));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, concat(authData, digest)),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(derSignature(raw)),
        userHandle: toBase64Url(this.userHandle),
      },
      clientExtensionResults: {},
    };
  }
}
