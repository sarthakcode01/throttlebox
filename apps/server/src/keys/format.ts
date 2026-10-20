import { randomBytes } from 'node:crypto';
import { KEY_ENVS, type KeyEnv } from '@throttlebox/shared';

/**
 * Key format:
 *
 *   sk_live_9Kd2mQxR7tYb4nW8pL3sA_zF1cH6jV0gN5eU
 *   │  │    │                │                │
 *   │  │    │                │                └─ 32 chars, 192 bits CSPRNG (the secret)
 *   │  │    │                └────────────────── 12 chars, base62, ~2^71 (the public id)
 *   │  │    └─────────────────────────────────── env: live | test
 *   │  └──────────────────────────────────────── key type marker
 *   └─────────────────────────────────────────── schema version
 *
 * Parsing splits on `_` with a fixed arity of 4. We never slice by "the first
 * N characters", because that breaks the moment the env segment changes length.
 */

export const KEY_PREFIX = 'sk';
export const PUBLIC_ID_LENGTH = 12;
export const SECRET_LENGTH = 32;

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 256 is not a multiple of 62, so a plain `byte % 62` would bias the first
 * `256 % 62 = 8` alphabet characters. We reject any byte >= 248 (the largest
 * multiple of 62 that fits in a byte) to keep every character equally likely.
 */
const MAX_UNBIASED_BYTE = 248;

const PUBLIC_ID_PATTERN = new RegExp(`^[0-9A-Za-z]{${PUBLIC_ID_LENGTH}}$`);
const SECRET_PATTERN = new RegExp(`^[0-9A-Za-z]{${SECRET_LENGTH}}$`);

/**
 * Generate `length` uniformly random base62 characters.
 *
 * Rejection sampling keeps the distribution flat; `Math.random()` is never used
 * for key material.
 */
export function randomBase62(length: number): string {
  let out = '';
  // Rejection sampling occasionally needs more bytes than requested, so pull in
  // chunks and keep whatever survives the filter.
  while (out.length < length) {
    const chunk = randomBytes(Math.ceil((length - out.length) * 1.3) + 8);
    for (const byte of chunk) {
      if (byte >= MAX_UNBIASED_BYTE) continue;
      out += BASE62_ALPHABET[byte % BASE62_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function isKeyEnv(value: string): value is KeyEnv {
  return (KEY_ENVS as readonly string[]).includes(value);
}

export interface ParsedKey {
  env: KeyEnv;
  publicId: string;
  secret: string;
}

/**
 * Parse a raw key into its parts, or null if it is not a well-formed key.
 *
 * Shape validation only — this says nothing about whether the key exists or is
 * valid. Use `verifyKey` for that.
 */
export function parseKey(raw: string): ParsedKey | null {
  if (typeof raw !== 'string') return null;

  const parts = raw.split('_');
  if (parts.length !== 4) return null;

  const [marker, env, publicId, secret] = parts;
  if (marker === undefined || env === undefined || publicId === undefined || secret === undefined) {
    return null;
  }

  if (marker !== KEY_PREFIX) return null;
  if (!isKeyEnv(env)) return null;
  if (!PUBLIC_ID_PATTERN.test(publicId)) return null;
  if (!SECRET_PATTERN.test(secret)) return null;

  return { env, publicId, secret };
}

/** Assemble a raw key from its parts. */
export function buildKey(env: KeyEnv, publicId: string, secret: string): string {
  return `${KEY_PREFIX}_${env}_${publicId}_${secret}`;
}

/**
 * The displayable prefix of a key — `sk_live_9Kd2mQxR7tYb`. It contains the
 * public id but never the secret.
 */
export function buildDisplayPrefix(env: KeyEnv, publicId: string): string {
  return `${KEY_PREFIX}_${env}_${publicId}`;
}

/** Matches a full raw key anywhere in a string. Used for redaction. */
export const RAW_KEY_PATTERN = /sk_(?:test|live)_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}/g;
