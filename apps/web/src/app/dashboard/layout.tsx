'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode } from 'react';
import { ApiError, api } from '@/lib/api';

type DashboardRoute =
  | '/dashboard'
  | '/dashboard/analytics'
  | '/dashboard/keys'
  | '/dashboard/services'
  | '/dashboard/docs'
  | '/dashboard/rate-limits'
  | '/dashboard/chaos'
  | '/dashboard/playground';

interface NavItem {
  label: string;
  href: DashboardRoute;
  icon: ReactNode;
  badge?: string;
  exact?: boolean;
}

interface DashboardLayoutProps {
  children: ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  // Resolve session once for all authenticated subpages
  const {
    data: sessionData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
  });

  // Query org plan for real-time tier badge & quota limits
  const { data: planData } = useQuery({
    queryKey: ['org-plan'],
    queryFn: api.getOrgPlan,
    enabled: Boolean(sessionData?.org?.id),
    retry: false,
  });

  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      queryClient.clear();
      router.push('/login');
    },
  });

  // Loading skeleton on initial entry
  if (isLoading) {
    return (
      <div className="dashboard-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--accent)', marginBottom: '16px' }}>
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="spin"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <div style={{ fontWeight: 600, fontSize: '1.1rem', marginBottom: '6px' }}>
            Connecting to Workspace…
          </div>
          <div style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
            Resolving cryptographic session and tier quotas
          </div>
        </div>
      </div>
    );
  }

  // Not signed in
  if (error instanceof ApiError && error.status === 401) {
    return (
      <div className="auth-page-container">
        <div className="auth-card text-center" style={{ maxWidth: '420px', width: '100%' }}>
          <div style={{ color: 'var(--danger)', marginBottom: '12px' }}>
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 style={{ margin: '0 0 8px' }}>Session Required</h2>
          <p className="muted" style={{ margin: '0 0 24px', fontSize: '0.9rem' }}>
            You must be signed in to access the workspace dashboard.
          </p>
          <Link
            href="/login"
            className="cta-button"
            style={{ justifyContent: 'center', width: '100%' }}
          >
            Sign in to Workspace &rarr;
          </Link>
        </div>
      </div>
    );
  }

  // General connection error
  if (error || !sessionData) {
    return (
      <div className="auth-page-container">
        <div className="auth-card text-center" style={{ maxWidth: '440px', width: '100%' }}>
          <div style={{ color: 'var(--danger)', marginBottom: '12px' }}>
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h2 style={{ margin: '0 0 8px' }}>Workspace Unavailable</h2>
          <p className="muted" style={{ margin: '0 0 20px', fontSize: '0.9rem' }}>
            Could not communicate with the Throttlebox API server. Verify the server is running on
            port 3001.
          </p>
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ['me'] })}
            className="secondary-button"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  const { user, org, role } = sessionData;
  const currentPlan = planData?.plan?.name?.toLowerCase() ?? org?.plan ?? 'free';
  const isPro = currentPlan === 'pro';
  const requestsPerWindow = planData?.plan?.requestsPerWindow ?? (isPro ? 5000 : 100);
  const burstAllowance = planData?.plan?.burstAllowance ?? (isPro ? 1.2 : 1.0);
  const maxCapacity = Math.round(requestsPerWindow * burstAllowance);

  const navItems: NavItem[] = [
    {
      label: 'Overview',
      href: '/dashboard',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      ),
      exact: true,
    },
    {
      label: 'Analytics & Logs',
      href: '/dashboard/analytics',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      ),
      badge: 'Timescale',
    },
    {
      label: 'API Keys',
      href: '/dashboard/keys',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 2l-2 2m-1-1l-3 3m2 2l-2 2m-7 1a5 5 0 1 1-7-7 5 5 0 0 1 7 7zm0 0l7 7-2 2" />
        </svg>
      ),
      badge: 'HMAC',
    },
    {
      label: 'Mock APIs',
      href: '/dashboard/services',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      ),
    },
    {
      label: 'API Docs & Explorer',
      href: '/dashboard/docs',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      ),
      badge: 'OpenAPI 3.1',
    },
    {
      label: 'Rate Limits & Tiers',
      href: '/dashboard/rate-limits',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      ),
      badge: isPro ? '6k Burst' : '100/hr',
    },
    {
      label: 'Chaos Studio',
      href: '/dashboard/chaos',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      ),
      badge: 'Chaos Engine',
    },
    {
      label: 'Time-Travel Playground',
      href: '/dashboard/playground',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 15 14" />
        </svg>
      ),
      badge: 'Replay & Diff',
    },
  ];

  // Helper for active breadcrumbs
  const currentNav = navItems.find((item) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href),
  );

  return (
    <div className="dashboard-shell">
      {/* ==================================================================
          Persistent Left Navigation Sidebar
          ================================================================== */}
      <aside className="dashboard-sidebar" aria-label="Dashboard Sidebar">
        <div className="dashboard-sidebar-header">
          <Link href="/dashboard" className="sidebar-brand">
            <svg
              width="22"
              height="22"
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
          </Link>

          {/* Organization & Tier Pill */}
          <div className="sidebar-org-pill">
            <div className="sidebar-org-info">
              <span className="sidebar-org-name" title={org?.name ?? 'Workspace'}>
                {org?.name ?? 'Personal Workspace'}
              </span>
              <span className="sidebar-org-sub">
                ID: {org?.id ? org.id.slice(0, 8) + '…' : '—'}
              </span>
            </div>
            <Link
              href="/dashboard/rate-limits"
              className={`tier-pill ${isPro ? 'pro' : 'free'}`}
              style={{ textDecoration: 'none' }}
              title="Click to manage tier"
            >
              {isPro ? '⚡ PRO' : 'FREE'}
            </Link>
          </div>
        </div>

        {/* Main Navigation Links */}
        <nav className="dashboard-nav-group">
          <div className="dashboard-nav-label">Platform Tools</div>
          {navItems.map((item) => {
            const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`dashboard-nav-item ${isActive ? 'active' : ''}`}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge && <span className="dashboard-nav-badge">{item.badge}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Quota Mini Progress Box */}
        <div className="sidebar-quota-box">
          <div className="sidebar-quota-title">
            <span style={{ color: 'var(--muted)' }}>Window Capacity</span>
            <span style={{ color: isPro ? 'var(--success)' : 'var(--accent)' }}>
              {requestsPerWindow.toLocaleString()} req/hr
            </span>
          </div>
          <div className="sidebar-quota-bar">
            <div
              className="sidebar-quota-fill"
              style={{
                width: isPro ? '85%' : '35%',
                background: isPro
                  ? 'linear-gradient(90deg, #5b8cff 0%, #3ecf8e 100%)'
                  : 'var(--accent)',
              }}
            />
          </div>
          <div className="sidebar-quota-sub">
            <span>Burst: {maxCapacity.toLocaleString()}</span>
            <Link
              href="/dashboard/rate-limits"
              style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
            >
              {isPro ? 'Manage' : 'Upgrade &rarr;'}
            </Link>
          </div>
        </div>

        {/* User Identity & Logout Footer */}
        <div className="dashboard-sidebar-footer">
          <div className="user-profile-row">
            <div className="user-avatar" title={user.email}>
              {user.name ? user.name.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase()}
            </div>
            <div className="user-details">
              <span className="user-name" title={user.name || user.email}>
                {user.name || user.email.split('@')[0]}
              </span>
              <span className="user-role-tag">
                {role ?? 'member'} • {user.email}
              </span>
            </div>
            <button
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              className="signout-btn"
              title="Sign Out"
              aria-label="Sign Out"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ==================================================================
          Main Content Viewport with Sticky Topbar
          ================================================================== */}
      <div className="dashboard-body">
        <header className="dashboard-topbar">
          <div className="topbar-breadcrumbs">
            <Link href="/dashboard">Workspace</Link>
            <span>/</span>
            <span className="current">{currentNav?.label ?? 'Dashboard'}</span>
          </div>

          <div className="topbar-actions">
            <div className="status-indicator">
              <div className="status-dot" />
              <span>Redis &amp; Fastify Online</span>
            </div>
            <Link
              href="/dashboard/docs"
              className="secondary-button"
              style={{ padding: '6px 12px', fontSize: '0.8125rem' }}
            >
              API Reference
            </Link>
          </div>
        </header>

        <main className="dashboard-main">{children}</main>
      </div>
    </div>
  );
}
