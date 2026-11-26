import { isIP } from 'node:net';
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

  /**
   * Brute-force protection for the credential endpoints. Attempts are counted
   * per IP inside the window.
   */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(20),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(900),

  /**
   * Ceiling on the session-authenticated dashboard API, per user.
   *
   * Generous enough for the dashboard's polling (every chart refetches, and the
   * playground sends bursts) but low enough that a single account cannot use
   * the analytics queries as a database load generator.
   */
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(100_000).default(600),
  API_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),

  /**
   * Comma-separated IPs or CIDR ranges of the reverse proxies in front of the
   * app, e.g. `10.0.0.0/8,172.16.0.1`.
   *
   * Empty (the default) means the app is reached directly, so
   * `X-Forwarded-For` is ignored entirely — otherwise any client could spoof
   * its own IP, and that IP is what the API key audit trail records and what
   * the credential limiter buckets on.
   *
   * This replaced a hop count. Counting hops is only correct when exactly N
   * proxies sit in front and each one appends; set one number too high, or put
   * the app directly on the internet, and every client can spoof its address
   * with no warning. An explicit range cannot be wrong in that direction.
   */
  TRUST_PROXY_CIDRS: z.string().default(''),

  /**
   * Session lifetime in seconds. Default 1 day.
   *
   * This is an **absolute** lifetime, not a sliding one: the expiry is fixed at
   * creation and is never extended by use, so a stolen token cannot be kept
   * alive indefinitely by replaying it.
   */
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(60 * 60 * 24 * 30, 'SESSION_TTL_SECONDS may not exceed 30 days')
    .default(60 * 60 * 24),
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

/**
 * Validate the trusted-proxy list at boot.
 *
 * A typo here silently disables or over-enables client-IP trust, and the value
 * feeds the audit trail, so an unparseable entry is a startup failure rather
 * than a warning.
 */
export const trustProxyCidrs: string[] = config.TRUST_PROXY_CIDRS.split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

for (const cidr of trustProxyCidrs) {
  const [address, prefix, ...rest] = cidr.split('/');
  if (rest.length > 0 || !address) {
    throw new Error(
      `Invalid environment configuration:\n  - TRUST_PROXY_CIDRS: '${cidr}' is not an IP or CIDR range`,
    );
  }
  if (isIP(address) === 0) {
    throw new Error(
      `Invalid environment configuration:\n  - TRUST_PROXY_CIDRS: '${cidr}' is not an IP or CIDR range`,
    );
  }
  if (prefix !== undefined) {
    const bits = Number(prefix);
    const maxBits = isIP(address) === 6 ? 128 : 32;
    if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
      throw new Error(
        `Invalid environment configuration:\n  - TRUST_PROXY_CIDRS: '${cidr}' has an invalid prefix length`,
      );
    }
  }
}

export const isProduction = config.NODE_ENV === 'production';

/**
 * The allowed dashboard origins.
 *
 * Parsed and validated at boot because this list gates credentialed CORS:
 * `credentials: true` means a cross-origin read of `/api/*` carries the session
 * cookie. A stray space, a scheme-less entry, or a `*` would silently produce
 * either a broken dashboard or an allowance nobody intended — and `*` combined
 * with credentials is a contradiction the browser resolves by rejecting every
 * request, which looks like an outage rather than a config error.
 */
export const webOrigins: string[] = (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (webOrigins.length === 0) {
  throw new Error(
    'Invalid environment configuration:\n  - WEB_ORIGIN must name at least one origin',
  );
}

for (const origin of webOrigins) {
  if (origin === '*') {
    throw new Error(
      "Invalid environment configuration:\n  - WEB_ORIGIN may not be '*': credentialed CORS needs an explicit origin",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(
      `Invalid environment configuration:\n  - WEB_ORIGIN entry '${origin}' is not an absolute URL`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid environment configuration:\n  - WEB_ORIGIN entry '${origin}' must be http or https`,
    );
  }
  if (parsed.origin !== origin) {
    throw new Error(
      `Invalid environment configuration:\n  - WEB_ORIGIN entry '${origin}' must be a bare origin (no path or trailing slash)`,
    );
  }
  if (isProduction && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid environment configuration:\n  - WEB_ORIGIN entry '${origin}' must use HTTPS in production`,
    );
  }
}

export const isTest = config.NODE_ENV === 'test';
