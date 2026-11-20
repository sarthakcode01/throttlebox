import { describe, expect, it } from 'vitest';
import { diffJson, diffRuns, roleHasPermission, type RunSnapshot } from '../src/index.js';

describe('diffJson', () => {
  it('returns nothing for identical values', () => {
    expect(diffJson({ a: 1, b: [1, 2, { c: 3 }] }, { a: 1, b: [1, 2, { c: 3 }] })).toEqual([]);
    expect(diffJson(null, null)).toEqual([]);
    expect(diffJson(NaN, NaN)).toEqual([]);
  });

  it('reports changed, added and removed object keys with paths', () => {
    const d = diffJson({ a: 1, b: 2, keep: true }, { a: 9, c: 3, keep: true });
    expect(d).toEqual([
      { path: 'a', kind: 'changed', before: 1, after: 9 },
      { path: 'b', kind: 'removed', before: 2 },
      { path: 'c', kind: 'added', after: 3 },
    ]);
  });

  it('recurses into nested objects and arrays by index', () => {
    const d = diffJson({ items: [{ id: 1, price: 5 }, { id: 2 }] }, { items: [{ id: 1, price: 6 }] });
    expect(d).toEqual([
      { path: 'items[0].price', kind: 'changed', before: 5, after: 6 },
      { path: 'items[1]', kind: 'removed', before: { id: 2 } },
    ]);
  });

  it('reports appended array items as added', () => {
    expect(diffJson([1], [1, 2])).toEqual([{ path: '$[1]', kind: 'added', after: 2 }]);
  });

  it('treats a type change as one changed entry, not a deep walk', () => {
    expect(diffJson({ a: { x: 1 } }, { a: [1] })).toEqual([
      { path: 'a', kind: 'changed', before: { x: 1 }, after: [1] },
    ]);
    expect(diffJson({ a: null }, { a: { x: 1 } })).toEqual([
      { path: 'a', kind: 'changed', before: null, after: { x: 1 } },
    ]);
  });

  it('distinguishes null from a missing key', () => {
    expect(diffJson({ a: null }, {})).toEqual([{ path: 'a', kind: 'removed', before: null }]);
    expect(diffJson({}, { a: null })).toEqual([{ path: 'a', kind: 'added', after: null }]);
  });

  it('quotes keys that are not plain identifiers', () => {
    const d = diffJson({ 'x-total': 1 }, { 'x-total': 2 });
    expect(d[0]!.path).toBe('$["x-total"]');
  });

  it('is symmetric in what it detects', () => {
    const a = { a: 1, b: { c: [1, 2] } };
    const b = { a: 2, b: { c: [1] }, d: 1 };
    expect(diffJson(a, b)).toHaveLength(diffJson(b, a).length);
  });
});

function run(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    outcome: 'ok',
    status: 200,
    durationMs: 10,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '42', name: 'Widget' }),
    ...over,
  };
}

describe('diffRuns', () => {
  it('two identical replays are identical, ignoring latency and volatile headers', () => {
    const a = run({ headers: { 'content-type': 'application/json', date: 'Mon', 'x-ratelimit-remaining': '99' } });
    const b = run({
      durationMs: 400,
      headers: { 'content-type': 'application/json', date: 'Tue', 'x-ratelimit-remaining': '98' },
    });
    const d = diffRuns(a, b);
    expect(d.identical).toBe(true);
    expect(d.durationDeltaMs).toBe(390);
  });

  it('detects a chaos-injected failure: status, headers and body all differ', () => {
    const clean = run();
    const faulty = run({
      status: 503,
      headers: { 'content-type': 'application/json', 'x-throttlebox-chaos-injected': 'true' },
      body: JSON.stringify({ error: 'chaos_fault_injected', statusCode: 503 }),
    });
    const d = diffRuns(clean, faulty);
    expect(d.identical).toBe(false);
    expect(d.status).toEqual({ before: 200, after: 503 });
    expect(d.headers.some((h) => h.path.includes('chaos-injected') && h.kind === 'added')).toBe(true);
    expect(d.body.length).toBeGreaterThan(0);
  });

  it('flags a dropped connection even though there is no status', () => {
    const d = diffRuns(run(), run({ outcome: 'dropped', status: null, body: '', headers: {} }));
    expect(d.outcome).toEqual({ before: 'ok', after: 'dropped' });
    expect(d.status).toEqual({ before: 200, after: null });
  });

  it('falls back to string comparison for non-JSON bodies', () => {
    expect(diffRuns(run({ body: 'hello' }), run({ body: 'world' })).body).toEqual([
      { path: '$', kind: 'changed', before: 'hello', after: 'world' },
    ]);
  });

  it('header names are compared case-insensitively', () => {
    const d = diffRuns(run({ headers: { 'X-Total': '1' } }), run({ headers: { 'x-total': '1' } }));
    expect(d.headers).toEqual([]);
  });

  it('honours a custom ignore list', () => {
    const a = run({ headers: { 'x-a': '1' } });
    const b = run({ headers: { 'x-a': '2' } });
    expect(diffRuns(a, b).identical).toBe(false);
    expect(diffRuns(a, b, { ignoreHeaders: ['x-a'] }).identical).toBe(true);
  });
});

describe('playground permissions', () => {
  it.each([
    ['owner', 'playground:run', true],
    ['admin', 'playground:run', true],
    ['dev', 'playground:run', true],
    ['viewer', 'playground:run', false],
    ['viewer', 'playground:read', true],
    ['dev', 'playground:read', true],
  ] as const)('%s / %s -> %s', (role, perm, expected) => {
    expect(roleHasPermission(role, perm)).toBe(expected);
  });
});
