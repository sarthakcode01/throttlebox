'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  KEY_ENVS,
  KEY_SCOPES,
  type ApiKeyCreatedResponse,
  type ApiKeySummary,
  type KeyEnv,
  type KeyScope,
} from '@throttlebox/shared';
import { ApiError, api } from '@/lib/api';
import Modal from '@/components/Modal';
import KeyReveal from '@/components/KeyReveal';

const SCOPE_LABELS: Record<KeyScope, string> = {
  'mock:read': 'Read mocks',
  'mock:write': 'Write mocks',
  'chaos:write': 'Change chaos settings',
  'keys:read': 'Read keys',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export default function KeysPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['keys'],
    queryFn: api.listKeys,
    retry: false,
  });

  // The raw key lives here and nowhere else. It is never written to
  // localStorage or sessionStorage, and it is cleared when the dialog closes.
  const [revealed, setRevealed] = useState<ApiKeyCreatedResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<ApiKeySummary | null>(null);
  const [revoking, setRevoking] = useState<ApiKeySummary | null>(null);
  const [revokeConfirmation, setRevokeConfirmation] = useState('');

  const createMutation = useMutation({
    mutationFn: api.createKey,
    onSuccess: async (result) => {
      setCreating(false);
      setRevealed(result);
      await queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => api.rotateKey(id),
    onSuccess: async (result) => {
      setRotating(null);
      setRevealed(result);
      await queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => api.revokeKey(id),
    onSuccess: async () => {
      setRevoking(null);
      setRevokeConfirmation('');
      await queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
  });

  /**
   * Dismiss the one-time reveal.
   *
   * Resetting the mutation matters: React Query keeps the last successful
   * result in its cache, and that result contains the raw key. Without the
   * reset the secret would sit in memory for the rest of the page's life,
   * which contradicts the promise that it is shown exactly once.
   */
  function dismissReveal() {
    setRevealed(null);
    createMutation.reset();
    rotateMutation.reset();
  }

  function message(err: unknown): string {
    return err instanceof ApiError ? err.message : 'Something went wrong';
  }

  if (isLoading) {
    return (
      <main>
        <div className="card">Loading your API keys…</div>
      </main>
    );
  }

  if (error) {
    return (
      <main>
        <div className="error">{message(error)}</div>
      </main>
    );
  }

  const keys = data?.keys ?? [];

  return (
    <main>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>API keys</h1>
          <p className="muted" style={{ margin: 0 }}>
            Keys authenticate calls to your mock APIs. The secret is shown once and never stored.
          </p>
        </div>
        <button onClick={() => setCreating(true)}>Create key</button>
      </div>

      {keys.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No API keys yet. Create one to start calling your mock endpoints.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="keys-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Env</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td>
                    <code>{key.display}</code>
                  </td>
                  <td>
                    <span className={`badge ${key.env}`}>{key.env}</span>
                  </td>
                  <td>
                    <span className="muted">{key.scopes.join(', ')}</span>
                  </td>
                  <td>
                    <span className={`badge ${key.status}`}>
                      {key.graceUntil && key.status === 'active' ? 'rotating' : key.status}
                    </span>
                  </td>
                  <td className="muted">{formatDate(key.lastUsedAt)}</td>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                      <button
                        className="secondary small"
                        onClick={() => setRotating(key)}
                        disabled={key.status === 'revoked'}
                      >
                        Rotate
                      </button>
                      <button
                        className="secondary small danger"
                        onClick={() => {
                          setRevoking(key);
                          setRevokeConfirmation('');
                        }}
                        disabled={key.status === 'revoked'}
                      >
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revealed && <KeyReveal result={revealed} onDismiss={dismissReveal} />}

      {creating && (
        <CreateKeyDialog
          pending={createMutation.isPending}
          error={createMutation.error ? message(createMutation.error) : null}
          onCancel={() => {
            setCreating(false);
            createMutation.reset();
          }}
          onSubmit={(body) => createMutation.mutate(body)}
        />
      )}

      {rotating && (
        <Modal title="Rotate key" onClose={() => setRotating(null)}>
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>
              A new key will be issued for <strong>{rotating.name}</strong>. The current key keeps
              working for 24 hours so you can swap it over without downtime, then it stops working
              on its own.
            </p>
            {rotateMutation.error && <div className="error">{message(rotateMutation.error)}</div>}
            <div className="row">
              <button
                onClick={() => rotateMutation.mutate({ id: rotating.id })}
                disabled={rotateMutation.isPending}
              >
                {rotateMutation.isPending ? 'Rotating…' : 'Rotate key'}
              </button>
              <button className="secondary" onClick={() => setRotating(null)}>
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {revoking && (
        <Modal title="Revoke key" onClose={() => setRevoking(null)}>
          <div className="stack">
            <div className="warning">
              Revoking <strong>{revoking.name}</strong> takes effect immediately. Any request using
              it will start failing with a 401.
            </div>
            <div>
              <label htmlFor="confirm">
                Type <code>{revoking.name}</code> to confirm
              </label>
              <input
                id="confirm"
                value={revokeConfirmation}
                onChange={(event) => setRevokeConfirmation(event.target.value)}
                autoComplete="off"
              />
            </div>
            {revokeMutation.error && <div className="error">{message(revokeMutation.error)}</div>}
            <div className="row">
              <button
                className="danger-button"
                onClick={() => revokeMutation.mutate({ id: revoking.id })}
                disabled={revokeConfirmation !== revoking.name || revokeMutation.isPending}
              >
                {revokeMutation.isPending ? 'Revoking…' : 'Revoke key'}
              </button>
              <button className="secondary" onClick={() => setRevoking(null)}>
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}

interface CreateKeyDialogProps {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: {
    name: string;
    env: KeyEnv;
    scopes: KeyScope[];
    expiresInDays: number | null;
  }) => void;
}

function CreateKeyDialog({ pending, error, onCancel, onSubmit }: CreateKeyDialogProps) {
  const [name, setName] = useState('');
  const [env, setEnv] = useState<KeyEnv>('test');
  const [scopes, setScopes] = useState<KeyScope[]>(['mock:read']);
  const [expiry, setExpiry] = useState('');

  function toggleScope(scope: KeyScope) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const expiresInDays = expiry ? Number.parseInt(expiry, 10) : null;

    onSubmit({
      name: name.trim(),
      env,
      // An empty selection would be rejected by the server, so keep at least
      // the read scope.
      scopes: scopes.length > 0 ? scopes : ['mock:read'],
      expiresInDays: expiry && Number.isFinite(expiresInDays) ? expiresInDays : null,
    });
  }

  return (
    <Modal title="Create an API key" onClose={onCancel}>
      <form className="stack" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="key-name">Name</label>
          <input
            id="key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="staging-backend"
            required
            maxLength={80}
            autoFocus
          />
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Something that tells you where this key is used.
          </p>
        </div>

        <div>
          <label htmlFor="key-env">Environment</label>
          <select
            id="key-env"
            value={env}
            onChange={(event) => setEnv(event.target.value as KeyEnv)}
          >
            {KEY_ENVS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label>Scopes</label>
          <div className="scope-list">
            {KEY_SCOPES.map((scope) => (
              <label key={scope} className="scope-option">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span>
                  {SCOPE_LABELS[scope]} <code>{scope}</code>
                </span>
              </label>
            ))}
          </div>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Scopes can only be widened. To narrow them later, rotate the key.
          </p>
        </div>

        <div>
          <label htmlFor="key-expiry">Expires in (days, optional)</label>
          <input
            id="key-expiry"
            type="number"
            min={1}
            max={365}
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            placeholder="Never"
          />
        </div>

        {error && <div className="error">{error}</div>}

        <div className="row">
          <button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create key'}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
