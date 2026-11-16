'use client';

import Link from 'next/link';
import { useState } from 'react';

type TerminalTab = 'curl' | 'headers' | 'body' | 'rate-limit';
type SyntaxTab = 'products' | 'users' | 'invoices';

export default function HomePage() {
  const [activeTerminalTab, setActiveTerminalTab] = useState<TerminalTab>('curl');
  const [activeSyntaxTab, setActiveSyntaxTab] = useState<SyntaxTab>('products');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (text: string, id: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(id);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const syntaxExamples: Record<SyntaxTab, { title: string; template: string; output: string }> = {
    products: {
      title: 'E-Commerce Catalog',
      template: `[
  "{{#repeat 3}}",
  {
    "id": "prod_{{faker.string.alphanumeric(8)}}",
    "name": "{{faker.commerce.productName()}}",
    "sku": "SKU-{{faker.string.numeric(6)}}",
    "category": "{{faker.commerce.department()}}",
    "price": {{faker.commerce.price({ min: 10, max: 250, dec: 2 })}},
    "currency": "USD",
    "inStock": {{faker.datatype.boolean(0.85)}},
    "inventory": {{faker.number.int({ min: 0, max: 450 })}},
    "metadata": {
      "rating": {{faker.number.float({ min: 3.5, max: 5.0, fractionDigits: 1 })}},
      "tags": ["featured", "{{faker.commerce.productAdjective()}}"]
    }
  },
  "{{/repeat}}"
]`,
      output: `[
  {
    "id": "prod_87b2ca1e",
    "name": "Ergonomic Titanium Keyboard",
    "sku": "SKU-849102",
    "category": "Electronics",
    "price": 189.50,
    "currency": "USD",
    "inStock": true,
    "inventory": 142,
    "metadata": {
      "rating": 4.8,
      "tags": ["featured", "Refined"]
    }
  },
  {
    "id": "prod_33c91d4a",
    "name": "Artisanal Ceramic Mug",
    "sku": "SKU-312984",
    "category": "Home",
    "price": 28.00,
    "currency": "USD",
    "inStock": true,
    "inventory": 88,
    "metadata": {
      "rating": 4.6,
      "tags": ["featured", "Handmade"]
    }
  },
  {
    "id": "prod_f09a82bb",
    "name": "Wireless Noise-Cancelling Buds",
    "sku": "SKU-765011",
    "category": "Electronics",
    "price": 129.99,
    "currency": "USD",
    "inStock": false,
    "inventory": 0,
    "metadata": {
      "rating": 4.9,
      "tags": ["featured", "Sleek"]
    }
  }
]`,
    },
    users: {
      title: 'User Profile & Permissions',
      template: `{
  "userId": "usr_{{faker.string.uuid()}}",
  "name": "{{faker.person.fullName()}}",
  "email": "{{faker.internet.email()}}",
  "role": "{{faker.helpers.arrayElement(['admin', 'member', 'billing_manager'])}}",
  "organization": {
    "id": "org_{{faker.string.alphanumeric(10)}}",
    "tier": "{{faker.helpers.arrayElement(['free', 'pro', 'enterprise'])}}"
  },
  "verified": true,
  "lastActiveAt": "{{faker.date.recent().toISOString()}}"
}`,
      output: `{
  "userId": "usr_7d9e4a3b-28f1-4320-b891-628d09cb8194",
  "name": "Elena Rostova",
  "email": "elena.rostova@acme-cloud.io",
  "role": "admin",
  "organization": {
    "id": "org_9k2m4x81zp",
    "tier": "pro"
  },
  "verified": true,
  "lastActiveAt": "2026-11-02T19:42:18.421Z"
}`,
    },
    invoices: {
      title: 'Billing & Invoices',
      template: `{
  "invoiceId": "inv_{{faker.string.numeric(8)}}",
  "billingPeriod": "2026-10",
  "amountDueCents": 2900,
  "currency": "USD",
  "status": "paid",
  "lineItems": [
    {
      "description": "Throttlebox Pro Workspace Quota (5,000 req/hr)",
      "amountCents": 2900,
      "quantity": 1
    }
  ],
  "paidAt": "2026-10-01T00:04:12Z"
}`,
      output: `{
  "invoiceId": "inv_93817204",
  "billingPeriod": "2026-10",
  "amountDueCents": 2900,
  "currency": "USD",
  "status": "paid",
  "lineItems": [
    {
      "description": "Throttlebox Pro Workspace Quota (5,000 req/hr)",
      "amountCents": 2900,
      "quantity": 1
    }
  ],
  "paidAt": "2026-10-01T00:04:12Z"
}`,
    },
  };

  return (
    <main className="landing-page">
      {/* ====================================================================
          Section 1: Sticky Top Navigation
          ==================================================================== */}
      <header className="site-nav">
        <div className="site-nav-container">
          <Link href="/" className="site-logo">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#5b8cff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span>Throttlebox</span>
            <span className="logo-badge">v0.4.0 • Tiers Live</span>
          </Link>

          <nav className="nav-menu" aria-label="Main Navigation">
            <a href="#features" className="nav-link">
              Features
            </a>
            <a href="#architecture" className="nav-link">
              Architecture
            </a>
            <a href="#templates" className="nav-link">
              Templates
            </a>
            <a href="#ratelimits" className="nav-link">
              Rate Limits
            </a>
            <a href="#pricing" className="nav-link">
              Pricing
            </a>
            <a href="#faq" className="nav-link">
              FAQ
            </a>
            <Link href="/docs" className="nav-link">
              Docs
            </Link>
          </nav>

          <div className="nav-actions">
            <Link
              href="/login"
              className="secondary-button"
              style={{ padding: '8px 16px', fontSize: '0.875rem' }}
            >
              Sign In
            </Link>
            <Link
              href="/login"
              className="cta-button"
              style={{ padding: '8px 16px', fontSize: '0.875rem' }}
            >
              Get Started Free &rarr;
            </Link>
          </div>
        </div>
      </header>

      {/* ====================================================================
          Section 2: Hero Section & Live Terminal Mockup
          ==================================================================== */}
      <section className="landing-section hero-wrap">
        <div className="hero-glow" aria-hidden="true" />
        <div className="landing-container hero-content">
          <div className="section-tag">
            <span>⚡ Phase 4 Released: Sliding-Window Tiers &amp; Bursting</span>
          </div>

          <h1 className="hero-title">
            Realistic API Mocks with{' '}
            <span className="highlight">Real Sliding-Window Rate Limits</span>
          </h1>

          <p className="hero-subtitle">
            Mint cryptographically peppered API keys, test against atomic Redis Lua sliding windows,
            simulate downstream chaos, and inspect p95/p99 continuous aggregates before shipping to
            staging.
          </p>

          <div className="hero-cta-row">
            <Link href="/login" className="cta-button">
              <span>Start Building Free</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
            <a href="#architecture" className="secondary-button">
              <span>Explore Engine Architecture</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </a>
          </div>

          {/* Quick Copy Snippet */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '10px',
              background: '#090c10',
              border: '1px solid var(--border)',
              borderRadius: '999px',
              padding: '6px 16px',
              marginBottom: '36px',
              fontSize: '0.8125rem',
              color: 'var(--muted)',
            }}
          >
            <span style={{ color: 'var(--accent)' }}>$</span>
            <code>
              curl -H &quot;Authorization: Bearer sk_live_...&quot; /mock/ecommerce/products
            </code>
            <button
              onClick={() =>
                handleCopy(
                  'curl -H "Authorization: Bearer sk_live_<your-key>" https://api.throttlebox.dev/mock/ecommerce/products',
                  'quick-curl',
                )
              }
              style={{
                background: 'none',
                border: 'none',
                color: copiedKey === 'quick-curl' ? 'var(--success)' : 'var(--muted)',
                cursor: 'pointer',
                padding: '2px 6px',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
            >
              {copiedKey === 'quick-curl' ? '✓ Copied' : 'Copy'}
            </button>
          </div>

          {/* Interactive Terminal Window */}
          <div className="terminal-box">
            <div className="terminal-header">
              <div className="terminal-dots">
                <div className="terminal-dot red" />
                <div className="terminal-dot yellow" />
                <div className="terminal-dot green" />
              </div>
              <div className="terminal-title">bash — throttlebox mock client v0.4.0</div>
              <div style={{ width: '40px' }} />
            </div>

            <div className="terminal-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={activeTerminalTab === 'curl'}
                className={`terminal-tab-btn ${activeTerminalTab === 'curl' ? 'active' : ''}`}
                onClick={() => setActiveTerminalTab('curl')}
              >
                1. cURL Request
              </button>
              <button
                role="tab"
                aria-selected={activeTerminalTab === 'headers'}
                className={`terminal-tab-btn ${activeTerminalTab === 'headers' ? 'active' : ''}`}
                onClick={() => setActiveTerminalTab('headers')}
              >
                2. HTTP Response Headers (200 OK)
              </button>
              <button
                role="tab"
                aria-selected={activeTerminalTab === 'body'}
                className={`terminal-tab-btn ${activeTerminalTab === 'body' ? 'active' : ''}`}
                onClick={() => setActiveTerminalTab('body')}
              >
                3. JSON Mock Payload
              </button>
              <button
                role="tab"
                aria-selected={activeTerminalTab === 'rate-limit'}
                className={`terminal-tab-btn ${activeTerminalTab === 'rate-limit' ? 'active' : ''}`}
                onClick={() => setActiveTerminalTab('rate-limit')}
              >
                4. Rate Limit Exceeded (429)
              </button>
            </div>

            {activeTerminalTab === 'curl' && (
              <pre className="terminal-code">
                <span className="t-cmd">curl</span> <span className="t-flag">-i</span>{' '}
                <span className="t-flag">-X</span> GET \<br />
                {'  '}
                <span className="t-url">https://api.throttlebox.dev/mock/ecommerce/products</span> \
                <br />
                {'  '}-H{' '}
                <span className="t-header">
                  &quot;Authorization: Bearer sk_live_9Kd2mQxR7tYb_...&quot;
                </span>{' '}
                \<br />
                {'  '}-H <span className="t-header">&quot;Accept: application/json&quot;</span>
              </pre>
            )}

            {activeTerminalTab === 'headers' && (
              <pre className="terminal-code">
                <span style={{ color: '#3ecf8e', fontWeight: 600 }}>HTTP/1.1 200 OK</span>
                <br />
                <span className="t-header">Content-Type:</span>{' '}
                <span className="t-val">application/json; charset=utf-8</span>
                <br />
                <span className="t-header">X-RateLimit-Limit:</span>{' '}
                <span className="t-val" style={{ color: '#5b8cff', fontWeight: 600 }}>
                  100
                </span>
                <br />
                <span className="t-header">X-RateLimit-Remaining:</span>{' '}
                <span className="t-val" style={{ color: '#3ecf8e', fontWeight: 600 }}>
                  97
                </span>
                <br />
                <span className="t-header">X-RateLimit-Reset:</span>{' '}
                <span className="t-val">1730563200</span> (in 3420s)
                <br />
                <span className="t-header">X-RateLimit-Policy:</span>{' '}
                <span className="t-val">100;w=3600</span>
                <br />
                <span className="t-header">X-Response-Time-Ms:</span>{' '}
                <span className="t-val">3.41ms</span>
                <br />
                <span className="t-header">Date:</span>{' '}
                <span className="t-val">Mon, 02 Nov 2026 21:58:00 GMT</span>
              </pre>
            )}

            {activeTerminalTab === 'body' && (
              <pre className="terminal-code">
                [<br />
                {'  '}&#123;
                <br />
                {'    '}&quot;<span className="t-key">id</span>&quot;: &quot;
                <span className="t-str">prod_87b2ca1e</span>&quot;,
                <br />
                {'    '}&quot;<span className="t-key">name</span>&quot;: &quot;
                <span className="t-str">Ergonomic Titanium Keyboard</span>&quot;,
                <br />
                {'    '}&quot;<span className="t-key">sku</span>&quot;: &quot;
                <span className="t-str">SKU-849102</span>&quot;,
                <br />
                {'    '}&quot;<span className="t-key">price</span>&quot;:{' '}
                <span className="t-num">189.50</span>,
                <br />
                {'    '}&quot;<span className="t-key">currency</span>&quot;: &quot;
                <span className="t-str">USD</span>&quot;,
                <br />
                {'    '}&quot;<span className="t-key">inStock</span>&quot;:{' '}
                <span style={{ color: '#ffb347' }}>true</span>,
                <br />
                {'    '}&quot;<span className="t-key">inventory</span>&quot;:{' '}
                <span className="t-num">142</span>
                <br />
                {'  '}&#125;
                <br />]
              </pre>
            )}

            {activeTerminalTab === 'rate-limit' && (
              <pre className="terminal-code">
                <span style={{ color: '#ff6b6b', fontWeight: 600 }}>
                  HTTP/1.1 429 Too Many Requests
                </span>
                <br />
                <span className="t-header">Content-Type:</span>{' '}
                <span className="t-val">application/json; charset=utf-8</span>
                <br />
                <span className="t-header">Retry-After:</span>{' '}
                <span className="t-val" style={{ color: '#ff6b6b', fontWeight: 700 }}>
                  42
                </span>
                <br />
                <span className="t-header">X-RateLimit-Limit:</span>{' '}
                <span className="t-val">100</span>
                <br />
                <span className="t-header">X-RateLimit-Remaining:</span>{' '}
                <span className="t-val" style={{ color: '#ff6b6b' }}>
                  0
                </span>
                <br />
                <span className="t-header">X-RateLimit-Reset:</span>{' '}
                <span className="t-val">1730563242</span>
                <br />
                <br />
                &#123;
                <br />
                {'  '}&quot;<span className="t-key">statusCode</span>&quot;:{' '}
                <span className="t-num">429</span>,
                <br />
                {'  '}&quot;<span className="t-key">error</span>&quot;: &quot;
                <span className="t-str">Too Many Requests</span>&quot;,
                <br />
                {'  '}&quot;<span className="t-key">message</span>&quot;: &quot;
                <span className="t-str">Rate limit exceeded. Try again in 42 seconds.</span>
                &quot;,
                <br />
                {'  '}&quot;<span className="t-key">retryAfterSeconds</span>&quot;:{' '}
                <span className="t-num">42</span>
                <br />
                &#125;
              </pre>
            )}
          </div>
        </div>
      </section>

      {/* ====================================================================
          Section 3: Technology Badges & Security Proofs Ticker
          ==================================================================== */}
      <section
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'rgba(14, 17, 23, 0.5)',
        }}
      >
        <div className="landing-container">
          <div className="stack-ticker">
            <div className="stack-item">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff5f56">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span>
                Redis 7 <strong>Atomic Lua Sliding Windows</strong>
              </span>
            </div>

            <div className="stack-item">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5b8cff">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>
                TimescaleDB <strong>Continuous Latency Aggregates</strong>
              </span>
            </div>

            <div className="stack-item">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3ecf8e">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>
                HMAC-SHA256 &amp; <strong>Argon2id Peppered Hashing</strong>
              </span>
            </div>

            <div className="stack-item">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffb347">
                <polygon points="12 2 2 22 22 22" />
              </svg>
              <span>
                OpenAPI 3.1 <strong>Stoplight Interactive Docs</strong>
              </span>
            </div>

            <div className="stack-item">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7ba5ff">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              <span>
                Node.js 22 LTS <strong>Fastify High-Throughput Core</strong>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          Section 4: Problem vs Solution (Staging Hell vs Throttlebox)
          ==================================================================== */}
      <section id="features" className="landing-section">
        <div className="landing-container">
          <div className="text-center">
            <div className="section-tag">Why Throttlebox</div>
            <h2 className="section-heading">Stop Fighting Broken Staging Sandboxes</h2>
            <p className="section-desc centered">
              Traditional staging environments are brittle, shared, and expensive. Throttlebox gives
              every developer and CI run an isolated, high-performance mock sandbox with genuine
              rate limits.
            </p>
          </div>

          <div className="comparison-grid">
            <div className="comparison-card flaky">
              <h3 className="comparison-title" style={{ color: '#ff6b6b' }}>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <span>Staging Hell &amp; Flaky Sandboxes</span>
              </h3>
              <ul className="comparison-list">
                <li>
                  <span style={{ color: '#ff6b6b' }}>&times;</span>
                  <span>
                    <strong>Shared state collisions:</strong> Test runs overwrite each other&apos;s
                    records, causing non-deterministic CI pipeline failures.
                  </span>
                </li>
                <li>
                  <span style={{ color: '#ff6b6b' }}>&times;</span>
                  <span>
                    <strong>Unrealistic rate testing:</strong> Sandboxes either don&apos;t limit
                    requests at all, or ban your dev IP without standard <code>X-RateLimit-*</code>{' '}
                    headers.
                  </span>
                </li>
                <li>
                  <span style={{ color: '#ff6b6b' }}>&times;</span>
                  <span>
                    <strong>Key sprawl &amp; leakage:</strong> Plaintext keys shared across Slack
                    channels with zero rotation audit logs.
                  </span>
                </li>
                <li>
                  <span style={{ color: '#ff6b6b' }}>&times;</span>
                  <span>
                    <strong>Zero chaos observability:</strong> Unable to simulate p99 tail latency,
                    timeouts, or intermittent upstream 503 gateway drops.
                  </span>
                </li>
              </ul>
            </div>

            <div className="comparison-card throttlebox">
              <h3 className="comparison-title" style={{ color: '#3ecf8e' }}>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>The Throttlebox Way</span>
              </h3>
              <ul className="comparison-list">
                <li>
                  <span style={{ color: '#3ecf8e' }}>✓</span>
                  <span>
                    <strong>Atomic sliding-window limiter:</strong> True Redis Lua ZSET sliding
                    windows enforce sub-millisecond precision with RFC 6585 compliance.
                  </span>
                </li>
                <li>
                  <span style={{ color: '#3ecf8e' }}>✓</span>
                  <span>
                    <strong>Peppered HMAC API keys:</strong> High-entropy cryptographic tokens
                    hashed with secret peppers; zero plaintext storage.
                  </span>
                </li>
                <li>
                  <span style={{ color: '#3ecf8e' }}>✓</span>
                  <span>
                    <strong>Live TimescaleDB metrics:</strong> Continuous aggregates record p50,
                    p95, and p99 latency without querying heavy transaction logs.
                  </span>
                </li>
                <li>
                  <span style={{ color: '#3ecf8e' }}>✓</span>
                  <span>
                    <strong>Declarative zero-eval templating:</strong> Fast, safe Faker syntax
                    without dangerous arbitrary JavaScript execution.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          Section 5: 4-Step Interactive Execution Flow
          ==================================================================== */}
      <section className="landing-section">
        <div className="landing-container">
          <div className="text-center">
            <div className="section-tag">How It Works</div>
            <h2 className="section-heading">From Zero to Throttled Mock in 60 Seconds</h2>
            <p className="section-desc centered">
              Build resilient frontend and backend services that gracefully handle real-world rate
              limits and network anomalies.
            </p>
          </div>

          <div className="workflow-grid">
            <div className="step-card">
              <div className="step-num">01</div>
              <h3 className="step-title">Define or Fork Service</h3>
              <p className="step-desc">
                Select from ready-to-use schemas (E-Commerce, Auth, CRM, Billing) or import your own
                OpenAPI 3.1 specification directly.
              </p>
            </div>

            <div className="step-card">
              <div className="step-num">02</div>
              <h3 className="step-title">Mint Peppered Keys</h3>
              <p className="step-desc">
                Generate high-entropy workspace keys with secret HMAC peppers. Assign read/write
                scopes and manage family rotation without downtime.
              </p>
            </div>

            <div className="step-card">
              <div className="step-num">03</div>
              <h3 className="step-title">Stress Test &amp; Throttle</h3>
              <p className="step-desc">
                Call your endpoints from tests or frontend clients. Verify <code>429</code> backoff
                behavior and <code>Retry-After</code> response handling.
              </p>
            </div>

            <div className="step-card">
              <div className="step-num">04</div>
              <h3 className="step-title">Inspect Continuous Analytics</h3>
              <p className="step-desc">
                Watch request histograms, status distributions, and p95/p99 latency continuously
                aggregated into TimescaleDB hypertables.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          Section 6: Bento Grid Architecture Deep-Dive
          ==================================================================== */}
      <section id="architecture" className="landing-section">
        <div className="landing-container">
          <div className="text-center">
            <div className="section-tag">Engine Architecture</div>
            <h2 className="section-heading">Engineered for Microsecond Precision</h2>
            <p className="section-desc centered">
              Every request traverses a hardened pipeline designed for sub-millisecond execution,
              cryptographic isolation, and failure resilience.
            </p>
          </div>

          <div className="bento-grid">
            {/* Bento 1: Atomic Lua Limiter */}
            <div className="bento-card col-span-2">
              <div>
                <div className="bento-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                </div>
                <h3 className="bento-title">Atomic Redis Lua Sliding-Window Counter</h3>
                <p className="bento-desc">
                  Unlike naive leaky-bucket or fixed-window counters that permit 2x traffic bursts
                  across window boundaries, Throttlebox executes an atomic Redis Lua script using{' '}
                  <code>redis.call(&apos;TIME&apos;)</code>, <code>ZREMRANGEBYSCORE</code>, and{' '}
                  <code>ZCARD</code>. Even under concurrent load from thousands of virtual users,
                  rate limits are enforced with microsecond accuracy.
                </p>
              </div>
              <div
                style={{
                  background: '#090c10',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: '0.8rem',
                  color: 'var(--muted)',
                }}
              >
                <span style={{ color: '#5b8cff' }}>EVALSHA</span> &lt;sha&gt; 1
                ratelimit:srv_demo:key_free 3600000 100 1730563200000 120
              </div>
            </div>

            {/* Bento 2: Peppered HMAC Keys */}
            <div className="bento-card">
              <div>
                <div className="bento-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <h3 className="bento-title">Cryptographic Key Isolation</h3>
                <p className="bento-desc">
                  API keys carry a routing prefix (<code>sk_live_...</code>), a public identifier,
                  and a 190-bit CSPRNG secret. Hashes are computed with server-side peppers,
                  preventing rainbow table attacks even if database backups are exposed.
                </p>
              </div>
              <div
                style={{
                  color: 'var(--success)',
                  fontSize: '0.8125rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span>✓ Zero Plaintext Key Persistence</span>
              </div>
            </div>

            {/* Bento 3: Continuous TimescaleDB Rollups */}
            <div className="bento-card">
              <div>
                <div className="bento-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                </div>
                <h3 className="bento-title">Continuous Latency Aggregates</h3>
                <p className="bento-desc">
                  Request telemetry streams into TimescaleDB hypertables. Materialized continuous
                  aggregates compute p50, p95, and p99 percentiles in real time without scanning raw
                  historical rows.
                </p>
              </div>
              <div
                style={{
                  color: 'var(--accent)',
                  fontSize: '0.8125rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span>⚡ Sub-5ms Metric Query Latency</span>
              </div>
            </div>

            {/* Bento 4: Redis Pub/Sub Cache Sync */}
            <div className="bento-card">
              <div>
                <div className="bento-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <circle cx="12" cy="12" r="2" />
                    <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
                  </svg>
                </div>
                <h3 className="bento-title">Zero-Downtime Cache Sync</h3>
                <p className="bento-desc">
                  Key revocations, rotations, and workspace tier upgrades publish messages to Redis
                  Pub/Sub channels. Clustered API gateways invalidate local L1 and L2 caches
                  instantaneously across nodes.
                </p>
              </div>
              <div
                style={{
                  color: 'var(--success)',
                  fontSize: '0.8125rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span>✓ Sub-10ms Cluster Invalidation</span>
              </div>
            </div>

            {/* Bento 5: Safe Zero-Eval Templating */}
            <div className="bento-card col-span-2">
              <div>
                <div className="bento-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                </div>
                <h3 className="bento-title">Declarative Sandboxed Templating (Zero Eval)</h3>
                <p className="bento-desc">
                  Throttlebox parses templates using a strict AST evaluator backed by Faker.js and
                  Handlebars loops. It generates richly formatted mock datasets with pagination,
                  filtering, and deterministic seed repeatability without permitting dangerous
                  arbitrary JavaScript execution in production.
                </p>
              </div>
              <div
                style={{
                  background: '#090c10',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: '0.8rem',
                  color: 'var(--muted)',
                }}
              >
                <span style={{ color: '#3ecf8e' }}>Deterministic Seed:</span> seed =
                hash(&quot;srv_store:v1&quot;) &rarr; Exact identical payload on every test run.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          Section 7: Interactive Template & Syntax Explorer
          ==================================================================== */}
      <section id="templates" className="landing-section">
        <div className="landing-container">
          <div className="text-center">
            <div className="section-tag">Interactive Explorer</div>
            <h2 className="section-heading">Declarative Templates in Action</h2>
            <p className="section-desc centered">
              Inspect how Throttlebox turns lightweight JSON template specifications into
              production-grade mock endpoints.
            </p>
          </div>

          <div className="syntax-explorer">
            <div className="syntax-tabs" role="tablist">
              {(['products', 'users', 'invoices'] as SyntaxTab[]).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={activeSyntaxTab === tab}
                  className={`syntax-tab-btn ${activeSyntaxTab === tab ? 'active' : ''}`}
                  onClick={() => setActiveSyntaxTab(tab)}
                >
                  {syntaxExamples[tab].title}
                </button>
              ))}
            </div>

            <div className="syntax-panes">
              <div className="syntax-pane" style={{ borderRight: '1px solid var(--border)' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '12px',
                  }}
                >
                  <div className="syntax-pane-title">Template Definition</div>
                  <button
                    onClick={() =>
                      handleCopy(syntaxExamples[activeSyntaxTab].template, 'template-copy')
                    }
                    style={{
                      background: 'none',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      fontSize: '0.75rem',
                      color: copiedKey === 'template-copy' ? 'var(--success)' : 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    {copiedKey === 'template-copy' ? '✓ Copied' : 'Copy Template'}
                  </button>
                </div>
                <pre
                  className="code-block"
                  style={{ maxHeight: '380px', overflow: 'auto', margin: 0 }}
                >
                  {syntaxExamples[activeSyntaxTab].template}
                </pre>
              </div>

              <div className="syntax-pane">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '12px',
                  }}
                >
                  <div className="syntax-pane-title">Generated Mock Output (200 OK)</div>
                  <button
                    onClick={() =>
                      handleCopy(syntaxExamples[activeSyntaxTab].output, 'output-copy')
                    }
                    style={{
                      background: 'none',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      fontSize: '0.75rem',
                      color: copiedKey === 'output-copy' ? 'var(--success)' : 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    {copiedKey === 'output-copy' ? '✓ Copied' : 'Copy Output'}
                  </button>
                </div>
                <pre
                  className="code-block"
                  style={{ maxHeight: '380px', overflow: 'auto', margin: 0, color: '#3ecf8e' }}
                >
                  {syntaxExamples[activeSyntaxTab].output}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          Section 8: Tier Comparison & Pricing Cards
          ==================================================================== */}
      <section id="pricing" className="landing-section">
        <div className="landing-container">
          <div className="text-center">
            <div className="section-tag" id="ratelimits">
              Workspace Tiers &amp; Quotas
            </div>
            <h2 className="section-heading">Predictable Quotas for Every Scale</h2>
            <p className="section-desc centered">
              Test rate limits on the free tier or scale to Pro with 5,000 req/hr and burst
              allowances. Switch tiers on the fly without restarting your application.
            </p>
          </div>

          <div className="pricing-grid">
            {/* Free Tier */}
            <div className="pricing-card">
              <h3 className="pricing-name">Free Workspace</h3>
              <div className="pricing-price">
                $0 <span>/ month</span>
              </div>
              <p className="pricing-desc">
                Ideal for individual developers, local prototype mocks, and initial client
                integration tests.
              </p>
              <ul className="pricing-features">
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>
                    <strong>100 requests / hour</strong> sliding window
                  </span>
                </li>
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>1 active workspace &amp; 3 API keys</span>
                </li>
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>Real-time Redis Lua rate limiting</span>
                </li>
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>
                    Standard <code>X-RateLimit-*</code> &amp; <code>429</code> headers
                  </span>
                </li>
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>24-hour TimescaleDB log retention</span>
                </li>
              </ul>
              <Link
                href="/login"
                className="secondary-button"
                style={{ textAlign: 'center', justifyContent: 'center' }}
              >
                Get Started Free
              </Link>
            </div>

            {/* Pro Tier (Featured) */}
            <div className="pricing-card featured">
              <div className="pricing-badge">Phase 4 Active</div>
              <h3 className="pricing-name" style={{ color: 'var(--accent)' }}>
                Pro Workspace
              </h3>
              <div className="pricing-price">
                $29 <span>/ month</span>
              </div>
              <p className="pricing-desc">
                For fast-moving engineering teams and CI/CD pipelines running continuous integration
                suites.
              </p>
              <ul className="pricing-features">
                <li>
                  <span style={{ color: 'var(--success)' }}>✓</span>
                  <span>
                    <strong>5,000 requests / hour</strong> sliding window
                  </span>
                </li>
                <li>
                  <span style={{ color: 'var(--success)' }}>✓</span>
                  <span>
                    <strong>+20% Burst Allowance (6,000 req)</strong> for peak test runs
                  </span>
                </li>
                <li>
                  <span style={{ color: 'var(--success)' }}>✓</span>
                  <span>Unlimited API keys &amp; key families</span>
                </li>
                <li>
                  <span style={{ color: 'var(--success)' }}>✓</span>
                  <span>Zero-downtime key rotation &amp; instant revocation</span>
                </li>
                <li>
                  <span style={{ color: 'var(--success)' }}>✓</span>
                  <span>
                    <strong>p50, p95, p99 Latency Analytics</strong> in TimescaleDB
                  </span>
                </li>
                <li>
                  <span style={{ color: 'var(--success)' }}>✓</span>
                  <span>Chaos injection (jitter, latency, synthetic 500s)</span>
                </li>
              </ul>
              <Link
                href="/login"
                className="cta-button"
                style={{ textAlign: 'center', justifyContent: 'center' }}
              >
                Upgrade to Pro &rarr;
              </Link>
            </div>

            {/* Enterprise Tier */}
            <div className="pricing-card">
              <h3 className="pricing-name">Enterprise</h3>
              <div className="pricing-price">
                Custom <span>/ dedicated</span>
              </div>
              <p className="pricing-desc">
                For regulated environments and platforms requiring self-hosted multi-tenant mock
                clusters.
              </p>
              <ul className="pricing-features">
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>Custom rate-limiting windows &amp; quotas</span>
                </li>
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>Self-hosted Docker / Kubernetes deployment</span>
                </li>
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>Custom Argon2id &amp; HMAC secret management</span>
                </li>
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>Dedicated Redis &amp; TimescaleDB cluster support</span>
                </li>
                <li>
                  <span style={{ color: 'var(--accent)' }}>✓</span>
                  <span>99.99% SLA &amp; dedicated engineering Slack channel</span>
                </li>
              </ul>
              <a
                href="mailto:support@throttlebox.dev"
                className="secondary-button"
                style={{ textAlign: 'center', justifyContent: 'center' }}
              >
                Contact Enterprise Sales
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          Section 9: Technical & Architecture FAQ
          ==================================================================== */}
      <section id="faq" className="landing-section">
        <div className="landing-container">
          <div className="text-center">
            <div className="section-tag">Architecture FAQ</div>
            <h2 className="section-heading">Frequently Asked Questions</h2>
            <p className="section-desc centered">
              Everything you need to know about key security, sliding-window mechanics, and failure
              isolation.
            </p>
          </div>

          <div className="faq-grid">
            <div className="faq-card">
              <h3 className="faq-q">How does sliding-window rate limiting work under the hood?</h3>
              <p className="faq-a">
                We store each request timestamp as a member in a Redis sorted set (ZSET) keyed by{' '}
                <code>ratelimit:&lt;serviceId&gt;:&lt;keyId&gt;</code>. An atomic Lua script prunes
                members older than <code>now - windowMs</code> with <code>ZREMRANGEBYSCORE</code>,
                counts active members via <code>ZCARD</code>, and rejects incoming requests with
                dynamic <code>Retry-After</code> headers when the count exceeds your tier allowance.
              </p>
            </div>

            <div className="faq-card">
              <h3 className="faq-q">
                Why use HMAC peppers instead of raw bcrypt/argon2 for API keys?
              </h3>
              <p className="faq-a">
                API request verification must complete in sub-millisecond timeframes. Argon2id is
                computationally heavy (15-50ms per check), which would bottleneck high-throughput
                mock traffic. We use constant-time peppered HMAC-SHA256 with Redis L1 caching for
                sub-millisecond lookups, while reserving Argon2id for password verification at
                login.
              </p>
            </div>

            <div className="faq-card">
              <h3 className="faq-q">What is the 20% burst allowance in Pro workspaces?</h3>
              <p className="faq-a">
                When running automated test suites (like Playwright, Cypress, or Vitest), requests
                often arrive in sudden spikes. Pro workspaces have a baseline limit of 5,000 req/hr
                with an automated burst ceiling of 6,000 requests, preventing test flakes during
                burst phases while preserving strict sliding-window protection.
              </p>
            </div>

            <div className="faq-card">
              <h3 className="faq-q">
                What happens if Redis encounters network latency or downtime?
              </h3>
              <p className="faq-a">
                Throttlebox implements a fail-open resilience pattern in <code>limiter.ts</code>. If
                Redis is unreachable, the rate limiter logs an alert and allows mock traffic to
                proceed with default response headers, preventing mock downtime from breaking your
                local development or staging environments.
              </p>
            </div>

            <div className="faq-card">
              <h3 className="faq-q">How does key rotation work without breaking active clients?</h3>
              <p className="faq-a">
                Throttlebox uses key families. When you rotate a key, a new sibling key is minted in
                the same family while the previous key enters a 24-hour sunset grace period. Your
                production or CI services can swap tokens smoothly without downtime.
              </p>
            </div>

            <div className="faq-card">
              <h3 className="faq-q">Can Throttlebox be self-hosted in air-gapped VPCs?</h3>
              <p className="faq-a">
                Yes. Throttlebox is packaged as clean Docker images with standard PostgreSQL
                (TimescaleDB) and Redis 7 dependencies. The entire stack boots with{' '}
                <code>docker compose up</code> in local environments or air-gapped Kubernetes
                clusters.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          Section 10: Final CTA Banner & Developer Footer
          ==================================================================== */}
      <section className="landing-section" style={{ paddingBottom: '40px' }}>
        <div className="landing-container">
          <div className="cta-banner">
            <h2>Ready to Test Real Rate Limits?</h2>
            <p>
              Create your free workspace in 30 seconds. No credit card required. Mint an API key and
              start calling mock endpoints right away.
            </p>
            <div className="hero-cta-row" style={{ marginBottom: 0 }}>
              <Link href="/login" className="cta-button">
                <span>Create Free Workspace</span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </Link>
              <Link href="/docs" className="secondary-button">
                <span>Read Interactive OpenAPI Docs</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* 4-Column Developer Footer */}
      <footer className="site-footer">
        <div className="landing-container">
          <div className="footer-grid">
            <div className="footer-brand">
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5b8cff"
                  strokeWidth="2.2"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                <h3 style={{ margin: 0 }}>Throttlebox</h3>
              </div>
              <p>
                The developer-first mock API platform with atomic sliding-window rate limiting,
                cryptographic key isolation, and continuous latency analytics.
              </p>
            </div>

            <div className="footer-col">
              <h4>Product</h4>
              <ul>
                <li>
                  <a href="#features">Features</a>
                </li>
                <li>
                  <a href="#architecture">Architecture</a>
                </li>
                <li>
                  <a href="#templates">Template Explorer</a>
                </li>
                <li>
                  <a href="#pricing">Pricing &amp; Quotas</a>
                </li>
                <li>
                  <Link href="/dashboard">Workspace Dashboard</Link>
                </li>
              </ul>
            </div>

            <div className="footer-col">
              <h4>Architecture</h4>
              <ul>
                <li>
                  <a href="#ratelimits">Atomic Redis Lua</a>
                </li>
                <li>
                  <a href="#architecture">TimescaleDB Hypertables</a>
                </li>
                <li>
                  <a href="#architecture">HMAC Key Pepper</a>
                </li>
                <li>
                  <Link href="/docs">OpenAPI 3.1 Specs</Link>
                </li>
                <li>
                  <a href="#faq">Failure Isolation</a>
                </li>
              </ul>
            </div>

            <div className="footer-col">
              <h4>Security &amp; Legal</h4>
              <ul>
                <li>
                  <Link href="/login">Account Sign In</Link>
                </li>
                <li>
                  <a href="#faq">Argon2id Standards</a>
                </li>
                <li>
                  <a href="https://github.com" target="_blank" rel="noopener noreferrer">
                    GitHub Repository
                  </a>
                </li>
                <li>
                  <a href="mailto:security@throttlebox.dev">Security Disclosures</a>
                </li>
                <li>
                  <a href="#pricing">Terms of Service</a>
                </li>
              </ul>
            </div>
          </div>

          <div className="footer-bottom">
            <div>
              &copy; {new Date().getFullYear()} Throttlebox Engine. Built with Node.js 22, Fastify,
              Next.js 15, Redis 7 &amp; TimescaleDB.
            </div>
            <div style={{ display: 'flex', gap: '16px' }}>
              <span style={{ color: 'var(--success)' }}>● All Systems Operational</span>
              <span>v0.4.0</span>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
