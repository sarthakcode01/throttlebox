'use client';

import { useEffect, useState } from 'react';

/**
 * The OpenAPI reference for a mock service.
 *
 * Stoplight Elements renders the document, so a developer can read the
 * endpoints, try them, and copy a request without leaving the page. The
 * script is loaded from a CDN — it is a documentation viewer, not part of
 * the product's own bundle.
 */
export default function DocsPage() {
  const [slug, setSlug] = useState('ecommerce');
  const [specUrl, setSpecUrl] = useState<string | null>(null);

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    setSpecUrl(`${apiUrl}/docs/${slug}/openapi.json`);
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

      {specUrl && (
        <div className="card" style={{ padding: 0, minHeight: 600, overflow: 'hidden' }}>
          <elements-api apiDescriptionUrl={specUrl} router="hash" layout="sidebar" />
        </div>
      )}
    </main>
  );
}
