'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/api';

export default function DashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
  });

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      queryClient.clear();
      router.push('/login');
    },
  });

  if (isLoading) {
    return (
      <main>
        <div className="card">Loading your workspace…</div>
      </main>
    );
  }

  if (error instanceof ApiError && error.status === 401) {
    return (
      <main>
        <div className="card stack">
          <p style={{ margin: 0 }}>You&apos;re not signed in.</p>
          <div>
            <button onClick={() => router.push('/login')}>Go to sign in</button>
          </div>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main>
        <div className="error">Could not load your workspace. Is the API running?</div>
      </main>
    );
  }

  const { user, org, role } = data;

  return (
    <main>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{org?.name ?? 'Your workspace'}</h1>
          <p className="muted" style={{ margin: 0 }}>
            Signed in as {user.email}
          </p>
        </div>
        <button className="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </button>
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted">Plan</span>
          <code>{org?.plan ?? 'free'}</code>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted">Your role</span>
          <code>{role ?? '—'}</code>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted">Organization ID</span>
          <code>{org?.id ?? '—'}</code>
        </div>
      </div>

      <h2>Coming next</h2>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          API key management, the mock engine, rate limiting, and analytics land in the phases that
          follow.
        </p>
      </div>
    </main>
  );
}
