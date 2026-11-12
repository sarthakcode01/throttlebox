import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orgWebhooks, type OrgWebhook } from '../db/schema.js';
import type { WebhookConfig } from '@throttlebox/shared';

export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Validates that a webhook URL is safe from SSRF attacks.
 * Rejects loopback, private RFC 1918, link-local, and cloud metadata addresses.
 */
export function isValidWebhookUrl(rawUrl: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Protocol validation: must be http or https (https mandatory in production)
  if (process.env.NODE_ENV === 'production') {
    if (parsed.protocol !== 'https:') {
      return { valid: false, reason: 'Webhooks must use HTTPS in production' };
    }
  } else {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: 'Webhooks must use HTTP or HTTPS' };
    }
  }

  const hostname = parsed.hostname.toLowerCase().trim();
  const cleanHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Reject loopback and internal domain names
  if (
    cleanHost === 'localhost' ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local') ||
    cleanHost.endsWith('.internal')
  ) {
    return { valid: false, reason: 'Loopback and internal domains are not permitted' };
  }

  // Reject IPv6 loopback, unique local, link-local
  if (
    cleanHost === '::1' ||
    cleanHost === '0:0:0:0:0:0:0:1' ||
    cleanHost.startsWith('fe80:') ||
    cleanHost.startsWith('fc00:') ||
    cleanHost.startsWith('fd00:')
  ) {
    return { valid: false, reason: 'Loopback and private IPv6 addresses are not permitted' };
  }

  // Reject IPv4 loopback, metadata, and private RFC 1918 subnets
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = ipv4Regex.exec(cleanHost);
  if (match) {
    const octet1 = parseInt(match[1]!, 10);
    const octet2 = parseInt(match[2]!, 10);
    const octet3 = parseInt(match[3]!, 10);
    const octet4 = parseInt(match[4]!, 10);

    if (octet1 > 255 || octet2 > 255 || octet3 > 255 || octet4 > 255) {
      return { valid: false, reason: 'Invalid IP address' };
    }

    if (octet1 === 0) {
      return { valid: false, reason: 'Invalid IP address range' };
    }

    // 127.0.0.0/8 (loopback)
    if (octet1 === 127) {
      return { valid: false, reason: 'Loopback IP addresses are not permitted' };
    }

    // 169.254.0.0/16 (link-local and cloud metadata like 169.254.169.254)
    if (octet1 === 169 && octet2 === 254) {
      return { valid: false, reason: 'Link-local and cloud metadata addresses are not permitted' };
    }

    // 10.0.0.0/8 (RFC 1918)
    if (octet1 === 10) {
      return { valid: false, reason: 'Private IP addresses are not permitted' };
    }

    // 172.16.0.0/12 (RFC 1918: 172.16.x.x - 172.31.x.x)
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) {
      return { valid: false, reason: 'Private IP addresses are not permitted' };
    }

    // 192.168.0.0/16 (RFC 1918)
    if (octet1 === 192 && octet2 === 168) {
      return { valid: false, reason: 'Private IP addresses are not permitted' };
    }

    // 100.64.0.0/10 (CGNAT)
    if (octet1 === 100 && octet2 >= 64 && octet2 <= 127) {
      return { valid: false, reason: 'Carrier-grade NAT IP addresses are not permitted' };
    }
  }

  return { valid: true };
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
  const trimmedUrl = url.trim();
  const urlCheck = isValidWebhookUrl(trimmedUrl);
  if (!urlCheck.valid) {
    throw new Error(urlCheck.reason ?? 'Invalid webhook URL');
  }

  const webhookSecret = secret && secret.trim().length > 0 ? secret.trim() : `whsec_${randomBytes(24).toString('hex')}`;

  const [created] = await db
    .insert(orgWebhooks)
    .values({
      orgId,
      url: trimmedUrl,
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
  const urlCheck = isValidWebhookUrl(webhook.url);
  if (!urlCheck.valid) {
    return {
      success: false,
      error: `Blocked SSRF attempt: ${urlCheck.reason}`,
    };
  }

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
