import { createHmac } from 'node:crypto';
import type { KeyEnv } from '@throttlebox/shared';
import { config } from '../config.js';
import { safeEqualHex } from '../util/crypto.js';
import {
  buildDisplayPrefix,
  buildKey,
  PUBLIC_ID_LENGTH,
  randomBase62,
  SECRET_LENGTH,
} from './format.js';

/**
 * Why HMAC-SHA-256 and not Argon2id?
 *
 * The threat model for an API key is not the threat model for a password.
 * A password has low entropy, so a slow KDF is the whole point — it makes each
 * guess expensive. An API key carries 192 bits of CSPRNG output: there is
 * nothing to brute force, so a slow hash buys nothing and costs 50–100ms on
 * *every API request*, which would blow the <5ms p95 budget in Phase 4.
 *
 * HMAC-SHA-256 with a server-side pepper gives us:
 *   - speed, because the hot path must stay cheap
 *   - a pepper that lives only in the environment, so a database dump produces
 *     hashes an attacker cannot verify anything against
 *   - one-way storage, since SHA-256 is preimage-resistant
 *
 * OWASP's guidance agrees: slow KDF for low-entropy secrets, fast hash or HMAC
 * for high-entropy tokens. Ours is the second case.
 */

export interface KeyMaterial {
  /** The full raw key. Returned to the user exactly once. */
  key: string;
  publicId: string;
  secret: string;
  /** Displayable prefix, e.g. `sk_live_9Kd2mQxR7tYb`. */
  prefix: string;
  /** Last 4 characters of the secret, for display. */
  last4: string;
}

/**
 * Generate a fresh key pair.
 *
 * `crypto.randomBytes` only — never `Math.random()`, and never a UUID as the
 * secret (UUIDv4 has 122 bits and a non-uniform nibble distribution).
 */
export function generateKeyMaterial(env: KeyEnv): KeyMaterial {
  const publicId = randomBase62(PUBLIC_ID_LENGTH);
  const secret = randomBase62(SECRET_LENGTH);

  return {
    key: buildKey(env, publicId, secret),
    publicId,
    secret,
    prefix: buildDisplayPrefix(env, publicId),
    last4: secret.slice(-4),
  };
}

/**
 * Hash the secret for storage: `HMAC-SHA-256(pepper, publicId:secret)`.
 *
 * The public id is mixed in so that the same secret under two different public
 * ids produces two different hashes.
 */
export function hashSecret(publicId: string, secret: string): string {
  return createHmac('sha256', config.KEY_PEPPER).update(`${publicId}:${secret}`).digest('hex');
}

/**
 * Compare two hex digests in constant time.
 *
 * Re-exported from `util/crypto` so the key module and the auth module share
 * one implementation.
 */
export { safeEqualHex };

/**
 * A digest of a fixed dummy value, used to keep the timing profile of a failed
 * lookup indistinguishable from a successful one.
 */
export const DUMMY_SECRET_HASH = hashSecret('dummy00000000', 'dummy'.repeat(8));
