import { describe, expect, it } from 'vitest';
import { createTemplateContext, renderTemplate, seedFrom } from '../../src/mock/template.js';

function context(overrides: Partial<Parameters<typeof createTemplateContext>[0]> = {}) {
  return createTemplateContext({
    params: { id: '42' },
    query: { page: '3' },
    body: { name: 'Widget' },
    headers: {},
    seed: seedFrom('test'),
    ...overrides,
  });
}

describe('template rendering', () => {
  it('resolves a path parameter', () => {
    const result = renderTemplate({ id: '{{params.id}}' }, context());
    expect(result).toEqual({ id: '42' });
  });

  it('preserves the type of an exact expression', () => {
    const result = renderTemplate({ count: '{{faker.number.int min=1 max=10}}' }, context());
    const count = (result as { count: number }).count;
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(10);
  });

  it('interpolates into a larger string', () => {
    const result = renderTemplate({ text: 'product #{{params.id}} is here' }, context());
    expect(result).toEqual({ text: 'product #42 is here' });
  });

  it('resolves a query parameter', () => {
    const result = renderTemplate({ page: '{{query.page}}' }, context());
    expect(result).toEqual({ page: '3' });
  });

  it('falls back to a literal default when a parameter is missing', () => {
    const result = renderTemplate({ page: '{{query.missing "1"}}' }, context());
    expect(result).toEqual({ page: '1' });
  });

  it('omits a key whose expression resolves to nothing', () => {
    const result = renderTemplate({ id: '{{params.nope}}', keep: 'yes' }, context());
    expect(result).toEqual({ keep: 'yes' });
  });

  it('walks arrays and nested objects', () => {
    const result = renderTemplate(
      { items: [{ id: '{{params.id}}' }, { id: 'static' }] },
      context(),
    );
    expect(result).toEqual({ items: [{ id: '42' }, { id: 'static' }] });
  });

  it('leaves literals alone', () => {
    const result = renderTemplate({ n: 7, b: true, s: 'plain' }, context());
    expect(result).toEqual({ n: 7, b: true, s: 'plain' });
  });

  it('is deterministic for the same seed', () => {
    const template = { name: '{{faker.person.fullName}}' };
    const first = renderTemplate(template, context({ seed: seedFrom('a') }));
    const second = renderTemplate(template, context({ seed: seedFrom('a') }));
    expect(first).toEqual(second);
  });

  it('produces different data for different seeds', () => {
    const template = { name: '{{faker.person.fullName}}' };
    const first = renderTemplate(template, context({ seed: seedFrom('a') }));
    const second = renderTemplate(template, context({ seed: seedFrom('b') }));
    expect(first).not.toEqual(second);
  });

  it('gives the same request a stable timestamp', () => {
    const template = { at: '{{now}}' };
    const seed = seedFrom('stable');

    const first = renderTemplate(template, context({ seed }));
    const second = renderTemplate(template, context({ seed }));

    expect(first).toEqual(second);
  });

  it('does not share faker state between contexts', () => {
    // Two contexts with different seeds must not interfere, which is the
    // whole reason each request gets its own Faker instance.
    const template = { n: '{{faker.person.firstName}}' };

    const first = renderTemplate(template, context({ seed: seedFrom('a') }));
    const other = renderTemplate(template, context({ seed: seedFrom('b') }));
    const firstAgain = renderTemplate(template, context({ seed: seedFrom('a') }));

    expect(first).not.toEqual(other);

    // A fresh context with the same seed reproduces the same value. If the
    // instances were shared, rendering `other` would have advanced the
    // generator and `firstAgain` would differ.
    expect(firstAgain).toEqual(first);
  });
});

describe('template safety', () => {
  it('refuses to traverse the prototype chain', () => {
    const result = renderTemplate({ x: '{{params.__proto__}}' }, context());
    expect(result).toEqual({});
  });

  it('refuses to reach the constructor', () => {
    const result = renderTemplate({ x: '{{params.constructor}}' }, context());
    expect(result).toEqual({});
  });

  it('refuses a faker namespace that is not on the allowlist', () => {
    const result = renderTemplate({ x: '{{faker.helpers.fake "x"}}' }, context());
    expect(result).toEqual({});
  });

  it('refuses to call a function outside faker', () => {
    const result = renderTemplate({ x: '{{body.toString}}' }, context());
    expect(result).toEqual({});
  });

  it('does not execute arbitrary code in an expression', () => {
    const result = renderTemplate({ x: '{{process.exit(1)}}' }, context());
    expect(result).toEqual({});
  });

  it('ignores an expression with an illegal character', () => {
    const result = renderTemplate({ x: '{{a b; c}}' }, context());
    expect(result).toEqual({});
  });

  it('survives a template that is not an object', () => {
    expect(renderTemplate('plain', context())).toBe('plain');
    expect(renderTemplate(42, context())).toBe(42);
    expect(renderTemplate(null, context())).toBeNull();
  });

  it('never throws on a hostile template', () => {
    const hostile = [
      { a: '{{faker.person.firstName}}', b: '{{__proto__.polluted}}' },
      { c: '{{params.id}}{{params.id}}{{params.id}}' },
      { d: '{{'.repeat(50) },
    ];

    for (const template of hostile) {
      expect(() => renderTemplate(template, context())).not.toThrow();
    }
  });
});
