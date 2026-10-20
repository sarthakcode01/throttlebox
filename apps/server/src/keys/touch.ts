import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';

/**
 * Write-behind buffer for `last_used_at`.
 *
 * A direct UPDATE per request would mean a Postgres write on every API call,
 * which is unacceptable at any real volume — it would show up in the p95
 * immediately. Instead we accumulate key ids in memory and flush them in
 * batches.
 *
 * Because the buffer is a Set, 200 requests to the same key inside one flush
 * window collapse into a single row in the batch.
 */

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 512;

const pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;

export function touch(keyId: string): void {
  pending.add(keyId);

  // Flush early if the buffer grows past the batch size. The promise is
  // intentionally not awaited: `touch` must never block or throw into the
  // request path.
  if (pending.size >= FLUSH_BATCH_SIZE) {
    void flushTouches();
  }
}

/**
 * Flush buffered key ids to the database.
 *
 * On failure the ids are put back so a transient database error does not lose
 * the data — the next flush picks them up.
 */
export async function flushTouches(): Promise<void> {
  if (pending.size === 0) return;

  const ids = [...pending];
  pending.clear();

  try {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(inArray(apiKeys.id, ids));
  } catch {
    for (const id of ids) pending.add(id);
  }
}

/** Start the periodic flusher. Call once, from the server bootstrap. */
export function startTouchFlusher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushTouches();
  }, FLUSH_INTERVAL_MS);

  // Don't hold the event loop open just for the flusher.
  timer.unref?.();
}

/**
 * Stop the flusher and flush what is left.
 *
 * Called on SIGTERM so a deploy does not lose the buffered timestamps.
 */
export async function stopTouchFlusher(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await flushTouches();
}
