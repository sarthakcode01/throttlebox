/**
 * Structural JSON diff, used by the Time-Travel Playground to show what
 * changed between two runs of the same request.
 *
 * Pure and dependency-free so it runs identically in the browser and in tests.
 */

export type JsonDiffKind = 'added' | 'removed' | 'changed';

export interface JsonDiffEntry {
  /** Dotted path with bracketed array indexes, e.g. `items[2].price`. `$` is the root. */
  path: string;
  kind: JsonDiffKind;
  before?: unknown;
  after?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinKey(base: string, key: string): string {
  const safe = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `[${JSON.stringify(key)}]`;
  if (base === '$') return safe.startsWith('[') ? `$${safe}` : safe;
  return safe.startsWith('[') ? `${base}${safe}` : `${base}.${safe}`;
}

/**
 * Deep-compare two JSON values. Arrays are compared by index. A value that
 * changes type (object -> array, number -> string, null -> object) is
 * reported as a single `changed` entry at that path rather than recursing.
 */
export function diffJson(before: unknown, after: unknown, path = '$'): JsonDiffEntry[] {
  if (Object.is(before, after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const out: JsonDiffEntry[] = [];
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) {
      const childPath = `${path === '$' ? '$' : path}[${i}]`;
      if (i >= before.length) {
        out.push({ path: childPath, kind: 'added', after: after[i] });
      } else if (i >= after.length) {
        out.push({ path: childPath, kind: 'removed', before: before[i] });
      } else {
        out.push(...diffJson(before[i], after[i], childPath));
      }
    }
    return out;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const out: JsonDiffEntry[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const childPath = joinKey(path, key);
      const inBefore = Object.prototype.hasOwnProperty.call(before, key);
      const inAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (!inBefore) {
        out.push({ path: childPath, kind: 'added', after: after[key] });
      } else if (!inAfter) {
        out.push({ path: childPath, kind: 'removed', before: before[key] });
      } else {
        out.push(...diffJson(before[key], after[key], childPath));
      }
    }
    return out;
  }

  return [{ path, kind: 'changed', before, after }];
}

/** Headers that differ on every request and say nothing about the API's behaviour. */
export const VOLATILE_HEADERS: readonly string[] = [
  'date',
  'content-length',
  'connection',
  'keep-alive',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
  'x-throttlebox-chaos-latency',
];

export interface RunSnapshot {
  outcome: 'ok' | 'dropped' | 'error';
  status: number | null;
  durationMs: number;
  headers: Record<string, string>;
  /** Raw response body text; parsed as JSON when possible. */
  body: string;
}

export interface RunDiff {
  identical: boolean;
  outcome: { before: RunSnapshot['outcome']; after: RunSnapshot['outcome'] } | null;
  status: { before: number | null; after: number | null } | null;
  /** Positive = the second run was slower. */
  durationDeltaMs: number;
  headers: JsonDiffEntry[];
  body: JsonDiffEntry[];
}

function parseBody(body: string): unknown {
  if (body === '') return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function normaliseHeaders(
  headers: Record<string, string>,
  ignore: readonly string[],
): Record<string, string> {
  const skip = new Set(ignore.map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!skip.has(lower)) out[lower] = value;
  }
  return out;
}

/**
 * Compare two captured runs. `identical` ignores latency (it is never
 * exactly equal) and volatile headers, so two replays of an unchanged mock
 * report no differences.
 */
export function diffRuns(
  before: RunSnapshot,
  after: RunSnapshot,
  options: { ignoreHeaders?: readonly string[] } = {},
): RunDiff {
  const ignore = options.ignoreHeaders ?? VOLATILE_HEADERS;

  const outcome = before.outcome === after.outcome ? null : { before: before.outcome, after: after.outcome };
  const status = before.status === after.status ? null : { before: before.status, after: after.status };
  const headers = diffJson(normaliseHeaders(before.headers, ignore), normaliseHeaders(after.headers, ignore));
  const body = diffJson(parseBody(before.body), parseBody(after.body));

  return {
    identical: outcome === null && status === null && headers.length === 0 && body.length === 0,
    outcome,
    status,
    durationDeltaMs: after.durationMs - before.durationMs,
    headers,
    body,
  };
}
