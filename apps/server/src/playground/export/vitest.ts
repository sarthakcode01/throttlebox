import type { PlaygroundRequest } from '@throttlebox/shared';
import { effectiveHeaders } from './headers.js';
import { inferShape } from './shape.js';

export interface VitestExportOptions {
  sessionName: string;
  baseUrl: string;
  /** Emit live tests for requests that captured a chaos fault, throttle or dropped socket. */
  includeFaults?: boolean;
}

/** A response produced by chaos or the limiter says nothing stable about the API. */
export function isFaultRun(r: PlaygroundRequest): boolean {
  return (
    r.outcome !== 'ok' ||
    r.responseStatus === 429 ||
    r.responseHeaders['x-throttlebox-chaos-injected'] === 'true' ||
    r.responseHeaders['x-throttlebox-chaos-latency'] !== undefined
  );
}

function lit(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `      ${line}`))
    .join('\n');
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Escape text for use inside a single-quoted JS string. */
function sq(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' ');
}

function testFor(r: PlaygroundRequest, index: number, includeFaults: boolean): string {
  const qs = Object.keys(r.query).length ? `?${new URLSearchParams(r.query).toString()}` : '';
  const title = sq(`#${index + 1} ${r.method} /mock/${r.serviceSlug}${r.path}${qs}`);

  if (isFaultRun(r) && !includeFaults) {
    const why =
      r.outcome === 'dropped'
        ? 'the connection was dropped by chaos'
        : r.responseStatus === 429
          ? 'the request was rate limited'
          : 'a chaos fault was injected';
    return `  // Captured while ${why}, so the expectation is not stable. Re-capture with chaos off to enable it.\n  it.skip('${title}', async () => {});`;
  }

  const lines: string[] = [];
  lines.push(`  it('${title}', async () => {`);
  lines.push(
    `    const res = await call(${JSON.stringify(r.method)}, ${JSON.stringify(`/mock/${r.serviceSlug}${r.path}`)}, {`,
  );
  if (Object.keys(r.query).length) lines.push(`      query: ${lit(r.query)},`);
  const headers = effectiveHeaders(r);
  if (Object.keys(headers).length) lines.push(`      headers: ${lit(headers)},`);
  if (r.body) lines.push(`      body: ${JSON.stringify(r.body)},`);
  lines.push('    });');

  if (r.responseStatus === null) {
    lines.push('    expect(res).toBeNull();');
  } else {
    lines.push('    expect(res).not.toBeNull();');
    lines.push(`    expect(res!.status).toBe(${r.responseStatus});`);
    if (!r.responseTruncated) {
      const parsed = parseJson(r.responseBody);
      if (parsed.ok) {
        lines.push('    const json = await res!.json();');
        lines.push(`    expect(shapeOf(json)).toEqual(${lit(inferShape(parsed.value))});`);
        lines.push(`    expect(json).toEqual(${lit(parsed.value)});`);
      } else if (r.responseBody !== '') {
        lines.push(`    expect(await res!.text()).toBe(${JSON.stringify(r.responseBody)});`);
      }
    }
  }
  lines.push('  });');
  return lines.join('\n');
}

const PRELUDE = `import { describe, expect, it } from 'vitest';

const BASE_URL = (process.env.THROTTLEBOX_BASE_URL ?? __BASE_URL__).replace(/\\/$/, '');
const API_KEY = process.env.THROTTLEBOX_API_KEY ?? '';

async function call(
  method: string,
  path: string,
  options: { query?: Record<string, string>; headers?: Record<string, string>; body?: string } = {},
): Promise<Response | null> {
  const qs = new URLSearchParams(options.query ?? {}).toString();
  try {
    return await fetch(\`\${BASE_URL}\${path}\${qs ? \`?\${qs}\` : ''}\`, {
      method,
      headers: { ...options.headers, Authorization: \`Bearer \${API_KEY}\` },
      body: options.body,
    });
  } catch {
    return null; // connection dropped
  }
}

type Shape = string | Shape[] | { [key: string]: Shape };
function shapeOf(value: unknown): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === 'object') {
    const out: { [key: string]: Shape } = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}
`;

/**
 * Generate a self-contained Vitest file from captured requests.
 *
 * The file imports only `vitest`, reads the key from `THROTTLEBOX_API_KEY`
 * (a secret never belongs in a generated file) and the host from
 * `THROTTLEBOX_BASE_URL`. Mock responses are deterministic, so asserting the
 * exact body is safe, and the shape assertion documents the contract.
 */
export function toVitest(requests: PlaygroundRequest[], options: VitestExportOptions): string {
  const name = options.sessionName.replace(/[\r\n]+/g, ' ');
  const prelude = PRELUDE.replace('__BASE_URL__', JSON.stringify(options.baseUrl));
  const tests = requests.map((r, i) => testFor(r, i, options.includeFaults ?? false));

  return `// Generated by Throttlebox Time-Travel Playground.
// Session: ${name}
//
// Run: THROTTLEBOX_API_KEY=sk_test_... THROTTLEBOX_BASE_URL=${options.baseUrl} npx vitest run <this file>
${prelude}
describe('${sq(name)}', () => {
${tests.join('\n\n')}
});
`;
}
