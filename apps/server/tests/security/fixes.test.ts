import { describe, expect, it } from 'vitest';
import {
  blockedHostnameReason,
  blockedIpReason,
  blockedIpv4Reason,
  blockedIpv6Reason,
  resolveWebhookTarget,
} from '../../src/analytics/webhookGuard.js';
import { maskSecret } from '../../src/analytics/webhooks.js';
import { backoffMs } from '../../src/analytics/webhookOutbox.js';
import { sessionDeadlineSeconds } from '../../src/auth/session.js';
import { redact } from '../../src/keys/redact.js';
import { templateVisibleHeaders } from '../../src/routes/mock.js';
import { safeEqualString } from '../../src/util/crypto.js';

/**
 * Regression tests for the 2026-11-26 audit fixes.
 *
 * Everything here is pure — no Postgres, no Redis — so it runs in any
 * environment and covers the logic that the security fixes turn on. The
 * database-backed behaviour (revocation propagation, the outbox drain) is
 * covered by the integration suites, which need the real services.
 */

describe('webhook egress guard — address classification', () => {
  it('blocks every private, loopback, link-local and reserved IPv4 range', () => {
    const blocked = [
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ];
    for (const address of blocked) {
      expect(blockedIpv4Reason(address), address).not.toBeNull();
    }
  });

  it('allows public IPv4 addresses, including ones adjacent to blocked ranges', () => {
    const allowed = [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '11.0.0.1',
      '172.32.0.1',
      '100.128.0.1',
    ];
    for (const address of allowed) {
      expect(blockedIpv4Reason(address), address).toBeNull();
    }
  });

  it('blocks IPv6 loopback, unique-local, link-local and multicast', () => {
    const blocked = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1'];
    for (const address of blocked) {
      expect(blockedIpv6Reason(address), address).not.toBeNull();
    }
  });

  it('judges IPv4-mapped and NAT64 forms by the IPv4 address inside them', () => {
    // These were the live bypass: `[::ffff:127.0.0.1]` normalises to
    // `[::ffff:7f00:1]`, which matched none of the old string prefixes.
    expect(blockedIpv6Reason('::ffff:127.0.0.1')).toContain('Loopback');
    expect(blockedIpv6Reason('::ffff:7f00:1')).toContain('Loopback');
    expect(blockedIpv6Reason('::ffff:169.254.169.254')).toContain('Link-local');
    expect(blockedIpv6Reason('::ffff:a9fe:a9fe')).toContain('Link-local');
    expect(blockedIpv6Reason('::ffff:10.0.0.1')).toContain('Private');
    expect(blockedIpv6Reason('64:ff9b::7f00:1')).toContain('Loopback');
    expect(blockedIpv6Reason('64:ff9b::a9fe:a9fe')).toContain('Link-local');

    // A mapped *public* address is still public.
    expect(blockedIpv6Reason('::ffff:8.8.8.8')).toBeNull();
    expect(blockedIpv6Reason('64:ff9b::8.8.8.8')).toBeNull();
  });

  it('handles compressed and expanded IPv6 spelling identically', () => {
    expect(blockedIpv6Reason('::ffff:7f00:1')).toBe(blockedIpv6Reason('0:0:0:0:0:ffff:7f00:1'));
    expect(blockedIpv6Reason('::1')).toBe(blockedIpv6Reason('0:0:0:0:0:0:0:1'));
  });

  it('rejects a zone-scoped address outright rather than parsing around it', () => {
    // `fe80::1%eth0` is not a valid IP for `isIP`, so it is refused as
    // malformed. Fail-closed is the right answer: a zone index cannot reach a
    // URL anyway, and guessing at one is how a bypass gets introduced.
    expect(blockedIpReason('fe80::1%eth0')).not.toBeNull();
    expect(blockedIpReason('fe80::1%25eth0')).not.toBeNull();

    // The address underneath is still recognised as link-local.
    expect(blockedIpv6Reason('fe80::1')).toContain('Link-local');
  });

  it('rejects malformed input rather than guessing', () => {
    expect(blockedIpReason('not-an-ip')).not.toBeNull();
    expect(blockedIpv4Reason('999.1.1.1')).not.toBeNull();
    expect(blockedIpv6Reason('gggg::1')).not.toBeNull();
  });
});

