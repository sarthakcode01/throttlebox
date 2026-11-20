'use client';

import { useMemo } from 'react';
import type { ApiKeySummary, MockServiceSummary } from '@throttlebox/shared';
import { fieldStyle, labelStyle, METHODS, monoStyle, prettyBody, type Draft } from './shared';

interface RequestBuilderProps {
  draft: Draft;
  onChange: (draft: Draft) => void;
  keys: ApiKeySummary[];
  services: MockServiceSummary[];
  sending: boolean;
  disabled: boolean;
  onSend: () => void;
  onClear: () => void;
}

export default function RequestBuilder({
  draft,
  onChange,
  keys,
  services,
  sending,
  disabled,
  onSend,
  onClear,
}: RequestBuilderProps) {
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => onChange({ ...draft, [field]: value });

  const bodyError = useMemo(() => {
    if (!draft.body.trim()) return null;
    try {
      JSON.parse(draft.body);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Invalid JSON';
    }
  }, [draft.body]);

  const hasBody = draft.method !== 'GET';
  const pathError = !draft.path.startsWith('/')
    ? 'Path must start with "/"'
    : /[?#\\]/.test(draft.path)
      ? 'Put query parameters in the Query box'
      : null;
  const canSend = !disabled && !sending && draft.keyId && draft.serviceSlug && !pathError;

  return (
    <div className="card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>
          Request
          {draft.parentId && (
            <span className="badge" style={{ marginLeft: '10px', color: 'var(--accent)' }}>
              fork
            </span>
          )}
        </h3>
        <button type="button" className="secondary-button" style={{ padding: '4px 12px', fontSize: '0.75rem' }} onClick={onClear}>
          Clear
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <label>
          <span style={labelStyle}>API key</span>
          <select
            aria-label="API key"
            style={fieldStyle}
            value={draft.keyId}
            onChange={(e) => set('keyId', e.target.value)}
          >
            <option value="">Select a key…</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} · {k.display}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span style={labelStyle}>Mock service</span>
          <select
            aria-label="Mock service"
            style={fieldStyle}
            value={draft.serviceSlug}
            onChange={(e) => set('serviceSlug', e.target.value)}
          >
            <option value="">Select a service…</option>
            {services.map((s) => (
              <option key={s.id} value={s.slug}>
                {s.name} ({s.slug})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '12px' }}>
        <label>
          <span style={labelStyle}>Method</span>
          <select
            aria-label="Method"
            style={fieldStyle}
            value={draft.method}
            onChange={(e) => set('method', e.target.value as Draft['method'])}
          >
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          <span style={labelStyle}>
            Path{' '}
            <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
              — sent to /mock/{draft.serviceSlug || '<service>'}
              {draft.path || '/'}
            </span>
          </span>
          <input
            aria-label="Path"
            style={{ ...fieldStyle, ...monoStyle }}
            value={draft.path}
            onChange={(e) => set('path', e.target.value)}
            placeholder="/products/42"
          />
        </label>
      </div>
      {pathError && <div style={{ color: '#f59e0b', fontSize: '0.75rem' }}>{pathError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <label>
          <span style={labelStyle}>Query (key=value per line)</span>
          <textarea
            aria-label="Query"
            rows={3}
            style={{ ...fieldStyle, ...monoStyle, resize: 'vertical' }}
            value={draft.query}
            onChange={(e) => set('query', e.target.value)}
            placeholder={'page=2\nsort=price'}
          />
        </label>
        <label>
          <span style={labelStyle}>Headers (Name: value per line)</span>
          <textarea
            aria-label="Headers"
            rows={3}
            style={{ ...fieldStyle, ...monoStyle, resize: 'vertical' }}
            value={draft.headers}
            onChange={(e) => set('headers', e.target.value)}
            placeholder={'X-Trace-Id: abc123'}
          />
        </label>
      </div>
      <div style={{ fontSize: '0.6875rem', color: 'var(--muted)' }}>
        Authorization is added for you from the selected key. Credentials you type here are never stored.
      </div>

      {hasBody && (
        <label>
          <span style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
            <span>Body (JSON)</span>
            <button
              type="button"
              className="secondary-button"
              style={{ padding: '0 8px', fontSize: '0.6875rem' }}
              disabled={!!bodyError || !draft.body.trim()}
              onClick={() => set('body', prettyBody(draft.body))}
            >
              Format
            </button>
          </span>
          <textarea
            aria-label="Body"
            rows={6}
            style={{ ...fieldStyle, ...monoStyle, resize: 'vertical', borderColor: bodyError ? '#ef4444' : undefined }}
            value={draft.body}
            onChange={(e) => set('body', e.target.value)}
            placeholder={'{\n  "name": "Gadget"\n}'}
          />
          {bodyError && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>Not valid JSON: {bodyError}</span>}
        </label>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="button"
          style={{ padding: '8px 28px', fontWeight: 600 }}
          disabled={!canSend}
          onClick={onSend}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
