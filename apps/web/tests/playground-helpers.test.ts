import { describe, expect, it } from 'vitest';
import type { PlaygroundRequest } from '@throttlebox/shared';
import {
  badgesFor,
  draftFromRequest,
  parseHeaders,
  parseQuery,
  prettyBody,
  statusColor,
  statusLabel,
} from '../src/components/playground/shared';

function req(over: Partial<PlaygroundRequest> = {}): PlaygroundRequest {
  return {
    id: 'r1',
    sessionId: 's1',
    keyId: 'k1',
    keyDisplay: 'sk_test_abc.1234',
    parentId: null,
    kind: 'send',
    method: 'GET',
    serviceSlug: 'ecommerce',
    path: '/products/42',
    query: {},
    headers: {},
    body: null,
    outcome: 'ok',
    responseStatus: 200,
    responseHeaders: {},
    responseBody: '{"id":"42"}',
    responseTruncated: false,
    durationMs: 12,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('parseQuery', () => {
  it('parses key=value lines, trimming and skipping blanks', () => {
    expect(parseQuery('page=2\n  sort = price \n\n=nokey\nflag')).toEqual({
      page: '2',
      sort: 'price',
      flag: '',
    });
  });

  it('keeps "=" inside a value', () => {
    expect(parseQuery('filter=a=b')).toEqual({ filter: 'a=b' });
  });

  it('returns an empty object for empty input', () => {
    expect(parseQuery('')).toEqual({});
  });
});

describe('parseHeaders', () => {
  it('parses Name: value lines and keeps colons inside values', () => {
    expect(parseHeaders('X-Trace: abc\nAccept: text/html: v2\nnot a header\n: orphan')).toEqual({
      'X-Trace': 'abc',
      Accept: 'text/html: v2',
    });
  });
});

describe('draftFromRequest (fork)', () => {
  it('pre-fills every field and links the parent', () => {
    const draft = draftFromRequest(
      req({
        method: 'POST',
        path: '/orders',
        query: { a: '1', b: '2' },
        headers: { 'x-k': 'v' },
        body: '{"n":1}',
      }),
    );
    expect(draft).toEqual({
      keyId: 'k1',
      method: 'POST',
      serviceSlug: 'ecommerce',
      path: '/orders',
      query: 'a=1\nb=2',
      headers: 'x-k: v',
      body: '{"n":1}',
      parentId: 'r1',
    });
  });

  it('round-trips through parseQuery / parseHeaders', () => {
    const original = req({ query: { page: '2' }, headers: { 'x-k': 'v' } });
    const draft = draftFromRequest(original);
    expect(parseQuery(draft.query)).toEqual(original.query);
    expect(parseHeaders(draft.headers)).toEqual(original.headers);
  });

  it('tolerates a deleted key and an empty body', () => {
    const draft = draftFromRequest(req({ keyId: null, body: null }));
    expect(draft.keyId).toBe('');
    expect(draft.body).toBe('');
  });
});

describe('status presentation', () => {
  it.each([
    [{ outcome: 'ok', responseStatus: 200 }, 'var(--success)', '200'],
    [{ outcome: 'ok', responseStatus: 404 }, '#f59e0b', '404'],
    [{ outcome: 'ok', responseStatus: 429 }, '#f59e0b', '429'],
    [{ outcome: 'ok', responseStatus: 503 }, '#ef4444', '503'],
    [{ outcome: 'dropped', responseStatus: null }, '#ef4444', 'DROPPED'],
    [{ outcome: 'error', responseStatus: null }, '#ef4444', 'ERROR'],
  ] as const)('%j', (r, color, label) => {
    expect(statusColor(r)).toBe(color);
    expect(statusLabel(r)).toBe(label);
  });
});

describe('badgesFor', () => {
  it('explains why a run looks the way it does', () => {
    expect(badgesFor(req())).toEqual([]);
    expect(
      badgesFor(req({ responseStatus: 503, responseHeaders: { 'x-throttlebox-chaos-injected': 'true' } })),
    ).toEqual(['chaos fault']);
    expect(badgesFor(req({ responseHeaders: { 'x-throttlebox-chaos-latency': '200ms' } }))).toEqual(['+200ms']);
    expect(badgesFor(req({ responseStatus: 429 }))).toEqual(['rate limited']);
    expect(badgesFor(req({ outcome: 'dropped', responseStatus: null }))).toEqual(['socket dropped']);
    expect(badgesFor(req({ responseTruncated: true }))).toEqual(['truncated']);
  });

  it('does not call a simulated chaos 429 a real rate limit', () => {
    const badges = badgesFor(
      req({ responseStatus: 429, responseHeaders: { 'x-throttlebox-chaos-injected': 'true' } }),
    );
    expect(badges).toEqual(['chaos fault']);
  });
});

describe('prettyBody', () => {
  it('pretty-prints JSON, passes text through, and handles empty', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('plain')).toBe('plain');
    expect(prettyBody('')).toBe('');
  });
});
