'use client';

import type { PlaygroundRequest } from '@throttlebox/shared';
import { badgesFor, monoStyle, statusColor, statusLabel } from './shared';

interface TimelineProps {
  requests: PlaygroundRequest[];
  selectedId: string | null;
  compareIds: string[];
  busyId: string | null;
  canRun: boolean;
  onSelect: (id: string) => void;
  onReplay: (id: string) => void;
  onFork: (request: PlaygroundRequest) => void;
  onToggleCompare: (id: string) => void;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Timeline({
  requests,
  selectedId,
  compareIds,
  busyId,
  canRun,
  onSelect,
  onReplay,
  onFork,
  onToggleCompare,
}: TimelineProps) {
  if (requests.length === 0) {
    return (
      <div className="muted" style={{ padding: '20px', fontSize: '0.8125rem', textAlign: 'center' }}>
        No requests yet. Send one to start the timeline.
      </div>
    );
  }

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {requests.map((r) => {
        const selected = r.id === selectedId;
        const compared = compareIds.includes(r.id);
        const badges = badgesFor(r);
        return (
          <li
            key={r.id}
            data-testid="timeline-item"
            style={{
              border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              background: selected ? 'var(--accent-dim)' : 'var(--surface)',
              borderRadius: '10px',
              padding: '10px 12px',
            }}
          >
            <button
              type="button"
              onClick={() => onSelect(r.id)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                display: 'block',
                width: '100%',
              }}
              aria-label={`Open ${r.method} ${r.path}`}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ ...monoStyle, fontSize: '0.6875rem', fontWeight: 700 }}>{r.method}</span>
                <span style={{ ...monoStyle, fontSize: '0.75rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.path}
                </span>
                <span style={{ ...monoStyle, fontSize: '0.75rem', fontWeight: 700, color: statusColor(r) }}>
                  {statusLabel(r)}
                </span>
              </div>
              <div className="muted" style={{ display: 'flex', gap: '8px', fontSize: '0.6875rem', marginTop: '4px', flexWrap: 'wrap' }}>
                <span>{timeOf(r.createdAt)}</span>
                <span>{r.durationMs} ms</span>
                {r.kind !== 'send' && <span style={{ color: 'var(--accent)' }}>{r.kind}</span>}
                {badges.map((b) => (
                  <span key={b} style={{ color: '#f59e0b' }}>
                    {b}
                  </span>
                ))}
              </div>
            </button>
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="secondary-button"
                style={{ padding: '2px 10px', fontSize: '0.6875rem' }}
                disabled={!canRun || busyId === r.id}
                onClick={() => onReplay(r.id)}
              >
                {busyId === r.id ? 'Replaying…' : 'Replay'}
              </button>
              <button
                type="button"
                className="secondary-button"
                style={{ padding: '2px 10px', fontSize: '0.6875rem' }}
                onClick={() => onFork(r)}
              >
                Fork
              </button>
              <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.6875rem' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={compared}
                  onChange={() => onToggleCompare(r.id)}
                  aria-label={`Compare ${r.method} ${r.path}`}
                />
                Compare
              </label>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
