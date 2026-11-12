import { db } from '../db/client.js';
import { requestLogs, type NewRequestLog } from '../db/schema.js';
import type { LogEntryInput } from './types.js';

const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 500;
const MAX_QUEUE_SIZE = 10_000;

let queue: LogEntryInput[] = [];
let isFlushing = false;
let flushTimer: NodeJS.Timeout | null = null;
const touchedOrgIds = new Set<string>();

type QuotaCheckCallback = (orgIds: string[]) => Promise<void>;
let quotaCheckCallback: QuotaCheckCallback | null = null;

export function setQuotaCheckCallback(cb: QuotaCheckCallback): void {
  quotaCheckCallback = cb;
}

/**
 * Non-blocking ingestion. Pushes a request log into the memory queue.
 * Returns immediately without awaiting I/O.
 */
export function recordRequestLog(entry: LogEntryInput): void {
  if (queue.length >= MAX_QUEUE_SIZE) {
    // Drop oldest to avoid unbounded heap growth under catastrophic DB downtime
    queue.splice(0, Math.floor(MAX_QUEUE_SIZE * 0.1));
    console.warn('[Telemetry] Log queue saturated; dropped oldest 10% entries');
  }

  queue.push({
    ...entry,
    time: entry.time ?? new Date(),
    rateLimited: entry.rateLimited ?? false,
  });

  if (entry.orgId) {
    touchedOrgIds.add(entry.orgId);
  }

  if (queue.length >= BATCH_SIZE && !isFlushing) {
    void flushQueue();
  }
}

/**
 * Flushes a batch of logs to TimescaleDB.
 */
export async function flushQueue(): Promise<void> {
  if (isFlushing || queue.length === 0) {
    return;
  }

  isFlushing = true;
  const batch = queue.splice(0, BATCH_SIZE * 2);

  try {
    const values: NewRequestLog[] = batch.map((item) => ({
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
    }));

    await db.insert(requestLogs).values(values);

    // If quota check callback is registered, trigger async check for touched orgs
    if (quotaCheckCallback && touchedOrgIds.size > 0) {
      const orgsToCheck = Array.from(touchedOrgIds);
      touchedOrgIds.clear();
      void quotaCheckCallback(orgsToCheck).catch((err) => {
        console.error('[Telemetry] Error checking quotas:', err);
      });
    }
  } catch (err) {
    console.error('[Telemetry] Failed to flush log batch:', err);
    // Restore failed batch to the front of the queue to retry on next flush
    queue.unshift(...batch);
    if (queue.length > MAX_QUEUE_SIZE) {
      // Drop oldest overflow if queue exceeds max capacity during extended DB outage
      queue.splice(MAX_QUEUE_SIZE);
    }
  } finally {
    isFlushing = false;
    if (queue.length >= BATCH_SIZE) {
      void flushQueue();
    }
  }
}

/**
 * Flush all pending logs until the queue is empty.
 */
export async function flushAll(): Promise<void> {
  while (queue.length > 0) {
    await flushQueue();
  }
  touchedOrgIds.clear();
}

/**
 * Reset queue and state for isolated unit testing.
 */
export function resetQueueForTesting(): void {
  queue = [];
  touchedOrgIds.clear();
  isFlushing = false;
  quotaCheckCallback = null;
}

/**
 * Starts the periodic background flush timer.
 */
export function startIngestFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushQueue();
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
    isFlushing,
  };
}
