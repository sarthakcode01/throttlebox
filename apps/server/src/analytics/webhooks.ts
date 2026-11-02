import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orgWebhooks, type OrgWebhook } from '../db/schema.js';
import type { WebhookConfig } from '@throttlebox/shared';

export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function toWebhookConfig(row: OrgWebhook): WebhookConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    url: row.url,
    secret: row.secret,
    isActive: row.isActive,
    lastAlertedThreshold: row.lastAlertedThreshold,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listOrgWebhooks(orgId: string): Promise<WebhookConfig[]> {
  const rows = await db
    .select()
    .from(orgWebhooks)
    .where(eq(orgWebhooks.orgId, orgId))
    .orderBy(desc(orgWebhooks.createdAt));

  return rows.map(toWebhookConfig);
}

export async function createOrgWebhook(
  orgId: string,
  url: string,
  secret?: string,
): Promise<WebhookConfig> {
  const webhookSecret = secret && secret.trim().length > 0 ? secret.trim() : `whsec_${randomBytes(24).toString('hex')}`;

  const [created] = await db
    .insert(orgWebhooks)
    .values({
      orgId,
      url: url.trim(),
      secret: webhookSecret,
      isActive: true,
      lastAlertedThreshold: null,
    })
    .returning();

  if (!created) {
    throw new Error('Failed to create webhook');
  }

  return toWebhookConfig(created);
}

export async function deleteOrgWebhook(orgId: string, webhookId: string): Promise<void> {
  await db
    .delete(orgWebhooks)
    .where(and(eq(orgWebhooks.id, webhookId), eq(orgWebhooks.orgId, orgId)));
}

export async function dispatchWebhook(
  webhook: { url: string; secret: string },
  eventName: string,
  data: Record<string, unknown>,
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const deliveryId = `del_${randomUUID()}`;
  const payloadString = JSON.stringify({
    id: `evt_${randomUUID()}`,
    event: eventName,
    timestamp: new Date().toISOString(),
    data,
  });

  const signature = signPayload(webhook.secret, payloadString);

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Throttlebox-Signature': `sha256=${signature}`,
        'X-Throttlebox-Event': eventName,
        'X-Throttlebox-Delivery': deliveryId,
        'User-Agent': 'Throttlebox-Webhooks/1.0',
      },
      body: payloadString,
      signal: AbortSignal.timeout(5000),
    });

    return {
      success: res.ok,
      statusCode: res.status,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}

export async function testOrgWebhook(
  orgId: string,
  webhookId: string,
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const [webhook] = await db
    .select()
    .from(orgWebhooks)
    .where(and(eq(orgWebhooks.id, webhookId), eq(orgWebhooks.orgId, orgId)))
    .limit(1);

  if (!webhook) {
    return { success: false, error: 'Webhook not found' };
  }

  return dispatchWebhook(webhook, 'ping', {
    message: 'Throttlebox webhook test event',
    orgId,
    test: true,
  });
}
