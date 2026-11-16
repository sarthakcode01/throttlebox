import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare two hex digests in constant time.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the length
 * check happens first — that check is not secret, since both sides are digests
 * of the same expected length.
 */
export function safeEqualHex(a: string, b: string): boolean {
  const expected = Buffer.from(a, 'hex');
  const actual = Buffer.from(b, 'hex');

  if (expected.length !== actual.length) return false;
  if (expected.length === 0) return false;

  return timingSafeEqual(expected, actual);
}

/**
 * Compare two arbitrary strings in constant time.
 *
 * Both sides are hashed to a fixed 32 bytes first, so the comparison time
 * does not depend on, and therefore does not reveal, either input's length.
 * Used for the CSRF double-submit check.
 */
export function safeEqualString(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;

  const expected = createHash('sha256').update(a, 'utf8').digest();
  const actual = createHash('sha256').update(b, 'utf8').digest();

  return timingSafeEqual(expected, actual);
}