describe('webhook egress guard — hostnames', () => {
  it('blocks internal names and bare labels', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'svc.local',
      'db.internal',
      'metadata.google.internal',
      'intranet',
      'instance-data',
    ]) {
      expect(blockedHostnameReason(host), host).not.toBeNull();
    }
  });

  it('allows public names', () => {
    for (const host of ['example.com', 'hooks.slack.com', 'api.acme.co.uk']) {
      expect(blockedHostnameReason(host), host).toBeNull();
    }
  });
});

describe('webhook egress guard — URL validation', () => {
  it('rejects non-http schemes and embedded credentials', async () => {
    expect((await resolveWebhookTarget('file:///etc/passwd')).ok).toBe(false);
    expect((await resolveWebhookTarget('ftp://example.com/x')).ok).toBe(false);
    expect((await resolveWebhookTarget('javascript:alert(1)')).ok).toBe(false);
    expect((await resolveWebhookTarget('https://user:pass@example.com/x')).ok).toBe(false);
  });

  it('rejects an unparseable URL', async () => {
    expect((await resolveWebhookTarget('not a url')).ok).toBe(false);
    expect((await resolveWebhookTarget('')).ok).toBe(false);
  });

  it('canonicalises alternate IPv4 encodings before deciding', async () => {
    // `new URL()` maps all of these onto 127.0.0.1, so the dotted-quad check
    // catches them. Pinned here so a future refactor cannot regress it.
    for (const url of [
      'http://2130706433/x',
      'http://0x7f000001/x',
      'http://0177.0.0.1/x',
      'http://127.1/x',
    ]) {
      expect((await resolveWebhookTarget(url)).ok, url).toBe(false);
    }
  });

  it('classifies bracketed IPv6 literals correctly instead of as hostnames', async () => {
    // `URL.hostname` keeps the brackets for IPv6 (`[::1]`), so a naive `isIP`
    // check treats every IPv6 literal as a domain name. That fails closed, but
    // for the wrong reason and it makes a legitimate IPv6 destination
    // impossible. These assert the classification, not just the verdict.
    const loopback = await resolveWebhookTarget('http://[::1]:8080/hook');
    expect(loopback.ok).toBe(false);
    if (!loopback.ok) expect(loopback.reason).toContain('Loopback');

    const mapped = await resolveWebhookTarget('http://[::ffff:127.0.0.1]/hook');
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.reason).toContain('Loopback');

    const metadata = await resolveWebhookTarget('http://[::ffff:169.254.169.254]/latest/meta-data');
    expect(metadata.ok).toBe(false);
    if (!metadata.ok) expect(metadata.reason).toContain('Link-local');

    const nat64 = await resolveWebhookTarget('http://[64:ff9b::127.0.0.1]/hook');
    expect(nat64.ok).toBe(false);
  });

  it('accepts a public IPv6 literal and pins the unbracketed address', async () => {
    const target = await resolveWebhookTarget('https://[2606:4700:4700::1111]/dns-query');
    expect(target.ok).toBe(true);
    if (target.ok) {
      // No brackets: this value is used for SNI and for the socket address.
      expect(target.target.address).toBe('2606:4700:4700::1111');
      expect(target.target.hostname).toBe('2606:4700:4700::1111');
      expect(target.target.family).toBe(6);
    }
  });

  it('returns a pinned address for an allowed literal, with the family recorded', async () => {
    const target = await resolveWebhookTarget('https://8.8.8.8/hook');
    expect(target.ok).toBe(true);
    if (target.ok) {
      expect(target.target.address).toBe('8.8.8.8');
      expect(target.target.family).toBe(4);
      expect(target.target.hostname).toBe('8.8.8.8');
    }
  });

  it('refuses plain HTTP when asked to', async () => {
    const target = await resolveWebhookTarget('http://8.8.8.8/hook', { allowHttp: false });
    expect(target.ok).toBe(false);
    if (!target.ok) expect(target.reason).toContain('HTTPS');
  });
});

