import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Outbound webhook URL validation — the SSRF guard.
 *
 * A webhook destination is attacker-controlled: any user with
 * `analytics:write` can register one, and `POST .../webhooks/:id/test` makes
 * the server fetch it on demand. The guard therefore has to answer one
 * question: *will this request reach a host this process should never be able
 * to reach?*
 *
 * A string check alone cannot answer that, so this module does three things:
 *
 *   1. **Parses** the URL and rejects anything that is not plain `http(s)`.
 *   2. **Resolves** the hostname and inspects *every* address it maps to —
 *      including the IPv4 addresses hidden behind IPv4-mapped and NAT64
 *      IPv6 forms, which a string check cannot see.
 *   3. **Pins** the validated address, so the connection is made to exactly
 *      the address that was checked. That closes the DNS-rebinding window
 *      between checking and connecting.
 *
 * The previous implementation only did step 1. It was defeated by
 * `http://[::ffff:127.0.0.1]/` (normalises to `[::ffff:7f00:1]`, which is not
 * one of the denied string prefixes) and by any permitted URL that answered
 * with a redirect, because `fetch()` followed it without re-checking.
 *
 * Redirects are now refused outright rather than followed and re-validated: a
 * legitimate quota webhook has no reason to redirect, and refusing removes the
 * whole class of "re-validate every hop and hope each implementation agrees".
 */

export interface AddressRange {
  name: string;
  reason: string;
}

/** IPv4 ranges that must never be reachable from a webhook. */
const BLOCKED_IPV4: { test: (o: number[]) => boolean; reason: string }[] = [
  { test: (o) => o[0] === 0, reason: 'The "this network" range (0.0.0.0/8) is not permitted' },
  { test: (o) => o[0] === 10, reason: 'Private IP addresses (RFC 1918) are not permitted' },
  { test: (o) => o[0] === 127, reason: 'Loopback IP addresses are not permitted' },
  {
    test: (o) => o[0] === 169 && o[1] === 254,
    reason: 'Link-local and cloud metadata addresses are not permitted',
  },
  {
    test: (o) => o[0] === 172 && o[1]! >= 16 && o[1]! <= 31,
    reason: 'Private IP addresses (RFC 1918) are not permitted',
  },
  {
    test: (o) => o[0] === 192 && o[1] === 168,
    reason: 'Private IP addresses (RFC 1918) are not permitted',
  },
  {
    test: (o) => o[0] === 100 && o[1]! >= 64 && o[1]! <= 127,
    reason: 'Carrier-grade NAT addresses are not permitted',
  },
  {
    test: (o) => o[0] === 192 && o[1] === 0 && o[2] === 0,
    reason: 'IETF protocol assignments are not permitted',
  },
  {
    test: (o) => o[0] === 198 && (o[1] === 18 || o[1] === 19),
    reason: 'Benchmarking addresses are not permitted',
  },
  { test: (o) => o[0]! >= 224, reason: 'Multicast and reserved addresses are not permitted' },
];

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

/** Explain why an IPv4 address is unreachable, or null when it is public. */
export function blockedIpv4Reason(address: string): string | null {
  const octets = parseIpv4(address);
  if (!octets) return 'Invalid IPv4 address';
  for (const range of BLOCKED_IPV4) {
    if (range.test(octets)) return range.reason;
  }
  return null;
}

/**
 * Expand an IPv6 address into its eight 16-bit groups.
 *
 * Hand-rolled rather than pulled from a dependency because the only shapes
 * that matter here are the ones a URL parser can produce: `::` compression and
 * a trailing dotted-quad for IPv4-mapped addresses.
 */
