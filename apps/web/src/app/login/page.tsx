'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

  // If already signed in, skip the form.
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
      <main>
        <div className="card">Redirecting to your dashboard…</div>
      </main>
    );
  }

  return (
    <main>
      <h1>Throttlebox</h1>
      <p className="lede">{mode === 'login' ? 'Welcome back.' : 'Create your workspace.'}</p>

      <div className="card auth-form">
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'login'}
            onClick={() => {
              setMode('login');
              setError(null);
            }}
          >
            Sign in
          </button>
          <button
            role="tab"
            aria-selected={mode === 'register'}
            onClick={() => {
              setMode('register');
              setError(null);
            }}
          >
            Create account
          </button>
        </div>

        <form className="stack" onSubmit={handleSubmit}>
          {mode === 'register' && (
            <div>
              <label htmlFor="name">Name</label>
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
            <label htmlFor="email">Email</label>
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
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'At least 10 characters' : '••••••••'}
              required
              minLength={mode === 'register' ? 10 : 1}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </div>

          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </main>
  );
}
