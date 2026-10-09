/**
 * The Python backend (FastAPI) is reached through rewrites, so the browser
 * only ever talks to this origin – no CORS setup needed.
 * THWX_API_URL must be set at build time AND run time (e.g. on Vercel).
 */
const API = (process.env.THWX_API_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${API}/api/v1/:path*` },
      { source: '/docs', destination: `${API}/docs` },
      { source: '/openapi.json', destination: `${API}/openapi.json` },
    ];
  },
};

export default nextConfig;
