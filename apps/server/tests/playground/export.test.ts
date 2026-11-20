import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { diffRuns, type PlaygroundRequest, type RunSnapshot } from '@throttlebox/shared';
import { inferShape } from '../../src/playground/export/shape.js';
import { isFaultRun, toVitest } from '../../src/playground/export/vitest.js';
import { toPostman } from '../../src/playground/export/postman.js';
import { createApiKey, signUp, startApp, type Client, type TestApp } from '../helpers/app.js';

function fakeRequest(over: Partial<PlaygroundRequest> = {}): PlaygroundRequest {
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
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: JSON.stringify({ id: '42', name: 'Widget', tags: ['a'] }),
    responseTruncated: false,
    durationMs: 5,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('inferShape', () => {
  it('describes structure, not values', () => {
    expect(inferShape({ b: 1, a: 'x', c: null, d: true, e: { f: [1, 2] }, g: [] })).toEqual({
      a: 'string',
      b: 'number',
      c: 'null',
      d: 'boolean',
      e: { f: ['number'] },
      g: [],
    });
  });

  it('uses the first array element and gives equal shapes for different values', () => {
    expect(inferShape([{ id: 1 }, { id: 2 }])).toEqual([{ id: 'number' }]);
    expect(inferShape({ name: 'a' })).toEqual(inferShape({ name: 'b' }));
  });
});

describe('toVitest (generator output)', () => {
  it('produces a self-contained file that imports only vitest and reads secrets from env', () => {
    const code = toVitest([fakeRequest()], { sessionName: 'Smoke', baseUrl: 'http://localhost:3001' });
    const imports = code.match(/^import .* from '.*';$/gm);
    expect(imports).toEqual(["import { describe, expect, it } from 'vitest';"]);
    expect(code).toContain('process.env.THROTTLEBOX_API_KEY');
    expect(code).toContain('process.env.THROTTLEBOX_BASE_URL');
    expect(code).toContain('describe(\'Smoke\'');
    expect(code).toContain('expect(res!.status).toBe(200);');
    expect(code).toContain('expect(shapeOf(json)).toEqual(');
    expect(code).toContain('expect(json).toEqual(');
  });

  it('never embeds an API key or authorization value', () => {
    const code = toVitest([fakeRequest({ headers: { 'x-ok': '1' } })], {
      sessionName: 'S',
      baseUrl: 'http://x',
    });
    expect(code).not.toMatch(/sk_(test|live)_[A-Za-z0-9]{12}_/);
    expect(code).not.toMatch(/Bearer sk_/);
  });

  it('escapes hostile session names and request titles', () => {
    const code = toVitest([fakeRequest({ path: "/it's" })], {
      sessionName: "x'); process.exit(1); //\nnext",
      baseUrl: 'http://x',
    });
    // The newline in the name must not start a new line of code.
    expect(code.split('\n').some((l) => l.startsWith('next'))).toBe(false);
    // The quote that would close the string literal is escaped.
    expect(code).toContain("describe('x\\'); process.exit(1); // next'");
    expect(code).toContain("it\\'s");
  });

  it('skips fault captures by default and enables them on request', () => {
    const faulty = fakeRequest({
      responseStatus: 503,
      responseHeaders: { 'x-throttlebox-chaos-injected': 'true' },
    });
    expect(isFaultRun(faulty)).toBe(true);
    expect(toVitest([faulty], { sessionName: 'S', baseUrl: 'http://x' })).toContain('it.skip(');
    expect(toVitest([faulty], { sessionName: 'S', baseUrl: 'http://x', includeFaults: true })).toContain(
      'expect(res!.status).toBe(503);',
    );
  });

  it.each([
    ['dropped', { outcome: 'dropped' as const, responseStatus: null }],
    ['rate limited', { responseStatus: 429 }],
    ['chaos latency', { responseHeaders: { 'x-throttlebox-chaos-latency': '200ms' } }],
  ])('treats a %s capture as a fault', (_l, over) => {
    expect(isFaultRun(fakeRequest(over))).toBe(true);
  });

  it('asserts text bodies verbatim and skips body assertions when truncated', () => {
    const text = toVitest([fakeRequest({ responseBody: 'plain text' })], { sessionName: 'S', baseUrl: 'http://x' });
    expect(text).toContain('expect(await res!.text()).toBe("plain text");');
    const trunc = toVitest([fakeRequest({ responseTruncated: true })], { sessionName: 'S', baseUrl: 'http://x' });
    expect(trunc).not.toContain('toEqual(');
    expect(trunc).toContain('toBe(200)');
  });

  it('includes query, headers and body in the call', () => {
    const code = toVitest(
      [fakeRequest({ method: 'POST', query: { a: '1' }, headers: { 'x-k': 'v' }, body: '{"n":1}' })],
      { sessionName: 'S', baseUrl: 'http://x' },
    );
    expect(code).toContain('"a": "1"');
    expect(code).toContain('"x-k": "v"');
    expect(code).toContain('body: "{\\"n\\":1}"');
  });
});

describe('toPostman', () => {
  it('builds a v2.1 collection with variables and no secret', () => {
    const c = toPostman([fakeRequest({ query: { page: '2' }, body: '{"a":1}', method: 'POST' })], {
      sessionName: 'My Col',
      baseUrl: 'http://localhost:3001',
    }) as {
      info: { name: string; schema: string };
      variable: { key: string; value: string }[];
      auth: { bearer: { value: string }[] };
      item: { name: string; request: { method: string; url: { raw: string; path: string[] }; body?: { raw: string } } }[];
    };
    expect(c.info.schema).toContain('v2.1.0');
    expect(c.info.name).toBe('My Col');
    expect(c.variable).toEqual([
      { key: 'baseUrl', value: 'http://localhost:3001' },
      { key: 'apiKey', value: '' },
    ]);
    expect(c.auth.bearer[0]!.value).toBe('{{apiKey}}');
    const item = c.item[0]!;
    expect(item.request.method).toBe('POST');
    expect(item.request.url.raw).toBe('{{baseUrl}}/mock/ecommerce/products/42?page=2');
    expect(item.request.url.path).toEqual(['mock', 'ecommerce', 'products', '42']);
    expect(item.request.body?.raw).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------------
// The export routes and the Phase 7 exit criterion, against a real server.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const scratchRoot = resolve(here, '../../.tmp-playground-export');
let t: TestApp;
let baseUrl: string;

beforeAll(async () => {
  t = await startApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  mkdirSync(scratchRoot, { recursive: true });
});
afterAll(async () => {
  await t.close();
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** Run a generated test file with a real `vitest run`, exactly as a user would. */
async function runGenerated(code: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(scratchRoot, 'run-'));
  writeFileSync(join(dir, 'generated.gen.ts'), code);
  writeFileSync(
    join(dir, 'vitest.config.mjs'),
    `export default { test: { include: ['**/*.gen.ts'], root: ${JSON.stringify(dir)}, globals: false } };\n`,
  );
  const vitestBin = join(
    dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
    'vitest.mjs',
  );
  return new Promise<{ code: number | null; out: string }>((resolveRun) => {
    const child = spawn(process.execPath, [vitestBin, 'run', '--config', join(dir, 'vitest.config.mjs')], {
      cwd: dir,
      env: { ...process.env, ...env, CI: '1', NO_COLOR: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (c) => resolveRun({ code: c, out }));
  });
}

async function setup(label: string) {
  const owner = await signUp(t, label);
  const key = await createApiKey(owner);
  const session = (await owner.post('/api/playground/sessions').send({ name: 'Exit Criterion' })).body
    .session;
  return { owner, key, session };
}

function snap(r: PlaygroundRequest): RunSnapshot {
  return {
    outcome: r.outcome,
    status: r.responseStatus,
    durationMs: r.durationMs,
    headers: r.responseHeaders,
    body: r.responseBody,
  };
}

async function sendProduct(owner: Client, sessionId: string, keyId: string, id: string) {
  const res = await owner.post(`/api/playground/sessions/${sessionId}/send`).send({
    keyId,
    method: 'GET',
    serviceSlug: 'ecommerce',
    path: `/products/${id}`,
  });
  expect(res.status).toBe(201);
  return res.body.request as PlaygroundRequest;
}

describe('export routes', () => {
  it('serves a Vitest file as an attachment, collapsing repeated runs of the same request', async () => {
    const { owner, key, session } = await setup('pg-exp-route');
    await sendProduct(owner, session.id, key.id, '1');
    await sendProduct(owner, session.id, key.id, '2');
    await sendProduct(owner, session.id, key.id, '1'); // repeat of the first

    const res = await owner.get(`/api/playground/sessions/${session.id}/export?format=vitest`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="exit-criterion.test.ts"');
    expect(res.headers['content-type']).toContain('text/plain');
    const text = res.text;
    expect(text.match(/\bit\('#/g)).toHaveLength(2); // 3 sends, 2 unique
    expect(text).toContain('/mock/ecommerce/products/1');
    expect(text).toContain('/mock/ecommerce/products/2');
  });

  it('exports a POST body with the JSON content type the runner applied by default', async () => {
    const code = toVitest([fakeRequest({ method: 'POST', body: '{"a":1}', headers: {} })], {
      sessionName: 'S',
      baseUrl: 'http://x',
    });
    expect(code).toContain('"content-type": "application/json"');
    const kept = toVitest([fakeRequest({ method: 'POST', body: 'a=1', headers: { 'content-type': 'text/plain' } })], {
      sessionName: 'S',
      baseUrl: 'http://x',
    });
    expect(kept).toContain('"content-type": "text/plain"');
    expect(kept).not.toContain('application/json');
  });

  it('exports exactly the requested ids without deduplicating', async () => {
    const { owner, key, session } = await setup('pg-exp-ids');
    const a = await sendProduct(owner, session.id, key.id, '1');
    const b = await sendProduct(owner, session.id, key.id, '1');
    await sendProduct(owner, session.id, key.id, '3');
    const res = await owner.get(`/api/playground/sessions/${session.id}/export?ids=${a.id},${b.id}`);
    expect(res.text.match(/\bit\('#/g)).toHaveLength(2);
    expect(res.text).not.toContain('/products/3');
  });

  it('serves a Postman collection', async () => {
    const { owner, key, session } = await setup('pg-exp-postman');
    await sendProduct(owner, session.id, key.id, '5');
    const res = await owner.get(`/api/playground/sessions/${session.id}/export?format=postman`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('.postman_collection.json');
    expect(res.body.info.schema).toContain('collection/v2.1.0');
    expect(res.body.item).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(key.key);
  });

  it('rejects an unknown format and malformed ids', async () => {
    const { owner, session } = await setup('pg-exp-bad');
    expect((await owner.get(`/api/playground/sessions/${session.id}/export?format=yaml`)).status).toBe(400);
    expect((await owner.get(`/api/playground/sessions/${session.id}/export?ids=nope`)).status).toBe(400);
  });
});

describe('Phase 7 exit criterion: send -> change chaos -> replay -> diff -> export a Vitest file that passes', () => {
  it('works end to end, and the exported file is a real, meaningful test', async () => {
    const { owner, key, session } = await setup('pg-exit');

    // 1. Send a request.
    const clean = await sendProduct(owner, session.id, key.id, '42');
    expect(clean.responseStatus).toBe(200);

    // 2. Modify chaos.
    await owner.put('/api/chaos').send({
      isEnabled: true,
      latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
      errors: { enabled: true, rate5xx: 1, rate429: 0, statusCodes: [503] },
      partition: { enabled: false, dropRate: 0 },
    });

    // 3. Replay.
    const replay = (await owner.post(`/api/playground/requests/${clean.id}/replay`).send({}))
      .body.request as PlaygroundRequest;
    expect(replay.responseStatus).toBe(503);

    // 4. Diff.
    const diff = diffRuns(snap(clean), snap(replay));
    expect(diff.identical).toBe(false);
    expect(diff.status).toEqual({ before: 200, after: 503 });
    expect(diff.headers.some((h) => h.path.includes('chaos-injected'))).toBe(true);
    expect(diff.body.length).toBeGreaterThan(0);

    // 5. Export the clean capture as a Vitest file.
    const exported = await owner.get(`/api/playground/sessions/${session.id}/export?ids=${clean.id}`);
    expect(exported.status).toBe(200);
    const file = exported.text;

    // 6a. With chaos off, the exported test passes against the live server.
    await owner.post('/api/chaos/reset');
    const passing = await runGenerated(file, {
      THROTTLEBOX_API_KEY: key.key,
      THROTTLEBOX_BASE_URL: baseUrl,
    });
    expect(passing.out).toMatch(/1 passed/);
    expect(passing.code).toBe(0);

    // 6b. It is a real test: when the API misbehaves again, it fails.
    await owner.put('/api/chaos').send({
      isEnabled: true,
      latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
      errors: { enabled: true, rate5xx: 1, rate429: 0, statusCodes: [503] },
      partition: { enabled: false, dropRate: 0 },
    });
    const failing = await runGenerated(file, {
      THROTTLEBOX_API_KEY: key.key,
      THROTTLEBOX_BASE_URL: baseUrl,
    });
    expect(failing.code).not.toBe(0);
    expect(failing.out).toMatch(/1 failed/);

    // 6c. And it fails without a valid key, rather than passing vacuously.
    await owner.post('/api/chaos/reset');
    const noKey = await runGenerated(file, { THROTTLEBOX_API_KEY: 'sk_test_bad', THROTTLEBOX_BASE_URL: baseUrl });
    expect(noKey.code).not.toBe(0);
  }, 90_000);

  it('a session containing a chaos-faulted capture exports it as a skipped test and the file still passes', async () => {
    const { owner, key, session } = await setup('pg-exit-skip');
    await sendProduct(owner, session.id, key.id, '1');
    await owner.put('/api/chaos').send({
      isEnabled: true,
      latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
      errors: { enabled: true, rate5xx: 1, rate429: 0, statusCodes: [500] },
      partition: { enabled: false, dropRate: 0 },
    });
    await sendProduct(owner, session.id, key.id, '2'); // captured as a fault
    await owner.post('/api/chaos/reset');

    const file = (await owner.get(`/api/playground/sessions/${session.id}/export`)).text;
    expect(file).toContain('it.skip(');
    const run = await runGenerated(file, { THROTTLEBOX_API_KEY: key.key, THROTTLEBOX_BASE_URL: baseUrl });
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/1 passed/);
    expect(run.out).toMatch(/1 skipped/);
  }, 90_000);

  it('a POST with a body round-trips through capture and export', async () => {
    const { owner, key, session } = await setup('pg-exit-post');
    const svc = await owner.post('/api/mock/services').send({ name: 'Echo2', slug: 'echo2' });
    await owner.post(`/api/mock/services/${svc.body.service.id}/routes`).send({
      method: 'POST',
      path: '/items',
      statusCode: 201,
      responseTemplate: { created: true, name: '{{body.name}}' },
    });
    const sent = await owner.post(`/api/playground/sessions/${session.id}/send`).send({
      keyId: key.id,
      method: 'POST',
      serviceSlug: 'echo2',
      path: '/items',
      body: JSON.stringify({ name: 'Gadget' }),
    });
    expect(sent.body.request.responseStatus).toBe(201);
    expect(JSON.parse(sent.body.request.responseBody)).toEqual({ created: true, name: 'Gadget' });

    const file = (await owner.get(`/api/playground/sessions/${session.id}/export`)).text;
    const run = await runGenerated(file, { THROTTLEBOX_API_KEY: key.key, THROTTLEBOX_BASE_URL: baseUrl });
    expect(run.out).toMatch(/1 passed/);
    expect(run.code).toBe(0);
  }, 90_000);
});
