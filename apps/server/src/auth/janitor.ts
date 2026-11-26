import { purgeOldAuditEvents } from '../keys/audit.js';
import { purgeExpiredSessions } from './session.js';

/**
 * Periodic cleanup of expired session rows.
 *
 * The `sessions` table is the durable copy of every session ever issued.
 * Redis is only a cache, so without this the table grows without bound —
 * every login, on every device, forever.
 *
 * The interval is deliberately coarse. Sessions are only deleted once they
 * have already expired, so there is no correctness requirement on how often
 * this runs.
 */
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/**
 * Delete expired sessions once, and prune the API key audit trail past its
 * retention window. Exposed so it can be tested directly.
 *
 * The audit trail is append-only by design, which is exactly why it needs a
 * bound: an unauthenticated caller who knows a `public_id` can add a row per
 * request, so without retention the table grows for as long as the attack runs.
 */
export async function runSessionCleanup(): Promise<number> {
  const sessions = await purgeExpiredSessions();
  // A failure to prune must not stop the session sweep.
  await purgeOldAuditEvents().catch(() => 0);
  return sessions;
}

export function startSessionJanitor(): void {
  if (timer) return;

  timer = setInterval(() => {
    void runSessionCleanup().catch(() => {
      // A failed cleanup is not worth crashing over — the next tick retries.
    });
  }, CLEANUP_INTERVAL_MS);

  // Don't hold the event loop open just for the janitor.
  timer.unref?.();
}

export async function stopSessionJanitor(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await runSessionCleanup().catch(() => {
    // Best effort during shutdown.
  });
}
