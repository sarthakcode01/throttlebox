import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Load the repo-root .env before validating. Real deployments inject real env
// vars, which dotenv does not overwrite.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../../.env') });

/**
 * Environment validation. The server refuses to boot with a bad or missing
 * config rather than failing later at request time.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().url(),

  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),

  /**
   * Server-side pepper for API key hashing. It never leaves the process: the
   * database stores only `HMAC-SHA-256(pepper, publicId:secret)`, so a stolen
   * dump yields hashes an attacker cannot verify anything against.
   */
  KEY_PEPPER: z.string().min(16, 'KEY_PEPPER must be at least 16 characters'),

  COOKIE_DOMAIN: z.string().default('localhost'),

  /** Session lifetime in seconds. Default 7 days. */
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = parsed.data;

// Reusing the session secret as the key pepper would mean one leaked value
// compromises both subsystems, so we refuse it outright.
if (config.KEY_PEPPER === config.SESSION_SECRET) {
  throw new Error(
    'Invalid environment configuration:\n  - KEY_PEPPER must differ from SESSION_SECRET',
  );
}

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
