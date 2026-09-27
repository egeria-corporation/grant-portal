import { describe, expect, it } from 'vitest';
import { inCidr, ipInList, parseCidr, parseIp } from '../../worker/lib/cidr';

describe('IP allowlist matching', () => {
  it('parses IPv4 and IPv6, including :: and mapped addresses', () => {
    expect(parseIp('203.0.113.9')).toEqual({ v: 4, n: 0xcb007109n });
    expect(parseIp('256.0.0.1')).toBeNull();
    expect(parseIp('::1')).toEqual({ v: 6, n: 1n });
    expect(parseIp('2001:db8::42')?.v).toBe(6);
    expect(parseIp('::ffff:203.0.113.9')).toEqual({ v: 4, n: 0xcb007109n });
    expect(parseIp('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIp('1::2::3')).toBeNull();
    expect(parseIp('fe80::1%eth0')).toBeNull();
  });

  it('matches ranges', () => {
    const v4 = parseCidr('203.0.113.0/24');
    expect(v4 && inCidr('203.0.113.200', v4)).toBe(true);
    expect(v4 && inCidr('203.0.114.1', v4)).toBe(false);
    expect(ipInList('2001:db8::42', ['2001:db8::/32'])).toBe(true);
    expect(ipInList('2001:db9::42', ['2001:db8::/32'])).toBe(false);
    expect(ipInList('198.51.100.7', ['198.51.100.7'])).toBe(true);
    expect(ipInList('::ffff:198.51.100.7', ['198.51.100.0/24'])).toBe(true);
    expect(ipInList('10.0.0.1', ['0.0.0.0/0'])).toBe(true);
    expect(ipInList('10.0.0.1', ['::/0'])).toBe(false);
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/8/1')).toBeNull();
    expect(parseCidr('nonsense')).toBeNull();
  });
});
