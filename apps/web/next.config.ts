import type { NextConfig } from 'next';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Content Security Policy.
 *
 * The dashboard renders user-controlled text (service names, route paths,
 * webhook URLs, chaos messages), so a CSP is a second line of defence if an
 * injection ever reaches the DOM. It ships report-only first, so a missed
 * source shows up in the console instead of breaking the page; switch the
 * header name to `Content-Security-Policy` once it is clean.
 *
 * `unpkg.com` is the pinned, SRI-checked Stoplight Elements bundle on the
 * docs page. Next.js needs inline scripts and styles for hydration.
 */
const csp = [
  "default-src 'self'",
  `connect-src 'self' ${apiUrl}`,
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep Next.js a pure client. The API boundary must stay visible so the
  // separate Fastify service, CORS config, and auth cookies are real.
  typedRoutes: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy-Report-Only', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
