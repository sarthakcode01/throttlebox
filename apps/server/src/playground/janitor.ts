import { purgeOldPlaygroundData } from './store.js';

/**
 * Periodic cleanup of playground history older than the retention window.
 * Mirrors `auth/janitor.ts`: coarse interval, best effort, unref'd.
 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export async function runPlaygroundCleanup(): Promise<number> {
  return purgeOldPlaygroundData();
}

export function startPlaygroundJanitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runPlaygroundCleanup().catch(() => {
      // The next tick retries.
    });
  }, CLEANUP_INTERVAL_MS);
  timer.unref?.();
}

export function stopPlaygroundJanitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
