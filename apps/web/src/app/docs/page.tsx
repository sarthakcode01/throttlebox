'use client';

import { useEffect, useState } from 'react';

/**
 * The OpenAPI reference for a mock service.
 *
 * Stoplight Elements renders the document, so a developer can read the
 * endpoints, try them, and copy a request without leaving the page.
 *
 * The document is fetched here rather than handed to the element as a URL.
 * The element's own fetch does not send credentials, and the API needs the
 * session cookie — so the browser fetches it with the cookie and passes the
 * result in as data.
 */
export default function DocsPage() {
  const [slug, setSlug] = useState('ecommerce');
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    const controller = new AbortController();

    async function load() {
      setError(null);
      setSpec(null);
      try {
        const response = await fetch(`${apiUrl}/docs/${slug}/openapi.json`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            response.status === 403
              ? 'Sign in to read the API reference for your services.'
              : `Could not load the document (${response.status})`,
          );
        }
        setSpec((await response.json()) as Record<string, unknown>);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      }
    }

    void load();
    return () => controller.abort();
  }, [slug]);

  useEffect(() => {
    const id = 'stoplight-elements';
    if (document.getElementById(id)) return;

    const script = document.createElement('script');
    script.id = id;
    script.src = 'https://unpkg.com/@stoplight/elements/web-components.min.js';
    script.async = true;
    document.body.appendChild(script);
  }, []);

  return (
    <main style={{ maxWidth: 1100 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>API reference</h1>
          <p className="muted" style={{ margin: 0 }}>
            The OpenAPI document for your mock service, generated from its routes.
          </p>
        </div>
        <div style={{ width: 220 }}>
          <label htmlFor="docs-slug">Service</label>
          <input
            id="docs-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="ecommerce"
          />
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!error && !spec && <div className="card">Loading the document…</div>}

      {spec && (
        <div className="card" style={{ padding: 0, minHeight: 600, overflow: 'hidden' }}>
          <elements-api apiDescription={spec} router="hash" layout="sidebar" />
        </div>
      )}
    </main>
  );
}
