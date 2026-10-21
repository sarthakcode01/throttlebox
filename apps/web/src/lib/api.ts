import type {
  ApiKeyCreatedResponse,
  ApiKeyListResponse,
  ApiKeySummary,
  CreateKeyRequest,
  CreateMockRouteRequest,
  CreateMockServiceRequest,
  LoginRequest,
  MeResponse,
  MockPreviewResponse,
  MockRouteSummary,
  MockServiceSummary,
  RegisterRequest,
  RotateKeyRequest,
} from '@throttlebox/shared';

/**
 * Browser fetch wrapper for the Fastify API.
 *
 * Two things matter here:
 *  1. `credentials: 'include'` so the httpOnly session cookie is sent.
 *  2. CSRF double-submit — echo the readable CSRF cookie on mutations.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function request<T>(
  path: string,
  options: RequestInit & { method?: string } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const isMutation = method !== 'GET' && method !== 'HEAD';

  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (isMutation) {
    const csrf = readCookie('throttlebox_csrf');
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    method,
    headers,
    credentials: 'include',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const body = payload as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      body.error ?? 'unknown_error',
      body.message ?? `Request failed with status ${response.status}`,
    );
  }

  return payload as T;
}

export const api = {
  health: () => request<{ ok: boolean }>('/health'),

  register: (body: RegisterRequest) =>
    request<{ user: { id: string; email: string; name: string } }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  login: (body: LoginRequest) =>
    request<{ user: { id: string; email: string; name: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<MeResponse>('/api/me'),

  // ---- API keys --------------------------------------------------------

  listKeys: () => request<ApiKeyListResponse>('/api/keys'),

  getKey: (id: string) => request<ApiKeySummary>(`/api/keys/${id}`),

  /** Returns the raw key. This is the only time it is ever visible. */
  createKey: (body: CreateKeyRequest) =>
    request<ApiKeyCreatedResponse>('/api/keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Returns a new raw key. The old one keeps working during the grace window. */
  rotateKey: (id: string, body: RotateKeyRequest = {}) =>
    request<ApiKeyCreatedResponse>(`/api/keys/${id}/rotate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  revokeKey: (id: string) => request<void>(`/api/keys/${id}/revoke`, { method: 'POST' }),

  /** Kill switch — revokes every key in the rotation chain. */
  revokeFamily: (id: string) => request<void>(`/api/families/${id}/revoke`, { method: 'POST' }),

  // ---- Mock services ----------------------------------------------------

  listMockServices: () => request<{ services: MockServiceSummary[] }>('/api/mock/services'),

  createMockService: (body: CreateMockServiceRequest) =>
    request<{ service: MockServiceSummary }>('/api/mock/services', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateMockService: (id: string, body: Partial<CreateMockServiceRequest>) =>
    request<{ service: MockServiceSummary }>(`/api/mock/services/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteMockService: (id: string) =>
    request<void>(`/api/mock/services/${id}`, { method: 'DELETE' }),

  listMockRoutes: (serviceId: string) =>
    request<{ routes: MockRouteSummary[] }>(`/api/mock/services/${serviceId}/routes`),

  createMockRoute: (serviceId: string, body: CreateMockRouteRequest) =>
    request<{ route: MockRouteSummary }>(`/api/mock/services/${serviceId}/routes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateMockRoute: (id: string, body: Partial<CreateMockRouteRequest>) =>
    request<{ route: MockRouteSummary }>(`/api/mock/routes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteMockRoute: (id: string) => request<void>(`/api/mock/routes/${id}`, { method: 'DELETE' }),

  /**
   * Render a mock response exactly as a caller would receive it.
   *
   * The body is returned as a string, because that is what goes over the
   * wire — showing the preview as the caller sees it is the point.
   */
  previewMock: (body: { serviceSlug: string; method: string; path: string; body?: unknown }) =>
    request<MockPreviewResponse>('/api/mock/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
