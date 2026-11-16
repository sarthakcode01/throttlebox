'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { Plan } from '@throttlebox/shared';
import { ApiError, api } from '@/lib/api';

export default function DashboardOverviewPage() {
  const queryClient = useQueryClient();
  const [tierError, setTierError] = useState<string | null>(null);

  // Queries
  const { data: session } = useQuery({ queryKey: ['me'], queryFn: api.me });
  const { data: planData } = useQuery({ queryKey: ['org-plan'], queryFn: api.getOrgPlan });
  const { data: keysData } = useQuery({ queryKey: ['keys'], queryFn: api.listKeys });
  const { data: servicesData } = useQuery({
    queryKey: ['mock-services'],
    queryFn: api.listMockServices,
  });

  const keys = keysData?.keys ?? [];
  // Revoked, expired and superseded keys are listed on the keys page but
  // are not "active".
  const activeKeys = keys.filter(
    (key) =>
      key.status === 'active' &&
      !(key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) &&
      !(key.graceUntil && new Date(key.graceUntil).getTime() <= Date.now()),
  );
  const services = servicesData?.services ?? [];
  const totalRoutes = services.reduce((acc, s) => acc + s.routeCount, 0);

  const plan = planData?.plan;
  const currentPlan = plan?.name?.toLowerCase() ?? session?.org?.plan ?? 'free';
  const isPro = currentPlan === 'pro';
  const requestsPerWindow = plan?.requestsPerWindow ?? (isPro ? 5000 : 100);
  const burstAllowance = plan?.burstAllowance ?? (isPro ? 1.2 : 1.0);
  const maxBurst = Math.round(requestsPerWindow * burstAllowance);

  // Plan toggle mutation
  const planMutation = useMutation({
    mutationFn: (newPlan: Plan) => api.updateOrgPlan(newPlan),
    onSuccess: async () => {
      setTierError(null);
      await queryClient.invalidateQueries({ queryKey: ['org-plan'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => {
      setTierError(err instanceof ApiError ? err.message : 'Could not update workspace plan');
    },
  });

  const togglePlan = () => {
    const nextPlan: Plan = isPro ? 'free' : 'pro';
    planMutation.mutate(nextPlan);
  };

  return (
    <div>
      {/* Title & Actions Row */}
      <div className="dashboard-header-row">
        <div>
          <h1 className="dashboard-title">Workspace Overview</h1>
          <p className="dashboard-subtitle">
            Welcome to {session?.org?.name ?? 'your workspace'}. Manage mock endpoints, mint API
            keys, and inspect sliding-window rate limits.
          </p>
        </div>

        <div className="row">
          <Link href="/dashboard/keys" className="cta-button" style={{ fontSize: '0.875rem' }}>
            + Mint API Key
          </Link>
          <Link
            href="/dashboard/services"
            className="secondary-button"
            style={{ fontSize: '0.875rem' }}
          >
            New Mock Service
          </Link>
        </div>
      </div>

      {/* ====================================================================
          Executive Metric Cards
          ==================================================================== */}
      <div className="metric-grid">
        {/* Metric 1: Active Keys */}
        <div className="metric-card">
          <div className="metric-card-head">
            <span className="metric-label">Active Keys</span>
            <div className="metric-icon-wrap">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 2l-2 2m-1-1l-3 3m2 2l-2 2m-7 1a5 5 0 1 1-7-7 5 5 0 0 1 7 7zm0 0l7 7-2 2" />
              </svg>
            </div>
          </div>
          <div className="metric-value">{activeKeys.length}</div>
          <div className="metric-sub">
            <Link href="/dashboard/keys" style={{ color: 'var(--accent)' }}>
              Manage keys &rarr;
            </Link>
          </div>
        </div>

        {/* Metric 2: Mock Endpoints */}
        <div className="metric-card">
          <div className="metric-card-head">
            <span className="metric-label">Mock Endpoints</span>
            <div
              className="metric-icon-wrap"
              style={{ color: 'var(--success)', background: 'rgba(62, 207, 142, 0.12)' }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
            </div>
          </div>
          <div className="metric-value">{totalRoutes}</div>
          <div className="metric-sub">Across {services.length} mock services</div>
        </div>

        {/* Metric 3: Rate Limit Capacity */}
        <div className="metric-card">
          <div className="metric-card-head">
            <span className="metric-label">Hourly Quota</span>
            <div
              className="metric-icon-wrap"
              style={{ color: '#ffb347', background: 'rgba(255, 179, 71, 0.12)' }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
          </div>
          <div className="metric-value">{requestsPerWindow.toLocaleString()}</div>
          <div className="metric-sub">
            {isPro ? (
              <span style={{ color: 'var(--success)' }}>
                +20% Burst ({maxBurst.toLocaleString()} peak)
              </span>
            ) : (
              <span>100 req/3600s sliding window</span>
            )}
          </div>
        </div>

        {/* Metric 4: Key Security */}
        <div className="metric-card">
          <div className="metric-card-head">
            <span className="metric-label">Key Security</span>
            <div
              className="metric-icon-wrap"
              style={{ color: '#7ba5ff', background: 'rgba(123, 165, 255, 0.12)' }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
          </div>
          <div className="metric-value" style={{ fontSize: '1.25rem' }}>
            HMAC-SHA256
          </div>
          <div className="metric-sub">Zero plaintext storage • Peppered</div>
        </div>
      </div>

      {/* ====================================================================
          Phase 4: Interactive Quota & Tier Switcher Card
          ==================================================================== */}
      <div className="quota-control-card">
        <div className="quota-control-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Workspace Rate Limit &amp; Tier Plan</h2>
            <span className={`tier-pill ${isPro ? 'pro' : 'free'}`}>
              {isPro ? '⚡ PRO TIER' : 'FREE TIER'}
            </span>
          </div>

          <button
            onClick={togglePlan}
            disabled={planMutation.isPending}
            className={isPro ? 'secondary-button' : 'cta-button'}
            style={{ fontSize: '0.875rem', padding: '8px 16px' }}
          >
            {planMutation.isPending
              ? 'Updating Tier…'
              : isPro
                ? 'Switch to Free Tier'
                : '⚡ Upgrade to Pro (5,000 req/hr)'}
          </button>
        </div>

        {tierError && (
          <div className="error" role="alert" style={{ marginBottom: '16px' }}>
            {tierError}
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '16px',
            background: '#090c10',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '16px 20px',
            marginBottom: '16px',
          }}
        >
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
              Base Quota
            </div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text)' }}>
              {requestsPerWindow.toLocaleString()} requests
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
              per 1 hour sliding window
            </div>
          </div>

          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
              Burst Allowance
            </div>
            <div
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                color: isPro ? 'var(--success)' : 'var(--text)',
              }}
            >
              {burstAllowance}x ({maxBurst.toLocaleString()} reqs)
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
              {isPro ? '20% headroom for automated CI suites' : 'Standard single quota limit'}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
              Limiter Engine
            </div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--accent)' }}>
              Redis 7 Atomic Lua
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
              RFC 6585 compliance with Retry-After
            </div>
          </div>
        </div>

        <div
          style={{
            fontSize: '0.8125rem',
            color: 'var(--muted)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>
            Upgrades sync instantaneously via Redis Pub/Sub without restarting gateway pods.
          </span>
          <Link
            href="/dashboard/rate-limits"
            style={{ color: 'var(--accent)', textDecoration: 'none' }}
          >
            Rate limit docs &amp; testing guide &rarr;
          </Link>
        </div>
      </div>

      {/* ====================================================================
          Quick Action Cards & Active Services
          ==================================================================== */}
      <h2 style={{ fontSize: '1.2rem', marginBottom: '16px' }}>Active Mock Services</h2>

      {services.length === 0 ? (
        <div className="card text-center" style={{ padding: '40px 24px' }}>
          <p className="muted" style={{ margin: '0 0 16px' }}>
            No mock services created yet. Create a service to get started.
          </p>
          <Link
            href="/dashboard/services"
            className="cta-button"
            style={{ display: 'inline-flex' }}
          >
            Create Your First Mock Service &rarr;
          </Link>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto', marginBottom: '32px' }}>
          <table className="keys-table">
            <thead>
              <tr>
                <th>Service Name</th>
                <th>Slug</th>
                <th>Routes</th>
                <th>Base Mock URL</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {services.map((svc) => (
                <tr key={svc.id}>
                  <td>
                    <strong>{svc.name}</strong>
                    {svc.description && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        {svc.description}
                      </div>
                    )}
                  </td>
                  <td>
                    <code>{svc.slug}</code>
                  </td>
                  <td>
                    <span className="badge" style={{ color: 'var(--accent)' }}>
                      {svc.routeCount} endpoints
                    </span>
                  </td>
                  <td>
                    <code style={{ fontSize: '0.8125rem' }}>/mock/{svc.slug}</code>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: '8px' }}>
                      <Link
                        href={`/dashboard/docs`}
                        className="secondary-button"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                      >
                        Docs
                      </Link>
                      <Link
                        href={`/dashboard/services`}
                        className="secondary-button"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                      >
                        Manage
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
