'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { PlaygroundExportFormat, PlaygroundRequest } from '@throttlebox/shared';
import { ApiError, api } from '@/lib/api';
import DiffView from '@/components/playground/DiffView';
import RequestBuilder from '@/components/playground/RequestBuilder';
import ResponseViewer from '@/components/playground/ResponseViewer';
import Timeline from '@/components/playground/Timeline';
import {
  download,
  draftFromRequest,
  EMPTY_DRAFT,
  fieldStyle,
  parseHeaders,
  parseQuery,
  type Draft,
} from '@/components/playground/shared';

function errorMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong';
}

export default function PlaygroundPage() {
  const queryClient = useQueryClient();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const role = me.data?.role ?? null;
  // Viewers can read history and export, but not run requests.
  const canRun = role !== null && role !== 'viewer';

  const sessions = useQuery({ queryKey: ['playground-sessions'], queryFn: api.listPlaygroundSessions });
  const keys = useQuery({ queryKey: ['keys'], queryFn: api.listKeys });
  const services = useQuery({ queryKey: ['mock-services'], queryFn: api.listMockServices });

  const activeKeys = useMemo(
    () => (keys.data?.keys ?? []).filter((k) => k.status === 'active'),
    [keys.data],
  );
  const serviceList = services.data?.services ?? [];

  // Open the most recent session automatically.
  useEffect(() => {
    if (!sessionId && sessions.data?.sessions.length) {
      setSessionId(sessions.data.sessions[0]!.id);
    }
  }, [sessionId, sessions.data]);

  // Sensible first values so "Send" works with one click.
  useEffect(() => {
    setDraft((d) => ({
      ...d,
      keyId: d.keyId || activeKeys[0]?.id || '',
      serviceSlug: d.serviceSlug || serviceList[0]?.slug || '',
    }));
  }, [activeKeys, serviceList]);

  const history = useQuery({
    queryKey: ['playground-requests', sessionId],
    queryFn: () => api.listPlaygroundRequests(sessionId!),
    enabled: !!sessionId,
  });
  const requests = history.data?.requests ?? [];
  const selected = requests.find((r) => r.id === selectedId) ?? null;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['playground-requests', sessionId] });
    await queryClient.invalidateQueries({ queryKey: ['playground-sessions'] });
  };

  const createSession = useMutation({
    mutationFn: () => api.createPlaygroundSession(),
    onSuccess: async ({ session }) => {
      setSessionId(session.id);
      setSelectedId(null);
      setCompareIds([]);
      setShowDiff(false);
      await queryClient.invalidateQueries({ queryKey: ['playground-sessions'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deletePlaygroundSession(id),
    onSuccess: async () => {
      setSessionId(null);
      setSelectedId(null);
      setCompareIds([]);
      await queryClient.invalidateQueries({ queryKey: ['playground-sessions'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const send = useMutation({
    mutationFn: () => {
      const body = draft.method === 'GET' ? null : draft.body.trim() || null;
      return api.sendPlaygroundRequest(sessionId!, {
        keyId: draft.keyId,
        method: draft.method,
        serviceSlug: draft.serviceSlug,
        path: draft.path,
        query: parseQuery(draft.query),
        headers: parseHeaders(draft.headers),
        body,
        ...(draft.parentId ? { parentId: draft.parentId } : {}),
      });
    },
    onSuccess: async ({ request }) => {
      setError(null);
      setSelectedId(request.id);
      setDraft((d) => ({ ...d, parentId: null }));
      await refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const replay = useMutation({
    mutationFn: (id: string) => {
      setBusyId(id);
      return api.replayPlaygroundRequest(id);
    },
    onSuccess: async ({ request }, originalId) => {
      setError(null);
      setSelectedId(request.id);
      // Line the original and its replay up for comparison.
      setCompareIds([originalId, request.id]);
      setShowDiff(true);
      await refresh();
    },
    onError: (e) => setError(errorMessage(e)),
    onSettled: () => setBusyId(null),
  });

  const ensureSessionThenSend = async () => {
    if (!sessionId) {
      const { session } = await createSession.mutateAsync();
      setSessionId(session.id);
      // The mutation above set the id; send on the next tick so it is used.
      setTimeout(() => send.mutate(), 0);
      return;
    }
    send.mutate();
  };

  const toggleCompare = (id: string) => {
    setCompareIds((ids) => {
      if (ids.includes(id)) return ids.filter((i) => i !== id);
      // Keep the two most recently ticked.
      return [...ids, id].slice(-2);
    });
  };

  const comparePair = useMemo((): [PlaygroundRequest, PlaygroundRequest] | null => {
    if (compareIds.length !== 2) return null;
    const a = requests.find((r) => r.id === compareIds[0]);
    const b = requests.find((r) => r.id === compareIds[1]);
    if (!a || !b) return null;
    // Earlier run on the left, later on the right.
    return new Date(a.createdAt) <= new Date(b.createdAt) ? [a, b] : [b, a];
  }, [compareIds, requests]);

  const exportSession = async (format: PlaygroundExportFormat) => {
    if (!sessionId) return;
    try {
      const { filename, text } = await api.exportPlaygroundSession(sessionId, format);
      download(filename, text, format === 'postman' ? 'application/json' : 'text/plain');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const onFork = (r: PlaygroundRequest) => {
    setDraft(draftFromRequest(r));
    setError(null);
  };

  const noKeys = keys.isSuccess && activeKeys.length === 0;

  return (
    <div style={{ maxWidth: '1280px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 800 }}>Time-Travel Playground</h2>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.875rem', maxWidth: '680px' }}>
            Send requests through the real pipeline, change something (try{' '}
            <Link href="/dashboard/chaos" style={{ color: 'var(--accent)' }}>
              Chaos Studio
            </Link>
            ), then replay and diff the results. Export any session as a runnable Vitest file or a Postman
            collection.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="secondary-button" disabled={!sessionId} onClick={() => exportSession('vitest')} style={{ padding: '6px 14px', fontSize: '0.8125rem' }}>
            Export Vitest
          </button>
          <button type="button" className="secondary-button" disabled={!sessionId} onClick={() => exportSession('postman')} style={{ padding: '6px 14px', fontSize: '0.8125rem' }}>
            Export Postman
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ padding: '12px 16px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '8px', color: '#ef4444', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}
      {noKeys && (
        <div style={{ padding: '12px 16px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '8px', fontSize: '0.875rem' }}>
          You need an active API key to send requests.{' '}
          <Link href="/dashboard/keys" style={{ color: 'var(--accent)' }}>
            Create one
          </Link>
          .
        </div>
      )}
      {role === 'viewer' && (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>
          Your role is read-only: you can browse history and export, but not send or replay.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', gap: '20px', alignItems: 'start' }}>
        {/* ---- Left: sessions + timeline ---- */}
        <aside className="card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <select
              aria-label="Session"
              style={fieldStyle}
              value={sessionId ?? ''}
              onChange={(e) => {
                setSessionId(e.target.value || null);
                setSelectedId(null);
                setCompareIds([]);
                setShowDiff(false);
              }}
            >
              <option value="">No session</option>
              {(sessions.data?.sessions ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.requestCount})
                </option>
              ))}
            </select>
            <button type="button" className="button" disabled={!canRun || createSession.isPending} onClick={() => createSession.mutate()} style={{ padding: '6px 12px', fontSize: '0.8125rem' }} aria-label="New session">
              +
            </button>
          </div>

          {sessionId && canRun && (
            <button
              type="button"
              className="secondary-button"
              style={{ padding: '4px 10px', fontSize: '0.6875rem', alignSelf: 'flex-start' }}
              onClick={() => {
                if (window.confirm('Delete this session and all its requests?')) deleteSession.mutate(sessionId);
              }}
            >
              Delete session
            </button>
          )}

          {compareIds.length === 2 && (
            <button type="button" className="button" style={{ padding: '6px 12px', fontSize: '0.8125rem' }} onClick={() => setShowDiff(true)}>
              Diff selected runs
            </button>
          )}

          <Timeline
            requests={requests}
            selectedId={selectedId}
            compareIds={compareIds}
            busyId={busyId}
            canRun={canRun}
            onSelect={setSelectedId}
            onReplay={(id) => replay.mutate(id)}
            onFork={onFork}
            onToggleCompare={toggleCompare}
          />
        </aside>

        {/* ---- Right: builder, response, diff ---- */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 }}>
          <RequestBuilder
            draft={draft}
            onChange={setDraft}
            keys={activeKeys}
            services={serviceList}
            sending={send.isPending || createSession.isPending}
            disabled={!canRun}
            onSend={ensureSessionThenSend}
            onClear={() => setDraft({ ...EMPTY_DRAFT, keyId: activeKeys[0]?.id ?? '', serviceSlug: serviceList[0]?.slug ?? '' })}
          />
          <ResponseViewer request={selected} />
          {showDiff && comparePair && (
            <DiffView before={comparePair[0]} after={comparePair[1]} onClose={() => setShowDiff(false)} />
          )}
        </section>
      </div>
    </div>
  );
}
