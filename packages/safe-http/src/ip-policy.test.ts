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

  it.each([
    // IPv4-compatible and other space ipaddr.js calls "unicast" but that is not global unicast.
    ['::7f00:1', 'outside_global_unicast'],
    ['::a9fe:a9fe', 'outside_global_unicast'],
    ['::a00:1', 'outside_global_unicast'],
    ['4000::1', 'outside_global_unicast'],
    ['8000::1', 'outside_global_unicast'],
    ['e000::1', 'outside_global_unicast'],
    ['100:0:0:1::1', 'outside_global_unicast'],
    ['[::7f00:1]', 'outside_global_unicast'],
  ])('rejects IPv6 %s outside 2000::/3 (%s)', (address, range) => {
    expect(classifyAddress(address)).toEqual({ allowed: false, range });
  });

  it('keeps allowing public IPv6 inside 2000::/3 and does not touch the IPv4 policy', () => {
    for (const address of ['2606:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e']) {
      expect(classifyAddress(address)).toEqual({ allowed: true, range: 'unicast' });
    }
    // Edges of 2000::/3 itself.
    expect(isPublicAddress('2000::1')).toBe(true);
    expect(isPublicAddress('3fff::1')).toBe(false); // documentation range, denied by ipaddr.js
    expect(isPublicAddress('1fff:ffff::1')).toBe(false);
    expect(isPublicAddress('4000::')).toBe(false);
    // Existing explicit denies are still in force inside 2000::/3.
    for (const address of ['2001:db8::1', '2002:a00:1::', '2001::1']) {
      expect(isPublicAddress(address)).toBe(false);
    }
    // IPv4 is unchanged.
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('10.0.0.1')).toBe(false);
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
