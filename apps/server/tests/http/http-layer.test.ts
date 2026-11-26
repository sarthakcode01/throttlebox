import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { safeEqualHex, safeEqualString } from '../../src/util/crypto.js';
import { redact } from '../../src/keys/redact.js';
import { registerErrorHandler, safeError } from '../../src/http/errorHandler.js';
import { registerSecurityHeaders } from '../../src/http/securityHeaders.js';
import { registerLenientContentType } from '../../src/http/contentType.js';
import { createRateLimit } from '../../src/http/rateLimit.js';

describe('constant-time comparisons', () => {
  it('safeEqualString matches only identical, non-empty strings', () => {
    expect(safeEqualString('abc', 'abc')).toBe(true);
    expect(safeEqualString('abc', 'abd')).toBe(false);
    expect(safeEqualString('abc', 'abcd')).toBe(false);
    expect(safeEqualString('', '')).toBe(false);
  });

  it('safeEqualHex matches only identical, non-empty digests', () => {
    expect(safeEqualHex('deadbeef', 'deadbeef')).toBe(true);
    expect(safeEqualHex('deadbeef', 'deadbeee')).toBe(false);
    expect(safeEqualHex('dead', 'deadbeef')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});

describe('redact', () => {
  const key = 'sk_live_' + 'A'.repeat(12) + '_' + 'b'.repeat(32);

  it('scrubs every raw key in a string, repeatedly (no stale lastIndex)', () => {
    const text = `a ${key} b ${key}`;
    expect(redact(text)).toBe('a sk_*** b sk_***');
    expect(redact(text)).toBe('a sk_*** b sk_***');
  });

  it('scrubs webhook signing secrets as well as API keys', () => {
    expect(redact('secret whsec_0123456789abcdef0123 in a body')).toBe(
      'secret whsec_*** in a body',
    );
  });

  it('leaves text without keys alone and tolerates empty input', () => {
    expect(redact('nothing to see')).toBe('nothing to see');
    expect(redact('')).toBe('');
  });
});

describe('error handler', () => {
  async function app() {
    const f = Fastify();
    registerErrorHandler(f);
    f.get('/boom', async () => {
      throw new Error('relation "secret_table" does not exist');
    });
    f.get('/teapot', async () => {
      throw safeError(418, 'short and stout', 'teapot');
    });
    f.get('/leaky', async () => {
      // A 4xx that did NOT opt in: its message must not reach the client.
      const e = new Error('relation "secret_table" does not exist') as Error & {
        statusCode: number;
      };
      e.statusCode = 400;
      throw e;
    });
    await f.ready();
    return f;
  }

  it('passes 4xx errors through with their code and message', async () => {
    const f = await app();
    const res = await f.inject('/teapot');
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: 'teapot', message: 'short and stout' });
    await f.close();
  });

  it('withholds the message of a 4xx that did not opt in', async () => {
    const f = await app();
    const res = await f.inject('/leaky');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('The request could not be processed');
    expect(JSON.stringify(res.json())).not.toContain('secret_table');
    await f.close();
  });

  it('turns unexpected errors into a 500 internal_error', async () => {
    const f = await app();
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('internal_error');
    await f.close();
  });
});

describe('security headers', () => {
  it('adds the baseline headers and no X-Powered-By', async () => {
    const f = Fastify();
    registerSecurityHeaders(f);
    f.get('/', async () => ({ ok: true }));
    const res = await f.inject('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['x-powered-by']).toBeUndefined();
    await f.close();
  });
});

describe('lenient content-type parser', () => {
  async function app() {
    const f = Fastify();
    registerLenientContentType(f);
    f.post('/x', async (req) => ({ body: req.body ?? null }));
    await f.ready();
    return f;
  }

  it('accepts an empty body with an arbitrary content type', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    await f.close();
  });

  it('rejects a non-empty body of an unsupported type with 415', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    await f.close();
  });

  it('still parses JSON normally', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/x', payload: { a: 1 } });
    expect(res.json()).toEqual({ body: { a: 1 } });
    await f.close();
  });
});

describe('fixed-window limiter details', () => {
  async function app(max: number, windowMs: number) {
    const f = Fastify();
    const limiter = createRateLimit({
      max,
      windowMs,
      keyGenerator: (r) => String(r.headers['x-who'] ?? 'anon'),
    });
    f.get('/', { preHandler: limiter.handler }, async () => ({ ok: true }));
    await f.ready();
    return { f, limiter };
  }

  it('decrements Remaining, then returns 429 with Retry-After past the max', async () => {
    const { f } = await app(2, 60_000);
    const a = await f.inject('/');
    expect(a.headers['x-ratelimit-remaining']).toBe('1');
    await f.inject('/');
    const c = await f.inject('/');
    expect(c.statusCode).toBe(429);
    expect(Number(c.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(c.headers['x-ratelimit-remaining']).toBe('0');
    await f.close();
  });

  it('opens a fresh window after it expires', async () => {
    const { f } = await app(1, 50);
    expect((await f.inject('/')).statusCode).toBe(200);
    expect((await f.inject('/')).statusCode).toBe(429);
    await new Promise((r) => setTimeout(r, 70));
    expect((await f.inject('/')).statusCode).toBe(200);
    await f.close();
  });

  it('reset() clears all buckets', async () => {
    const { f, limiter } = await app(1, 60_000);
    await f.inject('/');
    expect(limiter.size()).toBe(1);
    limiter.reset();
    expect(limiter.size()).toBe(0);
    await f.close();
  });
});
