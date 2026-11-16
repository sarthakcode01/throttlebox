import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  recordRequestLog,
  flushQueue,
  getQueueStats,
  setQuotaCheckCallback,
  resetQueueForTesting,
} from '../../src/analytics/ingest.js';
import {
  signPayload,
  dispatchWebhook,
  isValidWebhookUrl,
  webhookTransport,
} from '../../src/analytics/webhooks.js';
import { db } from '../../src/db/client.js';
import { requestLogs } from '../../src/db/schema.js';

describe('Analytics Ingestion Buffer', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    resetQueueForTesting();
  });

  it('enqueues logs non-blockingly and flushes to database in batches', async () => {
    const insertSpy = vi.spyOn(db, 'insert').mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof db.insert>);

    recordRequestLog({
      orgId: 'test-org-123',
      method: 'GET',
      path: '/mock/test/products',
      statusCode: 200,
      latencyMs: 42,
      traceId: 'trace-1',
    });

    expect(getQueueStats().queueLength).toBe(1);

    await flushQueue();

    expect(insertSpy).toHaveBeenCalledWith(requestLogs);
    expect(getQueueStats().queueLength).toBe(0);
  });

  it('notifies quota callback for touched organizations on flush', async () => {
    vi.spyOn(db, 'insert').mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof db.insert>);

    const quotaCallback = vi.fn().mockResolvedValue(undefined);
    setQuotaCheckCallback(quotaCallback);

    recordRequestLog({
      orgId: 'org-alert-test',
      method: 'POST',
      path: '/mock/test/orders',
      statusCode: 201,
      latencyMs: 88,
      traceId: 'trace-2',
    });

    await flushQueue();

    expect(quotaCallback).toHaveBeenCalledWith(['org-alert-test']);
  });

  it('restores log batch to queue when database insert fails', async () => {
    vi.spyOn(db, 'insert').mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('Connection lost')),
    } as unknown as ReturnType<typeof db.insert>);

    recordRequestLog({
      orgId: 'org-fail-test',
      method: 'GET',
      path: '/mock/test/items',
      statusCode: 200,
      latencyMs: 15,
      traceId: 'trace-fail',
    });

    expect(getQueueStats().queueLength).toBe(1);

    await flushQueue();

    // The log should be restored back into the queue for subsequent retry
    expect(getQueueStats().queueLength).toBe(1);
  });
});

describe('Webhooks & HMAC Signatures', () => {
  it('signs payload with HMAC-SHA256 correctly', () => {
    const secret = 'whsec_test_secret_key_123';
    const payload = JSON.stringify({ event: 'ping', test: true });

    const signature1 = signPayload(secret, payload);
    const signature2 = signPayload(secret, payload);

    expect(signature1).toBe(signature2);
    expect(signature1).toHaveLength(64); // SHA-256 hex digest is 64 hex characters
  });

  it('dispatches webhook with required Throttlebox headers', async () => {
    const sendMock = vi.spyOn(webhookTransport, 'send').mockResolvedValue({ status: 200 });

    const result = await dispatchWebhook(
      { url: 'https://example.com/webhook', secret: 'whsec_secret' },
      'quota.threshold_reached',
      { threshold: 80, currentUsage: 85, limit: 100 },
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const callArgs = sendMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs![0]).toBe('https://example.com/webhook');
    const headers = callArgs![1].headers;
    expect(headers['X-Throttlebox-Event']).toBe('quota.threshold_reached');
    expect(headers['X-Throttlebox-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers['X-Throttlebox-Delivery']).toMatch(/^del_/);
    expect(headers['Content-Type']).toBe('application/json');

    // The signature covers exactly the bytes that are sent.
    const signature = headers['X-Throttlebox-Signature']!.replace('sha256=', '');
    expect(signature).toBe(signPayload('whsec_secret', callArgs![1].body));
  });

  it('treats a redirect as a failed delivery rather than following it', async () => {
    vi.spyOn(webhookTransport, 'send').mockResolvedValue({ status: 302 });

    const result = await dispatchWebhook(
      { url: 'https://example.com/webhook', secret: 'whsec_secret' },
      'ping',
      {},
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(302);
  });

  it('returns a generic error instead of the network failure detail', async () => {
    vi.spyOn(webhookTransport, 'send').mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:6379'), { code: 'ECONNREFUSED' }),
    );

    const result = await dispatchWebhook(
      { url: 'https://example.com/webhook', secret: 'whsec_secret' },
      'ping',
      {},
    );

    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/ECONNREFUSED|6379/);
  });

  it('rejects SSRF target addresses including private subnets and cloud metadata', () => {
    // Loopback
    expect(isValidWebhookUrl('http://localhost:8080/hook').valid).toBe(false);
    expect(isValidWebhookUrl('http://127.0.0.1/hook').valid).toBe(false);
    expect(isValidWebhookUrl('http://[::1]/hook').valid).toBe(false);

    // Cloud metadata (AWS / GCP / Azure)
    expect(isValidWebhookUrl('http://169.254.169.254/latest/meta-data').valid).toBe(false);

    // Private RFC 1918 subnets
    expect(isValidWebhookUrl('http://10.0.0.1/webhook').valid).toBe(false);
    expect(isValidWebhookUrl('http://172.16.5.10/webhook').valid).toBe(false);
    expect(isValidWebhookUrl('http://172.31.255.1/webhook').valid).toBe(false);
    expect(isValidWebhookUrl('http://192.168.1.1/webhook').valid).toBe(false);

    // Internal domains
    expect(isValidWebhookUrl('http://service.internal/hook').valid).toBe(false);
    expect(isValidWebhookUrl('http://app.local/hook').valid).toBe(false);

    // Valid public destinations
    expect(isValidWebhookUrl('https://api.acme.com/webhooks/receiver').valid).toBe(true);
    expect(isValidWebhookUrl('https://hooks.slack.com/services/T00/B00/X00').valid).toBe(true);
  });

  it('blocks dispatch when webhook destination is an SSRF risk', async () => {
    const result = await dispatchWebhook(
      { url: 'http://169.254.169.254/metadata', secret: 'whsec_secret' },
      'test.event',
      {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked SSRF attempt');
  });
});
