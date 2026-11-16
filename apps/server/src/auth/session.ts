import { and, eq, gt, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { redis } from '../db/redis.js';
import { sessions } from '../db/schema.js';
import { createHash } from 'node:crypto';
import { generateSessionToken, hashSessionToken } from './token.js';

export const SESSION_COOKIE = 'throttlebox_session';
export const CSRF_COOKIE = 'throttlebox_csrf';

export interface SessionRecord {
  userId: string;
  sessionId: string;
  orgId?: string | null;
  role?: string | null;
  /**
   * Absolute expiry, epoch milliseconds. The Redis TTL slides on use, so
   * without this an actively used token would never expire.
   */
  expiresAt?: number;
  /** When `orgId`/`role` were last read from `org_members`, epoch ms. */
  membershipCheckedAt?: number;
  /** SHA-256 of the User-Agent the session was created with. */
  userAgentHash?: string | null;
}

export function hashUserAgent(userAgent: string | undefined): string | null {
  return userAgent ? createHash('sha256').update(userAgent).digest('hex') : null;
}

/** Seconds left before an absolute expiry, never less than 1. */
function secondsUntil(expiresAtMs: number, nowMs: number): number {
  return Math.max(1, Math.floor((expiresAtMs - nowMs) / 1000));
}

function redisKey(tokenHash: string): string {
  return `session:${tokenHash}`;
}

export interface CreateSessionInput {
  userId: string;
  orgId?: string | null;
  role?: string | null;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

/**
 * Create a session and return the raw tokens.
 *
 * The raw session token is returned exactly once — the caller puts it in an
 * httpOnly cookie. Only its SHA-256 hash is persisted.
 */
export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  const token = generateSessionToken();
  const csrfToken = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);

  // Postgres holds the audit record (and survives a Redis flush).
  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning({ id: sessions.id });

  if (!row) {
    throw new Error('Failed to create session record');
  }

  // Redis is the hot lookup path, with a matching TTL.
  // Cache orgId and role in Redis session record to eliminate per-request Postgres queries.
  const record: SessionRecord = {
    userId: input.userId,
    sessionId: row.id,
    orgId: input.orgId ?? null,
    role: input.role ?? null,
    expiresAt: expiresAt.getTime(),
    // Only a caller that looked the membership up can vouch for it. Without
    // one, the middleware reads it on first use.
    ...(input.orgId !== undefined ? { membershipCheckedAt: Date.now() } : {}),
    userAgentHash: hashUserAgent(input.userAgent),
  };
  await redis.set(redisKey(tokenHash), JSON.stringify(record), 'EX', config.SESSION_TTL_SECONDS);

  return { token, csrfToken, expiresAt };
}

/**
 * Updates an active session cache in Redis (e.g. warming cached orgId and role).
 *
 * The TTL is capped at the session's absolute expiry, so a rewrite can never
 * extend its life.
 */
export async function updateSessionRecord(token: string, record: SessionRecord): Promise<void> {
  const tokenHash = hashSessionToken(token);
  const ttl = record.expiresAt
    ? Math.min(config.SESSION_TTL_SECONDS, secondsUntil(record.expiresAt, Date.now()))
    : config.SESSION_TTL_SECONDS;
  await redis.set(redisKey(tokenHash), JSON.stringify(record), 'EX', ttl);
}

/**
 * Look up a session by raw token.
 *
 * Checks Redis first (the common case), falling back to Postgres and
 * re-warming the cache if Redis has no entry. Returns null when the session
 * is missing or expired. Extends the TTL on use (sliding expiration).
 */
export async function resolveSession(token: string): Promise<SessionRecord | null> {
  const tokenHash = hashSessionToken(token);

  const cached = await redis.get(redisKey(tokenHash));
  if (cached) {
    const record = JSON.parse(cached) as SessionRecord;
    const nowMs = Date.now();

    // The sliding TTL keeps an idle-timeout, but the absolute expiry is
    // what ends the session. A record without one predates this check;
    // the durable row below still has the real expiry.
    if (record.expiresAt !== undefined) {
      if (record.expiresAt <= nowMs) {
        await redis.del(redisKey(tokenHash));
        return null;
      }
      await redis.expire(
        redisKey(tokenHash),
        Math.min(config.SESSION_TTL_SECONDS, secondsUntil(record.expiresAt, nowMs)),
      );
      return record;
    }
    await redis.del(redisKey(tokenHash));
  }

  // Cache miss — fall back to the durable record.
  const now = new Date();
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);

  if (!row) {
    return null;
  }

  // No membership here: the auth middleware reads it fresh on first use.
  const record: SessionRecord = {
    userId: row.userId,
    sessionId: row.id,
    expiresAt: row.expiresAt.getTime(),
    userAgentHash: hashUserAgent(row.userAgent ?? undefined),
  };

  // Re-warm the cache, but never beyond the session's real expiry.
  await redis.set(
    redisKey(tokenHash),
    JSON.stringify(record),
    'EX',
    Math.min(config.SESSION_TTL_SECONDS, secondsUntil(row.expiresAt.getTime(), now.getTime())),
  );

  return record;
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = hashSessionToken(token);
  await redis.del(redisKey(tokenHash));
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Revoke every session for a user. Use on password change.
 */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  const rows = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(eq(sessions.userId, userId));

  if (rows.length === 0) return;

  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.del(redisKey(row.tokenHash));
  }
  await pipeline.exec();

  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/**
 * Housekeeping: drop expired session rows so the table doesn't grow forever.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}
