import { createHash } from 'node:crypto';
import { Faker, en } from '@faker-js/faker';

/**
 * The mock response template engine.
 *
 * Templates are JSON documents that may contain `{{...}}` expressions:
 *
 *   { "id": "{{params.id}}", "name": "{{faker.commerce.productName}}" }
 *   { "total": {{faker.number.int 10 500}} }
 *
 * The rules that make this safe:
 *
 *  - **No `eval`, ever.** An expression is a dotted path plus literal
 *    arguments. It is resolved by walking an object graph, never by compiling
 *    a string.
 *
 *  - **A closed surface.** Only the faker namespaces listed below are
 *    reachable. `helpers` is excluded because those functions need arguments
 *    this syntax cannot express, and `faker.fake` would let a template
 *    evaluate another template.
 *
 *  - **Prototype pollution is blocked.** `__proto__`, `constructor`, and
 *    `prototype` are refused at every step, and only own properties are read.
 *
 *  - **The whole thing is wrapped.** A template cannot take the server down:
 *    a failure resolves to `undefined` and the response still renders.
 *
 * A string that is *exactly* one expression resolves to the raw value, so
 * `{{faker.number.int 1 10}}` produces the number 7, not the string "7".
 */

/**
 * Faker namespaces a template may reach.
 *
 * `helpers` is deliberately excluded: those functions need arguments this
 * syntax cannot express, and `faker.helpers.fake` would let a template
 * evaluate another template. `fakerCore` is internal plumbing.
 */
const ALLOWED_FAKER_NAMESPACES = new Set([
  'airline',
  'animal',
  'book',
  'color',
  'commerce',
  'company',
  'database',
  'datatype',
  'date',
  'finance',
  'food',
  'git',
  'hacker',
  'image',
  'internet',
  'location',
  'lorem',
  'music',
  'number',
  'person',
  'phone',
  'science',
  'string',
  'system',
  'vehicle',
  'word',
]);

/** Property names that must never be traversed. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deepest path we will walk. Stops pathological expressions. */
const MAX_PATH_DEPTH = 6;

/** How far back a generated timestamp can be. Keeps `{{now}}` plausible. */
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The start of the current UTC day.
 *
 * The generated timestamp is anchored here rather than to the exact current
 * instant, so it is stable for the whole day. Anchoring to `Date.now()` would
 * make every response differ by a millisecond, which is exactly the kind of
 * flake a mock API should not introduce.
 */
function startOfUtcDay(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

const EXPRESSION_PATTERN = /\{\{\s*([^}]*?)\s*\}\}/g;
/** An expression is a dotted path plus optional literal arguments. */
const EXPRESSION_PATTERN_STRICT = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

export interface TemplateContext {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  faker: Faker;
  /** A stable, plausible timestamp for the request. */
  now: string;
}

/**
 * A deterministic seed derived from the request.
 *
 * Two goals: the same request always produces the same data, so a developer
 * can rely on a product having a stable id and price across calls, and
 * different resources produce different data, so a list is not twenty copies
 * of the same product.
 */
export function seedFrom(...parts: string[]): number {
  const hash = createHash('sha256').update(parts.join('|')).digest();
  // Faker takes a 32-bit seed.
  return hash.readUInt32BE(0);
}

export function createTemplateContext(input: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  seed: number;
}): TemplateContext {
  // A fresh Faker instance per request, rather than seeding the shared
  // global one. The global instance is a single mutable object, so two
  // concurrent requests would fight over its seed.
  const seeded = new Faker({ locale: [en] });
  seeded.seed(input.seed);

  return {
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? null,
    headers: input.headers ?? {},
    faker: seeded,
    // A stable, plausible timestamp for the request: the same request always
    // produces the same response, so a developer's assertions do not become
    // flaky — but it still looks like a real recent time.
    now: new Date(startOfUtcDay() - (input.seed % RECENT_WINDOW_MS)).toISOString(),
  };
}

/**
 * Walk a dotted path through the context.
 *
 * Returns the resolved value, or `undefined` if the path is malformed,
 * forbidden, or does not exist.
 */
