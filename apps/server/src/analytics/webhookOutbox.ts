import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orgWebhooks, webhookDeliveries } from '../db/schema.js';
import { dispatchWebhook } from './webhooks.js';

/**
 * Webhook delivery outbox worker.
 *
 * Quota alerts are queued as rows and delivered here, off the request path and
 * off the telemetry flush. Delivery used to be awaited inside the ingest loop,
 * so a slow endpoint delayed telemetry for every organisation, and a failed
 * alert vanished with no record. This module fixes both: the queue is durable,
 * attempts are counted, failures back off, and a delivery that exhausts its
 * retries is left visible as `failed` rather than silently dropped.
 */

const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 20;
const TICK_MS = 15_000;

/** Exponential backoff capped at an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

export interface QueuedDelivery {
  orgId: string;
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Queue an event for every active webhook in an organisation.
 *
 * One INSERT, no network: this is what the quota monitor calls.
 */
export async function enqueueWebhookEvent(input: QueuedDelivery): Promise<string | null> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      orgId: input.orgId,
      webhookId: input.webhookId,
      event: input.event,
      payload: input.payload,
      status: 'pending',
      nextAttemptAt: new Date(),
    })
    .returning({ id: webhookDeliveries.id });

  return row?.id ?? null;
}

export interface DrainResult {
  attempted: number;
  delivered: number;
  failed: number;
  retrying: number;
}

/**
 * Attempt every delivery that is due.
 *
 * Rows are claimed with a single `UPDATE ... RETURNING`-style transition guarded
 * by `status = 'pending'`, so two instances draining at once cannot both deliver
 * the same row: the second sees `status = 'sending'` and skips it.
 */
export async function drainWebhookOutbox(now: Date = new Date()): Promise<DrainResult> {
  const due = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(BATCH_SIZE);

  const result: DrainResult = { attempted: 0, delivered: 0, failed: 0, retrying: 0 };

  for (const row of due) {
    // Claim it. A no-op update means another replica got there first.
    const claimed = await db
      .update(webhookDeliveries)
      .set({ status: 'sending', attempts: sql`${webhookDeliveries.attempts} + 1` })
      .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.status, 'pending')))
      .returning({ id: webhookDeliveries.id, attempts: webhookDeliveries.attempts });

    if (claimed.length === 0) continue;

    result.attempted += 1;
    const attempts = claimed[0]?.attempts ?? 1;

    const [webhook] = await db
      .select({ url: orgWebhooks.url, secret: orgWebhooks.secret, isActive: orgWebhooks.isActive })
      .from(orgWebhooks)
      .where(eq(orgWebhooks.id, row.webhookId))
      .limit(1);

    if (!webhook || !webhook.isActive) {
      await db
        .update(webhookDeliveries)
        .set({ status: 'failed', lastError: 'Webhook was deleted or deactivated' })
        .where(eq(webhookDeliveries.id, row.id));
      result.failed += 1;
      continue;
    }

    const outcome = await dispatchWebhook(webhook, row.event, row.payload, {
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });

    if (outcome.success) {
      await db
        .update(webhookDeliveries)
        .set({ status: 'delivered', deliveredAt: new Date(), lastError: null })
        .where(eq(webhookDeliveries.id, row.id));
      result.delivered += 1;
      continue;
    }

    const exhausted = attempts >= MAX_ATTEMPTS;
    await db
      .update(webhookDeliveries)
      .set({
        status: exhausted ? 'failed' : 'pending',
        lastError: outcome.error ?? `HTTP ${outcome.statusCode ?? 'unknown'}`,
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      })
      .where(eq(webhookDeliveries.id, row.id));

    if (exhausted) result.failed += 1;
    else result.retrying += 1;
  }

  return result;
}

/**
 * Recover rows abandoned mid-delivery.
 *
 * A process killed between claiming a row and recording the outcome would leave
 * it stuck in `sending` forever. Anything in that state for over five minutes is
 * put back to pending so it gets another attempt.
 */
export async function requeueStuckDeliveries(): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const recovered = await db
    .update(webhookDeliveries)
    .set({ status: 'pending' })
    .where(
      and(
        eq(webhookDeliveries.status, 'sending'),
        or(lte(webhookDeliveries.nextAttemptAt, cutoff), lte(webhookDeliveries.createdAt, cutoff)),
      ),
    )
    .returning({ id: webhookDeliveries.id });

  return recovered.length;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** One tick: recover abandoned rows, then drain what is due. */
export async function runWebhookOutboxTick(): Promise<DrainResult> {
  await requeueStuckDeliveries();
  return drainWebhookOutbox();
}

export function startWebhookOutbox(): void {
  if (timer) return;

  timer = setInterval(() => {
    // Never overlap ticks: a tick that is still running means the network is
    // slow, and piling up more work would not help.
    if (running) return;
    running = true;
    void runWebhookOutboxTick()
      .catch((err) => {
        console.error('[webhook-outbox] tick failed:', err);
      })
      .finally(() => {
        running = false;
      });
  }, TICK_MS);

  timer.unref?.();
}

/** Stop the worker and make one last attempt at what is due. */
export async function stopWebhookOutbox(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (running) return;
  running = true;
  try {
    await runWebhookOutboxTick();
  } catch {
    // Best effort during shutdown.
  } finally {
    running = false;
  }
}
