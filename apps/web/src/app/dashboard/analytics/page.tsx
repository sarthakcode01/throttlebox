'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { api } from '@/lib/api';
import type {
  AnalyticsLatencyBucket,
  AnalyticsUsageBucket,
  RequestLogSummary,
  WebhookConfig,
} from '@throttlebox/shared';

type TimeRange = '1h' | '24h' | '7d' | '30d';

export default function AnalyticsDashboardPage() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<TimeRange>('24h');
  const [showWebhooksModal, setShowWebhooksModal] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookSecret, setNewWebhookSecret] = useState('');
  const [testStatus, setTestStatus] = useState<Record<string, string>>({});
  const [copiedTraceId, setCopiedTraceId] = useState<string | null>(null);

  // 1. Overview metrics
  const { data: overview, isLoading: overviewLoading, refetch: refetchOverview } = useQuery({
    queryKey: ['analytics-overview', range],
    queryFn: () => api.getAnalyticsOverview(range),
    refetchInterval: 10_000,
  });

  // 2. Usage series
  const { data: usageData, isLoading: usageLoading } = useQuery({
    queryKey: ['analytics-usage', range],
    queryFn: () => api.getAnalyticsUsage(range),
    refetchInterval: 10_000,
  });

  // 3. Latency series
  const { data: latencyData, isLoading: latencyLoading } = useQuery({
    queryKey: ['analytics-latency', range],
    queryFn: () => api.getAnalyticsLatency(range),
    refetchInterval: 10_000,
  });

  // 4. Status and Error breakdown
  const { data: errorsData } = useQuery({
    queryKey: ['analytics-errors', range],
    queryFn: () => api.getAnalyticsErrors(range),
    refetchInterval: 10_000,
  });

  // 5. Recent Request Logs
  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery({
    queryKey: ['analytics-logs'],
    queryFn: () => api.getAnalyticsLogs(20, 0),
    refetchInterval: 5_000,
  });

  // 6. Webhooks
  const { data: webhooksData, refetch: refetchWebhooks } = useQuery({
    queryKey: ['webhooks'],
    queryFn: api.getWebhooks,
  });

  // Webhook Mutations
  const createWebhookMutation = useMutation({
    mutationFn: (body: { url: string; secret?: string }) => api.createWebhook(body),
    onSuccess: () => {
      setNewWebhookUrl('');
      setNewWebhookSecret('');
      refetchWebhooks();
    },
  });

  const deleteWebhookMutation = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => {
      refetchWebhooks();
    },
  });

  const testWebhookMutation = useMutation({
    mutationFn: (id: string) => api.testWebhook(id),
    onSuccess: (data, id) => {
      setTestStatus((prev) => ({
        ...prev,
        [id]: data.success ? `Success (${data.statusCode})` : `Failed: ${data.error ?? 'Unknown'}`,
      }));
    },
    onError: (err: unknown, id) => {
      setTestStatus((prev) => ({
        ...prev,
        [id]: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }));
    },
  });

  const handleCopyTrace = (traceId: string) => {
    navigator.clipboard.writeText(traceId);
    setCopiedTraceId(traceId);
    setTimeout(() => setCopiedTraceId(null), 2000);
  };

  const handleRefreshAll = () => {
    refetchOverview();
    queryClient.invalidateQueries({ queryKey: ['analytics-usage'] });
    queryClient.invalidateQueries({ queryKey: ['analytics-latency'] });
    queryClient.invalidateQueries({ queryKey: ['analytics-errors'] });
    refetchLogs();
  };

  return (
    <div>
      {/* Top Header & Toolbar */}
      <div className="analytics-toolbar">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>Telemetry & Analytics</h2>
            <span
              style={{
                fontSize: '0.6875rem',
                fontFamily: 'var(--font-mono)',
                background: 'rgba(91, 140, 255, 0.12)',
                color: 'var(--accent)',
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(91, 140, 255, 0.3)',
              }}
            >
              TimescaleDB Hypertable
            </span>
          </div>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.8125rem' }}>
            Real-time continuous aggregate telemetry, latency distributions, and quota thresholds.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Time Range Pills */}
          <div className="range-pill-group" role="tablist">
            {(['1h', '24h', '7d', '30d'] as TimeRange[]).map((r) => (
              <button
                key={r}
                role="tab"
                aria-selected={range === r}
                className={`range-pill ${range === r ? 'active' : ''}`}
                onClick={() => setRange(r)}
              >
                {r.toUpperCase()}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowWebhooksModal(true)}
            className="secondary-button"
            style={{ fontSize: '0.8125rem', padding: '6px 14px' }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            Webhooks & Alerts
          </button>

          <button
            onClick={handleRefreshAll}
            className="secondary-button"
            style={{ fontSize: '0.8125rem', padding: '6px 12px' }}
            title="Refresh analytics data"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </div>

      {/* KPI Cards Row */}
      <div className="metric-grid" style={{ marginBottom: '24px' }}>
        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-label">Total Requests</span>
            <div className="metric-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
          </div>
          <div className="metric-value">
            {overviewLoading ? '...' : (overview?.totalRequests ?? 0).toLocaleString()}
          </div>
          <div className="metric-hint">Requests in selected {range} window</div>
        </div>

        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-label">Error Rate</span>
            <div
              className="metric-icon"
              style={{
                color:
                  (overview?.errorRate ?? 0) > 5
                    ? 'var(--danger)'
                    : (overview?.errorRate ?? 0) > 0
                      ? '#f59e0b'
                      : 'var(--success)',
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
          </div>
          <div
            className="metric-value"
            style={{
              color:
                (overview?.errorRate ?? 0) > 5
                  ? 'var(--danger)'
                  : (overview?.errorRate ?? 0) > 0
                    ? '#f59e0b'
                    : 'inherit',
            }}
          >
            {overviewLoading ? '...' : `${overview?.errorRate ?? 0}%`}
          </div>
          <div className="metric-hint">Status codes 4xx and 5xx</div>
        </div>

        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-label">p95 Latency</span>
            <div className="metric-icon" style={{ color: 'var(--accent)' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
          </div>
          <div className="metric-value">
            {overviewLoading ? '...' : `${overview?.p95LatencyMs ?? 0} ms`}
          </div>
          <div className="metric-hint">95% of calls respond faster than this</div>
        </div>

        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-label">Throttled (429)</span>
            <div className="metric-icon" style={{ color: '#f59e0b' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
          </div>
          <div className="metric-value">
            {overviewLoading ? '...' : (overview?.throttledRequests ?? 0).toLocaleString()}
          </div>
          <div className="metric-hint">Rate limit exceeded drops</div>
        </div>
      </div>

      {/* Interactive TimescaleDB SVG Charts */}
      <div className="analytics-charts-grid">
        {/* Chart 1: Volume & Errors */}
        <div className="chart-card">
          <div className="chart-card-header">
            <h3 className="chart-card-title">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
              Request Volume & Errors
            </h3>
            <div className="chart-legend">
              <div className="chart-legend-item">
                <span className="chart-legend-dot" style={{ background: 'var(--accent)' }} />
                <span>Total Calls</span>
              </div>
              <div className="chart-legend-item">
                <span className="chart-legend-dot" style={{ background: 'var(--danger)' }} />
                <span>Errors (&gt;= 400)</span>
              </div>
            </div>
          </div>

          <UsageSvgChart
            series={usageData?.series ?? []}
            isLoading={usageLoading}
            range={range}
          />
        </div>

        {/* Chart 2: Latency Percentiles (p50, p95, p99) */}
        <div className="chart-card">
          <div className="chart-card-header">
            <h3 className="chart-card-title">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Latency Percentiles (ms)
            </h3>
            <div className="chart-legend">
              <div className="chart-legend-item">
                <span className="chart-legend-dot" style={{ background: 'var(--success)' }} />
                <span>p50</span>
              </div>
              <div className="chart-legend-item">
                <span className="chart-legend-dot" style={{ background: 'var(--accent)' }} />
                <span>p95</span>
              </div>
              <div className="chart-legend-item">
                <span className="chart-legend-dot" style={{ background: '#a78bfa' }} />
                <span>p99</span>
              </div>
            </div>
          </div>

          <LatencySvgChart
            series={latencyData?.series ?? []}
            isLoading={latencyLoading}
            range={range}
          />
        </div>
      </div>

      {/* Status Breakdown & Top Error Endpoints */}
      <div className="analytics-charts-grid" style={{ marginBottom: '24px' }}>
        {/* Status Distribution */}
        <div className="chart-card">
          <div className="chart-card-header">
            <h3 className="chart-card-title">HTTP Status Distribution</h3>
          </div>

          <StatusBarBreakdown errorsData={errorsData} />

          <div className="status-breakdown-legend">
            <div className="status-legend-item">
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>2xx Success</div>
              <div className="status-legend-count" style={{ color: 'var(--success)' }}>
                {(errorsData?.status2xx ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="status-legend-item">
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>4xx Client Error</div>
              <div className="status-legend-count" style={{ color: 'var(--danger)' }}>
                {(errorsData?.status4xx ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="status-legend-item">
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>429 Rate Limited</div>
              <div className="status-legend-count" style={{ color: '#f59e0b' }}>
                {(errorsData?.status429 ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="status-legend-item">
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>5xx Server Error</div>
              <div className="status-legend-count" style={{ color: '#ef4444' }}>
                {(errorsData?.status5xx ?? 0).toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        {/* Top Failing Paths */}
        <div className="chart-card">
          <div className="chart-card-header">
            <h3 className="chart-card-title">Top Error Endpoints</h3>
          </div>

          {errorsData?.topErrorPaths && errorsData.topErrorPaths.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {errorsData.topErrorPaths.map((item, idx) => (
                <div
                  key={`${item.path}-${item.statusCode}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: '#0d1117',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                    <span
                      className={
                        item.statusCode === 429
                          ? 'log-badge-429'
                          : 'log-badge-4xx'
                      }
                    >
                      {item.statusCode}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.8125rem',
                        color: 'var(--text)',
                        textOverflow: 'ellipsis',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.path}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      color: 'var(--muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {item.count} errors
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '140px',
                color: 'var(--muted)',
                fontSize: '0.875rem',
              }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                style={{ marginBottom: '8px', opacity: 0.5 }}
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              No failing requests recorded in this range. Clean operational health!
            </div>
          )}
        </div>
      </div>

      {/* Recent Request Logs Live Table */}
      <div className="log-table-wrap">
        <div className="log-table-header">
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Live Telemetry Logs</h3>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: '0.75rem' }}>
              Asynchronously buffered write-behind logs from TimescaleDB (auto-refreshing every 5s)
            </p>
          </div>
          <span className="badge" style={{ fontSize: '0.75rem' }}>
            {logsData?.total ?? 0} total events
          </span>
        </div>

        {logsLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--muted)' }}>
            Loading request logs...
          </div>
        ) : !logsData?.logs || logsData.logs.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--muted)' }}>
            No request logs recorded yet. Send requests with an API key to `/mock/:serviceSlug/*` to populate telemetry.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
              <thead>
                <tr style={{ background: '#0d1117', borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                  <th style={{ padding: '10px 16px', color: 'var(--muted)', fontWeight: 500 }}>Time</th>
                  <th style={{ padding: '10px 16px', color: 'var(--muted)', fontWeight: 500 }}>Method</th>
                  <th style={{ padding: '10px 16px', color: 'var(--muted)', fontWeight: 500 }}>Endpoint</th>
                  <th style={{ padding: '10px 16px', color: 'var(--muted)', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '10px 16px', color: 'var(--muted)', fontWeight: 500 }}>Latency</th>
                  <th style={{ padding: '10px 16px', color: 'var(--muted)', fontWeight: 500 }}>API Key</th>
                  <th style={{ padding: '10px 16px', color: 'var(--muted)', fontWeight: 500 }}>Trace ID</th>
                </tr>
              </thead>
              <tbody>
                {logsData.logs.map((log: RequestLogSummary) => {
                  const methodClass = `method-${log.method.toLowerCase()}`;
                  let statusBadgeClass = 'log-badge-2xx';
                  if (log.statusCode === 429 || log.rateLimited) {
                    statusBadgeClass = 'log-badge-429';
                  } else if (log.statusCode >= 400) {
                    statusBadgeClass = 'log-badge-4xx';
                  }

                  const formattedTime = new Date(log.time).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  });

                  return (
                    <tr
                      key={log.traceId}
                      style={{ borderBottom: '1px solid #161b24', transition: 'background 0.1s ease' }}
                    >
                      <td style={{ padding: '10px 16px', fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
                        {formattedTime}
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        <span className={`method-tag ${methodClass}`}>{log.method}</span>
                      </td>
                      <td
                        style={{
                          padding: '10px 16px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text)',
                          maxWidth: '300px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {log.path}
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        <span className={statusBadgeClass}>
                          {log.statusCode} {log.rateLimited ? '(429 Throttled)' : ''}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: '10px 16px',
                          fontFamily: 'var(--font-mono)',
                          color: log.latencyMs > 500 ? 'var(--danger)' : log.latencyMs > 100 ? '#f59e0b' : 'inherit',
                        }}
                      >
                        {log.latencyMs} ms
                      </td>
                      <td style={{ padding: '10px 16px', fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
                        {log.keyDisplay ?? 'Anonymous'}
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        <button
                          onClick={() => handleCopyTrace(log.traceId)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: copiedTraceId === log.traceId ? 'var(--success)' : 'var(--muted)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                          title="Click to copy Trace ID"
                        >
                          {copiedTraceId === log.traceId ? 'Copied!' : `${log.traceId.slice(0, 12)}…`}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Webhooks & Alerts Modal */}
      {showWebhooksModal && (
        <div className="modal-backdrop" onClick={() => setShowWebhooksModal(false)}>
          <div
            className="auth-card"
            style={{ maxWidth: '640px', width: '100%', margin: '40px auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '16px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700 }}>
                Quota Webhooks & Alerts
              </h2>
              <button
                onClick={() => setShowWebhooksModal(false)}
                className="secondary-button"
                style={{ padding: '4px 8px', fontSize: '0.8rem' }}
              >
                ✕
              </button>
            </div>

            <p className="muted" style={{ fontSize: '0.875rem', margin: '0 0 20px' }}>
              Configure endpoints that receive signed HMAC-SHA256 HTTP POST notifications when your organization consumes 80% or 100% of its rate limit quota.
            </p>

            {/* List Existing Webhooks */}
            <div style={{ marginBottom: '24px' }}>
              <h4 style={{ margin: '0 0 10px', fontSize: '0.875rem', color: 'var(--text)' }}>
                Active Webhook Endpoints
              </h4>

              {webhooksData?.webhooks && webhooksData.webhooks.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {webhooksData.webhooks.map((wh: WebhookConfig) => (
                    <div
                      key={wh.id}
                      style={{
                        background: '#0d1117',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        padding: '12px 16px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.8125rem',
                            color: 'var(--text)',
                            fontWeight: 600,
                            wordBreak: 'break-all',
                          }}
                        >
                          {wh.url}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <button
                            onClick={() => testWebhookMutation.mutate(wh.id)}
                            disabled={testWebhookMutation.isPending}
                            className="secondary-button"
                            style={{ fontSize: '0.75rem', padding: '3px 8px' }}
                          >
                            Send Test Ping
                          </button>
                          <button
                            onClick={() => deleteWebhookMutation.mutate(wh.id)}
                            disabled={deleteWebhookMutation.isPending}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--danger)',
                              cursor: 'pointer',
                              fontSize: '0.75rem',
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          fontSize: '0.75rem',
                          color: 'var(--muted)',
                        }}
                      >
                        <span>
                          Secret: <code style={{ fontFamily: 'var(--font-mono)' }}>{wh.secret.slice(0, 14)}…</code>
                        </span>
                        {wh.lastAlertedThreshold ? (
                          <span style={{ color: '#f59e0b', fontWeight: 600 }}>
                            ⚠️ Alerted at {wh.lastAlertedThreshold}% threshold
                          </span>
                        ) : (
                          <span style={{ color: 'var(--success)' }}>✓ Operational (Monitoring)</span>
                        )}
                      </div>

                      {testStatus[wh.id] && (
                        <div
                          style={{
                            fontSize: '0.75rem',
                            fontFamily: 'var(--font-mono)',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            background: testStatus[wh.id]?.startsWith('Success')
                              ? 'rgba(62, 207, 142, 0.1)'
                              : 'rgba(255, 107, 107, 0.1)',
                            color: testStatus[wh.id]?.startsWith('Success')
                              ? 'var(--success)'
                              : 'var(--danger)',
                          }}
                        >
                          Ping result: {testStatus[wh.id]}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    padding: '20px',
                    textAlign: 'center',
                    background: '#0d1117',
                    border: '1px dashed var(--border)',
                    borderRadius: '8px',
                    color: 'var(--muted)',
                    fontSize: '0.8125rem',
                  }}
                >
                  No webhooks configured yet. Register one below to receive automated capacity alerts.
                </div>
              )}
            </div>

            {/* Add New Webhook Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!newWebhookUrl) return;
                createWebhookMutation.mutate({
                  url: newWebhookUrl,
                  secret: newWebhookSecret || undefined,
                });
              }}
              style={{
                borderTop: '1px solid var(--border)',
                paddingTop: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <h4 style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text)' }}>
                Register Webhook Endpoint
              </h4>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
                  Target Webhook URL
                </label>
                <input
                  type="url"
                  required
                  placeholder="https://api.yourdomain.com/webhooks/throttlebox"
                  value={newWebhookUrl}
                  onChange={(e) => setNewWebhookUrl(e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '4px' }}>
                  HMAC Secret (optional, auto-generated if left empty)
                </label>
                <input
                  type="text"
                  placeholder="whsec_custom_secret_key"
                  value={newWebhookSecret}
                  onChange={(e) => setNewWebhookSecret(e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              </div>

              <button
                type="submit"
                disabled={createWebhookMutation.isPending || !newWebhookUrl}
                className="cta-button"
                style={{ justifyContent: 'center', marginTop: '6px' }}
              >
                {createWebhookMutation.isPending ? 'Registering...' : 'Register Webhook Endpoint'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure SVG Chart Components (React 19 compatible, zero external dependencies)
// ---------------------------------------------------------------------------

function UsageSvgChart({
  series,
  isLoading,
}: {
  series: AnalyticsUsageBucket[];
  isLoading: boolean;
  range: TimeRange;
}) {
  const chartPoints = useMemo(() => {
    if (!series || series.length === 0) return null;
    const maxVal = Math.max(...series.map((s) => s.requests), 10);
    const width = 560;
    const height = 150;
    const padding = 20;

    const points = series.map((item, index) => {
      const x = padding + (index / Math.max(series.length - 1, 1)) * (width - padding * 2);
      const y = height - (item.requests / maxVal) * (height - 30);
      const errorY = height - (item.errors / maxVal) * (height - 30);
      return { x, y, errorY, item };
    });

    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    if (!firstPoint || !lastPoint) return null;

    // Area path
    const areaD = `M ${firstPoint.x} ${height} L ${points.map((p) => `${p.x} ${p.y}`).join(' L ')} L ${lastPoint.x} ${height} Z`;
    const lineD = `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')}`;
    const errorLineD = `M ${points.map((p) => `${p.x} ${p.errorY}`).join(' L ')}`;

    return { points, areaD, lineD, errorLineD, maxVal, width, height };
  }, [series]);

  if (isLoading) {
    return (
      <div className="chart-svg-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
        Loading timeseries...
      </div>
    );
  }

  if (!chartPoints || series.length === 0) {
    return (
      <div className="chart-svg-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: '0.8125rem' }}>
        No traffic telemetry recorded yet.
      </div>
    );
  }

  return (
    <div className="chart-svg-wrap">
      <svg
        viewBox={`0 0 ${chartPoints.width} ${chartPoints.height + 25}`}
        style={{ width: '100%', height: '100%', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id="usageGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5b8cff" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#5b8cff" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        <line x1="20" y1="30" x2="540" y2="30" stroke="#1c212d" strokeDasharray="3 3" />
        <line x1="20" y1="90" x2="540" y2="90" stroke="#1c212d" strokeDasharray="3 3" />
        <line x1="20" y1="150" x2="540" y2="150" stroke="#232936" />

        {/* Area & Lines */}
        <path d={chartPoints.areaD} fill="url(#usageGradient)" />
        <path d={chartPoints.lineD} fill="none" stroke="#5b8cff" strokeWidth="2.5" />
        <path d={chartPoints.errorLineD} fill="none" stroke="#ff6b6b" strokeWidth="1.8" strokeDasharray="2 2" />

        {/* Data points */}
        {chartPoints.points.map((p, idx) => (
          <circle
            key={idx}
            cx={p.x}
            cy={p.y}
            r="3"
            fill="#5b8cff"
            stroke="#0b0d12"
            strokeWidth="1.5"
          >
            <title>{`${new Date(p.item.bucket).toLocaleTimeString()}: ${p.item.requests} reqs (${p.item.errors} err)`}</title>
          </circle>
        ))}

        {/* Bottom time labels */}
        {series[0] && (
          <text x="20" y="168" fill="#586074" fontSize="10" fontFamily="var(--font-mono)">
            {new Date(series[0].bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </text>
        )}
        {series[series.length - 1] && (
          <text x="540" y="168" fill="#586074" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">
            {new Date(series[series.length - 1]!.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </text>
        )}
      </svg>
    </div>
  );
}

function LatencySvgChart({
  series,
  isLoading,
}: {
  series: AnalyticsLatencyBucket[];
  isLoading: boolean;
  range: TimeRange;
}) {
  const chartPoints = useMemo(() => {
    if (!series || series.length === 0) return null;
    const maxVal = Math.max(...series.map((s) => s.p99), 50);
    const width = 560;
    const height = 150;
    const padding = 20;

    const points = series.map((item, index) => {
      const x = padding + (index / Math.max(series.length - 1, 1)) * (width - padding * 2);
      const yP50 = height - (item.p50 / maxVal) * (height - 30);
      const yP95 = height - (item.p95 / maxVal) * (height - 30);
      const yP99 = height - (item.p99 / maxVal) * (height - 30);
      return { x, yP50, yP95, yP99, item };
    });

    const lineP50 = `M ${points.map((p) => `${p.x} ${p.yP50}`).join(' L ')}`;
    const lineP95 = `M ${points.map((p) => `${p.x} ${p.yP95}`).join(' L ')}`;
    const lineP99 = `M ${points.map((p) => `${p.x} ${p.yP99}`).join(' L ')}`;

    return { points, lineP50, lineP95, lineP99, maxVal, width, height };
  }, [series]);

  if (isLoading) {
    return (
      <div className="chart-svg-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
        Loading latency metrics...
      </div>
    );
  }

  if (!chartPoints || series.length === 0) {
    return (
      <div className="chart-svg-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: '0.8125rem' }}>
        No latency data recorded in this range.
      </div>
    );
  }

  return (
    <div className="chart-svg-wrap">
      <svg
        viewBox={`0 0 ${chartPoints.width} ${chartPoints.height + 25}`}
        style={{ width: '100%', height: '100%', overflow: 'visible' }}
      >
        {/* Grid lines */}
        <line x1="20" y1="30" x2="540" y2="30" stroke="#1c212d" strokeDasharray="3 3" />
        <line x1="20" y1="90" x2="540" y2="90" stroke="#1c212d" strokeDasharray="3 3" />
        <line x1="20" y1="150" x2="540" y2="150" stroke="#232936" />

        {/* Lines */}
        <path d={chartPoints.lineP99} fill="none" stroke="#a78bfa" strokeWidth="1.8" />
        <path d={chartPoints.lineP95} fill="none" stroke="#5b8cff" strokeWidth="2.2" />
        <path d={chartPoints.lineP50} fill="none" stroke="#3ecf8e" strokeWidth="2.2" />

        {/* Bottom time labels */}
        {series[0] && (
          <text x="20" y="168" fill="#586074" fontSize="10" fontFamily="var(--font-mono)">
            {new Date(series[0].bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </text>
        )}
        {series[series.length - 1] && (
          <text x="540" y="168" fill="#586074" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">
            {new Date(series[series.length - 1]!.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </text>
        )}
      </svg>
    </div>
  );
}

function StatusBarBreakdown({
  errorsData,
}: {
  errorsData?: {
    status2xx: number;
    status4xx: number;
    status429: number;
    status5xx: number;
  };
}) {
  const total =
    (errorsData?.status2xx ?? 0) +
    (errorsData?.status4xx ?? 0) +
    (errorsData?.status429 ?? 0) +
    (errorsData?.status5xx ?? 0);

  if (!errorsData || total === 0) {
    return (
      <div className="status-bar-track" style={{ background: '#1c212d' }}>
        <div style={{ width: '100%', height: '100%', background: '#232936' }} />
      </div>
    );
  }

  const p2xx = (errorsData.status2xx / total) * 100;
  const p4xx = (errorsData.status4xx / total) * 100;
  const p429 = (errorsData.status429 / total) * 100;
  const p5xx = (errorsData.status5xx / total) * 100;

  return (
    <div className="status-bar-track">
      <div
        className="status-bar-segment"
        style={{ width: `${p2xx}%`, background: 'var(--success)' }}
        title={`2xx: ${errorsData.status2xx} (${p2xx.toFixed(1)}%)`}
      />
      <div
        className="status-bar-segment"
        style={{ width: `${p4xx}%`, background: 'var(--danger)' }}
        title={`4xx: ${errorsData.status4xx} (${p4xx.toFixed(1)}%)`}
      />
      <div
        className="status-bar-segment"
        style={{ width: `${p429}%`, background: '#f59e0b' }}
        title={`429: ${errorsData.status429} (${p429.toFixed(1)}%)`}
      />
      <div
        className="status-bar-segment"
        style={{ width: `${p5xx}%`, background: '#ef4444' }}
        title={`5xx: ${errorsData.status5xx} (${p5xx.toFixed(1)}%)`}
      />
    </div>
  );
}
