'use client';

import { useState } from 'react';
import type { PlaygroundRequest } from '@throttlebox/shared';
import { badgesFor, monoStyle, prettyBody, statusColor, statusLabel } from './shared';

export default function ResponseViewer({ request }: { request: PlaygroundRequest | null }) {
  const [tab, setTab] = useState<'body' | 'headers'>('body');

  if (!request) {
    return (
      <div className="card muted" style={{ padding: '28px', textAlign: 'center', fontSize: '0.875rem' }}>
        Send a request, or pick one from the timeline, to see its response.
      </div>
    );
  }

  const badges = badgesFor(request);
  const headerEntries = Object.entries(request.responseHeaders).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Response</h3>
        <span
          data-testid="response-status"
          style={{ ...monoStyle, fontWeight: 700, color: statusColor(request) }}
        >
          {statusLabel(request)}
        </span>
        <span className="muted" style={{ fontSize: '0.8125rem' }}>
          {request.durationMs} ms
        </span>
        {badges.map((b) => (
          <span key={b} className="badge" style={{ color: '#f59e0b', borderColor: 'rgba(245,158,11,0.4)' }}>
            {b}
          </span>
        ))}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.75rem' }}>
          {request.kind}
          {request.keyDisplay ? ` · ${request.keyDisplay}` : ''}
        </span>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'body'} onClick={() => setTab('body')}>
          Body
        </button>
        <button role="tab" aria-selected={tab === 'headers'} onClick={() => setTab('headers')}>
          Headers ({headerEntries.length})
        </button>
      </div>

      {tab === 'body' ? (
        <pre
          style={{
            ...monoStyle,
            margin: 0,
            padding: '14px',
            maxHeight: '360px',
            overflow: 'auto',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            fontSize: '0.75rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {prettyBody(request.responseBody) || '(empty body)'}
          {request.responseTruncated ? '\n\n… response truncated at 64 KB' : ''}
        </pre>
      ) : (
        <table className="keys-table" style={{ fontSize: '0.75rem' }}>
          <tbody>
            {headerEntries.map(([name, value]) => (
              <tr key={name}>
                <td style={{ ...monoStyle, fontWeight: 600 }}>{name}</td>
                <td style={{ ...monoStyle, wordBreak: 'break-all' }}>{value}</td>
              </tr>
            ))}
            {headerEntries.length === 0 && (
              <tr>
                <td className="muted">No response headers (connection dropped)</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
