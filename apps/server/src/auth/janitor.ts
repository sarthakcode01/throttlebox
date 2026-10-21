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

/** Delete expired sessions once. Exposed so it can be tested directly. */
export async function runSessionCleanup(): Promise<number> {
  return purgeExpiredSessions();
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
