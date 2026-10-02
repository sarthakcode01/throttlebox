import { and, eq, gt, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { redis } from '../db/redis.js';
import { sessions } from '../db/schema.js';
import { generateSessionToken, hashSessionToken } from './token.js';

export const SESSION_COOKIE = 'throttlebox_session';
export const CSRF_COOKIE = 'throttlebox_csrf';

interface SessionRecord {
  userId: string;
  sessionId: string;
}

function redisKey(tokenHash: string): string {
  return `session:${tokenHash}`;
}

export interface CreateSessionInput {
  userId: string;
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
  const record: SessionRecord = { userId: input.userId, sessionId: row.id };
  await redis.set(redisKey(tokenHash), JSON.stringify(record), 'EX', config.SESSION_TTL_SECONDS);

  return { token, csrfToken, expiresAt };
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
    await redis.expire(redisKey(tokenHash), config.SESSION_TTL_SECONDS);
    return JSON.parse(cached) as SessionRecord;
  }

  // Cache miss — fall back to the durable record.
  const now = new Date();
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);

  if (!row) {
    return null;
  }

  const record: SessionRecord = { userId: row.userId, sessionId: row.id };

  // Re-warm the cache, but never beyond the session's real expiry.
  const remainingSeconds = Math.max(
    1,
    Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000),
  );
  await redis.set(
    redisKey(tokenHash),
    JSON.stringify(record),
    'EX',
    Math.min(config.SESSION_TTL_SECONDS, remainingSeconds),
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
