import { randomBytes } from 'node:crypto';
import { safeEqualString } from '../util/crypto.js';

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

const INTERNAL_TOKEN = randomBytes(32).toString('hex');

export function getInternalToken(): string {
  return INTERNAL_TOKEN;
}

/** Constant-time check of a presented token. */
export function isInternalToken(presented: unknown): boolean {
  return typeof presented === 'string' && safeEqualString(presented, INTERNAL_TOKEN);
}
