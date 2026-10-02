import { createHash, randomBytes } from 'node:crypto';

/**
 * Session tokens are 256 bits of CSPRNG output, hex encoded.
 * We only ever store SHA-256(token) server-side, so a database leak
 * does not hand an attacker usable session cookies.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
