'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
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
        return api.register({ email, password, name });
      }
      return api.login({ email, password });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      router.push('/dashboard');
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  }

  if (session) {
    return (
      <main className="auth-page-container">
        <div className="card text-center" style={{ maxWidth: '400px', width: '100%' }}>
          <div style={{ color: 'var(--accent)', marginBottom: '12px' }}>
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 style={{ margin: '0 0 8px' }}>Already Authenticated</h2>
          <p className="muted" style={{ margin: '0 0 20px' }}>
            Redirecting to your workspace dashboard…
          </p>
          <Link href="/dashboard" className="cta-button" style={{ justifyContent: 'center' }}>
            Go to Dashboard &rarr;
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page-container">
      <div className="auth-ambient-glow" aria-hidden="true" />

      <div className="auth-card-outer">
        {/* Brand Header */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '10px',
              textDecoration: 'none',
              marginBottom: '10px',
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#5b8cff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text)' }}>
              Throttlebox
            </span>
          </Link>
          <div style={{ fontSize: '0.875rem', color: 'var(--muted)' }}>
            Developer Mock Platform • Sliding-Window Rate Limiting
          </div>
        </div>

        {/* Auth Form Card */}
        <div className="auth-card">
          {/* Segmented Control Tabs */}
          <div className="auth-tabs-segmented" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`auth-tab-segment ${mode === 'login' ? 'active' : ''}`}
              onClick={() => {
                setMode('login');
                setError(null);
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`auth-tab-segment ${mode === 'register' ? 'active' : ''}`}
              onClick={() => {
                setMode('register');
                setError(null);
              }}
            >
              Create Account
            </button>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 6px' }}>
              {mode === 'login' ? 'Welcome Back' : 'Create Your Workspace'}
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'var(--muted)', margin: 0 }}>
              {mode === 'login'
                ? 'Sign in to manage API keys, test rate limits, and inspect telemetry.'
                : 'Get started in seconds with a pre-seeded E-Commerce mock service.'}
            </p>
          </div>

          <form className="stack" onSubmit={handleSubmit}>
            {mode === 'register' && (
              <div>
                <label htmlFor="name">Full Name</label>
                <input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  required
                  autoComplete="name"
                />
              </div>
            )}

            <div>
              <label htmlFor="email">Work Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
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
                <label htmlFor="password" style={{ margin: 0 }}>
                  Password
                </label>
                {mode === 'register' && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                    Min. 10 characters
                  </span>
                )}
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? 'At least 10 characters' : '••••••••••••'}
                required
                minLength={mode === 'register' ? 10 : 1}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              />
            </div>

            {error && (
              <div className="error" role="alert" style={{ fontSize: '0.875rem' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              className="cta-button"
              disabled={mutation.isPending}
              style={{
                width: '100%',
                justifyContent: 'center',
                padding: '12px',
                marginTop: '8px',
                cursor: mutation.isPending ? 'not-allowed' : 'pointer',
                opacity: mutation.isPending ? 0.7 : 1,
              }}
            >
              {mutation.isPending
                ? mode === 'login'
                  ? 'Verifying Credentials…'
                  : 'Provisioning Workspace…'
                : mode === 'login'
                  ? 'Sign In to Workspace'
                  : 'Create Free Account'}
            </button>
          </form>

          {/* Onboarding Notice for Register */}
          {mode === 'register' && (
            <div
              style={{
                marginTop: '16px',
                padding: '10px 12px',
                background: 'rgba(62, 207, 142, 0.06)',
                border: '1px solid rgba(62, 207, 142, 0.2)',
                borderRadius: '6px',
                fontSize: '0.775rem',
                color: 'var(--muted)',
                lineHeight: 1.5,
              }}
            >
              <span style={{ color: 'var(--success)', fontWeight: 600 }}>⚡ Instant Setup: </span>
              Your account includes an isolated organization, seeded mock endpoints, and an initial
              100 req/hr rate limit sandbox.
            </div>
          )}

          {/* Trust & Security Badge Box */}
          <div className="auth-trust-box">
            <div>
              <strong>Security Architecture:</strong>
            </div>
            <div style={{ marginTop: '4px' }}>
              • Argon2id password hashing with memory-hard parameters
              <br />
              • Encrypted HTTP-only cookies with SameSite protection
              <br />• Double-submit CSRF verification on mutations
            </div>
          </div>
        </div>

        {/* Back Link */}
        <div style={{ textAlign: 'center', marginTop: '24px' }}>
          <Link
            href="/"
            style={{
              color: 'var(--muted)',
              fontSize: '0.875rem',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            &larr; Back to Throttlebox Overview
          </Link>
        </div>
      </div>
    </main>
  );
}
