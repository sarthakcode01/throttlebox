import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters. Tuned for interactive logins on modest hardware.
 *
 * These are for passwords only. API keys use HMAC-SHA-256 with a server-side
 * pepper instead — a key is a high-entropy random secret, so a slow KDF buys
 * no security and costs latency on every request. See `keys/generate.ts`.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored Argon2id hash.
 *
 * `verify` returns false for malformed hashes rather than throwing, so a
 * corrupt row can't crash the login route.
 */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
