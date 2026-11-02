'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Plan } from '@throttlebox/shared';
import { ApiError, api } from '@/lib/api';

export default function RateLimitsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data: session } = useQuery({ queryKey: ['me'], queryFn: api.me });
  const { data: planData, isLoading } = useQuery({
    queryKey: ['org-plan'],
    queryFn: api.getOrgPlan,
  });

  const plan = planData?.plan;
  const currentPlan = plan?.name?.toLowerCase() ?? session?.org?.plan ?? 'free';
  const isPro = currentPlan === 'pro';
  const requestsPerWindow = plan?.requestsPerWindow ?? (isPro ? 5000 : 100);
  const burstAllowance = plan?.burstAllowance ?? (isPro ? 1.2 : 1.0);
  const maxCapacity = Math.round(requestsPerWindow * burstAllowance);

  const planMutation = useMutation({
    mutationFn: (newPlan: Plan) => api.updateOrgPlan(newPlan),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['org-plan'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Could not change workspace tier');
    },
  });

  const handleCopy = (text: string, id: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(id);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const testCurl = `for i in {1..120}; do curl -s -i -H "Authorization: Bearer <your-key>" http://localhost:3001/mock/ecommerce/products | grep -E "HTTP|X-RateLimit|Retry-After"; done`;

  return (
    <div>
      {/* Header */}
      <div className="dashboard-header-row">
        <div>
          <h1 className="dashboard-title">Rate Limits &amp; Tier Management</h1>
          <p className="dashboard-subtitle">
            Atomic Redis Lua sliding-window quotas with microsecond precision, automated burst
            allowances, and zero-downtime cluster synchronization.
          </p>
        </div>

        <button
          onClick={() => planMutation.mutate(isPro ? 'free' : 'pro')}
          disabled={planMutation.isPending}
          className={isPro ? 'secondary-button' : 'cta-button'}
          style={{ fontSize: '0.875rem' }}
        >
          {planMutation.isPending
            ? 'Updating Tier…'
            : isPro
              ? 'Downgrade to Free (100 req/hr)'
              : '⚡ Upgrade to Pro (5,000 req/hr + Burst)'}
        </button>
      </div>

      {error && (
        <div className="error" role="alert" style={{ marginBottom: '20px' }}>
          {error}
        </div>
      )}

      {/* ====================================================================
          Current Plan Status Banner
          ==================================================================== */}
      <div className="quota-control-card" style={{ marginBottom: '32px' }}>
        <div className="quota-control-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Active Plan Configuration</h2>
            <span className={`tier-pill ${isPro ? 'pro' : 'free'}`}>
              {isPro ? '⚡ PRO WORKSPACE' : 'FREE WORKSPACE'}
            </span>
          </div>

          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            Organization: <strong>{session?.org?.name}</strong>
          </span>
        </div>

        {isLoading ? (
          <div className="muted">Loading rate limit configuration…</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '16px',
              background: '#090c10',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '18px 20px',
              marginBottom: '16px',
            }}
          >
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
                Window Quota
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text)' }}>
                {requestsPerWindow.toLocaleString()}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                requests / 3600 seconds
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
                Burst Headroom
              </div>
              <div
                style={{
                  fontSize: '1.35rem',
                  fontWeight: 800,
                  color: isPro ? 'var(--success)' : 'var(--text)',
                }}
              >
                {burstAllowance}x
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                {isPro
                  ? `Peak ceiling: ${maxCapacity.toLocaleString()} req`
                  : 'No burst multiplier'}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
                Sliding Window
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--accent)' }}>
                1 Hour
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                Rolling 3,600s bucket
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
                Pub/Sub Cluster Sync
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--success)' }}>
                Instant
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                Zero-restart pod reload
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>
            Need custom limits or air-gapped dedicated clusters?{' '}
            <a href="mailto:support@throttlebox.dev" style={{ color: 'var(--accent)' }}>
              Contact Enterprise
            </a>
          </span>
          <button
            onClick={() => planMutation.mutate(isPro ? 'free' : 'pro')}
            disabled={planMutation.isPending}
            className="secondary-button"
            style={{ padding: '6px 14px', fontSize: '0.8125rem' }}
          >
            {isPro ? 'Downgrade to Free' : 'Switch to Pro Plan'}
          </button>
        </div>
      </div>

      {/* ====================================================================
          Technical Breakdown Cards
          ==================================================================== */}
      <h2 style={{ fontSize: '1.2rem', marginBottom: '16px' }}>
        How Sliding-Window Limiting Works
      </h2>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '20px',
          marginBottom: '32px',
        }}
      >
        <div className="card" style={{ padding: '24px' }}>
          <div style={{ color: 'var(--accent)', marginBottom: '12px' }}>
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <h3 style={{ fontSize: '1.05rem', margin: '0 0 8px' }}>Atomic Redis Lua Scripts</h3>
          <p className="muted" style={{ fontSize: '0.875rem', margin: 0, lineHeight: 1.6 }}>
            Every request executes an atomic Lua script in Redis. Monotonic time is resolved via{' '}
            <code>redis.call(&apos;TIME&apos;)</code>, stale members are pruned with{' '}
            <code>ZREMRANGEBYSCORE</code>, and active counts are checked via <code>ZCARD</code>.
          </p>
        </div>

        <div className="card" style={{ padding: '24px' }}>
          <div style={{ color: 'var(--success)', marginBottom: '12px' }}>
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h3 style={{ fontSize: '1.05rem', margin: '0 0 8px' }}>RFC 6585 Rate Headers</h3>
          <p className="muted" style={{ fontSize: '0.875rem', margin: 0, lineHeight: 1.6 }}>
            Throttlebox populates <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>
            , <code>X-RateLimit-Reset</code>, and <code>X-RateLimit-Policy</code> on every response.
            Throttled requests return a standard <code>429</code> with <code>Retry-After</code>.
          </p>
        </div>

        <div className="card" style={{ padding: '24px' }}>
          <div style={{ color: '#ffb347', marginBottom: '12px' }}>
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <h3 style={{ fontSize: '1.05rem', margin: '0 0 8px' }}>Automated Burst Allowance</h3>
          <p className="muted" style={{ fontSize: '0.875rem', margin: 0, lineHeight: 1.6 }}>
            Pro workspaces enjoy a 20% burst allowance (6,000 requests) to absorb concurrent surges
            from automated CI pipelines without failing tests due to transient spikes.
          </p>
        </div>
      </div>

      {/* ====================================================================
          Terminal Test Snippet
          ==================================================================== */}
      <h2 style={{ fontSize: '1.2rem', marginBottom: '16px' }}>Test Rate Limits in Terminal</h2>

      <div className="card" style={{ padding: '20px 24px' }}>
        <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.875rem' }}>
          Run this loop in your terminal to see the sliding window enforce limits and emit standard
          rate headers:
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#090c10',
            border: '1px solid var(--border)',
            borderRadius: '7px',
            padding: '12px 16px',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '0.8125rem',
            color: 'var(--muted)',
            overflowX: 'auto',
          }}
        >
          <div>
            <span style={{ color: 'var(--accent)' }}>$ </span>
            {testCurl}
          </div>
          <button
            onClick={() => handleCopy(testCurl, 'curl-loop')}
            className="secondary-button"
            style={{ padding: '4px 10px', fontSize: '0.75rem', flexShrink: 0, marginLeft: '16px' }}
          >
            {copiedKey === 'curl-loop' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
