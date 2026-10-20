import { describe, expect, it } from 'vitest';
import { generateKeyMaterial, hashSecret, safeEqualHex } from '../../src/keys/generate.js';
import { parseKey } from '../../src/keys/format.js';
import { redact } from '../../src/keys/redact.js';

describe('generateKeyMaterial', () => {
  it('produces a key in the documented format', () => {
    const material = generateKeyMaterial('live');
    const parsed = parseKey(material.key);

    expect(parsed).not.toBeNull();
    expect(parsed?.env).toBe('live');
    expect(parsed?.publicId).toBe(material.publicId);
    expect(parsed?.secret).toBe(material.secret);
  });

  it('exposes a prefix that carries no secret material', () => {
    const material = generateKeyMaterial('test');
    expect(material.prefix).toBe(`sk_test_${material.publicId}`);
    expect(material.prefix).not.toContain(material.secret);
  });

  it('derives last4 from the end of the secret', () => {
    const material = generateKeyMaterial('test');
    expect(material.last4).toBe(material.secret.slice(-4));
  });

  it('generates unique keys', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(generateKeyMaterial('test').key);
    }
    expect(seen.size).toBe(500);
  });

  it('never repeats a public id', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(generateKeyMaterial('test').publicId);
    }
    expect(seen.size).toBe(500);
  });
});

describe('hashSecret', () => {
  it('is deterministic for the same public id and secret', () => {
    expect(hashSecret('abc123', 'secret')).toBe(hashSecret('abc123', 'secret'));
  });

  it('produces a different hash for a different public id', () => {
    expect(hashSecret('abc123', 'secret')).not.toBe(hashSecret('abc124', 'secret'));
  });

  it('produces a different hash for a different secret', () => {
    expect(hashSecret('abc123', 'secret')).not.toBe(hashSecret('abc123', 'secreT'));
  });

  it('never leaks the secret', () => {
    const hash = hashSecret('abc123', 'sup3rs3cret');
    expect(hash).not.toContain('sup3rs3cret');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('safeEqualHex', () => {
  it('matches identical digests', () => {
    const hash = hashSecret('abc123', 'secret');
    expect(safeEqualHex(hash, hash)).toBe(true);
  });

  it('rejects different digests', () => {
    expect(safeEqualHex(hashSecret('abc123', 'a'), hashSecret('abc123', 'b'))).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    expect(safeEqualHex('abcd', 'abcdef')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(safeEqualHex('', '')).toBe(false);
  });
});

describe('redact', () => {
  const rawKey = 'sk_live_9Kd2mQxR7tYb_zF1cH6jV0gN5eU4tR8wB3nL6kJ9pQ2vX';

  it('the fixture is a well-formed key', () => {
    expect(parseKey(rawKey)).not.toBeNull();
  });

  it('scrubs a key from a string', () => {
    expect(redact(`the key is ${rawKey} ok`)).not.toContain(rawKey);
    expect(redact(`the key is ${rawKey} ok`)).toContain('sk_***');
  });

  it('scrubs a key that sits at the very start and end of a string', () => {
    expect(redact(rawKey)).toBe('sk_***');
    expect(redact(`${rawKey}${rawKey}`)).toBe('sk_***sk_***');
  });

  it('scrubs several keys in one string', () => {
    const text = `a=${rawKey} b=${rawKey.replace('live', 'test')}`;
    const result = redact(text);
    expect(result).not.toContain(rawKey);
    expect(result.match(/sk_\*\*\*/g)).toHaveLength(2);
  });

  it('leaves near-miss strings alone', () => {
    const nearMisses = [
      'sk_live_9Kd2mQxR7tYb', // missing secret
      'sk_live_9Kd2mQxR7tYb_zF1cH6jV0gN5eU4tR8wB3nL6kJ9p', // short secret
      'sk_prod_9Kd2mQxR7tYb_zF1cH6jV0gN5eU4tR8wB3nL6kJ9pQ2vX', // unknown env
      'pk_live_9Kd2mQxR7tYb_zF1cH6jV0gN5eU4tR8wB3nL6kJ9pQ2vX', // wrong marker
    ];

    for (const nearMiss of nearMisses) {
      expect(redact(nearMiss)).toBe(nearMiss);
    }
  });

  it('handles an empty string', () => {
    expect(redact('')).toBe('');
  });
});
