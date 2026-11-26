import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credentials for requests the server sends to itself.
 *
 * The playground runs a user's request through the real mock pipeline with
 * `fastify.inject()`. The raw API key is never stored, so it cannot be
 * replayed; instead the runner presents this per-process secret together
 * with the id of the key to act as.
 *
 * The token exists only in memory, is regenerated on every boot, and is
 * never logged, stored or returned. Outside callers cannot know it, so the
 * header is useless to them.
 */
export const INTERNAL_AUTH_HEADER = 'x-throttlebox-internal';
export const INTERNAL_KEY_ID_HEADER = 'x-throttlebox-key-id';

/**
 * The token is deliberately not exported.
 *
 * `getInternalToken()` used to be, which meant any future server-side code that
 * reached this module — an error reporter dumping module state, a debug route,
 * a log line — could learn a value that bypasses key authentication entirely.
 * The only caller that needs it is the runner, which gets it through
 * `internalAuthHeaders()` below.
 */
const INTERNAL_TOKEN = randomBytes(32).toString('hex');

/** Headers that authenticate an in-process, injected request. */
export function internalAuthHeaders(keyId: string): Record<string, string> {
  return {
    [INTERNAL_AUTH_HEADER]: INTERNAL_TOKEN,
    [INTERNAL_KEY_ID_HEADER]: keyId,
  };
}

/**
 * Constant-time check of a presented token.
 *
 * Both sides are hashed first so the comparison is over fixed-length digests:
 * `safeEqualString` returns early on a length mismatch, and the length of the
 * presented header is attacker-controlled.
 */
export function isInternalToken(presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expected = createHash('sha256').update(INTERNAL_TOKEN).digest();
  const actual = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expected, actual);
}
