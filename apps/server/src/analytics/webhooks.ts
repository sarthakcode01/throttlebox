import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { CreateWebhookResponse, WebhookConfig } from '@throttlebox/shared';
import { desc, eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orgWebhooks, type OrgWebhook } from '../db/schema.js';
import { resolveWebhookTarget, type WebhookTarget } from './webhookGuard.js';

export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Mask a webhook secret for display.
 *
 * Keeps a recognisable prefix and the last two characters so a user can tell
 * *which* secret is configured, and nothing else. It is not reversible and not
 * enough to sign a payload.
 */
export function maskSecret(secret: string): string {
  const prefixMatch = /^(whsec_)/.exec(secret);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  return `${prefix}${'•'.repeat(4)}…${secret.slice(-2)}`;
}

/**
 * The client-facing view of a webhook.
 *
 * The signing secret is deliberately absent: it is a credential, it was
 * previously returned on every list call to any `analytics:read` holder
 * (including `viewer`), and it is the only thing a receiver can use to verify
 * that a payload really came from Throttlebox. It is write-only now, exactly
 * like a raw API key.
 */
export function toWebhookConfig(row: OrgWebhook): WebhookConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    url: row.url,
    isActive: row.isActive,
    lastAlertedThreshold: row.lastAlertedThreshold,
    createdAt: row.createdAt.toISOString(),
    secretPreview: maskSecret(row.secret),
    hasCustomSecret: !row.secret.startsWith('whsec_'),
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
): Promise<CreateWebhookResponse> {
  // Validation (including DNS resolution and the address checks) happens in the
  // route, where a rejection can become a 400 with the reason attached.
  const supplied = secret && secret.trim().length > 0 ? secret.trim() : null;
  const webhookSecret = supplied ?? `whsec_${randomBytes(24).toString('hex')}`;

  const [created] = await db
    .insert(orgWebhooks)
    .values({
      orgId,
      url,
      secret: webhookSecret,
      isActive: true,
      lastAlertedThreshold: null,
    })
    .returning();

  if (!created) {
    throw new Error('Failed to create webhook');
  }

  return {
    ...toWebhookConfig(created),
    // Shown once. A generated secret must be copied now; a supplied one is
    // already known to the caller, so it is not echoed back.
    secret: supplied ? null : webhookSecret,
  };
}

export async function deleteOrgWebhook(orgId: string, webhookId: string): Promise<void> {
  await db
    .delete(orgWebhooks)
    .where(and(eq(orgWebhooks.id, webhookId), eq(orgWebhooks.orgId, orgId)));
}

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * POST a signed payload to a validated target.
 *
 * The connection is made to the **pinned address** the guard resolved, not to
 * whatever `fetch(url)` would resolve at connect time — that gap is the DNS
 * rebinding window. `node:https` keeps `servername` set to the hostname, so TLS
 * certificate validation still runs against the certificate the host presents.
 *
 * Redirects are not followed. A quota webhook has no reason to redirect, and
 * following one would let a permitted URL point the request at a host the guard
 * never approved.
 */
function postPinned(
  target: WebhookTarget,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<DeliveryResult> {
  const url = new URL(target.url);
  const isHttps = url.protocol === 'https:';

  return new Promise((resolve) => {
    const transport = isHttps ? https : http;

    const request = transport.request(
      {
        protocol: url.protocol,
        // The pinned address: no second DNS lookup happens.
        host: target.address,
        family: target.family,
        port: url.port || (isHttps ? 443 : 80),
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          Host: url.host,
          'Content-Length': Buffer.byteLength(body),
        },
        // Send SNI and validate the certificate against the *name*, not the IP.
        ...(isHttps ? { servername: target.hostname } : {}),
        timeout: timeoutMs,
      },
      (response) => {
        // Drain so the socket can be released; the body is not used.
        response.resume();
        const status = response.statusCode ?? 0;

        // 3xx means the destination is trying to move us somewhere the guard
        // has not vetted. Treat it as a blocked delivery.
        if (status >= 300 && status < 400) {
          resolve({
            success: false,
            statusCode: status,
            error: 'Webhook endpoint returned a redirect, which is not followed',
          });
          return;
        }

        resolve({ success: status >= 200 && status < 300, statusCode: status });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error(`Webhook delivery timed out after ${timeoutMs}ms`));
    });

    request.on('error', (err: Error) => {
      resolve({ success: false, error: err.message });
    });

    request.end(body);
  });
}

/**
 * Deliver one event to one webhook.
 *
 * The target is re-resolved on every delivery rather than trusting the URL that
 * was stored at creation time: DNS is not a stable fact, and re-checking means a
 * host that has since started answering with a private address is refused
 * rather than contacted.
 */
export async function dispatchWebhook(
  webhook: { url: string; secret: string },
  eventName: string,
  data: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<DeliveryResult> {
  const resolved = await resolveWebhookTarget(webhook.url, {
    allowHttp: process.env.NODE_ENV !== 'production',
  });
  if (!resolved.ok) {
    return { success: false, error: `Blocked by the webhook egress guard: ${resolved.reason}` };
  }

  const deliveryId = `del_${randomUUID()}`;
  const payloadString = JSON.stringify({
    id: `evt_${randomUUID()}`,
    event: eventName,
    timestamp: new Date().toISOString(),
    data,
  });

  return postPinned(
    resolved.target,
    {
      'Content-Type': 'application/json',
      'X-Throttlebox-Signature': `sha256=${signPayload(webhook.secret, payloadString)}`,
      'X-Throttlebox-Event': eventName,
      'X-Throttlebox-Delivery': deliveryId,
      'User-Agent': 'Throttlebox-Webhooks/1.0',
    },
    payloadString,
    options.timeoutMs ?? 5000,
  );
}

export async function testOrgWebhook(orgId: string, webhookId: string): Promise<DeliveryResult> {
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
