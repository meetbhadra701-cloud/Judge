import { describe, expect, it } from 'vitest';
import { classifyAddress, isPublicAddress } from './index.js';

describe('address policy', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'linkLocal'],
    ['100.64.0.1', 'carrierGradeNat'],
    ['100.100.100.200', 'carrierGradeNat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['192.0.2.10', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['203.0.113.7', 'reserved'],
  ])('rejects IPv4 %s (%s)', (address, range) => {
    expect(classifyAddress(address)).toEqual({ allowed: false, range });
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'uniqueLocal'],
    ['fd00:ec2::254', 'uniqueLocal'],
    ['fe80::1', 'linkLocal'],
    ['ff02::1', 'multicast'],
    ['::ffff:10.0.0.1', 'ipv4Mapped'],
    ['::ffff:127.0.0.1', 'ipv4Mapped'],
    ['::ffff:169.254.169.254', 'ipv4Mapped'],
    ['64:ff9b::a00:1', 'rfc6052'],
    ['2002:a00:1::', '6to4'],
    ['2001:db8::1', 'reserved'],
    ['fec0::1', 'deprecatedSiteLocal'],
  ])('rejects IPv6 %s (%s)', (address, range) => {
    expect(classifyAddress(address)).toEqual({ allowed: false, range });
  });

  it('accepts global unicast and rejects non-strict syntax', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
    expect(isPublicAddress('[2606:4700::1111]')).toBe(true);
    for (const odd of ['0x7f.0.0.1', '017700000001', '2130706433', '127.1', 'example.com', '']) {
      expect(classifyAddress(odd)).toEqual({ allowed: false, range: 'invalid' });
    }
  });
});
