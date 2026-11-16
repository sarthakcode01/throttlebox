'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type {
  CreateMockRouteRequest,
  CreateMockServiceRequest,
  HttpMethod,
  MockPreviewResponse,
  MockRouteSummary,
  MockServiceSummary,
} from '@throttlebox/shared';
import { ApiError, api } from '@/lib/api';
import Modal from '@/components/Modal';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function useServiceMutations() {
  const queryClient = useQueryClient();

  const createService = useMutation({
    mutationFn: api.createMockService,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mock-services'] });
    },
  });

  const deleteService = useMutation({
    mutationFn: (id: string) => api.deleteMockService(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mock-services'] });
    },
  });

  const createRoute = useMutation({
    mutationFn: ({ serviceId, body }: { serviceId: string; body: CreateMockRouteRequest }) =>
      api.createMockRoute(serviceId, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mock-routes'] });
      await queryClient.invalidateQueries({ queryKey: ['mock-services'] });
    },
  });

  const updateRoute = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CreateMockRouteRequest> }) =>
      api.updateMockRoute(id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mock-routes'] });
      await queryClient.invalidateQueries({ queryKey: ['mock-services'] });
    },
  });

  const deleteRoute = useMutation({
    mutationFn: (id: string) => api.deleteMockRoute(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mock-routes'] });
      await queryClient.invalidateQueries({ queryKey: ['mock-services'] });
    },
  });

  return { createService, deleteService, createRoute, updateRoute, deleteRoute };
}