function resolvePath(context: TemplateContext, path: string): unknown {
  const segments = path.split('.');

  if (segments.length === 0 || segments.length > MAX_PATH_DEPTH) return undefined;
  if (!EXPRESSION_PATTERN_STRICT.test(path)) return undefined;

  let current: unknown = context;

  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object' && typeof current !== 'function') return undefined;

    // Own properties only — inherited ones (`toString`, `__proto__`, …) are
    // never visible to a template.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Parse a literal value: a number, a quoted string, or a boolean.
 *
 * Anything else is dropped, which keeps the argument surface closed.
 */
function parseLiteral(token: string): number | string | boolean | undefined {
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (token === 'true') return true;
  if (token === 'false') return false;

  const quoted = /^"([^"\\]*)"$|^'([^'\\]*)'$/.exec(token);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';

  return undefined;
}

/**
 * Parse the arguments of an expression.
 *
 * Two styles are supported, because faker uses both:
 *
 *   `{{faker.string.alphanumeric 10}}`      → positional: `alphanumeric(10)`
 *   `{{faker.number.int min=1 max=10000}}`  → named: `int({ min: 1, max: 10000 })`
 *
 * The named form exists because faker's numeric helpers take a single
 * options object, not a `min, max` pair. Passing `int(1, 10000)` silently
 * means "max 1" and returns values below the requested minimum.
 */
function parseArgs(tokens: string[]): unknown[] {
  const named: Record<string, number | string | boolean> = {};
  const positional: (number | string | boolean)[] = [];
  let hasNamed = false;

  for (const token of tokens) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(token);
    if (assignment) {
      const value = parseLiteral(assignment[2] ?? '');
      if (value !== undefined) {
        named[assignment[1] as string] = value;
        hasNamed = true;
      }
      continue;
    }

    const value = parseLiteral(token);
    if (value !== undefined) positional.push(value);
  }

  if (hasNamed) return [named];
  return positional;
}

/**
 * Resolve one expression body — the text between `{{` and `}}`.
 */
function resolveExpression(context: TemplateContext, expression: string): unknown {
  const tokens = expression.split(/\s+/).filter(Boolean);
  const path = tokens[0];
  if (path === undefined) return undefined;

  const rest = tokens.slice(1);

  // The first segment may be `faker`, which has its own gate.
  if (path === 'faker' || path.startsWith('faker.')) {
    const namespace = path.split('.')[1];
    if (!namespace || !ALLOWED_FAKER_NAMESPACES.has(namespace)) return undefined;
  }

  const resolved = resolvePath(context, path);
  if (typeof resolved !== 'function') {
    // A literal argument acts as a default, so `{{query.page "1"}}` falls
    // back to "1" when the caller did not send the parameter.
    if (resolved === undefined && !path.startsWith('faker.')) {
      const fallback = parseArgs(rest);
      if (fallback.length > 0) return fallback[0];
    }
    return resolved;
  }

  // Calling a resolved function is only meaningful for faker helpers.
  if (!path.startsWith('faker.')) return undefined;

  try {
    const args = parseArgs(rest);
    return (resolved as (...a: unknown[]) => unknown)(...args);
  } catch {
    return undefined;
  }
}

/**
 * Render a string that may contain expressions.
 *
 * When the string is exactly one expression the raw value is returned, which
 * preserves types. Otherwise the resolved values are interpolated as text.
 */
function renderString(template: string, context: TemplateContext): unknown {
  const exact = /^\{\{\s*([^}]*?)\s*\}\}$/.exec(template);
  if (exact) {
    return resolveExpression(context, exact[1] ?? '');
  }

  return template.replace(EXPRESSION_PATTERN, (_match, expression: string) => {
    const value = resolveExpression(context, expression);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Render a template.
 *
 * Objects and arrays are walked recursively. Anything that is not a string,
 * object, or array is returned as-is — numbers and booleans in a template are
 * literals.
 */
export function renderTemplate(template: unknown, context: TemplateContext): unknown {
  if (typeof template === 'string') {
    return renderString(template, context);
  }

  if (Array.isArray(template)) {
    return template.map((item) => renderTemplate(item, context));
  }

  if (template !== null && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      // A key that resolves to a function is left out, so a template cannot
      // smuggle a callable into a response.
      const rendered = renderTemplate(value, context);
      if (rendered === undefined) continue;
      out[key] = rendered;
    }
    return out;
  }

  return template;
}

/**
 * JSON stringification that survives circular references.
 *
 * Faker occasionally returns objects with shared references. `JSON.stringify`
 * throws on a cycle, and a mock response must never be the thing that breaks
 * the request.
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      },
      2,
    );
  } catch {
    return JSON.stringify({ error: 'response could not be serialized' });
  }
}
