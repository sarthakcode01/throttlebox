import { describe, expect, it } from 'vitest';
import {
  buildDisplayPrefix,
  buildKey,
  parseKey,
  PUBLIC_ID_LENGTH,
  randomBase62,
  SECRET_LENGTH,
} from '../../src/keys/format.js';

describe('randomBase62', () => {
  it('returns the requested length', () => {
    expect(randomBase62(1)).toHaveLength(1);
    expect(randomBase62(12)).toHaveLength(12);
    expect(randomBase62(32)).toHaveLength(32);
  });

  it('only emits base62 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomBase62(32)).toMatch(/^[0-9A-Za-z]{32}$/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(randomBase62(12));
    }
    expect(seen.size).toBe(1000);
  });

  it('uses the whole alphabet rather than a biased subset', () => {
    // A `byte % 62` implementation would under-represent the first 8
    // characters of the alphabet, because 256 is not a multiple of 62.
    const counts = new Map<string, number>();
    const sample = randomBase62(20_000);

    for (const char of sample) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }

    expect(counts.size).toBe(62);

    const expected = 20_000 / 62;
    for (const [char, count] of counts) {
      // A 20% band comfortably covers sampling noise while still failing on
      // the modulo bias, which would push the first 8 characters well outside
      // it.
      expect(count, `character ${char} appeared ${count} times`).toBeGreaterThan(expected * 0.8);
      expect(count, `character ${char} appeared ${count} times`).toBeLessThan(expected * 1.2);
    }
  });
});

/** A syntactically valid key: 12-char public id, 32-char secret. */
const PUBLIC_ID = '9Kd2mQxR7tYb';
const SECRET = 'zF1cH6jV0gN5eU4tR8wB3nL6kJ9pQ2vX';
const VALID_KEY = `sk_live_${PUBLIC_ID}_${SECRET}`;

describe('key fixtures', () => {
  it('has the lengths the format requires', () => {
    expect(PUBLIC_ID).toHaveLength(PUBLIC_ID_LENGTH);
    expect(SECRET).toHaveLength(SECRET_LENGTH);
  });
});

describe('parseKey', () => {
  it('parses a well-formed key', () => {
    const parsed = parseKey(VALID_KEY);
    expect(parsed).not.toBeNull();
    expect(parsed?.env).toBe('live');
    expect(parsed?.publicId).toHaveLength(PUBLIC_ID_LENGTH);
    expect(parsed?.secret).toHaveLength(SECRET_LENGTH);
  });

  it('round-trips through buildKey', () => {
    const parsed = parseKey(VALID_KEY)!;
    expect(buildKey(parsed.env, parsed.publicId, parsed.secret)).toBe(VALID_KEY);
    expect(parseKey(buildKey(parsed.env, parsed.publicId, parsed.secret))).toEqual(parsed);
  });

  it('rejects a truncated key', () => {
    expect(parseKey(VALID_KEY.slice(0, -1))).toBeNull();
  });

  it('rejects a key with the wrong arity', () => {
    expect(parseKey('sk_live_9Kd2mQxR7tYb')).toBeNull();
    expect(parseKey(`sk_live_${PUBLIC_ID}_${SECRET}_extra`)).toBeNull();
  });

  it('rejects an unknown environment', () => {
    expect(parseKey(VALID_KEY.replace('sk_live_', 'sk_prod_'))).toBeNull();
  });

  it('rejects a wrong key-type marker', () => {
    expect(parseKey(VALID_KEY.replace('sk_', 'pk_'))).toBeNull();
  });

  it('rejects non-base62 characters in the secret', () => {
    const broken = VALID_KEY.slice(0, -1) + '-';
    expect(parseKey(broken)).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseKey('')).toBeNull();
  });

  it('rejects a key whose public id is the wrong length', () => {
    expect(parseKey(`sk_live_short_${SECRET}`)).toBeNull();
  });

  it('rejects a key whose secret is the wrong length', () => {
    expect(parseKey(`sk_live_${PUBLIC_ID}_${SECRET.slice(0, 30)}`)).toBeNull();
  });
});

describe('buildDisplayPrefix', () => {
  it('exposes the environment and public id but not the secret', () => {
    const prefix = buildDisplayPrefix('live', '9Kd2mQxR7tYb');
    expect(prefix).toBe('sk_live_9Kd2mQxR7tYb');
    expect(prefix.split('_')).toHaveLength(3);
  });
});