export default function ServicesPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingService, setCreatingService] = useState(false);
  const [editingRoute, setEditingRoute] = useState<MockRouteSummary | null>(null);
  const [creatingRoute, setCreatingRoute] = useState(false);
  const [previewing, setPreviewing] = useState<MockRouteSummary | null>(null);
  const [deletingServiceId, setDeletingServiceId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { createService, deleteService, createRoute, updateRoute, deleteRoute } =
    useServiceMutations();

  const servicesQuery = useQuery({
    queryKey: ['mock-services'],
    queryFn: api.listMockServices,
    retry: false,
  });

  const services = servicesQuery.data?.services ?? [];
  const selected = services.find((service) => service.id === selectedId) ?? services[0] ?? null;

  const routesQuery = useQuery({
    queryKey: ['mock-routes', selected?.id],
    queryFn: () => api.listMockRoutes(selected!.id),
    enabled: Boolean(selected),
    retry: false,
  });

  const routes = routesQuery.data?.routes ?? [];

  function message(err: unknown): string {
    return err instanceof ApiError ? err.message : 'Something went wrong';
  }

  const handleCopy = (text: string, id: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(id);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

  return (
    <div>
      {/* Top Header */}
      <div className="dashboard-header-row">
        <div>
          <h1 className="dashboard-title">Mock APIs Studio</h1>
          <p className="dashboard-subtitle">
            Define realistic mock endpoints, parameter bindings, and dynamic Faker response
            templates without deploying custom code.
          </p>
        </div>

        <div className="row">
          {selected && (
            <button
              onClick={() => setCreatingRoute(true)}
              className="cta-button"
              style={{ fontSize: '0.875rem' }}
            >
              + Add Route
            </button>
          )}
          <button
            onClick={() => setCreatingService(true)}
            className="secondary-button"
            style={{ fontSize: '0.875rem' }}
          >
            New Service
          </button>
        </div>
      </div>

      {servicesQuery.error && (
        <div className="error" role="alert" style={{ marginBottom: '20px' }}>
          {message(servicesQuery.error)}
        </div>
      )}

      {servicesQuery.isLoading && (
        <div className="card text-center" style={{ padding: '40px' }}>
          <div className="muted">Loading workspace mock APIs…</div>
        </div>
      )}

      {!servicesQuery.isLoading && services.length === 0 ? (
        <div className="card text-center" style={{ padding: '48px 24px' }}>
          <div style={{ color: 'var(--accent)', marginBottom: '12px' }}>
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </div>
          <h3 style={{ margin: '0 0 8px' }}>No Mock Services Created</h3>
          <p className="muted" style={{ margin: '0 0 20px', fontSize: '0.875rem' }}>
            Build a mock backend to serve deterministic JSON data with custom latency and status
            codes.
          </p>
          <button
            onClick={() => setCreatingService(true)}
            className="cta-button"
            style={{ display: 'inline-flex' }}
          >
            + Create First Mock Service
          </button>
        </div>
      ) : (
        /* Studio Master-Detail Split Grid */
        <div className="studio-grid">
          {/* Left Pane: Services List */}
          <div className="studio-list-card">
            <div className="studio-list-head">
              <span
                style={{
                  fontSize: '0.8125rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: 'var(--muted)',
                }}
              >
                Services ({services.length})
              </span>
              <button
                onClick={() => setCreatingService(true)}
                className="secondary-button"
                style={{ padding: '2px 8px', fontSize: '0.75rem' }}
              >
                + New
              </button>
            </div>

            <div>
              {services.map((svc) => (
                <div
                  key={svc.id}
                  className={`studio-item ${selected?.id === svc.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(svc.id)}
                >
                  <div style={{ minWidth: 0, paddingRight: '8px' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>
                      {svc.name}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                      slug: <code>{svc.slug}</code>
                    </div>
                  </div>
                  <span className="badge" style={{ color: 'var(--accent)', flexShrink: 0 }}>
                    {svc.routeCount} routes
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Right Pane: Selected Service Routes & Details */}
          {selected ? (
            <div className="stack" style={{ gap: '20px' }}>
              {/* Service Meta Card */}
              <div className="card" style={{ padding: '20px 24px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    marginBottom: '12px',
                    flexWrap: 'wrap',
                    gap: '12px',
                  }}
                >
                  <div>
                    <h2 style={{ margin: '0 0 4px', fontSize: '1.25rem' }}>{selected.name}</h2>
                    <p className="muted" style={{ margin: 0, fontSize: '0.875rem' }}>
                      {selected.description || 'No description provided.'}
                    </p>
                  </div>

                  <div className="row" style={{ gap: '8px' }}>
                    <Link
                      href="/dashboard/docs"
                      className="secondary-button"
                      style={{ padding: '6px 12px', fontSize: '0.8125rem' }}
                    >
                      OpenAPI Docs &rarr;
                    </Link>
                    {!selected.isSeeded && (
                      <button
                        onClick={() => setDeletingServiceId(selected.id)}
                        className="secondary-button"
                        style={{
                          padding: '6px 12px',
                          fontSize: '0.8125rem',
                          color: 'var(--danger)',
                          borderColor: 'rgba(255, 107, 107, 0.4)',
                        }}
                      >
                        Delete Service
                      </button>
                    )}
                  </div>
                </div>

                {/* Base URL Pill */}
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '10px',
                    background: '#090c10',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '8px 14px',
                    fontSize: '0.8125rem',
                    color: 'var(--muted)',
                  }}
                >
                  <span>Base Endpoint:</span>
                  <code style={{ color: 'var(--text)' }}>
                    {apiUrl}/mock/{selected.slug}
                  </code>
                  <button
                    onClick={() => handleCopy(`${apiUrl}/mock/${selected.slug}`, 'service-base')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: copiedKey === 'service-base' ? 'var(--success)' : 'var(--accent)',
                      cursor: 'pointer',
                      padding: '0 4px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                    }}
                  >
                    {copiedKey === 'service-base' ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Endpoints List */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '14px',
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>
                    Configured Routes ({routes.length})
                  </h3>
                  <button
                    onClick={() => setCreatingRoute(true)}
                    className="cta-button"
                    style={{ padding: '6px 12px', fontSize: '0.8125rem' }}
                  >
                    + Add Route
                  </button>
                </div>

                {routesQuery.isLoading && (
                  <div className="card text-center" style={{ padding: '30px' }}>
                    <div className="muted">Loading routes…</div>
                  </div>
                )}

                {!routesQuery.isLoading && routes.length === 0 ? (
                  <div className="card text-center" style={{ padding: '40px 24px' }}>
                    <p className="muted" style={{ margin: '0 0 14px', fontSize: '0.875rem' }}>
                      This service doesn&apos;t have any active endpoints yet.
                    </p>
                    <button
                      onClick={() => setCreatingRoute(true)}
                      className="cta-button"
                      style={{ display: 'inline-flex', padding: '8px 14px' }}
                    >
                      + Create First Endpoint
                    </button>
                  </div>
                ) : (
                  routes.map((route) => {
                    const methodClass = `method-${route.method.toLowerCase()}`;
                    return (
                      <div key={route.id} className="route-card-item">
                        <div className="route-info-left">
                          <span
                            className={`badge ${methodClass}`}
                            style={{ minWidth: '60px', textAlign: 'center' }}
                          >
                            {route.method}
                          </span>
                          <div>
                            <div className="route-path">{route.path}</div>
                            {route.summary && (
                              <div
                                className="muted"
                                style={{ fontSize: '0.75rem', marginTop: '2px' }}
                              >
                                {route.summary}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="row" style={{ gap: '10px' }}>
                          <span
                            className="badge"
                            style={{
                              color: route.statusCode < 400 ? 'var(--success)' : 'var(--danger)',
                            }}
                          >
                            {route.statusCode}
                          </span>
                          {!route.isActive && (
                            <span className="badge" style={{ color: 'var(--muted)' }}>
                              inactive
                            </span>
                          )}
                          {route.latencyMs > 0 && (
                            <span className="badge" style={{ color: 'var(--muted)' }}>
                              +{route.latencyMs}ms
                            </span>
                          )}

                          <button
                            className="secondary-button"
                            style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                            onClick={() => setPreviewing(route)}
                          >
                            Live Preview
                          </button>
                          <button
                            className="secondary-button"
                            style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                            onClick={() => setEditingRoute(route)}
                          >
                            Edit
                          </button>
                          <button
                            className="secondary-button"
                            style={{
                              padding: '4px 10px',
                              fontSize: '0.75rem',
                              color: 'var(--danger)',
                              borderColor: 'rgba(255, 107, 107, 0.4)',
                            }}
                            onClick={() => deleteRoute.mutate(route.id)}
                            disabled={deleteRoute.isPending}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div className="card text-center" style={{ padding: '40px' }}>
              <div className="muted">Select a service on the left to inspect its endpoints.</div>
            </div>
          )}
        </div>
      )}

      {/* Delete Service Confirmation Modal */}
      {deletingServiceId && selected && (
        <Modal
          title="Delete Mock Service"
          onClose={() => {
            setDeletingServiceId(null);
            deleteService.reset();
          }}
        >
          <div className="stack">
            <div className="warning">
              Deleting service <strong>{selected.name}</strong> will delete all of its routes and
              OpenAPI specifications. This action cannot be undone.
            </div>
            {deleteService.error && <div className="error">{message(deleteService.error)}</div>}
            <div
              className="row"
              style={{ justifyContent: 'flex-end', gap: '10px', marginTop: '14px' }}
            >
              <button className="secondary-button" onClick={() => setDeletingServiceId(null)}>
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
                  cursor: deleteService.isPending ? 'not-allowed' : 'pointer',
                }}
                onClick={() =>
                  deleteService.mutate(deletingServiceId, {
                    onSuccess: () => {
                      setDeletingServiceId(null);
                      setSelectedId(null);
                    },
                  })
                }
                disabled={deleteService.isPending}
              >
                {deleteService.isPending ? 'Deleting…' : 'Delete Service'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Create Service Modal */}
      {creatingService && (
        <ServiceForm
          pending={createService.isPending}
          error={createService.error ? message(createService.error) : null}
          onCancel={() => {
            setCreatingService(false);
            createService.reset();
          }}
          onSubmit={(body) =>
            createService.mutate(body, {
              onSuccess: (res) => {
                setCreatingService(false);
                setSelectedId(res.service.id);
              },
            })
          }
        />
      )}

      {/* Create Route Modal */}
      {creatingRoute && selected && (
        <RouteForm
          service={selected}
          pending={createRoute.isPending}
          error={createRoute.error ? message(createRoute.error) : null}
          onCancel={() => {
            setCreatingRoute(false);
            createRoute.reset();
          }}
          onSubmit={(body) =>
            createRoute.mutate(
              { serviceId: selected.id, body },
              { onSuccess: () => setCreatingRoute(false) },
            )
          }
        />
      )}

      {/* Edit Route Modal */}
      {editingRoute && selected && (
        <RouteForm
          service={selected}
          initial={editingRoute}
          pending={updateRoute.isPending}
          error={updateRoute.error ? message(updateRoute.error) : null}
          onCancel={() => {
            setEditingRoute(null);
            updateRoute.reset();
          }}
          onSubmit={(body) =>
            updateRoute.mutate(
              { id: editingRoute.id, body },
              { onSuccess: () => setEditingRoute(null) },
            )
          }
        />
      )}

      {/* Live Preview Modal */}
      {previewing && selected && (
        <PreviewDialog service={selected} route={previewing} onClose={() => setPreviewing(null)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal Dialogs                                                      */
/* ------------------------------------------------------------------ */

interface ServiceFormProps {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: CreateMockServiceRequest) => void;
}

function ServiceForm({ pending, error, onCancel, onSubmit }: ServiceFormProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');

  return (
    <Modal title="Create Mock Service" onClose={onCancel}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name: name.trim(), slug: slug.trim() || undefined, description });
        }}
      >
        <div>
          <label htmlFor="service-name">Service Name</label>
          <input
            id="service-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Products Service"
            required
            maxLength={80}
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="service-slug">URL Slug (optional)</label>
          <input
            id="service-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="e.g. products"
            maxLength={40}
          />
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.75rem' }}>
            Endpoints will be served at{' '}
            <code>/mock/{slug || name.toLowerCase().replace(/\s+/g, '-') || 'slug'}</code>.
          </p>
        </div>
        <div>
          <label htmlFor="service-description">Description</label>
          <input
            id="service-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Catalog and product inventory endpoints"
            maxLength={500}
          />
        </div>

        {error && <div className="error">{error}</div>}

        <div className="row" style={{ justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="cta-button" disabled={pending}>
            {pending ? 'Creating…' : 'Create Service'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PreviewDialog({
  service,
  route,
  onClose,
}: {
  service: MockServiceSummary;
  route: MockRouteSummary;
  onClose: () => void;
}) {
  const [path, setPath] = useState(route.path);
  const [result, setResult] = useState<MockPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useMutation({
    mutationFn: () =>
      api.previewMock({
        serviceSlug: service.slug,
        method: route.method,
        path: path.startsWith('/') ? path : `/${path}`,
      }),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
    },
    onError: (err) => {
      setResult(null);
      setError(err instanceof ApiError ? err.message : 'Could not render the preview');
    },
  });

  return (
    <Modal title={`Live Template Preview — ${route.method} ${route.path}`} onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0, fontSize: '0.875rem' }}>
          Evaluate template and Faker expressions through the actual mock execution pipeline. Add a
          query string (e.g. <code>?page=2</code>) to the path to test query parameters.
        </p>

        <div className="row" style={{ alignItems: 'flex-end', gap: '10px' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="preview-path">Test URL Path</label>
            <input
              id="preview-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') preview.mutate();
              }}
            />
          </div>
          <button
            onClick={() => preview.mutate()}
            disabled={preview.isPending}
            className="cta-button"
            style={{ padding: '10px 18px' }}
          >
            {preview.isPending ? 'Rendering…' : 'Execute & Render'}
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        {result && (
          <div className="stack" style={{ gap: '12px', marginTop: '12px' }}>
            <div className="row" style={{ gap: '12px' }}>
              <span className="badge" style={{ color: 'var(--success)' }}>
                Status {result.statusCode}
              </span>
              {result.latencyMs > 0 && (
                <span className="badge" style={{ color: 'var(--muted)' }}>
                  Latency {result.latencyMs}ms
                </span>
              )}
              {result.matchedRoute && (
                <span className="muted" style={{ fontSize: '0.75rem' }}>
                  Matched pattern: <code>{result.matchedRoute}</code>
                </span>
              )}
            </div>

            {Object.keys(result.headers).length > 0 && (
              <div>
                <label>Emitted Headers</label>
                <pre className="code-block" style={{ maxHeight: '120px' }}>
                  {Object.entries(result.headers)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\n')}
                </pre>
              </div>
            )}

            <div>
              <label>Rendered JSON Payload</label>
              <pre className="code-block" style={{ maxHeight: '280px', color: '#3ecf8e' }}>
                {result.body}
              </pre>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

interface RouteFormProps {
  service: MockServiceSummary;
  initial?: MockRouteSummary;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: CreateMockRouteRequest) => void;
}

function RouteForm({ service, initial, pending, error, onCancel, onSubmit }: RouteFormProps) {
  const [method, setMethod] = useState<HttpMethod>(initial?.method ?? 'GET');
  const [path, setPath] = useState(initial?.path ?? '/');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [statusCode, setStatusCode] = useState(String(initial?.statusCode ?? 200));
  const [template, setTemplate] = useState(
    JSON.stringify(
      initial?.responseTemplate ?? {
        id: '{{params.id}}',
        name: '{{faker.commerce.productName}}',
        price: 99.99,
      },
      null,
      2,
    ),
  );
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [latencyMs, setLatencyMs] = useState(String(initial?.latencyMs ?? 0));
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [headers, setHeaders] = useState(JSON.stringify(initial?.responseHeaders ?? {}, null, 2));

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    let parsed: unknown;
    try {
      parsed = JSON.parse(template);
    } catch {
      setTemplateError('The response template must be valid JSON');
      return;
    }

    let parsedHeaders: Record<string, string>;
    try {
      const value = JSON.parse(headers || '{}') as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      parsedHeaders = value as Record<string, string>;
    } catch {
      setTemplateError('Response headers must be a JSON object of name → value');
      return;
    }

    const status = Number(statusCode);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      setTemplateError('The HTTP status code must be between 100 and 599');
      return;
    }
    setTemplateError(null);

    onSubmit({
      method,
      path: path.trim(),
      summary: summary.trim(),
      description: description.trim(),
      statusCode: status,
      responseTemplate: parsed,
      responseHeaders: parsedHeaders,
      latencyMs: Math.max(0, Math.min(30_000, Number(latencyMs) || 0)),
      isActive,
    });
  }

  return (
    <Modal title={initial ? 'Edit Mock Route' : 'Create Mock Route'} onClose={onCancel}>
      <form className="stack" onSubmit={handleSubmit}>
        <div className="row" style={{ alignItems: 'flex-end', gap: '10px' }}>
          <div style={{ flex: '0 0 110px' }}>
            <label htmlFor="route-method">Method</label>
            <select
              id="route-method"
              value={method}
              onChange={(event) => setMethod(event.target.value as HttpMethod)}
            >
              {METHODS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="route-path">Endpoint Path</label>
            <input
              id="route-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/products/:id"
              required
            />
          </div>
          <div style={{ flex: '0 0 90px' }}>
            <label htmlFor="route-status">HTTP Code</label>
            <input
              id="route-status"
              type="number"
              min={100}
              max={599}
              value={statusCode}
              onChange={(event) => setStatusCode(event.target.value)}
            />
          </div>
        </div>

        <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
          Caller URL:{' '}
          <code>
            /mock/{service.slug}
            {path.startsWith('/') ? path : `/${path}`}
          </code>
        </p>

        <div>
          <label htmlFor="route-summary">Route Summary / Description</label>
          <input
            id="route-summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="e.g. Retrieve single product by id"
            maxLength={200}
          />
        </div>

        <div>
          <label htmlFor="route-description">Description (shown in the OpenAPI document)</label>
          <input
            id="route-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
          />
        </div>

        <div className="row" style={{ gap: '10px', alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 160px' }}>
            <label htmlFor="route-latency">Artificial latency (ms)</label>
            <input
              id="route-latency"
              type="number"
              min={0}
              max={30000}
              value={latencyMs}
              onChange={(event) => setLatencyMs(event.target.value)}
            />
          </div>
          <label className="scope-option" style={{ marginBottom: '8px' }}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            <span>Active</span>
          </label>
        </div>

        <div>
          <label htmlFor="route-headers">Response headers (JSON object)</label>
          <textarea
            id="route-headers"
            value={headers}
            onChange={(event) => setHeaders(event.target.value)}
            rows={3}
            spellCheck={false}
            className="code-input"
          />
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.75rem' }}>
            Values may use template tags, e.g. <code>{'"Location": "/orders/{{params.id}}"'}</code>.
          </p>
        </div>

        <div>
          <label htmlFor="route-template">Response JSON Template</label>
          <textarea
            id="route-template"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            rows={10}
            spellCheck={false}
            className="code-input"
          />
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.75rem' }}>
            Supported tags: <code>{'{{params.<name>}}'}</code>, <code>{'{{query.<name>}}'}</code>,
            and Faker generators like <code>{'{{faker.commerce.productName}}'}</code>.
          </p>
        </div>

        {templateError && <div className="error">{templateError}</div>}
        {error && <div className="error">{error}</div>}

        <div className="row" style={{ justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="cta-button" disabled={pending}>
            {pending ? 'Saving Route…' : initial ? 'Save Changes' : 'Create Route'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
