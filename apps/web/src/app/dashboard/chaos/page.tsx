'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useTransition } from 'react';
import type {
  ChaosBenchmarkResult,
  ChaosErrorConfig,
  ChaosLatencyConfig,
  ChaosPartitionConfig,
  ChaosRuleConfig,
} from '@throttlebox/shared';
import { api } from '@/lib/api';

export default function ChaosStudioPage() {
  const queryClient = useQueryClient();
  const [, startTransition] = useTransition();

  // 1. Fetch active chaos configuration
  const { data: chaosData, isLoading: chaosLoading } = useQuery({
    queryKey: ['chaos-rules'],
    queryFn: api.getChaosRules,
  });

  const rule: ChaosRuleConfig | undefined = chaosData?.defaultRule;

  // Local draft state for sliders
  const [isEnabled, setIsEnabled] = useState<boolean>(false);
  const [latency, setLatency] = useState<ChaosLatencyConfig>({
    enabled: false,
    distribution: 'normal',
    meanMs: 200,
    stddevMs: 50,
    minMs: 0,
    maxMs: 30000,
  });
  const [errors, setErrors] = useState<ChaosErrorConfig>({
    enabled: false,
    rate5xx: 0.05,
    rate429: 0.0,
    statusCodes: [500, 502, 503, 504],
    customMessage: '',
  });
  const [partition, setPartition] = useState<ChaosPartitionConfig>({
    enabled: false,
    dropRate: 0.0,
  });

  // Track if local draft has been initialized from server
  const [hasInitialized, setHasInitialized] = useState(false);
  useEffect(() => {
    if (rule && !hasInitialized) {
      setIsEnabled(rule.isEnabled);
      setLatency(rule.latency);
      setErrors(rule.errors);
      setPartition(rule.partition);
      setHasInitialized(true);
    }
  }, [rule, hasInitialized]);

  // Benchmark state
  const [benchmarkCount, setBenchmarkCount] = useState(100);
  const [benchmarkResult, setBenchmarkResult] = useState<ChaosBenchmarkResult | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  // Save Mutation
  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateChaosRule({
        isEnabled,
        latency,
        errors,
        partition,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['chaos-rules'], (old: { defaultRule: ChaosRuleConfig; rules: ChaosRuleConfig[] } | undefined) => {
        if (!old) return old;
        return { ...old, defaultRule: data.rule };
      });
      setSaveSuccessMsg('Chaos rules published to Redis cluster');
      setTimeout(() => setSaveSuccessMsg(null), 3500);
    },
  });

  // Reset Mutation
  const resetMutation = useMutation({
    mutationFn: api.resetChaosRules,
    onSuccess: () => {
      setIsEnabled(false);
      setLatency({ enabled: false, distribution: 'normal', meanMs: 200, stddevMs: 50 });
      setErrors({ enabled: false, rate5xx: 0.0, rate429: 0.0, statusCodes: [500, 502, 503, 504] });
      setPartition({ enabled: false, dropRate: 0.0 });
      queryClient.invalidateQueries({ queryKey: ['chaos-rules'] });
      setSaveSuccessMsg('All chaos controls disabled');
      setTimeout(() => setSaveSuccessMsg(null), 3500);
    },
  });

  // Benchmark Runner Mutation
  const benchmarkMutation = useMutation({
    mutationFn: () =>
      api.runChaosBenchmark({
        serviceSlug: 'flagship',
        requestCount: benchmarkCount,
      }),
    onSuccess: (res) => {
      setBenchmarkResult(res);
    },
  });

  const handleToggleStatusCode = (code: number) => {
    const current = errors.statusCodes ?? [500, 502, 503, 504];
    const exists = current.includes(code);
    let next: number[];
    if (exists) {
      next = current.filter((c) => c !== code);
      if (next.length === 0) next = [500]; // Keep at least one
    } else {
      next = [...current, code].sort((a, b) => a - b);
    }
    setErrors({ ...errors, statusCodes: next });
  };

  if (chaosLoading) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--muted)' }}>
        Loading Chaos Engineering Studio…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '28px' }}>
      {/* Top Banner */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 800 }}>Chaos Engineering Studio</h2>
            <span
              className="badge"
              style={{
                background: isEnabled ? 'rgba(239, 68, 68, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                color: isEnabled ? '#ef4444' : 'var(--muted)',
                borderColor: isEnabled ? 'rgba(239, 68, 68, 0.4)' : 'var(--border)',
                fontWeight: 700,
                letterSpacing: '0.04em',
              }}
            >
              {isEnabled ? '● ACTIVE FAULTS INJECTING' : '○ INACTIVE'}
            </span>
          </div>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.875rem', maxWidth: '650px' }}>
            Simulate unpredictable network jitter, server crashes, simulated rate limits, and raw socket disconnects to test SDK resilience and circuit breakers.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
            className="secondary-button"
            style={{ padding: '8px 16px', fontSize: '0.8125rem' }}
          >
            Reset to Defaults
          </button>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="button"
            style={{
              padding: '8px 20px',
              fontSize: '0.8125rem',
              fontWeight: 600,
              background: isEnabled ? '#ef4444' : 'var(--accent)',
              borderColor: isEnabled ? '#dc2626' : 'var(--accent)',
            }}
          >
            {saveMutation.isPending ? 'Saving…' : 'Publish Chaos Rules'}
          </button>
        </div>
      </div>

      {saveSuccessMsg && (
        <div
          style={{
            padding: '12px 18px',
            background: 'rgba(62, 207, 142, 0.1)',
            border: '1px solid rgba(62, 207, 142, 0.3)',
            borderRadius: '8px',
            color: 'var(--success)',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {saveSuccessMsg}
        </div>
      )}

      {/* Master Enable Card */}
      <div
        className="card"
        style={{
          padding: '20px 24px',
          borderLeft: isEnabled ? '4px solid #ef4444' : '4px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div>
          <strong style={{ fontSize: '1rem', display: 'block' }}>Master Chaos Engine Switch</strong>
          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            When toggled on, incoming requests to mock APIs evaluate the rules below in sub-millisecond memory before reaching endpoints.
          </span>
        </div>
        <label
          style={{
            position: 'relative',
            display: 'inline-block',
            width: '52px',
            height: '28px',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => startTransition(() => setIsEnabled(e.target.checked))}
            style={{ opacity: 0, width: 0, height: 0 }}
          />
          <span
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: isEnabled ? '#ef4444' : '#232936',
              borderRadius: '28px',
              transition: '0.2s',
            }}
          >
            <span
              style={{
                position: 'absolute',
                content: "''",
                height: '20px',
                width: '20px',
                left: isEnabled ? '26px' : '4px',
                bottom: '4px',
                backgroundColor: '#ffffff',
                borderRadius: '50%',
                transition: '0.2s',
              }}
            />
          </span>
        </label>
      </div>

      {/* Grid of 3 Chaos Controllers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
        {/* 1. Network Latency Jitter */}
        <div className="card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>Latency & Jitter</h3>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: '0.75rem' }}>
                Gaussian (Box-Muller) delay distribution
              </p>
            </div>
            <input
              type="checkbox"
              checked={latency.enabled}
              onChange={(e) => setLatency({ ...latency, enabled: e.target.checked })}
              style={{ width: '18px', height: '18px', accentColor: '#3ecf8e', cursor: 'pointer' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', opacity: latency.enabled ? 1 : 0.4 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '6px' }}>
                <span className="muted">Mean Delay (&mu;)</span>
                <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{latency.meanMs} ms</strong>
              </div>
              <input
                type="range"
                min="0"
                max="2000"
                step="25"
                disabled={!latency.enabled}
                value={latency.meanMs}
                onChange={(e) => setLatency({ ...latency, meanMs: Number(e.target.value) })}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '6px' }}>
                <span className="muted">Standard Deviation (&sigma;)</span>
                <strong style={{ fontFamily: 'var(--font-mono)', color: '#a78bfa' }}>{latency.stddevMs} ms</strong>
              </div>
              <input
                type="range"
                min="0"
                max="500"
                step="10"
                disabled={!latency.enabled}
                value={latency.stddevMs}
                onChange={(e) => setLatency({ ...latency, stddevMs: Number(e.target.value) })}
                style={{ width: '100%', accentColor: '#a78bfa' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              {(['normal', 'uniform', 'fixed'] as const).map((dist) => (
                <button
                  key={dist}
                  type="button"
                  disabled={!latency.enabled}
                  onClick={() => setLatency({ ...latency, distribution: dist })}
                  className="secondary-button"
                  style={{
                    flex: 1,
                    fontSize: '0.75rem',
                    padding: '6px 0',
                    justifyContent: 'center',
                    textTransform: 'capitalize',
                    background: latency.distribution === dist ? 'var(--accent-dim)' : 'transparent',
                    color: latency.distribution === dist ? 'var(--accent)' : 'var(--muted)',
                    borderColor: latency.distribution === dist ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  {dist}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 2. Error Injection */}
        <div className="card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>Fault Responses (5xx / 429)</h3>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: '0.75rem' }}>
                Probabilistic transient HTTP error responses
              </p>
            </div>
            <input
              type="checkbox"
              checked={errors.enabled}
              onChange={(e) => setErrors({ ...errors, enabled: e.target.checked })}
              style={{ width: '18px', height: '18px', accentColor: '#ef4444', cursor: 'pointer' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', opacity: errors.enabled ? 1 : 0.4 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '6px' }}>
                <span className="muted">5xx Server Error Rate</span>
                <strong style={{ fontFamily: 'var(--font-mono)', color: '#ef4444' }}>
                  {Math.round(errors.rate5xx * 100)}%
                </strong>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                disabled={!errors.enabled}
                value={errors.rate5xx}
                onChange={(e) => setErrors({ ...errors, rate5xx: Number(e.target.value) })}
                style={{ width: '100%', accentColor: '#ef4444' }}
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '6px' }}>
                <span className="muted">Simulated 429 Throttle Rate</span>
                <strong style={{ fontFamily: 'var(--font-mono)', color: '#f59e0b' }}>
                  {Math.round(errors.rate429 * 100)}%
                </strong>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                disabled={!errors.enabled}
                value={errors.rate429}
                onChange={(e) => setErrors({ ...errors, rate429: Number(e.target.value) })}
                style={{ width: '100%', accentColor: '#f59e0b' }}
              />
            </div>

            <div>
              <span className="muted" style={{ fontSize: '0.75rem', display: 'block', marginBottom: '6px' }}>
                Target 5xx Status Codes
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[500, 502, 503, 504].map((code) => {
                  const selected = errors.statusCodes?.includes(code);
                  return (
                    <button
                      key={code}
                      type="button"
                      disabled={!errors.enabled}
                      onClick={() => handleToggleStatusCode(code)}
                      className="secondary-button"
                      style={{
                        padding: '4px 8px',
                        fontSize: '0.75rem',
                        fontFamily: 'var(--font-mono)',
                        background: selected ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
                        color: selected ? '#ef4444' : 'var(--muted)',
                        borderColor: selected ? '#ef4444' : 'var(--border)',
                      }}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* 3. Connection Drops & Partition */}
        <div className="card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>Network Partition (TCP RST)</h3>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: '0.75rem' }}>
                True socket destruction without HTTP response
              </p>
            </div>
            <input
              type="checkbox"
              checked={partition.enabled}
              onChange={(e) => setPartition({ ...partition, enabled: e.target.checked })}
              style={{ width: '18px', height: '18px', accentColor: '#e11d48', cursor: 'pointer' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', opacity: partition.enabled ? 1 : 0.4 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '6px' }}>
                <span className="muted">Connection Drop Probability</span>
                <strong style={{ fontFamily: 'var(--font-mono)', color: '#e11d48' }}>
                  {Math.round(partition.dropRate * 100)}%
                </strong>
              </div>
              <input
                type="range"
                min="0"
                max="0.5"
                step="0.01"
                disabled={!partition.enabled}
                value={partition.dropRate}
                onChange={(e) => setPartition({ ...partition, dropRate: Number(e.target.value) })}
                style={{ width: '100%', accentColor: '#e11d48' }}
              />
            </div>

            <div
              style={{
                padding: '12px',
                background: '#0d1117',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                fontSize: '0.75rem',
                color: 'var(--muted)',
                lineHeight: 1.5,
              }}
            >
              Destroys raw TCP socket (`request.raw.destroy()`), triggering a genuine client-side `ECONNRESET`. Ideal for testing socket reconnects.
            </div>
          </div>
        </div>
      </div>

      {/* Resilience Benchmark Suite (The Self-Demonstrating Tool) */}
      <div className="card" style={{ padding: '28px', display: 'flex', flexDirection: 'column', gap: '22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>"Test Your Resilience" Live Benchmark</h3>
              <span className="badge" style={{ background: 'rgba(91, 140, 255, 0.15)', color: 'var(--accent)' }}>
                Differentiator
              </span>
            </div>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.8125rem' }}>
              Executes a batch of requests against the active chaos profile to verify fault distributions and latency histograms.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span className="muted" style={{ fontSize: '0.8125rem' }}>Requests:</span>
            <select
              value={benchmarkCount}
              onChange={(e) => setBenchmarkCount(Number(e.target.value))}
              style={{
                background: '#0d1117',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '0.8125rem',
              }}
            >
              <option value={50}>50 Requests</option>
              <option value={100}>100 Requests</option>
              <option value={200}>200 Requests</option>
            </select>

            <button
              onClick={() => benchmarkMutation.mutate()}
              disabled={benchmarkMutation.isPending}
              className="button"
              style={{ padding: '8px 20px', fontSize: '0.8125rem', fontWeight: 600 }}
            >
              {benchmarkMutation.isPending ? 'Simulating…' : 'Fire Benchmark Suite'}
            </button>
          </div>
        </div>

        {/* Results Panel */}
        {benchmarkResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', paddingTop: '10px' }}>
            {/* 4 Stat Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
              <div style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: '8px', padding: '16px' }}>
                <span className="muted" style={{ fontSize: '0.75rem' }}>Success (2xx)</span>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--success)', marginTop: '4px' }}>
                  {benchmarkResult.successful} / {benchmarkResult.totalRequests}
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                  {Math.round((benchmarkResult.successful / benchmarkResult.totalRequests) * 100)}% Pass Rate
                </span>
              </div>

              <div style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: '8px', padding: '16px' }}>
                <span className="muted" style={{ fontSize: '0.75rem' }}>Server Faults (5xx)</span>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#ef4444', marginTop: '4px' }}>
                  {benchmarkResult.errors5xx}
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                  {Math.round((benchmarkResult.errors5xx / benchmarkResult.totalRequests) * 100)}% Rate
                </span>
              </div>

              <div style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: '8px', padding: '16px' }}>
                <span className="muted" style={{ fontSize: '0.75rem' }}>Network Drops</span>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#e11d48', marginTop: '4px' }}>
                  {benchmarkResult.dropped}
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                  {Math.round((benchmarkResult.dropped / benchmarkResult.totalRequests) * 100)}% ECONNRESET
                </span>
              </div>

              <div style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: '8px', padding: '16px' }}>
                <span className="muted" style={{ fontSize: '0.75rem' }}>Latency Profile</span>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent)', marginTop: '4px' }}>
                  {benchmarkResult.p95LatencyMs} ms
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                  P95 Latency (&mu;={benchmarkResult.meanLatencyMs}ms)
                </span>
              </div>
            </div>

            {/* SVG Latency Histogram */}
            <div>
              <span className="muted" style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '10px' }}>
                Observed Latency Distribution (Histogram)
              </span>
              <div style={{ background: '#0d1117', border: '1px solid var(--border)', borderRadius: '8px', padding: '20px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {benchmarkResult.histogram.map((bracket) => {
                    const pct = Math.round((bracket.count / benchmarkResult.totalRequests) * 100);
                    return (
                      <div key={bracket.bracket} style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '0.75rem' }}>
                        <span style={{ width: '100px', fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
                          {bracket.bracket}
                        </span>
                        <div style={{ flex: 1, background: '#1c212d', height: '14px', borderRadius: '4px', overflow: 'hidden' }}>
                          <div
                            style={{
                              width: `${pct}%`,
                              height: '100%',
                              background: 'linear-gradient(90deg, #5b8cff, #a78bfa)',
                              transition: 'width 0.4s ease',
                            }}
                          />
                        </div>
                        <span style={{ width: '70px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                          {bracket.count} ({pct}%)
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
