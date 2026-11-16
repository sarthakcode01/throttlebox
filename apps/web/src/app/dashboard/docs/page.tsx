'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type DocsViewMode = 'stoplight' | 'explorer' | 'raw';

/**
 * Stoplight Elements is loaded from a CDN, so it is pinned to an exact
 * version and checked with Subresource Integrity. Unpinned, any new upstream
 * release — or a compromised one — would run in the dashboard origin with the
 * signed-in user's session.
 */
const STOPLIGHT_BASE = 'https://unpkg.com/@stoplight/elements@9.0.29';
const STOPLIGHT_JS_SRI = 'sha384-enyjBaVmV00WFIo0D7AIVgtZ/4x0idVNWHotG8WUpvQo9HXgMSGAAW2YEOpiJTpP';
const STOPLIGHT_CSS_SRI = 'sha384-iVQBHadsD+eV0M5+ubRCEVXrXEBj+BqcuwjUwPoVJc0Pb1fmrhYSAhL+BFProHdV';

export default function DashboardDocsPage() {
  const [selectedSlug, setSelectedSlug] = useState<string>('ecommerce');
  const [viewMode, setViewMode] = useState<DocsViewMode>('explorer');
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [specLoading, setSpecLoading] = useState(false);
  const [specError, setSpecError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

  // 1. Fetch available mock services to populate dropdown
  const { data: servicesData, isLoading: servicesLoading } = useQuery({
    queryKey: ['mock-services'],
    queryFn: api.listMockServices,
    retry: false,
  });

  const services = servicesData?.services ?? [];

  // If user has services and current slug isn't in list, pick the first
  useEffect(() => {
    if (services.length > 0 && !services.some((s) => s.slug === selectedSlug)) {
      setSelectedSlug(services[0]?.slug ?? 'ecommerce');
    }
  }, [services, selectedSlug]);

  // 2. Fetch OpenAPI 3.1 JSON for the selected service
  useEffect(() => {
    if (!selectedSlug) return;
    const controller = new AbortController();

    async function fetchDoc() {
      setSpecLoading(true);
      setSpecError(null);
      setSpec(null);

      try {
        const response = await fetch(`${apiUrl}/docs/${selectedSlug}/openapi.json`, {
          credentials: 'include',
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 403) {
            throw new Error('Sign in or generate an API key to read this OpenAPI document.');
          }
          if (response.status === 404) {
            throw new Error(`Service "${selectedSlug}" has no registered OpenAPI specification.`);
          }
          throw new Error(`Could not load OpenAPI document (${response.status})`);
        }

        const data = (await response.json()) as Record<string, unknown>;
        setSpec(data);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setSpecError((err as Error).message);
      } finally {
        setSpecLoading(false);
      }
    }

    void fetchDoc();
    return () => controller.abort();
  }, [selectedSlug, apiUrl]);

  // 3. Inject Stoplight Elements stylesheet and script safely
  useEffect(() => {
    // Inject Stylesheet
    const cssId = 'stoplight-elements-css';
    if (!document.getElementById(cssId)) {
      const link = document.createElement('link');
      link.id = cssId;
      link.rel = 'stylesheet';
      link.href = `${STOPLIGHT_BASE}/styles.min.css`;
      link.integrity = STOPLIGHT_CSS_SRI;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }

    // Inject Web Component JS
    const scriptId = 'stoplight-elements-js';
    if (!document.getElementById(scriptId)) {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = `${STOPLIGHT_BASE}/web-components.min.js`;
      script.integrity = STOPLIGHT_JS_SRI;
      script.crossOrigin = 'anonymous';
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  const handleCopy = (text: string, id: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(id);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const handleDownload = () => {
    if (!spec) return;
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedSlug}-openapi.json`;
    a.click();
    // Revoking straight after click() can cancel the download in some
    // browsers; give it a moment to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Helper for Native Route Explorer
  const paths = (spec?.paths as Record<string, Record<string, Record<string, unknown>>>) ?? {};
  const routeEntries = Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({
      path,
      method: method.toUpperCase(),
      summary: (op.summary as string) || path,
      responses: (op.responses as Record<string, { description?: string }>) || {},
    })),
  );

  return (
    <div>
      {/* Top Header */}
      <div className="dashboard-header-row">
        <div>
          <h1 className="dashboard-title">API Reference &amp; Explorer</h1>
          <p className="dashboard-subtitle">
            Inspect, test, and export your dynamically generated OpenAPI 3.1 specifications.
          </p>
        </div>

        <div className="row">
          <button
            onClick={handleDownload}
            disabled={!spec}
            className="secondary-button"
            style={{ fontSize: '0.875rem' }}
          >
            Download OpenAPI Spec (.json)
          </button>
        </div>
      </div>

      {/* Control Hub Bar */}
      <div className="docs-hub-bar">
        {/* Service Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <label htmlFor="service-select" style={{ margin: 0, fontWeight: 600 }}>
            Mock Service:
          </label>
          {servicesLoading ? (
            <span className="muted" style={{ fontSize: '0.875rem' }}>
              Loading services…
            </span>
          ) : services.length === 0 ? (
            <span className="muted" style={{ fontSize: '0.875rem' }}>
              No mock services found. <Link href="/dashboard/services">Create one</Link>.
            </span>
          ) : (
            <select
              id="service-select"
              value={selectedSlug}
              onChange={(e) => setSelectedSlug(e.target.value)}
              style={{ width: 'auto', minWidth: '220px', padding: '6px 12px' }}
            >
              {services.map((svc) => (
                <option key={svc.id} value={svc.slug}>
                  {svc.name} ({svc.slug}) — {svc.routeCount} routes
                </option>
              ))}
            </select>
          )}

          {/* Base URL Pill */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: '#090c10',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '6px 10px',
              fontSize: '0.75rem',
              color: 'var(--muted)',
            }}
          >
            <span>Base URL:</span>
            <code style={{ color: 'var(--text)' }}>
              {apiUrl}/mock/{selectedSlug}
            </code>
            <button
              onClick={() => handleCopy(`${apiUrl}/mock/${selectedSlug}`, 'base-url')}
              style={{
                background: 'none',
                border: 'none',
                color: copiedKey === 'base-url' ? 'var(--success)' : 'var(--accent)',
                cursor: 'pointer',
                padding: '0 4px',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
            >
              {copiedKey === 'base-url' ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {/* View Mode Switcher */}
        <div className="docs-mode-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={viewMode === 'explorer'}
            className={`docs-mode-tab ${viewMode === 'explorer' ? 'active' : ''}`}
            onClick={() => setViewMode('explorer')}
          >
            Interactive Explorer
          </button>
          <button
            role="tab"
            aria-selected={viewMode === 'stoplight'}
            className={`docs-mode-tab ${viewMode === 'stoplight' ? 'active' : ''}`}
            onClick={() => setViewMode('stoplight')}
          >
            Stoplight Elements
          </button>
          <button
            role="tab"
            aria-selected={viewMode === 'raw'}
            className={`docs-mode-tab ${viewMode === 'raw' ? 'active' : ''}`}
            onClick={() => setViewMode('raw')}
          >
            Raw OpenAPI 3.1
          </button>
        </div>
      </div>

      {/* Error / Loading Alert */}
      {specError && (
        <div className="error" role="alert" style={{ marginBottom: '24px' }}>
          {specError}
        </div>
      )}

      {specLoading && !spec && (
        <div className="card text-center" style={{ padding: '48px 24px' }}>
          <div style={{ color: 'var(--accent)', marginBottom: '12px' }}>
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </div>
          <p style={{ margin: 0, fontWeight: 600 }}>Building OpenAPI 3.1 Specification…</p>
          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            Compiling mock route trees into typed OpenAPI schemas
          </span>
        </div>
      )}

      {/* ====================================================================
          View Mode 1: Native Route Explorer & Playground
          ==================================================================== */}
      {spec && viewMode === 'explorer' && (
        <div className="stack" style={{ gap: '16px' }}>
          {routeEntries.length === 0 ? (
            <div className="card text-center" style={{ padding: '48px' }}>
              <h3>No Active Routes Configured</h3>
              <p className="muted">
                Service &quot;{selectedSlug}&quot; does not have any active routes yet. Add
                endpoints in the Mock APIs studio.
              </p>
              <Link
                href="/dashboard/services"
                className="cta-button"
                style={{ display: 'inline-flex' }}
              >
                Go to Mock APIs Studio &rarr;
              </Link>
            </div>
          ) : (
            routeEntries.map((route, i) => {
              // Path parameters are `{name}` in the document; fill in a
              // sample value so the copied command actually runs.
              const samplePath = route.path.replace(/\{([^}]+)\}/g, '1');
              const fullCurl = `curl -i -H "Authorization: Bearer <your-key>" ${apiUrl}/mock/${selectedSlug}${samplePath}`;
              const methodClass = `method-${route.method.toLowerCase()}`;

              return (
                <div key={i} className="card" style={{ padding: '20px 24px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: '14px',
                      flexWrap: 'wrap',
                      gap: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span className={`badge ${methodClass}`}>{route.method}</span>
                      <code style={{ fontSize: '1rem', fontWeight: 600 }}>{route.path}</code>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {Object.keys(route.responses).map((status) => (
                        <span key={status} className="badge" style={{ color: 'var(--success)' }}>
                          Status {status}
                        </span>
                      ))}
                      <button
                        onClick={() => handleCopy(fullCurl, `curl-${i}`)}
                        className="secondary-button"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                      >
                        {copiedKey === `curl-${i}` ? '✓ Copied cURL' : 'Copy cURL'}
                      </button>
                    </div>
                  </div>

                  <div
                    style={{
                      background: '#090c10',
                      border: '1px solid var(--border)',
                      borderRadius: '7px',
                      padding: '10px 14px',
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: '0.8125rem',
                      color: 'var(--muted)',
                    }}
                  >
                    <span style={{ color: 'var(--accent)' }}>$ </span>
                    {fullCurl}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ====================================================================
          View Mode 2: Stoplight Elements Console
          ==================================================================== */}
      {spec && viewMode === 'stoplight' && (
        <div className="stoplight-embed-wrap">
          <elements-api
            apiDescription={spec}
            router="hash"
            layout="sidebar"
            style={{ display: 'block', height: '75vh', minHeight: '650px' }}
          />
        </div>
      )}

      {/* ====================================================================
          View Mode 3: Raw OpenAPI 3.1 Spec JSON
          ==================================================================== */}
      {spec && viewMode === 'raw' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div
            style={{
              padding: '12px 18px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: '#10141c',
            }}
          >
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--muted)' }}>
              OpenAPI 3.1.0 Document ({selectedSlug})
            </div>
            <button
              onClick={() => handleCopy(JSON.stringify(spec, null, 2), 'raw-json')}
              className="secondary-button"
              style={{ padding: '4px 10px', fontSize: '0.75rem' }}
            >
              {copiedKey === 'raw-json' ? '✓ Copied' : 'Copy JSON'}
            </button>
          </div>
          <pre
            className="code-block"
            style={{ maxHeight: '600px', margin: 0, borderRadius: 0, border: 'none' }}
          >
            {JSON.stringify(spec, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
