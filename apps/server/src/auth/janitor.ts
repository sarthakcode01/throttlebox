import { lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiKeyEvents } from '../db/schema.js';
import { purgeExpiredSessions } from './session.js';

/**
 * Periodic cleanup of expired session rows and old audit events.
 *
 * The `sessions` table is the durable copy of every session ever issued.
 * Redis is only a cache, so without this the table grows without bound —
 * every login, on every device, forever.
 *
 * `api_key_events` grows the same way, and faster: every failed key
 * authentication can write a row. Events are kept for a fixed window.
 *
 * The interval is deliberately coarse. Sessions are only deleted once they
 * have already expired, so there is no correctness requirement on how often
 * this runs.
 */
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/** How long API key audit events are kept. */
export const AUDIT_RETENTION_DAYS = 90;

let timer: NodeJS.Timeout | null = null;

/** Delete expired sessions once. Exposed so it can be tested directly. */
export async function runSessionCleanup(): Promise<number> {
  return purgeExpiredSessions();
}

/** Delete audit events past the retention window. */
export async function runAuditCleanup(): Promise<number> {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(apiKeyEvents)
    .where(lt(apiKeyEvents.createdAt, cutoff))
    .returning({ id: apiKeyEvents.id });
  return deleted.length;
}

async function runAll(): Promise<void> {
  // A failed cleanup is not worth crashing over — the next tick retries.
  await runSessionCleanup().catch(() => undefined);
  await runAuditCleanup().catch(() => undefined);
}

export function startSessionJanitor(): void {
  if (timer) return;

  timer = setInterval(() => {
    void runAll();
  }, CLEANUP_INTERVAL_MS);

  // Don't hold the event loop open just for the janitor.
  timer.unref?.();
}

export async function stopSessionJanitor(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await runAll();
}
