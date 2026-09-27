/** IPv4/IPv6 addresses and CIDR ranges for the staff IP allowlist (spec §5.9). No dependency. */

interface Parsed {
  v: 4 | 6;
  n: bigint;
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  let text = s;
  // A trailing embedded IPv4 (::ffff:1.2.3.4) becomes two groups.
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n4 = parseV4(v4[2] ?? '');
    if (n4 === null) return null;
    text = `${v4[1]}${(n4 >> 16n).toString(16)}:${(n4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export function parseIp(s: string): Parsed | null {
  const t = s.trim();
  if (t.includes(':')) {
    const n = parseV6(t);
    if (n === null) return null;
    // IPv4-mapped IPv6 compares as IPv4.
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
    return { v: 6, n };
  }
  const n = parseV4(t);
  return n === null ? null : { v: 4, n };
}

export interface Cidr {
  v: 4 | 6;
  base: bigint;
  bits: number;
}

export function parseCidr(s: string): Cidr | null {
  const [addr, len, extra] = s.trim().split('/');
  if (extra !== undefined || !addr) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { v: ip.v, base: ip.n & mask, bits };
}

export function inCidr(ip: string, cidr: Cidr): boolean {
  const p = parseIp(ip);
  if (!p || p.v !== cidr.v) return false;
  const max = p.v === 4 ? 32 : 128;
  const mask = cidr.bits === 0 ? 0n : ((1n << BigInt(cidr.bits)) - 1n) << BigInt(max - cidr.bits);
  return (p.n & mask) === cidr.base;
}

export function ipInList(ip: string, list: string[]): boolean {
  return list.some((entry) => {
    const c = parseCidr(entry);
    return c ? inCidr(ip, c) : false;
  });
}
