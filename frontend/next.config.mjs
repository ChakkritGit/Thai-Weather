/**
 * The Python backend (FastAPI) is reached through rewrites, so the browser
 * only ever talks to this origin – no CORS setup needed.
 * THWX_API_URL must be set at build time AND run time (e.g. on Vercel).
 */
const API = (process.env.THWX_API_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');

/**
 * Security headers for every page. Next's own hydration scripts are inline, hence 'unsafe-inline'
 * for scripts; the rest is locked to this origin (fonts included), and the site cannot be framed.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' data: blob:", // MapLibre fetches its image layers from data: URLs
  "worker-src 'self' blob:", // MapLibre's workers
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const BASE_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];
/**
 * Document-only headers. Kept off images, the manifest and static files: iOS's home-screen icon
 * fetcher fetched the touch icon fine yet fell back to a letter tile while these were on it.
 */
const PAGE_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Frame-Options', value: 'DENY' },
  // the map asks for location; nothing else needs device features
  { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // loads its WebAssembly with top-level await: keep it out of the server bundle (lib/ogText.ts)
  serverExternalPackages: ['harfbuzzjs'],
  async headers() {
    return [
      { source: '/:path*', headers: BASE_HEADERS },
      // the font files never change under a name; a new cut gets a new file name
      { source: '/fonts/plex/:file*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      {
        source:
          '/((?!_next/static|_next/image|app-icons|apple-touch-icon|favicon|splash|icons|og|maplibre|fonts|manifest\\.webmanifest).*)',
        headers: PAGE_HEADERS,
      },
    ];
  },
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${API}/api/v1/:path*` },
      { source: '/favicon.ico', destination: '/app-icons/icon-192.png' },
    ];
  },
};

export default nextConfig;
