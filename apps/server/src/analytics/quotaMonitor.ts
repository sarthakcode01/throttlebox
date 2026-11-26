import { and, eq } from 'drizzle-orm';
import { db, sql } from '../db/client.js';
import { orgWebhooks } from '../db/schema.js';
import { getOrgPlan } from '../ratelimit/tier.js';
import { enqueueWebhookEvent } from './webhookOutbox.js';

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

export async function checkSingleOrgQuota(orgId: string): Promise<void> {
  const plan = await getOrgPlan(orgId);
  const limit = Math.floor(plan.requestsPerWindow * plan.burstAllowance);

  // Count requests in the current window
  const [usageRow] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM request_logs
    WHERE org_id = ${orgId} AND time >= NOW() - (${plan.windowSeconds} || ' seconds')::interval;
  `;

  const count = usageRow?.count ?? 0;
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

  // Queue rather than deliver.
  //
  // This used to `await dispatchWebhook(...)` — a third-party HTTP call with a
  // 5s timeout — inside the telemetry flush. One slow endpoint delayed ingest
  // for every organisation and a failure left no record. The outbox worker
  // delivers and retries; this path only writes a row.
  await Promise.allSettled(
    webhooks.map(async (webhook) => {
      const last = webhook.lastAlertedThreshold;

      if (currentThreshold !== null && (last === null || currentThreshold > last)) {
        // Threshold reached or increased (e.g. from 80% to 100%)
        await enqueueWebhookEvent({
          orgId,
          webhookId: webhook.id,
          event: 'quota.threshold_reached',
          payload: {
            orgId,
            threshold: currentThreshold,
            currentUsage: count,
            limit,
            windowSeconds: plan.windowSeconds,
          },
        });

        await db
          .update(orgWebhooks)
          .set({ lastAlertedThreshold: currentThreshold, updatedAt: new Date() })
          .where(eq(orgWebhooks.id, webhook.id));
      } else if (currentThreshold === null && last !== null) {
        // Usage dropped below threshold (new window started)
        await db
          .update(orgWebhooks)
          .set({ lastAlertedThreshold: null, updatedAt: new Date() })
          .where(eq(orgWebhooks.id, webhook.id));
      }
    }),
  );
}
