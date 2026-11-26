import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  recordRequestLog,
  flushQueue,
  getQueueStats,
  setQuotaCheckCallback,
  resetQueueForTesting,
} from '../../src/analytics/ingest.js';
import { signPayload, dispatchWebhook } from '../../src/analytics/webhooks.js';
import { resolveWebhookTarget } from '../../src/analytics/webhookGuard.js';
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

  it('rejects SSRF target addresses including private subnets and cloud metadata', async () => {
    // Loopback
    expect((await resolveWebhookTarget('http://localhost:8080/hook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://127.0.0.1/hook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://[::1]/hook')).ok).toBe(false);

    // Alternate IPv4 encodings are canonicalised by `new URL()` and then caught
    expect((await resolveWebhookTarget('http://2130706433/hook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://0x7f000001/hook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://127.1/hook')).ok).toBe(false);

    // IPv4-mapped and NAT64 IPv6 forms — these were the live bypass
    expect((await resolveWebhookTarget('http://[::ffff:127.0.0.1]/hook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://[::ffff:7f00:1]/hook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://[64:ff9b::7f00:1]/hook')).ok).toBe(false);
    expect(
      (await resolveWebhookTarget('http://[::ffff:169.254.169.254]/latest/meta-data')).ok,
    ).toBe(false);

    // Cloud metadata (AWS / GCP / Azure)
    expect((await resolveWebhookTarget('http://169.254.169.254/latest/meta-data')).ok).toBe(false);

    // Private RFC 1918 subnets
    expect((await resolveWebhookTarget('http://10.0.0.1/webhook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://172.16.5.10/webhook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://172.31.255.1/webhook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://192.168.1.1/webhook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://100.64.0.1/webhook')).ok).toBe(false);

    // Internal domains and bare labels (which resolve through search domains)
    expect((await resolveWebhookTarget('http://service.internal/hook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://app.local/hook')).ok).toBe(false);
    expect((await resolveWebhookTarget('http://intranet/hook')).ok).toBe(false);

    // Non-http schemes and embedded credentials
    expect((await resolveWebhookTarget('file:///etc/passwd')).ok).toBe(false);
    expect((await resolveWebhookTarget('gopher://example.com/')).ok).toBe(false);
    expect((await resolveWebhookTarget('https://user:pw@example.com/hook')).ok).toBe(false);
  });

  it('blocks dispatch when webhook destination is an SSRF risk', async () => {
    const result = await dispatchWebhook(
      { url: 'http://169.254.169.254/metadata', secret: 'whsec_secret' },
      'test.event',
      {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('webhook egress guard');
  });
});
