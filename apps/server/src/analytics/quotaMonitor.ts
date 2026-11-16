import { and, eq, isNull, lt, or, sql as drizzleSql } from 'drizzle-orm';
import { db, sql } from '../db/client.js';
import { orgWebhooks } from '../db/schema.js';
import { getOrgWindowUsage } from '../ratelimit/limiter.js';
import { getOrgPlan } from '../ratelimit/tier.js';
import { dispatchWebhook } from './webhooks.js';

/**
 * Usage has to fall this far below the 80% threshold before the alert state
 * resets. In a sliding window usage hovers around a threshold, and resetting
 * the moment it dipped re-sent the same alert over and over.
 */
const RESET_BELOW_RATIO = 0.7;

/** After a failed delivery, wait this long before trying that webhook again. */
const FAILURE_COOLDOWN_MS = 60_000;
const failedAt = new Map<string, number>();

/**
 * Check quota consumption for an array of org IDs and notify via webhook
 * when 80% or 100% threshold is reached.
 */
export async function checkOrgQuotas(orgIds: string[]): Promise<void> {
  for (const orgId of orgIds) {
    try {
      await checkSingleOrgQuota(orgId);
    } catch (err) {
      console.error(`[QuotaMonitor] Error checking quota for org ${orgId}:`, err);
    }
  }
}

/**
 * Requests in the current window. Read from the rate limiter's own Redis
 * sorted set — exact, and one round trip — instead of a `count(*)` over the
 * hypertable on every flush. Falls back to the table if Redis is down.
 */
async function windowUsage(orgId: string, windowSeconds: number): Promise<number> {
  const fromRedis = await getOrgWindowUsage(orgId, windowSeconds);
  if (fromRedis !== null) return fromRedis;

  const [usageRow] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM request_logs
    WHERE org_id = ${orgId}
      AND time >= NOW() - make_interval(secs => ${windowSeconds})
      AND rate_limited = false;
  `;
  return usageRow?.count ?? 0;
}

export async function checkSingleOrgQuota(orgId: string): Promise<void> {
  const plan = await getOrgPlan(orgId);
  const limit = Math.floor(plan.requestsPerWindow * plan.burstAllowance);

  const count = await windowUsage(orgId, plan.windowSeconds);
  const ratio = limit > 0 ? count / limit : 0;

  let currentThreshold: number | null = null;
  if (ratio >= 1.0) {
    currentThreshold = 100;
  } else if (ratio >= 0.8) {
    currentThreshold = 80;
  }

  const webhooks = await db
    .select()
    .from(orgWebhooks)
    .where(and(eq(orgWebhooks.orgId, orgId), eq(orgWebhooks.isActive, true)));

  if (webhooks.length === 0) {
    return;
  }

  // Dispatch webhooks in parallel so a slow or hanging destination endpoint does not block others
  await Promise.allSettled(
    webhooks.map(async (webhook) => {
      if (currentThreshold === null) {
        if (webhook.lastAlertedThreshold !== null && ratio < RESET_BELOW_RATIO) {
          await db
            .update(orgWebhooks)
            .set({ lastAlertedThreshold: null, updatedAt: new Date() })
            .where(eq(orgWebhooks.id, webhook.id));
        }
        return;
      }

      const lastFailure = failedAt.get(webhook.id);
      if (lastFailure && Date.now() - lastFailure < FAILURE_COOLDOWN_MS) return;

      // Claim the alert atomically. Two overlapping checks (or two
      // instances) used to both read "not alerted yet" and both send it.
      // Only the one whose UPDATE matches gets to dispatch.
      const previous = webhook.lastAlertedThreshold;
      const [claimed] = await db
        .update(orgWebhooks)
        .set({ lastAlertedThreshold: currentThreshold, updatedAt: new Date() })
        .where(
          and(
            eq(orgWebhooks.id, webhook.id),
            or(
              isNull(orgWebhooks.lastAlertedThreshold),
              lt(orgWebhooks.lastAlertedThreshold, currentThreshold),
            ),
          ),
        )
        .returning({ id: orgWebhooks.id });

      if (!claimed) return;

      const result = await dispatchWebhook(webhook, 'quota.threshold_reached', {
        orgId,
        threshold: currentThreshold,
        currentUsage: count,
        limit,
        windowSeconds: plan.windowSeconds,
      });

      if (result.success) {
        failedAt.delete(webhook.id);
        return;
      }

      // The alert was not delivered. Hand the claim back so a later check
      // retries it, instead of recording an alert nobody received.
      failedAt.set(webhook.id, Date.now());
      await db
        .update(orgWebhooks)
        .set({ lastAlertedThreshold: previous, updatedAt: new Date() })
        .where(
          and(
            eq(orgWebhooks.id, webhook.id),
            drizzleSql`${orgWebhooks.lastAlertedThreshold} = ${currentThreshold}`,
          ),
        );
    }),
  );
}
