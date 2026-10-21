import { timingSafeEqual } from 'node:crypto';

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
 * Used for the CSRF double-submit check, where both values are fixed-length
 * tokens but are not necessarily hex.
 */
export function safeEqualString(a: string, b: string): boolean {
  const expected = Buffer.from(a, 'utf8');
  const actual = Buffer.from(b, 'utf8');

  if (expected.length !== actual.length) return false;
  if (expected.length === 0) return false;

  return timingSafeEqual(expected, actual);
}
