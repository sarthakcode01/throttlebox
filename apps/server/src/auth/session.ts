import { and, eq, gt, lt } from 'drizzle-orm';
import Redis from 'ioredis';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { redis } from '../db/redis.js';
import { sessions } from '../db/schema.js';
import { generateSessionToken, hashSessionToken } from './token.js';

export const SESSION_COOKIE = 'throttlebox_session';
export const CSRF_COOKIE = 'throttlebox_csrf';

/**
 * Channel used to tell every instance that a session has been destroyed.
 *
 * Redis is the hot lookup path for sessions, so a logout that only did a local
 * `DEL` would leave the record readable by other replicas until its TTL ran
 * out. The TTL is a day at most now (see `SESSION_ABSOLUTE_TTL_SECONDS`), but
 * "up to a day" is still far too long for a sign-out.
 */
const SESSION_REVOKED_CHANNEL = 'session:revoked';

interface RevocationMessage {
  tokenHash: string;
}

export interface SessionRecord {
  userId: string;
  sessionId: string;
  orgId?: string | null;
  role?: string | null;
  /**
   * Absolute deadline, epoch milliseconds.
   *
   * This is the session's real expiry. It is carried in the cached record and
   * never extended by use, so a stolen token cannot be kept alive forever by
   * replaying it. Records written before this field existed have no value; a
   * cached record without one is treated as untrusted and reloaded from
   * Postgres.
   */
  expiresAt?: number;
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
 * httpOnly cookie. Only its keyed digest is persisted.
 */
export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  const token = generateSessionToken();
  const csrfToken = generateSessionToken();
  const tokenHash = hashSessionToken(token, config.SESSION_SECRET);
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);

  // Postgres holds the durable record (and survives a Redis flush).
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

  // Redis is the hot lookup path, with a matching TTL. The record carries its
  // own absolute deadline so a cache hit can enforce expiry without a query.
  const record: SessionRecord = {
    userId: input.userId,
    sessionId: row.id,
    orgId: input.orgId ?? null,
    role: input.role ?? null,
    expiresAt: expiresAt.getTime(),
  };
  await redis.set(redisKey(tokenHash), JSON.stringify(record), 'EX', config.SESSION_TTL_SECONDS);

  return { token, csrfToken, expiresAt };
}

/**
 * Seconds left before a record's absolute deadline.
 *
 * Returns 0 when the record has no deadline (untrusted) or has passed.
 */
export function sessionDeadlineSeconds(record: SessionRecord): number {
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return 0;
  return Math.floor((record.expiresAt - Date.now()) / 1000);
}

/**
 * Look up a session by raw token.
 *
 * Checks Redis first (the common case), falling back to Postgres and
 * re-warming the cache if Redis has no entry. Returns null when the session is
 * missing or past its absolute deadline.
 *
 * Deliberately **not** sliding past the deadline: the TTL is refreshed so a
 * live session stays cached, but never beyond `expiresAt`. Without that cap a
 * token used once a week would live forever, which is exactly the control a
 * stolen token depends on.
 */
export async function resolveSession(token: string): Promise<SessionRecord | null> {
  const tokenHash = hashSessionToken(token, config.SESSION_SECRET);

  const cached = await redis.get(redisKey(tokenHash));
  if (cached) {
    const record = JSON.parse(cached) as SessionRecord;
    const remaining = sessionDeadlineSeconds(record);

    if (remaining <= 0) {
      // Past the deadline, or written by an older build without one. Drop the
      // cache entry; Postgres is authoritative and will refuse it too.
      await redis.del(redisKey(tokenHash));
      return null;
    }

    await redis.expire(redisKey(tokenHash), remaining);
    return record;
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

  const record: SessionRecord = {
    userId: row.userId,
    sessionId: row.id,
    expiresAt: row.expiresAt.getTime(),
  };

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

/**
 * Broadcast a destroyed session so every replica drops its cached copy.
 *
 * Failure to publish is not fatal: the local delete already happened, and the
 * remaining exposures expire within the absolute deadline. It is logged so a
 * Redis partition does not fail silently.
 */
async function broadcastRevocation(tokenHash: string): Promise<void> {
  try {
    await redis.publish(SESSION_REVOKED_CHANNEL, JSON.stringify({ tokenHash }));
  } catch (err) {
    console.error('[session] Failed to broadcast revocation:', err);
  }
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = hashSessionToken(token, config.SESSION_SECRET);
  await redis.del(redisKey(tokenHash));
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  await broadcastRevocation(tokenHash);
}

/**
 * Revoke every session for a user. Use on password change or sign-out-everywhere.
 */
export async function destroyAllSessionsForUser(userId: string): Promise<number> {
  const rows = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(eq(sessions.userId, userId));

  if (rows.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.del(redisKey(row.tokenHash));
  }
  await pipeline.exec();

  await db.delete(sessions).where(eq(sessions.userId, userId));

  for (const row of rows) {
    await broadcastRevocation(row.tokenHash);
  }

  return rows.length;
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

let subscriberRedis: Redis | null = null;

/** Start listening for session revocations published by any instance. */
export function startSessionPubSub(): void {
  if (subscriberRedis) return;

  try {
    subscriberRedis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    subscriberRedis.subscribe(SESSION_REVOKED_CHANNEL, (err) => {
      if (err) {
        console.error('[session:pubsub] Failed to subscribe to revocations:', err.message);
      }
    });

    subscriberRedis.on('message', (channel, message) => {
      if (channel !== SESSION_REVOKED_CHANNEL) return;
      try {
        const { tokenHash } = JSON.parse(message) as RevocationMessage;
        if (tokenHash) {
          void redis.del(redisKey(tokenHash)).catch((err) => {
            console.error('[session:pubsub] Failed to drop revoked session:', err);
          });
        }
      } catch (err) {
        console.error('[session:pubsub] Failed to parse revocation message:', err);
      }
    });

    subscriberRedis.on('error', (err) => {
      console.error('[session:pubsub] Subscriber Redis error:', err.message);
    });
  } catch (err) {
    console.error('[session:pubsub] Failed to initialize subscriber:', err);
  }
}

/** Stop the subscriber connection during graceful shutdown. */
export async function stopSessionPubSub(): Promise<void> {
  if (subscriberRedis) {
    try {
      await subscriberRedis.unsubscribe(SESSION_REVOKED_CHANNEL);
      subscriberRedis.disconnect();
    } catch {
      // ignore on shutdown
    } finally {
      subscriberRedis = null;
    }
  }
}
