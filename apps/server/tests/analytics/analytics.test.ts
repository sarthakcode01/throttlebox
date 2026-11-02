import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  recordRequestLog,
  flushQueue,
  getQueueStats,
  setQuotaCheckCallback,
  resetQueueForTesting,
} from '../../src/analytics/ingest.js';
import { signPayload, dispatchWebhook } from '../../src/analytics/webhooks.js';
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchWebhook(
      { url: 'https://example.com/webhook', secret: 'whsec_secret' },
      'quota.threshold_reached',
      { threshold: 80, currentUsage: 85, limit: 100 },
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs![0]).toBe('https://example.com/webhook');
    const headers = (callArgs![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Throttlebox-Event']).toBe('quota.threshold_reached');
    expect(headers['X-Throttlebox-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers['X-Throttlebox-Delivery']).toMatch(/^del_/);
    expect(headers['Content-Type']).toBe('application/json');

    vi.unstubAllGlobals();
  });
});