function parseIpv6(address: string): number[] | null {
  let input = address.toLowerCase();

  // A zone index (`fe80::1%eth0`) is not reachable through a URL, but strip it
  // so it cannot be used to smuggle a different address past the checks.
  const zone = input.indexOf('%');
  if (zone !== -1) input = input.slice(0, zone);

  // Split off an embedded IPv4 tail (`::ffff:127.0.0.1`).
  let ipv4Tail: number[] | null = null;
  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    ipv4Tail = parseIpv4(tail);
    if (!ipv4Tail) return null;
    input = input.slice(0, lastColon + 1) + '0:0';
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const chunk of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      groups.push(parseInt(chunk, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !rest) return null;

  const explicit = head.length + rest.length;
  if (halves.length === 1 && explicit !== 8) return null;
  if (explicit > 8) return null;

  const groups = halves.length === 2 ? [...head, ...Array(8 - explicit).fill(0), ...rest] : head;

  // Fold the embedded IPv4 tail into the final two groups.
  if (ipv4Tail) {
    groups[6] = ((ipv4Tail[0]! << 8) | ipv4Tail[1]!) & 0xffff;
    groups[7] = ((ipv4Tail[2]! << 8) | ipv4Tail[3]!) & 0xffff;
  }

  return groups;
}

/** The IPv4 address inside an IPv4-mapped or NAT64 IPv6 address, if any. */
function extractEmbeddedIpv4(groups: number[]): { address: string; label: string } | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // ::ffff:0:0/96 — IPv4-mapped. Every address here is an IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return { address: ipv4FromGroups(g6, g7), label: 'IPv4-mapped IPv6' };
  }

  // 64:ff9b::/96 — NAT64 well-known prefix. Usually routed to IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return { address: ipv4FromGroups(g6, g7), label: 'NAT64 IPv6' };
  }

  // ::ffff:0:0:0/96 — IPv4-translated (deprecated, still routable on some stacks).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return { address: ipv4FromGroups(g6, g7), label: 'IPv4-translated IPv6' };
  }

  return null;
}

function ipv4FromGroups(hi: number | undefined, lo: number | undefined): string {
  const a = (hi ?? 0) >> 8;
  const b = (hi ?? 0) & 0xff;
  const c = (lo ?? 0) >> 8;
  const d = (lo ?? 0) & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/** Explain why an IPv6 address is unreachable, or null when it is public. */
export function blockedIpv6Reason(address: string): string | null {
  const groups = parseIpv6(address);
  if (!groups) return 'Invalid IPv6 address';

  // Anything that embeds an IPv4 address is judged as that IPv4 address, so
  // ::ffff:127.0.0.1 cannot slip past a check written for dotted quads.
  const embedded = extractEmbeddedIpv4(groups);
  if (embedded) {
    const reason = blockedIpv4Reason(embedded.address);
    if (reason) return `${reason} (via ${embedded.label} ${embedded.address})`;
    return null;
  }

  const [g0, g1] = groups;

  // ::/128 (unspecified) and ::1/128 (loopback).
  if (groups.every((g) => g === 0)) {
    return 'The unspecified IPv6 address is not permitted';
  }
  if (g0 === 0 && groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return 'Loopback IP addresses are not permitted';
  }

  // fc00::/7 — unique local addresses.
  if (((g0 ?? 0) & 0xfe00) === 0xfc00) {
    return 'Private IPv6 addresses (unique local) are not permitted';
  }

  // fe80::/10 — link-local.
  if (((g0 ?? 0) & 0xffc0) === 0xfe80) {
    return 'Link-local IPv6 addresses are not permitted';
  }

  // ff00::/8 — multicast.
  if (((g0 ?? 0) & 0xff00) === 0xff00) {
    return 'Multicast IPv6 addresses are not permitted';
  }

  // 2001:db8::/32 — documentation.
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return 'Documentation IPv6 addresses are not permitted';
  }

  return null;
}

/** Reason an IP literal is unreachable, or null when it is public. */
export function blockedIpReason(address: string): string | null {
  const version = isIP(address);
  if (version === 4) return blockedIpv4Reason(address);
  if (version === 6) return blockedIpv6Reason(address);
  return 'Not an IP address';
}

