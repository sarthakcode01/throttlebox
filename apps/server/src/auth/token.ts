import { createHmac, randomBytes } from 'node:crypto';

/**
 * Session tokens are 256 bits of CSPRNG output, hex encoded.
 *
 * We only ever store a keyed digest of the token server-side, so a database
 * leak does not hand an attacker usable session cookies. The digest is an
 * HMAC keyed by `SESSION_SECRET` rather than a bare SHA-256: without the key,
 * the digest of a token reveals nothing, and rotating the key invalidates
 * every stored session at once.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** Keyed digest of a session token. `key` is `SESSION_SECRET`. */
export function hashSessionToken(token: string, key: string): string {
  return createHmac('sha256', key).update(token).digest('hex');
}
