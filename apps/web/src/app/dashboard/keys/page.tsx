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

  const [filterEnv, setFilterEnv] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

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

  function dismissReveal() {
    setRevealed(null);
    createMutation.reset();
    rotateMutation.reset();
  }

  function message(err: unknown): string {
    return err instanceof ApiError ? err.message : 'Something went wrong';
  }

  const allKeys = data?.keys ?? [];
  const filteredKeys = allKeys.filter((key) => {
    const matchesEnv = filterEnv === 'all' || key.env === filterEnv;
    const matchesSearch =
      searchQuery.trim() === '' ||
      key.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      key.display.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesEnv && matchesSearch;
  });

  return (
    <div>
      {/* Header Row */}
      <div className="dashboard-header-row">
        <div>
          <h1 className="dashboard-title">API Key Management</h1>
          <p className="dashboard-subtitle">
            Cryptographically peppered keys authenticating calls to your mock endpoints. Secrets are
            shown once upon creation.
          </p>
        </div>

        <button
          onClick={() => setCreating(true)}
          className="cta-button"
          style={{ fontSize: '0.875rem' }}
        >
          + Mint API Key
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '20px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {['all', 'test', 'live', 'dev'].map((env) => (
            <button
              key={env}
              onClick={() => setFilterEnv(env)}
              className="secondary-button"
              style={{
                padding: '4px 12px',
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                background: filterEnv === env ? 'var(--accent-dim)' : 'var(--surface)',
                color: filterEnv === env ? 'var(--accent)' : 'var(--muted)',
                borderColor: filterEnv === env ? 'var(--accent)' : 'var(--border)',
                fontWeight: filterEnv === env ? 700 : 500,
              }}
            >
              {env}
            </button>
          ))}
        </div>

        <div style={{ width: '280px' }}>
          <input
            placeholder="Search keys by name or prefix…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ padding: '6px 12px', fontSize: '0.8125rem' }}
          />
        </div>
      </div>

      {/* Error alert */}
      {error && (
        <div className="error" role="alert" style={{ marginBottom: '20px' }}>
          {message(error)}
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="card text-center" style={{ padding: '40px' }}>
          <div className="muted">Loading workspace API keys…</div>
        </div>
      )}

      {/* Keys Table */}
      {!isLoading && filteredKeys.length === 0 ? (
        <div className="card text-center" style={{ padding: '48px 24px' }}>
          <div style={{ color: 'var(--muted)', marginBottom: '12px' }}>
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 2l-2 2m-1-1l-3 3m2 2l-2 2m-7 1a5 5 0 1 1-7-7 5 5 0 0 1 7 7zm0 0l7 7-2 2" />
            </svg>
          </div>
          <h3 style={{ margin: '0 0 8px' }}>
            {allKeys.length === 0 ? 'No API Keys Minted' : 'No Keys Match Your Filter'}
          </h3>
          <p className="muted" style={{ margin: '0 0 20px', fontSize: '0.875rem' }}>
            {allKeys.length === 0
              ? 'Mint an API key to authenticate requests against your sliding-window mock APIs.'
              : 'Try clearing your search query or environment filter.'}
          </p>
          {allKeys.length === 0 && (
            <button
              onClick={() => setCreating(true)}
              className="cta-button"
              style={{ display: 'inline-flex' }}
            >
              + Mint First API Key
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="keys-table">
            <thead>
              <tr>
                <th>Key Name</th>
                <th>Public Identifier</th>
                <th>Env</th>
                <th>Granted Scopes</th>
                <th>Status</th>
                <th>Last Active</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredKeys.map((key) => {
                const isRotating = key.graceUntil && key.status === 'active';
                return (
                  <tr key={key.id}>
                    <td>
                      <strong>{key.name}</strong>
                    </td>
                    <td>
                      <code>{key.display}</code>
                    </td>
                    <td>
                      <span className={`badge ${key.env}`}>{key.env}</span>
                    </td>
                    <td>
                      <span className="muted" style={{ fontSize: '0.8125rem' }}>
                        {key.scopes.join(', ')}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${isRotating ? 'method-put' : key.status}`}>
                        {isRotating ? 'rotating (24h grace)' : key.status}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: '0.8125rem' }}>
                      {formatDate(key.lastUsedAt)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: '8px' }}>
                        <button
                          className="secondary-button"
                          style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                          onClick={() => setRotating(key)}
                          disabled={key.status === 'revoked'}
                        >
                          Rotate
                        </button>
                        <button
                          className="secondary-button"
                          style={{
                            padding: '4px 10px',
                            fontSize: '0.75rem',
                            color: 'var(--danger)',
                            borderColor: 'rgba(255, 107, 107, 0.4)',
                          }}
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* One-time reveal modal */}
      {revealed && <KeyReveal result={revealed} onDismiss={dismissReveal} />}

      {/* Create key dialog */}
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

      {/* Rotate key modal */}
      {rotating && (
        <Modal title="Rotate API Key" onClose={() => setRotating(null)}>
          <div className="stack">
            <p className="muted" style={{ margin: 0, fontSize: '0.9rem' }}>
              A new cryptographically secure successor key will be minted for{' '}
              <strong style={{ color: 'var(--text)' }}>{rotating.name}</strong>. The current key
              will remain valid for a 24-hour grace window to ensure zero-downtime key rotation
              across your deployments.
            </p>
            {rotateMutation.error && <div className="error">{message(rotateMutation.error)}</div>}
            <div
              className="row"
              style={{ justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}
            >
              <button className="secondary-button" onClick={() => setRotating(null)}>
                Cancel
              </button>
              <button
                className="cta-button"
                onClick={() => rotateMutation.mutate({ id: rotating.id })}
                disabled={rotateMutation.isPending}
              >
                {rotateMutation.isPending ? 'Rotating Key…' : 'Confirm Rotation'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Revoke key modal */}
      {revoking && (
        <Modal title="Revoke API Key" onClose={() => setRevoking(null)}>
          <div className="stack">
            <div className="warning">
              Revoking <strong style={{ color: 'var(--text)' }}>{revoking.name}</strong> is
              permanent and takes effect immediately across all cluster pods. Incoming requests will
              instantly receive a 401 Unauthorized status.
            </div>
            <div>
              <label htmlFor="confirm-key-name">
                Type <code>{revoking.name}</code> to confirm revocation:
              </label>
              <input
                id="confirm-key-name"
                value={revokeConfirmation}
                onChange={(event) => setRevokeConfirmation(event.target.value)}
                autoComplete="off"
                placeholder={revoking.name}
              />
            </div>
            {revokeMutation.error && <div className="error">{message(revokeMutation.error)}</div>}
            <div
              className="row"
              style={{ justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}
            >
              <button className="secondary-button" onClick={() => setRevoking(null)}>
                Cancel
              </button>
              <button
                style={{
                  background: 'var(--danger)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '7px',
                  padding: '8px 16px',
                  fontWeight: 600,
                  cursor:
                    revokeConfirmation !== revoking.name || revokeMutation.isPending
                      ? 'not-allowed'
                      : 'pointer',
                  opacity:
                    revokeConfirmation !== revoking.name || revokeMutation.isPending ? 0.6 : 1,
                }}
                onClick={() => revokeMutation.mutate({ id: revoking.id })}
                disabled={revokeConfirmation !== revoking.name || revokeMutation.isPending}
              >
                {revokeMutation.isPending ? 'Revoking Key…' : 'Permanently Revoke Key'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
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
      scopes: scopes.length > 0 ? scopes : ['mock:read'],
      expiresInDays: expiry && Number.isFinite(expiresInDays) ? expiresInDays : null,
    });
  }

  return (
    <Modal title="Mint New API Key" onClose={onCancel}>
      <form className="stack" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="key-name">Key Name</label>
          <input
            id="key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. ci-pipeline-key"
            required
            maxLength={80}
            autoFocus
          />
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.75rem' }}>
            A descriptive label identifying where this key is deployed.
          </p>
        </div>

        <div>
          <label htmlFor="key-env">Target Environment</label>
          <select
            id="key-env"
            value={env}
            onChange={(event) => setEnv(event.target.value as KeyEnv)}
          >
            {KEY_ENVS.map((option) => (
              <option key={option} value={option}>
                {option.toUpperCase()} ({option})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label>Authorized Scopes</label>
          <div className="scope-list">
            {KEY_SCOPES.map((scope) => (
              <label key={scope} className="scope-option">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span>
                  {SCOPE_LABELS[scope]} <code style={{ fontSize: '0.75rem' }}>{scope}</code>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="key-expiry">Expiration Window (days, optional)</label>
          <input
            id="key-expiry"
            type="number"
            min={1}
            max={365}
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            placeholder="Never expires"
          />
        </div>

        {error && <div className="error">{error}</div>}

        <div className="row" style={{ justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="cta-button" disabled={pending}>
            {pending ? 'Minting Key…' : 'Mint Key'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