describe('webhook secret masking', () => {
  it('keeps only a prefix hint and the last two characters', () => {
    const secret = 'whsec_0123456789abcdef0123456789abcdef';
    const masked = maskSecret(secret);

    expect(masked).toContain('whsec_');
    expect(masked.endsWith('ef')).toBe(true);
    expect(masked).not.toContain('0123456789abcdef');
    // Short enough that it cannot be mistaken for the secret.
    expect(masked.length).toBeLessThan(16);
  });

  it('masks a custom secret without inventing a prefix', () => {
    expect(maskSecret('custom-secret-value-99').startsWith('whsec_')).toBe(false);
    expect(maskSecret('custom-secret-value-99').endsWith('99')).toBe(true);
  });
});

describe('redaction covers every credential shape', () => {
  it('scrubs API keys and webhook secrets in the same pass', () => {
    const key = 'sk_live_' + 'A'.repeat(12) + '_' + 'b'.repeat(32);
    const text = `key=${key} hook=whsec_0123456789abcdef0123`;
    const out = redact(text);

    expect(out).not.toContain(key);
    expect(out).not.toContain('whsec_0123456789abcdef0123');
    expect(out).toContain('sk_***');
    expect(out).toContain('whsec_***');
  });
});

describe('session deadline enforcement', () => {
  const base = { userId: 'u', sessionId: 's' };

  it('reports the remaining seconds for a live session', () => {
    const record = { ...base, expiresAt: Date.now() + 60_000 };
    const remaining = sessionDeadlineSeconds(record);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it('reports zero for an expired session, so the caller drops it', () => {
    expect(sessionDeadlineSeconds({ ...base, expiresAt: Date.now() - 1 })).toBeLessThanOrEqual(0);
  });

  it('treats a record with no deadline as untrusted', () => {
    // A record written by an older build has no `expiresAt`. It must not be
    // accepted as "live forever" — the cache hit path rejects it and falls back
    // to Postgres, which knows the real expiry.
    expect(sessionDeadlineSeconds(base)).toBe(0);
    expect(sessionDeadlineSeconds({ ...base, expiresAt: Number.NaN })).toBe(0);
  });
});

describe('webhook outbox backoff', () => {
  it('grows exponentially and is capped at an hour', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(60 * 60 * 1000);
  });
});

describe('constant-time comparison tolerates no length oracle', () => {
  it('still compares equal strings correctly', () => {
    expect(safeEqualString('abcdef', 'abcdef')).toBe(true);
    expect(safeEqualString('abcdef', 'abcdeg')).toBe(false);
    expect(safeEqualString('abcdef', 'abcde')).toBe(false);
  });
});

describe('response templates cannot read credentials', () => {
  it('drops every header that carries a credential', () => {
    const visible = templateVisibleHeaders({
      authorization: 'Bearer sk_live_abcdef',
      cookie: '__Host-tb_session=abc',
      'x-csrf-token': 'csrf-value',
      'x-api-key': 'sk_live_abcdef',
      'x-throttlebox-internal': 'f'.repeat(64),
      'set-cookie': 'leak=1',
      accept: 'application/json',
      'user-agent': 'curl/8',
    });

    expect(visible).toEqual({ accept: 'application/json', 'user-agent': 'curl/8' });
  });

  it('normalises header name casing so the allowlist cannot be bypassed', () => {
    const visible = templateVisibleHeaders({ Accept: 'text/html', 'X-Request-Id': 'r-1' });
    expect(visible).toEqual({ accept: 'text/html', 'x-request-id': 'r-1' });
  });

  it('handles repeated headers and absent values', () => {
    const visible = templateVisibleHeaders({ accept: ['a/b', 'c/d'], 'user-agent': undefined });
    expect(visible).toEqual({ accept: 'a/b' });
  });
});
