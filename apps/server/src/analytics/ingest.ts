import { db } from '../db/client.js';
import { requestLogs, type NewRequestLog } from '../db/schema.js';
import type { LogEntryInput } from './types.js';

/** A flush is triggered as soon as this many rows are waiting. */
const BATCH_SIZE = 100;
/** Rows written per INSERT. Larger than the trigger so a backlog drains fast. */
const INSERT_CHUNK = 500;
const FLUSH_INTERVAL_MS = 500;
const MAX_QUEUE_SIZE = 10_000;
/** Backoff after a failed flush, doubling up to the cap. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
/** How long `flushAll` may keep trying at shutdown. */
const FLUSH_ALL_DEADLINE_MS = 10_000;

let queue: LogEntryInput[] = [];
let inFlight: Promise<void> | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
let retryAt = 0;
const touchedOrgIds = new Set<string>();

type QuotaCheckCallback = (orgIds: string[]) => Promise<void>;
let quotaCheckCallback: QuotaCheckCallback | null = null;
/** At most one quota check at a time, so overlapping flushes cannot race. */
let quotaCheckRunning: Promise<void> | null = null;

export function setQuotaCheckCallback(cb: QuotaCheckCallback): void {
  quotaCheckCallback = cb;
}

/** Drop the oldest rows once the queue is over capacity. */
function trimQueue(): void {
  if (queue.length > MAX_QUEUE_SIZE) {
    const dropped = queue.length - MAX_QUEUE_SIZE;
    queue.splice(0, dropped);
    console.warn(`[Telemetry] Log queue saturated; dropped ${dropped} oldest entries`);
  }
}

/**
 * Non-blocking ingestion. Pushes a request log into the memory queue.
 * Returns immediately without awaiting I/O.
 */
export function recordRequestLog(entry: LogEntryInput): void {
  queue.push({
    ...entry,
    time: entry.time ?? new Date(),
    rateLimited: entry.rateLimited ?? false,
  });
  trimQueue();

  if (entry.orgId) {
    touchedOrgIds.add(entry.orgId);
  }

  if (queue.length >= BATCH_SIZE && !inFlight && Date.now() >= retryAt) {
    void flushQueue();
  }
}

function toRow(item: LogEntryInput): NewRequestLog {
  return {
    time: item.time ?? new Date(),
    keyId: item.keyId ?? null,
    orgId: item.orgId,
    serviceId: item.serviceId ?? null,
    method: item.method,
    path: item.path,
    statusCode: item.statusCode,
    latencyMs: item.latencyMs,
    rateLimited: item.rateLimited ?? false,
    traceId: item.traceId,
  };
}

/** Postgres error classes that mean "this row is bad", not "the database is down". */
function isDataError(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  // 22 = data exception, 23 = integrity constraint violation.
  return code.startsWith('22') || code.startsWith('23');
}

/**
 * Write a batch. If the whole batch is rejected because of its contents, fall
 * back to one row at a time and drop only the rows that fail.
 *
 * A single bad row used to fail the batch, which went back to the front of
 * the queue and failed again on every attempt — ingestion stopped for good.
 */
async function writeBatch(batch: LogEntryInput[]): Promise<void> {
  try {
    await db.insert(requestLogs).values(batch.map(toRow));
    return;
  } catch (err) {
    if (!isDataError(err)) throw err;
  }

  let dropped = 0;
  for (const item of batch) {
    try {
      await db.insert(requestLogs).values(toRow(item));
    } catch (err) {
      if (!isDataError(err)) throw err;
      dropped += 1;
    }
  }
  if (dropped > 0) {
    console.warn(`[Telemetry] Dropped ${dropped} request log row(s) the database rejected`);
  }
}

async function runFlush(): Promise<void> {
  const batch = queue.splice(0, INSERT_CHUNK);
  if (batch.length === 0) return;

  try {
    await writeBatch(batch);
    consecutiveFailures = 0;
    retryAt = 0;

    if (quotaCheckCallback && touchedOrgIds.size > 0 && !quotaCheckRunning) {
      const orgsToCheck = Array.from(touchedOrgIds);
      touchedOrgIds.clear();
      quotaCheckRunning = quotaCheckCallback(orgsToCheck)
        .catch((err) => {
          console.error('[Telemetry] Error checking quotas:', err);
        })
        .finally(() => {
          quotaCheckRunning = null;
        });
    }
  } catch (err) {
    console.error('[Telemetry] Failed to flush log batch:', err);
    // Put the batch back at the front so it is retried first, then trim
    // from the oldest end if the queue is now over capacity.
    queue.unshift(...batch);
    trimQueue();

    // Back off. An immediate retry while the database is down was a tight
    // loop hammering it.
    consecutiveFailures += 1;
    retryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (consecutiveFailures - 1));
  }
}

/**
 * Flushes a batch of logs to TimescaleDB.
 *
 * Concurrent callers share the flush already in progress.
 */
export function flushQueue(): Promise<void> {
  if (inFlight) return inFlight;
  if (queue.length === 0) return Promise.resolve();

  inFlight = runFlush().finally(() => {
    inFlight = null;
    if (queue.length >= BATCH_SIZE && Date.now() >= retryAt) {
      void flushQueue();
    }
  });
  return inFlight;
}

/**
 * Flush all pending logs, giving up at a deadline.
 *
 * This used to `while (queue.length) await flushQueue()`. When a timer flush
 * was already running, `flushQueue` returned at once, so the loop spun on
 * microtasks without ever yielding to the I/O that would finish that flush —
 * a 100% CPU hang at shutdown. Each iteration now awaits real work, and a
 * database that stays down cannot hold shutdown hostage.
 */
export async function flushAll(deadlineMs = FLUSH_ALL_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + deadlineMs;

  while (queue.length > 0 || inFlight) {
    if (Date.now() >= deadline) {
      console.warn(`[Telemetry] Gave up flushing ${queue.length} log row(s) at shutdown`);
      break;
    }

    const failuresBefore = consecutiveFailures;
    retryAt = 0;
    await flushQueue();

    if (consecutiveFailures > failuresBefore) {
      // Wait out a short backoff before the next attempt, on the event loop.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  touchedOrgIds.clear();
}

/**
 * Reset queue and state for isolated unit testing.
 */
export function resetQueueForTesting(): void {
  queue = [];
  touchedOrgIds.clear();
  inFlight = null;
  consecutiveFailures = 0;
  retryAt = 0;
  quotaCheckCallback = null;
  quotaCheckRunning = null;
}

/**
 * Starts the periodic background flush timer.
 */
export function startIngestFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (Date.now() >= retryAt) void flushQueue();
  }, FLUSH_INTERVAL_MS);
  if (flushTimer.unref) {
    flushTimer.unref();
  }
}

/**
 * Stops the timer and flushes any pending logs.
 */
export async function stopIngestFlusher(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushAll();
}

/**
 * Get internal queue stats for testing / observability.
 */
export function getQueueStats(): { queueLength: number; isFlushing: boolean } {
  return {
    queueLength: queue.length,
    isFlushing: inFlight !== null,
  };
}
