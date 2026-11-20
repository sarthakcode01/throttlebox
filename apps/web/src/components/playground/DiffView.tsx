'use client';

import { useMemo, useState } from 'react';
import {
  diffRuns,
  type JsonDiffEntry,
  type PlaygroundRequest,
  type RunSnapshot,
} from '@throttlebox/shared';
import { monoStyle, statusLabel } from './shared';

function snapshot(r: PlaygroundRequest): RunSnapshot {
  return {
    outcome: r.outcome,
    status: r.responseStatus,
    durationMs: r.durationMs,
    headers: r.responseHeaders,
    body: r.responseBody,
  };
}

const KIND_STYLE: Record<JsonDiffEntry['kind'], { color: string; bg: string; sign: string }> = {
  added: { color: '#3ecf8e', bg: 'rgba(62,207,142,0.10)', sign: '+' },
  removed: { color: '#ef4444', bg: 'rgba(239,68,68,0.10)', sign: '−' },
  changed: { color: '#f59e0b', bg: 'rgba(245,158,11,0.10)', sign: '~' },
};

function show(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function Entries({ title, entries }: { title: string; entries: JsonDiffEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="muted" style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '12px 0 6px' }}>
        {title} ({entries.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {entries.map((e, i) => {
          const s = KIND_STYLE[e.kind];
          return (
            <div
              key={`${e.path}-${i}`}
              data-testid={`diff-${e.kind}`}
              style={{ ...monoStyle, background: s.bg, borderLeft: `3px solid ${s.color}`, padding: '6px 10px', borderRadius: '4px', fontSize: '0.75rem', display: 'grid', gridTemplateColumns: '16px 1fr', gap: '6px' }}
            >
              <span style={{ color: s.color, fontWeight: 700 }}>{s.sign}</span>
              <span style={{ wordBreak: 'break-all' }}>
                <strong>{e.path}</strong>
                {e.kind !== 'added' && (
                  <span style={{ color: '#ef4444' }}> {show(e.before)}</span>
                )}
                {e.kind === 'changed' && <span className="muted"> → </span>}
                {e.kind !== 'removed' && (
                  <span style={{ color: '#3ecf8e' }}> {show(e.after)}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DiffView({
  before,
  after,
  onClose,
}: {
  before: PlaygroundRequest;
  after: PlaygroundRequest;
  onClose: () => void;
}) {
  const [showNoise, setShowNoise] = useState(false);
  const diff = useMemo(
    () => diffRuns(snapshot(before), snapshot(after), showNoise ? { ignoreHeaders: [] } : undefined),
    [before, after, showNoise],
  );

  return (
    <div className="card" style={{ padding: '20px' }} data-testid="diff-view">
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Response diff</h3>
        <span
          className="badge"
          style={{
            color: diff.identical ? 'var(--success)' : '#f59e0b',
            borderColor: diff.identical ? 'rgba(62,207,142,0.4)' : 'rgba(245,158,11,0.4)',
          }}
        >
          {diff.identical ? 'identical' : 'differences found'}
        </span>
        <label style={{ marginLeft: 'auto', fontSize: '0.75rem', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showNoise} onChange={(e) => setShowNoise(e.target.checked)} />
          Show volatile headers
        </label>
        <button type="button" className="secondary-button" style={{ padding: '2px 12px', fontSize: '0.75rem' }} onClick={onClose}>
          Close
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '14px' }}>
        {[
          { label: 'Before', r: before },
          { label: 'After', r: after },
        ].map(({ label, r }) => (
          <div key={label} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px' }}>
            <div className="muted" style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase' }}>
              {label}
            </div>
            <div style={{ ...monoStyle, fontSize: '0.8125rem', marginTop: '4px' }}>
              {r.method} {r.path} → <strong>{statusLabel(r)}</strong> · {r.durationMs} ms
            </div>
          </div>
        ))}
      </div>

      {diff.status && (
        <div style={{ marginTop: '12px', fontSize: '0.8125rem' }}>
          Status: <strong style={{ color: '#ef4444' }}>{diff.status.before ?? 'none'}</strong> →{' '}
          <strong style={{ color: '#3ecf8e' }}>{diff.status.after ?? 'none'}</strong>
        </div>
      )}
      {diff.outcome && (
        <div style={{ marginTop: '6px', fontSize: '0.8125rem' }}>
          Outcome: <strong>{diff.outcome.before}</strong> → <strong>{diff.outcome.after}</strong>
        </div>
      )}
      <div className="muted" style={{ marginTop: '6px', fontSize: '0.8125rem' }}>
        Latency: {diff.durationDeltaMs >= 0 ? '+' : ''}
        {diff.durationDeltaMs} ms
      </div>

      <Entries title="Headers" entries={diff.headers} />
      <Entries title="Body" entries={diff.body} />
    </div>
  );
}
