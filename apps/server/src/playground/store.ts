import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  PLAYGROUND_LIMITS,
  type HttpMethod,
  type PlaygroundRequest,
  type PlaygroundRequestKind,
  type PlaygroundSession,
} from '@throttlebox/shared';
import { db } from '../db/client.js';
import {
  apiKeys,
  playgroundRequests,
  playgroundSessions,
  type PlaygroundRequestRow,
  type PlaygroundSessionRow,
} from '../db/schema.js';
import type { PlaygroundRunResult } from './runner.js';

export class PlaygroundError extends Error {
  constructor(
    public code: 'not_found' | 'limit_reached' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'PlaygroundError';
  }
}

export function playgroundErrorStatus(code: PlaygroundError['code']): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'limit_reached':
      return 409;
    default:
      return 400;
  }
}

// ---- Sessions -------------------------------------------------------------

function toSession(row: PlaygroundSessionRow, requestCount: number): PlaygroundSession {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    requestCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createSession(
  orgId: string,
  userId: string | null,
  name?: string,
): Promise<PlaygroundSession> {
  const [row] = await db
    .insert(playgroundSessions)
    .values({ orgId, createdBy: userId, ...(name ? { name } : {}) })
    .returning();
  if (!row) throw new Error('Failed to create playground session');
  return toSession(row, 0);
}

export async function listSessions(orgId: string): Promise<PlaygroundSession[]> {
  const rows = await db
    .select({
      session: playgroundSessions,
      count: sql<number>`count(${playgroundRequests.id})::int`,
    })
    .from(playgroundSessions)
    .leftJoin(playgroundRequests, eq(playgroundRequests.sessionId, playgroundSessions.id))
    .where(eq(playgroundSessions.orgId, orgId))
    .groupBy(playgroundSessions.id)
    .orderBy(desc(playgroundSessions.updatedAt))
    .limit(100);
  return rows.map((r) => toSession(r.session, r.count));
}

export async function getSession(orgId: string, id: string): Promise<PlaygroundSessionRow> {
  const [row] = await db
    .select()
    .from(playgroundSessions)
    .where(and(eq(playgroundSessions.id, id), eq(playgroundSessions.orgId, orgId)))
    .limit(1);
  if (!row) throw new PlaygroundError('not_found', 'Playground session not found');
  return row;
}

export async function renameSession(
  orgId: string,
  id: string,
  name: string,
): Promise<PlaygroundSession> {
  const [row] = await db
    .update(playgroundSessions)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(playgroundSessions.id, id), eq(playgroundSessions.orgId, orgId)))
    .returning();
  if (!row) throw new PlaygroundError('not_found', 'Playground session not found');
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(playgroundRequests)
    .where(eq(playgroundRequests.sessionId, id));
  return toSession(row, count);
}

export async function deleteSession(orgId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(playgroundSessions)
    .where(and(eq(playgroundSessions.id, id), eq(playgroundSessions.orgId, orgId)))
    .returning({ id: playgroundSessions.id });
  if (deleted.length === 0) throw new PlaygroundError('not_found', 'Playground session not found');
}

// ---- Requests -------------------------------------------------------------

type RequestWithKey = PlaygroundRequestRow & { keyPrefix: string | null; keyLast4: string | null };