/** Hostnames that never resolve to a public address, or that name a cloud control plane. */
export function blockedHostnameReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'Loopback and internal domains are not permitted';
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return 'Loopback and internal domains are not permitted';
  }
  // Cloud metadata names that resolve through DNS rather than a literal IP.
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata.goog' ||
    host === 'instance-data' ||
    host.endsWith('.ec2.internal')
  ) {
    return 'Cloud metadata endpoints are not permitted';
  }
  if (!host.includes('.')) {
    // A bare label is resolved through the search domains, which are internal.
    return 'A fully qualified domain name is required';
  }

  return null;
}

export interface WebhookTarget {
  url: string;
  /** The exact address that was validated, pinned for the connection. */
  address: string;
  family: 4 | 6;
  hostname: string;
}

export interface WebhookTargetResult {
  ok: true;
  target: WebhookTarget;
}

export interface WebhookTargetError {
  ok: false;
  reason: string;
}

/** Either a validated, pinned target or the reason it was refused. */
export type WebhookTargetOutcome = WebhookTargetResult | WebhookTargetError;

/**
 * Validate a webhook URL and resolve it to a pinned address.
 *
 * Every step fails closed: an unresolvable name, a name with even one blocked
 * address, or a non-http(s) scheme all produce `{ ok: false }`.
 *
 * Note that this resolves DNS. Callers on a hot path should cache the result;
 * webhook creation and delivery are both rare enough not to need it.
 */
export async function resolveWebhookTarget(
  rawUrl: string,
  options: { allowHttp?: boolean } = {},
): Promise<WebhookTargetOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'Webhooks must use HTTP or HTTPS' };
  }
  if (parsed.protocol === 'http:' && options.allowHttp === false) {
    return { ok: false, reason: 'Webhooks must use HTTPS' };
  }
  if (parsed.username || parsed.password) {
    // Credentials in the URL would be forwarded to the target and recorded in
    // logs, and they let a URL look like one host while connecting with auth
    // meant for another.
    return { ok: false, reason: 'Webhook URLs may not contain credentials' };
  }

  // `URL` canonicalises numeric IPv4 forms (2130706433, 0x7f000001, 0177.0.0.1,
  // 127.1) to dotted quads, so the checks below see the same address the socket
  // will connect to.
  //
  // It does **not** strip the brackets from an IPv6 literal: `hostname` is
  // `[::1]`, not `::1`. Left in place, `isIP()` returns 0 for every IPv6
  // literal, which silently routed them into the hostname checks — failing
  // closed by accident, with the wrong reason, and making a legitimate IPv6
  // destination impossible to use. Strip them here, and keep the bracketed
  // form only where it belongs (the `Host` header).
  const rawHostname = parsed.hostname;
  const hostname =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;

  const literalVersion = isIP(hostname);

  if (literalVersion === 4 || literalVersion === 6) {
    const reason = blockedIpReason(hostname);
    if (reason) return { ok: false, reason };
    return {
      ok: true,
      target: {
        url: parsed.toString(),
        address: hostname,
        family: literalVersion,
        hostname,
      },
    };
  }

  const hostReason = blockedHostnameReason(hostname);
  if (hostReason) return { ok: false, reason: hostReason };

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'The webhook host could not be resolved' };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'The webhook host could not be resolved' };
  }

  // Reject when *any* answer is blocked. A name with one public and one private
  // address is a rebinding attempt, not a coincidence.
  for (const entry of addresses) {
    const reason = blockedIpReason(entry.address);
    if (reason) {
      return { ok: false, reason: `${reason} (${hostname} resolves to ${entry.address})` };
    }
  }

  const chosen = addresses[0]!;
  return {
    ok: true,
    target: {
      url: parsed.toString(),
      address: chosen.address,
      family: chosen.family === 6 ? 6 : 4,
      hostname,
    },
  };
}

/**
 * Is this URL a permissible webhook destination?
 *
 * Kept as the cheap synchronous shape existing callers use for validation; the
 * authoritative check is `resolveWebhookTarget`, which is what delivery uses.
 */
export async function isValidWebhookUrl(rawUrl: string): Promise<WebhookTargetOutcome> {
  return resolveWebhookTarget(rawUrl);
}
