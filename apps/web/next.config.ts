import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep Next.js a pure client. The API boundary must stay visible so the
  // separate Fastify service, CORS config, and auth cookies are real.
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
