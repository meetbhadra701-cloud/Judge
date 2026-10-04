import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/*
 * Address policy for server-side fetches (docs/SECURITY.md §2). Addresses are parsed with a real
 * IP/CIDR library, never compared as string prefixes. Only globally routable unicast addresses
 * may be contacted; every other range ipaddr.js knows (loopback, private, link-local, multicast,
 * unspecified, broadcast, carrier-grade NAT, unique-local, reserved/documentation, IPv4-mapped,
 * NAT64, 6to4, Teredo, deprecated site-local, ...) is refused. An explicit CIDR denylist repeats
 * the most important ranges as defence in depth.
 */

const DENIED_CIDRS: readonly [ipaddr.IPv4 | ipaddr.IPv6, number][] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/32',
  '2001:db8::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
].map((cidr) => ipaddr.parseCIDR(cidr));

export interface AddressDecision {
  readonly allowed: boolean;
  /** The ipaddr.js range name (e.g. `unicast`, `private`, `linkLocal`) or `invalid`. */
  readonly range: string;
}

/** Classifies one literal IP address. Only strict IPv4 dotted-quad or IPv6 syntax is accepted. */
export function classifyAddress(address: string): AddressDecision {
  const literal = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (isIP(literal) === 0) return { allowed: false, range: 'invalid' };
  const parsed = ipaddr.parse(literal);
  const range = parsed.range();
  if (range !== 'unicast') return { allowed: false, range };
  for (const [network, bits] of DENIED_CIDRS) {
    if (parsed.kind() === network.kind() && parsed.match(network, bits)) {
      return { allowed: false, range: 'denylisted' };
    }
  }
  return { allowed: true, range };
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address).allowed;
}
