import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Outbound-request guard for user-supplied URLs (webhooks).
 *
 * A string check on the hostname is not enough on its own:
 *
 *  - a public hostname can resolve to a private address (`*.nip.io`, or
 *    any name the attacker controls);
 *  - it can resolve to a public address when checked and a private one
 *    when connected to (DNS rebinding);
 *  - a redirect can send the request anywhere after the check.
 *
 * So the address is checked where it is used: `safeLookup` is passed to the
 * socket as its DNS resolver, and refuses to hand back a blocked address.
 * The connection is made to exactly the address that was checked. Redirects
 * are never followed.
 */

const blocked = new BlockList();

// IPv4 ranges that are not the public internet.
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}

// IPv6 ranges that are not the public internet. IPv4-mapped (::ffff:0:0/96)
// and NAT64 (64:ff9b::/96) addresses are unwrapped and checked as IPv4
// below, so they are not listed here.
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (covers fd00::/8 and the rest of fc00::/7)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated, still routable internally)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** The IPv4 address embedded in an IPv4-mapped or NAT64 IPv6 address. */
function embeddedIPv4(address: string): string | null {
  const lower = address.toLowerCase();
  const prefixes = ['::ffff:', '64:ff9b::'];
  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    if (isIP(rest) === 4) return rest;
    // Hex form, e.g. ::ffff:7f00:1
    const parts = rest.split(':');
    if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const high = parseInt(parts[0]!, 16);
      const low = parseInt(parts[1]!, 16);
      return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    }
  }
  return null;
}

/** Is this literal IP address one an outbound request must never reach? */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIPv4(bare);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(bare, 'ipv6');
  }
  // Not an IP at all: refuse rather than guess.
  return true;
}

/** Host names that are internal by convention, whatever they resolve to. */
export function isInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    !host.includes('.') // single-label names resolve through search domains
  );
}

export class BlockedAddressError extends Error {
  code = 'EBLOCKEDADDRESS';
  constructor(host: string) {
    super(`Refusing to connect to ${host}: it resolves to a private or reserved address`);
  }
}

/**
 * A DNS resolver for `http.request` that only returns public addresses.
 *
 * Every address the name resolves to must be public — a name with one public
 * and one private record is refused, since the socket could pick either.
 */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }

    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))) {
      callback(new BlockedAddressError(hostname), '', 0);
      return;
    }

    if ((options as { all?: boolean }).all) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    } else {
      const [first] = list;
      callback(null, first!.address, first!.family);
    }
  });
};
