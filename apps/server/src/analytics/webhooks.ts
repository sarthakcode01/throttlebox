import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orgWebhooks, type OrgWebhook } from '../db/schema.js';
import type { CreatedWebhookConfig, WebhookConfig } from '@throttlebox/shared';
import { isProduction } from '../config.js';
import {
  BlockedAddressError,
  isBlockedAddress,
  isInternalHostname,
  safeLookup,
} from '../http/ssrf.js';

export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Shortest signing secret a caller may supply. Generated ones are 48 hex chars. */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

const DELIVERY_TIMEOUT_MS = 5000;

/**
 * Validates that a webhook URL is safe from SSRF attacks, as far as the URL
 * itself can tell: scheme, embedded credentials, internal host names, and
 * literal private addresses (in any encoding the URL parser accepts — it
 * canonicalises `2130706433`, `0x7f000001` and `127.1` to `127.0.0.1`).
 *
 * A host *name* can still resolve to a private address, so this is the first
 * check, not the only one: delivery resolves the name and refuses private
 * addresses at connect time (see `http/ssrf.ts`).
 */
export function isValidWebhookUrl(rawUrl: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Protocol validation: must be http or https (https mandatory in production)
  if (isProduction) {
    if (parsed.protocol !== 'https:') {
      return { valid: false, reason: 'Webhooks must use HTTPS in production' };
    }
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Webhooks must use HTTP or HTTPS' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'Webhook URLs cannot contain credentials' };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    if (isBlockedAddress(host)) {
      return { valid: false, reason: 'Private, loopback and reserved addresses are not permitted' };
    }
    return { valid: true };
  }

  if (isInternalHostname(host)) {
    return { valid: false, reason: 'Loopback and internal domains are not permitted' };
  }

  return { valid: true };
}

/** Show enough of a secret to recognise it, never enough to use it. */
function maskSecret(secret: string): string {
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

/**
 * The signing secret is a credential, so it is write-only: list and get
 * responses carry a masked preview. The full value is returned once, by
 * `createOrgWebhook`.
 */
export function toWebhookConfig(row: OrgWebhook): WebhookConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    url: row.url,
    secretPreview: maskSecret(row.secret),
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

export class WebhookValidationError extends Error {
  statusCode = 400;
  code = 'invalid_webhook_url';
}

export async function createOrgWebhook(
  orgId: string,
  url: string,
  secret?: string,
): Promise<CreatedWebhookConfig> {
  const trimmedUrl = url.trim();
  const urlCheck = isValidWebhookUrl(trimmedUrl);
  if (!urlCheck.valid) {
    throw new WebhookValidationError(urlCheck.reason ?? 'Invalid webhook URL');
  }

  const webhookSecret =
    secret && secret.trim().length > 0 ? secret.trim() : `whsec_${randomBytes(24).toString('hex')}`;

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

  // The one response that carries the full secret.
  return { ...toWebhookConfig(created), secret: webhookSecret };
}

/** Delete a webhook. Returns false when the org has no webhook with that id. */
export async function deleteOrgWebhook(orgId: string, webhookId: string): Promise<boolean> {
  const deleted = await db
    .delete(orgWebhooks)
    .where(and(eq(orgWebhooks.id, webhookId), eq(orgWebhooks.orgId, orgId)))
    .returning({ id: orgWebhooks.id });
  return deleted.length > 0;
}

export interface WebhookRequest {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * The HTTP client used for deliveries. An object so tests can replace it.
 *
 * `fetch` was not usable here: it follows redirects, and it resolves DNS on
 * its own after any check we make, which is the DNS-rebinding gap.
 * `http.request` with `lookup: safeLookup` connects to exactly the address
 * that was checked, and never follows a redirect.
 */
export const webhookTransport = {
  send(url: string, request: WebhookRequest): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const client = target.protocol === 'https:' ? https : http;

      const req = client.request(
        target,
        {
          method: 'POST',
          headers: { ...request.headers, 'Content-Length': Buffer.byteLength(request.body) },
          lookup: safeLookup,
          timeout: request.timeoutMs,
        },
        (res) => {
          // The body is not needed; drain it so the socket is released.
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
          res.on('error', reject);
        },
      );

      req.on('timeout', () => req.destroy(new Error('Webhook delivery timed out')));
      req.on('error', reject);
      req.end(request.body);
    });
  },
};

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
    const res = await webhookTransport.send(webhook.url, {
      headers: {
        'Content-Type': 'application/json',
        'X-Throttlebox-Signature': `sha256=${signature}`,
        'X-Throttlebox-Event': eventName,
        'X-Throttlebox-Delivery': deliveryId,
        'User-Agent': 'Throttlebox-Webhooks/1.0',
      },
      body: payloadString,
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });

    // Redirects are not followed, so a 3xx is a failed delivery.
    return {
      success: res.status >= 200 && res.status < 300,
      statusCode: res.status,
    };
  } catch (err: unknown) {
    // Generic messages only. The raw error (ECONNREFUSED vs a timeout vs a
    // TLS failure) turned the test endpoint into a port scanner.
    if (err instanceof BlockedAddressError) {
      return {
        success: false,
        error: 'Blocked SSRF attempt: destination resolves to a private address',
      };
    }
    return { success: false, error: 'Delivery failed: the endpoint could not be reached' };
  }
}

export async function testOrgWebhook(
  orgId: string,
  webhookId: string,
): Promise<{ success: boolean; statusCode?: number; error?: string } | null> {
  const [webhook] = await db
    .select()
    .from(orgWebhooks)
    .where(and(eq(orgWebhooks.id, webhookId), eq(orgWebhooks.orgId, orgId)))
    .limit(1);

  if (!webhook) return null;

  return dispatchWebhook(webhook, 'ping', {
    message: 'Throttlebox webhook test event',
    orgId,
    test: true,
  });
}
