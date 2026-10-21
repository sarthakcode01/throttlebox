'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type {
  CreateMockRouteRequest,
  CreateMockServiceRequest,
  HttpMethod,
  MockRouteSummary,
  MockServiceSummary,
} from '@throttlebox/shared';
import { ApiError, api } from '@/lib/api';
import Modal from '@/components/Modal';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The mutations the page needs.
 *
 * Declared in one place so the forms below can take them as props and stay
 * free of query-client plumbing.
 */
function useServiceMutations() {
  const queryClient = useQueryClient();

  const createService = useMutation({
    mutationFn: api.createMockService,
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

  return { createService, createRoute, updateRoute };
}

export default function ServicesPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingService, setCreatingService] = useState(false);
  const [editingRoute, setEditingRoute] = useState<MockRouteSummary | null>(null);
  const [creatingRoute, setCreatingRoute] = useState(false);

  const { createService, createRoute, updateRoute } = useServiceMutations();

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

  const deleteRoute = useMutation({
    mutationFn: (id: string) => api.deleteMockRoute(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mock-routes'] });
      await queryClient.invalidateQueries({ queryKey: ['mock-services'] });
    },
  });

  function message(err: unknown): string {
    return err instanceof ApiError ? err.message : 'Something went wrong';
  }

  if (servicesQuery.isLoading) {
    return (
      <main>
        <div className="card">Loading your mock APIs…</div>
      </main>
    );
  }

  if (servicesQuery.error) {
    return (
      <main>
        <div className="error">{message(servicesQuery.error)}</div>
      </main>
    );
  }

  return (
    <main>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Mock APIs</h1>
          <p className="muted" style={{ margin: 0 }}>
            Each service is a backend your code can call. Responses are rendered from a template.
          </p>
        </div>
        <button onClick={() => setCreatingService(true)}>New service</button>
      </div>

      {services.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No mock services yet. Create one to start building an endpoint.
          </p>
        </div>
      ) : (
        <div className="split">
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="keys-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Slug</th>
                  <th>Routes</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr
                    key={service.id}
                    onClick={() => setSelectedId(service.id)}
                    className={service.id === selected?.id ? 'selected' : undefined}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{service.name}</td>
                    <td>
                      <code>{service.slug}</code>
                    </td>
                    <td className="muted">{service.routeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected && (
            <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
              <div
                className="row"
                style={{ justifyContent: 'space-between', padding: '16px 20px' }}
              >
                <div>
                  <h2 style={{ margin: 0 }}>{selected.name}</h2>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    <code>/mock/{selected.slug}</code>
                  </p>
                </div>
                <button className="secondary" onClick={() => setCreatingRoute(true)}>
                  Add route
                </button>
              </div>

              {routesQuery.isLoading ? (
                <div className="card" style={{ border: 'none' }}>
                  Loading routes…
                </div>
              ) : (
                <table className="keys-table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Path</th>
                      <th>Status</th>
                      <th>Summary</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(routesQuery.data?.routes ?? []).map((route) => (
                      <tr key={route.id}>
                        <td>
                          <span className={`badge method-${route.method.toLowerCase()}`}>
                            {route.method}
                          </span>
                        </td>
                        <td>
                          <code>{route.path}</code>
                        </td>
                        <td className="muted">{route.statusCode}</td>
                        <td className="muted">{route.summary || '—'}</td>
                        <td>
                          <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                            <button
                              className="secondary small"
                              onClick={() => setEditingRoute(route)}
                            >
                              Edit
                            </button>
                            <button
                              className="secondary small danger"
                              onClick={() => deleteRoute.mutate(route.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {creatingService && (
        <ServiceForm
          pending={createService.isPending}
          error={createService.error ? message(createService.error) : null}
          onCancel={() => {
            setCreatingService(false);
            createService.reset();
          }}
          onSubmit={(body) => createService.mutate(body)}
        />
      )}

      {creatingRoute && selected && (
        <RouteForm
          service={selected}
          pending={createRoute.isPending}
          error={createRoute.error ? message(createRoute.error) : null}
          onCancel={() => {
            setCreatingRoute(false);
            createRoute.reset();
          }}
          onSubmit={(body) => createRoute.mutate({ serviceId: selected.id, body })}
        />
      )}

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
          onSubmit={(body) => updateRoute.mutate({ id: editingRoute.id, body })}
        />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
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
    <Modal title="New mock service" onClose={onCancel}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name: name.trim(), slug: slug.trim() || undefined, description });
        }}
      >
        <div>
          <label htmlFor="service-name">Name</label>
          <input
            id="service-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Payments"
            required
            maxLength={80}
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="service-slug">URL slug (optional)</label>
          <input
            id="service-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="payments"
            maxLength={40}
          />
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Your endpoints will live at{' '}
            <code>/mock/{slug || name.toLowerCase() || 'your-slug'}</code>.
          </p>
        </div>
        <div>
          <label htmlFor="service-description">Description</label>
          <input
            id="service-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this API is for"
            maxLength={500}
          />
        </div>

        {error && <div className="error">{error}</div>}

        <div className="row">
          <button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create service'}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
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
    JSON.stringify(initial?.responseTemplate ?? { hello: 'world' }, null, 2),
  );
  const [templateError, setTemplateError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    let parsed: unknown;
    try {
      parsed = JSON.parse(template);
    } catch {
      setTemplateError('The response template must be valid JSON');
      return;
    }
    setTemplateError(null);

    onSubmit({
      method,
      path: path.trim(),
      summary: summary.trim(),
      statusCode: Number(statusCode),
      responseTemplate: parsed,
    });
  }

  return (
    <Modal title={initial ? 'Edit route' : 'New route'} onClose={onCancel}>
      <form className="stack" onSubmit={handleSubmit}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 120px' }}>
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
            <label htmlFor="route-path">Path</label>
            <input
              id="route-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/products/:id"
              required
            />
          </div>
          <div style={{ flex: '0 0 110px' }}>
            <label htmlFor="route-status">Status</label>
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

        <p className="muted" style={{ margin: 0 }}>
          Served at{' '}
          <code>
            /mock/{service.slug}
            {path}
          </code>
        </p>

        <div>
          <label htmlFor="route-summary">Summary</label>
          <input
            id="route-summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="List products"
            maxLength={200}
          />
        </div>

        <div>
          <label htmlFor="route-template">Response template</label>
          <textarea
            id="route-template"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            rows={10}
            spellCheck={false}
            className="code-input"
          />
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Use <code>{'{{params.id}}'}</code> for path parameters, <code>{'{{query.page}}'}</code>{' '}
            for query parameters, and <code>{'{{faker.person.fullName}}'}</code> for realistic data.
          </p>
        </div>

        {templateError && <div className="error">{templateError}</div>}
        {error && <div className="error">{error}</div>}

        <div className="row">
          <button type="submit" disabled={pending}>
            {pending ? 'Saving…' : initial ? 'Save route' : 'Create route'}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