function toRequest(row: RequestWithKey): PlaygroundRequest {
  return {
    id: row.id,
    sessionId: row.sessionId,
    keyId: row.keyId,
    keyDisplay: row.keyPrefix && row.keyLast4 ? `${row.keyPrefix}.${row.keyLast4}` : null,
    parentId: row.parentId,
    kind: row.kind,
    method: row.method as HttpMethod,
    serviceSlug: row.serviceSlug,
    path: row.path,
    query: row.query as Record<string, string>,
    headers: row.headers as Record<string, string>,
    body: row.body,
    outcome: row.outcome,
    responseStatus: row.responseStatus,
    responseHeaders: row.responseHeaders as Record<string, string>,
    responseBody: row.responseBody,
    responseTruncated: row.responseTruncated,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

const requestColumns = {
  req: playgroundRequests,
  keyPrefix: apiKeys.prefix,
  keyLast4: apiKeys.last4,
};

export interface RecordRequestInput {
  orgId: string;
  sessionId: string;
  keyId: string;
  parentId: string | null;
  kind: PlaygroundRequestKind;
  method: HttpMethod;
  serviceSlug: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  result: PlaygroundRunResult;
}

export async function countSessionRequests(sessionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(playgroundRequests)
    .where(eq(playgroundRequests.sessionId, sessionId));
  return row?.count ?? 0;
}

/** Throws when the session is already at its cap, before anything is executed. */
export async function assertSessionHasRoom(sessionId: string): Promise<void> {
  if ((await countSessionRequests(sessionId)) >= PLAYGROUND_LIMITS.maxRequestsPerSession) {
    throw new PlaygroundError(
      'limit_reached',
      `A session holds at most ${PLAYGROUND_LIMITS.maxRequestsPerSession} requests. Start a new session or delete this one.`,
    );
  }
}

export async function recordRequest(input: RecordRequestInput): Promise<PlaygroundRequest> {
  const [row] = await db
    .insert(playgroundRequests)
    .values({
      sessionId: input.sessionId,
      orgId: input.orgId,
      keyId: input.keyId,
      parentId: input.parentId,
      kind: input.kind,
      method: input.method,
      serviceSlug: input.serviceSlug,
      path: input.path,
      query: input.query,
      headers: input.headers,
      body: input.body,
      outcome: input.result.outcome,
      responseStatus: input.result.status,
      responseHeaders: input.result.headers,
      responseBody: input.result.body,
      responseTruncated: input.result.truncated,
      durationMs: input.result.durationMs,
    })
    .returning();
  if (!row) throw new Error('Failed to record playground request');

  await db
    .update(playgroundSessions)
    .set({ updatedAt: new Date() })
    .where(eq(playgroundSessions.id, input.sessionId));

  return getRequest(input.orgId, row.id);
}

export async function getRequest(orgId: string, id: string): Promise<PlaygroundRequest> {
  const [row] = await db
    .select(requestColumns)
    .from(playgroundRequests)
    .leftJoin(apiKeys, eq(apiKeys.id, playgroundRequests.keyId))
    .where(and(eq(playgroundRequests.id, id), eq(playgroundRequests.orgId, orgId)))
    .limit(1);
  if (!row) throw new PlaygroundError('not_found', 'Playground request not found');
  return toRequest({ ...row.req, keyPrefix: row.keyPrefix, keyLast4: row.keyLast4 });
}

/** Newest first. `before` is an ISO timestamp cursor (exclusive). */
export async function listRequests(
  orgId: string,
  sessionId: string,
  options: { limit?: number; before?: string; ids?: string[] } = {},
): Promise<PlaygroundRequest[]> {
  await getSession(orgId, sessionId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const conditions = [
    eq(playgroundRequests.sessionId, sessionId),
    eq(playgroundRequests.orgId, orgId),
  ];
  if (options.before) conditions.push(lt(playgroundRequests.createdAt, new Date(options.before)));
  if (options.ids && options.ids.length > 0) conditions.push(inArray(playgroundRequests.id, options.ids));

  const rows = await db
    .select(requestColumns)
    .from(playgroundRequests)
    .leftJoin(apiKeys, eq(apiKeys.id, playgroundRequests.keyId))
    .where(and(...conditions))
    .orderBy(desc(playgroundRequests.createdAt))
    .limit(limit);

  return rows.map((r) => toRequest({ ...r.req, keyPrefix: r.keyPrefix, keyLast4: r.keyLast4 }));
}

/** Delete history older than the retention window. Returns rows removed. */
export async function purgeOldPlaygroundData(
  retentionDays: number = PLAYGROUND_LIMITS.retentionDays,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(playgroundRequests)
    .where(lt(playgroundRequests.createdAt, cutoff))
    .returning({ id: playgroundRequests.id });
  // Drop sessions that are now empty and untouched for the whole window.
  await db
    .delete(playgroundSessions)
    .where(
      and(
        lt(playgroundSessions.updatedAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM playground_requests r WHERE r.session_id = ${playgroundSessions.id})`,
      ),
    );
  return deleted.length;
}
