'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If already signed in, redirect to dashboard.
  const { data: session } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === 'register') {
        return api.register({ email: email.trim(), password, name: name.trim() });
      }
      return api.login({ email: email.trim(), password });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      router.push('/dashboard');
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
  });

  // The "already signed in" screen promises a redirect; do it.
  useEffect(() => {
    if (session) router.replace('/dashboard');
  }, [session, router]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  }

  if (session) {
    return (
      <main
        className="auth-split-layout"
        style={{
          width: '100%',
          maxWidth: '100vw',
          margin: 0,
          padding: 0,
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          className="auth-form-card text-center"
          style={{ maxWidth: '440px', width: '100%', margin: 'auto' }}
        >
          <div
            style={{
              color: 'var(--accent)',
              marginBottom: '16px',
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <div className="auth-logo-icon" style={{ width: '48px', height: '48px' }}>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#5b8cff"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700, margin: '0 0 8px' }}>
            Already Authenticated
          </h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', margin: '0 0 24px' }}>
            Your active session is recognized. Redirecting to workspace dashboard…
          </p>
          <Link href="/dashboard" className="auth-submit-btn" style={{ textDecoration: 'none' }}>
            <span>Go to Dashboard</span>
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
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main
      className="auth-split-layout"
      style={{
        width: '100%',
        maxWidth: '100vw',
        margin: 0,
        padding: 0,
        minHeight: '100vh',
      }}
    >
      {/* Background ambient lighting */}
      <div className="auth-bg-blob-1" aria-hidden="true" />
      <div className="auth-bg-blob-2" aria-hidden="true" />

      {/* ====================================================================
          LEFT SECTION: Image / Visual Tech Showcase & Platform Narrative
          ==================================================================== */}
      <section className="auth-split-left">
        <div className="auth-split-left-inner">
          {/* Brand Header & Live System Status */}
          <div className="auth-brand-row">
            <Link href="/" className="auth-brand-logo" aria-label="Throttlebox Home">
              <div className="auth-logo-icon">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5b8cff"
                  strokeWidth="2.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
              <span className="auth-brand-title">Throttlebox</span>
            </Link>

            <div className="auth-status-pill">
              <span className="auth-status-dot" aria-hidden="true" />
              <span>API Gateway • 99.99% Operational</span>
            </div>
          </div>

          {/* Hero Copy */}
          <div className="auth-hero-content">
            <div className="auth-hero-badge">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>Sliding-Window Rate Limiting Engine</span>
            </div>

            <h1 className="auth-hero-title">
              Architect Resilient APIs with <span className="text-gradient">Real-Time Mocking</span>
            </h1>

            <p className="auth-hero-desc">
              Simulate sliding-window rate limits, 429 Retry-After cascades, and upstream outages
              before hitting production.
            </p>

            {/* Visual Showcase Card / Technical Mockup (Image + Live Metrics) */}
            <div className="auth-showcase-card">
              <div className="auth-showcase-header">
                <div className="auth-showcase-dots" aria-hidden="true">
                  <span className="auth-dot red" />
                  <span className="auth-dot yellow" />
                  <span className="auth-dot green" />
                </div>
                <div className="auth-showcase-endpoint">
                  <span>GET</span>
                  <span>api.throttlebox.dev/v1/mock/orders</span>
                </div>
                <div className="auth-showcase-status">200 OK • 12ms</div>
              </div>

              <div className="auth-showcase-body">
                {/* Dynamic Sliding Window Gauge */}
                <div className="auth-window-viz">
                  <div className="auth-window-meta">
                    <span>SLIDING WINDOW CAPACITY</span>
                    <strong>78 / 100 req (78%)</strong>
                  </div>
                  <div className="auth-window-track">
                    <div className="auth-window-fill" />
                  </div>
                </div>

                {/* Response Headers Inspector */}
                <div className="auth-headers-preview">
                  <div className="auth-header-pill">
                    <span className="auth-header-key">X-RateLimit-Limit</span>
                    <span className="auth-header-val">100</span>
                  </div>
                  <div className="auth-header-pill">
                    <span className="auth-header-key">X-RateLimit-Remaining</span>
                    <span className="auth-header-val">22</span>
                  </div>
                  <div className="auth-header-pill">
                    <span className="auth-header-key">X-RateLimit-Reset</span>
                    <span className="auth-header-val">14s</span>
                  </div>
                  <div className="auth-header-pill">
                    <span className="auth-header-key">Retry-After</span>
                    <span className="auth-header-val">0s</span>
                  </div>
                </div>

                {/* Feature Chips */}
                <div className="auth-features-row">
                  <div className="auth-feature-chip">
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#5b8cff"
                      strokeWidth="2.2"
                    >
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    <span>Redis 7 Lua</span>
                  </div>
                  <div className="auth-feature-chip">
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#3ecf8e"
                      strokeWidth="2.2"
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    <span>Argon2id Hash</span>
                  </div>
                  <div className="auth-feature-chip">
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#ffb347"
                      strokeWidth="2.2"
                    >
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                    <span>Live Telemetry</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Social Proof / Engineering Testimonial */}
          <div className="auth-proof-card">
            <div className="auth-proof-avatar" aria-hidden="true">
              TB
            </div>
            <div>
              <p className="auth-proof-quote">
                &ldquo;Throttlebox caught our rate limit cascading loop before our Black Friday
                deployment. An indispensable developer tool.&rdquo;
              </p>
              <div className="auth-proof-author">
                Staff Infrastructure Engineer • Scaled Microservices
              </div>
            </div>
          </div>
        </div>

        {/* Tilted Divider Accent along the slanted boundary */}
        <div className="auth-tilt-divider" aria-hidden="true">
          <svg viewBox="0 0 60 1000" preserveAspectRatio="none">
            <defs>
              <linearGradient id="tiltedLaserGradient" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#5b8cff" stopOpacity="0.85" />
                <stop offset="35%" stopColor="#7ea9ff" stopOpacity="0.45" />
                <stop offset="70%" stopColor="#3ecf8e" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#5b8cff" stopOpacity="0.1" />
              </linearGradient>
            </defs>
            <line
              x1="58"
              y1="0"
              x2="2"
              y2="1000"
              stroke="url(#tiltedLaserGradient)"
              strokeWidth="2.5"
            />
          </svg>
        </div>
      </section>

      {/* ====================================================================
          RIGHT SECTION: Auth Form with High-End Hover Effects
          ==================================================================== */}
      <section className="auth-split-right">
        <div className="auth-form-container">
          <div className="auth-form-card">
            {/* Segmented Mode Switcher Tabs */}
            <div className="auth-tabs-modern" role="tablist" aria-label="Authentication Mode">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'login'}
                className={`auth-tab-btn ${mode === 'login' ? 'active' : ''}`}
                onClick={() => {
                  setMode('login');
                  setError(null);
                }}
              >
                {mode === 'login' && <span className="auth-tab-indicator-dot" aria-hidden="true" />}
                Sign In
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'register'}
                className={`auth-tab-btn ${mode === 'register' ? 'active' : ''}`}
                onClick={() => {
                  setMode('register');
                  setError(null);
                }}
              >
                {mode === 'register' && (
                  <span className="auth-tab-indicator-dot" aria-hidden="true" />
                )}
                Create Account
              </button>
            </div>

            {/* Form Title & Subtitle */}
            <div style={{ marginBottom: '22px' }}>
              <h2
                style={{
                  fontSize: '1.35rem',
                  fontWeight: 700,
                  margin: '0 0 6px',
                  color: '#ffffff',
                }}
              >
                {mode === 'login' ? 'Welcome Back' : 'Create Your Workspace'}
              </h2>
              <p
                style={{ fontSize: '0.875rem', color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}
              >
                {mode === 'login'
                  ? 'Sign in to manage API keys, test rate limits, and inspect telemetry.'
                  : 'Get started in seconds with a pre-seeded E-Commerce mock service.'}
              </p>
            </div>

            {/* The Authentication Form */}
            <form className="stack" onSubmit={handleSubmit}>
              {mode === 'register' && (
                <div>
                  <label htmlFor="auth-name">Full Name</label>
                  <div className="auth-input-field">
                    <span className="auth-input-icon">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </span>
                    <input
                      id="auth-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ada Lovelace"
                      required
                      autoComplete="name"
                    />
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="auth-email">Work Email</label>
                <div className="auth-input-field">
                  <span className="auth-input-icon">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="20" height="16" x="2" y="4" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                  </span>
                  <input
                    id="auth-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                  />
                </div>
              </div>

              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '6px',
                  }}
                >
                  <label htmlFor="auth-password" style={{ margin: 0 }}>
                    Password
                  </label>
                  {mode === 'register' && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                      Min. 12 characters
                    </span>
                  )}
                </div>
                <div className="auth-input-field">
                  <span className="auth-input-icon">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? 'At least 12 characters' : '••••••••••••'}
                    required
                    minLength={mode === 'register' ? 12 : 1}
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    style={{ paddingRight: '42px' }}
                  />
                  <button
                    type="button"
                    className="auth-pwd-toggle"
                    onClick={() => setShowPassword(!showPassword)}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                    ) : (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <div
                  className="error"
                  role="alert"
                  style={{
                    fontSize: '0.875rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              <button type="submit" className="auth-submit-btn" disabled={mutation.isPending}>
                {mutation.isPending && <span className="auth-spinner" aria-hidden="true" />}
                <span>
                  {mutation.isPending
                    ? mode === 'login'
                      ? 'Verifying Credentials…'
                      : 'Provisioning Workspace…'
                    : mode === 'login'
                      ? 'Sign In to Workspace'
                      : 'Create Free Account'}
                </span>
                {!mutation.isPending && (
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
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                )}
              </button>
            </form>

            {/* Onboarding Notice for Register */}
            {mode === 'register' && (
              <div className="auth-instant-setup">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#3ecf8e"
                  strokeWidth="2"
                  style={{ flexShrink: 0, marginTop: '2px' }}
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                <div>
                  <strong style={{ color: 'var(--success)' }}>Instant Setup: </strong>
                  Isolated organization, pre-seeded mock endpoints, and an initial 100 req/hr rate
                  limit sandbox ready in seconds.
                </div>
              </div>
            )}

            {/* Trust & Security Badge Box with Interactive Hover Glow */}
            <div className="auth-trust-box-modern">
              <div className="auth-trust-title">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5b8cff"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Enterprise Security Architecture</span>
              </div>
              <div className="auth-trust-list">
                <div className="auth-trust-item">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Argon2id password hashing with memory-hard parameters</span>
                </div>
                <div className="auth-trust-item">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>HTTP-only session cookies with SameSite=Lax protection</span>
                </div>
                <div className="auth-trust-item">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Double-submit CSRF verification on mutation routes</span>
                </div>
              </div>
            </div>
          </div>

          {/* Back to Overview Link */}
          <div style={{ textAlign: 'center', marginTop: '24px' }}>
            <Link href="/" className="auth-back-link">
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
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              <span>Back to Throttlebox Overview</span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
