import type { CSSProperties } from 'react';
import type { HttpMethod, PlaygroundRequest } from '@throttlebox/shared';

export const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export const fieldStyle: CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  padding: '8px 10px',
  fontSize: '0.8125rem',
  fontFamily: 'inherit',
};

export const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

export const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.6875rem',
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  marginBottom: '6px',
};

/** What the builder form holds. Query and headers are edited as text, one entry per line. */
export interface Draft {
  keyId: string;
  method: HttpMethod;
  serviceSlug: string;
  path: string;
  query: string;
  headers: string;
  body: string;
  parentId: string | null;
}

export const EMPTY_DRAFT: Draft = {
  keyId: '',
  method: 'GET',
  serviceSlug: '',
  path: '/',
  query: '',
  headers: '',
  body: '',
  parentId: null,
};

/** `a=1` per line -> `{ a: '1' }`. Blank lines and lines with no key are ignored. */
export function parseQuery(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    const key = (i === -1 ? line : line.slice(0, i)).trim();
    if (key) out[key] = i === -1 ? '' : line.slice(i + 1).trim();
  }
  return out;
}

/** `Name: value` per line -> `{ Name: 'value' }`. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    if (key) out[key] = line.slice(i + 1).trim();
  }
  return out;
}

const toLines = (record: Record<string, string>, sep: string) =>
  Object.entries(record)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');

/** Pre-fill the builder from a past request (the "Fork" action). */
export function draftFromRequest(r: PlaygroundRequest): Draft {
  return {
    keyId: r.keyId ?? '',
    method: r.method,
    serviceSlug: r.serviceSlug,
    path: r.path,
    query: toLines(r.query, '='),
    headers: toLines(r.headers, ': '),
    body: r.body ?? '',
    parentId: r.id,
  };
}

export function statusColor(r: Pick<PlaygroundRequest, 'outcome' | 'responseStatus'>): string {
  if (r.outcome !== 'ok' || r.responseStatus === null) return '#ef4444';
  if (r.responseStatus >= 500) return '#ef4444';
  if (r.responseStatus === 429) return '#f59e0b';
  if (r.responseStatus >= 400) return '#f59e0b';
  return 'var(--success)';
}

export function statusLabel(r: Pick<PlaygroundRequest, 'outcome' | 'responseStatus'>): string {
  if (r.outcome === 'dropped') return 'DROPPED';
  if (r.outcome === 'error') return 'ERROR';
  return String(r.responseStatus ?? '—');
}

/** Short badges that explain *why* a run looks the way it does. */
export function badgesFor(r: PlaygroundRequest): string[] {
  const out: string[] = [];
  if (r.responseHeaders['x-throttlebox-chaos-injected'] === 'true') out.push('chaos fault');
  if (r.responseHeaders['x-throttlebox-chaos-latency']) out.push(`+${r.responseHeaders['x-throttlebox-chaos-latency']}`);
  if (r.responseStatus === 429 && r.responseHeaders['x-throttlebox-chaos-injected'] !== 'true') out.push('rate limited');
  if (r.outcome === 'dropped') out.push('socket dropped');
  if (r.responseTruncated) out.push('truncated');
  return out;
}

export function prettyBody(body: string): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function download(filename: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
