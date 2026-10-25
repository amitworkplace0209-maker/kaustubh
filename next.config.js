/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  // Dev-only: allow the loopback host the app is served on. The frontend
  // defaults point at IPv4 (127.0.0.1) to match the backend bind, and Next's
  // dev server refuses cross-origin /_next/* (HMR) requests from non-localhost
  // origins unless explicitly allowed — which wedges reliability on 127.0.0.1.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  async headers() {
    return [
      {
        // The service worker must NEVER be served from the HTTP cache:
        // a stale worker keeps serving an old app shell forever, which is the
        // classic "the app did not update" PWA bug.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
          // The worker is registered at the root scope.
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        // The manifest is swapped per workspace at runtime — it must never be
        // cached by the browser either.
        source: '/manifest.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      {
        source: '/manifest-trading.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      {
        source: '/manifest-data.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      {
        source: '/manifest-services.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      {
        source: '/manifest-ai.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      {
        source: '/offline.html',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
    ];
  },
  async rewrites() {
    // The browser cannot complete cross-origin requests to the Python service
    // on 127.0.0.1:8000, so the frontend calls its own /api/* paths and Next
    // forwards them here. `afterFiles` means real route handlers under app/api
    // (search, ticks/stream, auth, market-watch, ...) still win — this only
    // catches the paths that have no local handler.
    const backend = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
    return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
  },
  async redirects() {
    return [
      // Root → login (middleware handles auth check).
      { source: '/', destination: '/login', permanent: false },
      // Legacy workspace selector → login.
      { source: '/workspace', destination: '/login', permanent: false },
      // Legacy /dashboard → trading workspace.
      { source: '/dashboard', destination: '/trading/dashboard', permanent: false },
      // Legacy flat routes → workspace routes (backward compat).
      { source: '/orders', destination: '/trading/orders', permanent: false },
      { source: '/positions', destination: '/trading/positions', permanent: false },
      { source: '/holdings', destination: '/trading/holdings', permanent: false },
      { source: '/portfolio', destination: '/trading/portfolio', permanent: false },
      { source: '/funds', destination: '/trading/funds', permanent: false },
      { source: '/calculator', destination: '/trading/calculator', permanent: false },
      { source: '/market-watch', destination: '/trading/market-watch', permanent: false },
      { source: '/order-history', destination: '/trading/order-history', permanent: false },
      { source: '/notifications', destination: '/trading/notifications', permanent: false },
      { source: '/settings', destination: '/trading/settings', permanent: false },
      { source: '/system', destination: '/services/system', permanent: false },
      { source: '/system-indicators', destination: '/services/system-indicators', permanent: false },
      // Data Saver root → dashboard.
      { source: '/phase2', destination: '/data-saver/dashboard', permanent: false },
      // Legacy Phase 2 Data Saver routes → current Data Saver application.
      { source: '/phase2/:path*', destination: '/data-saver/:path*', permanent: false },
      // Legacy flat Data Server routes → current Data Saver application.
      { source: '/stocks', destination: '/data-saver/subscription', permanent: false },
      { source: '/live-ticks', destination: '/data-saver/ticks', permanent: false },
      { source: '/downloads', destination: '/data-saver/downloads', permanent: false },
      { source: '/downloads/formats', destination: '/data-saver/formats', permanent: false },
      { source: '/downloads/schedules', destination: '/data-saver/schedules', permanent: false },
      // Legacy /data/* navigation → Data Saver application (explicit name mapping).
      { source: '/data/dashboard', destination: '/data-saver/dashboard', permanent: false },
      { source: '/data/stocks', destination: '/data-saver/subscription', permanent: false },
      { source: '/data/live-ticks', destination: '/data-saver/ticks', permanent: false },
      { source: '/data/market-watch', destination: '/data-saver/watch', permanent: false },
      { source: '/data/downloads', destination: '/data-saver/downloads', permanent: false },
      { source: '/data/downloads/formats', destination: '/data-saver/formats', permanent: false },
      { source: '/data/downloads/schedules', destination: '/data-saver/schedules', permanent: false },
      { source: '/data/downloads/schedules/new', destination: '/data-saver/schedules/new', permanent: false },
      { source: '/data/download-history', destination: '/data-saver/download-history', permanent: false },
      { source: '/data/quality', destination: '/data-saver/quality', permanent: false },
      { source: '/data/tick-analytics', destination: '/data-saver/analytics', permanent: false },
      { source: '/data/insights', destination: '/data-saver/insights', permanent: false },
      { source: '/data/notifications', destination: '/data-saver/alerts', permanent: false },
      { source: '/data/settings', destination: '/data-saver/configuration', permanent: false },
      // Legacy /data/* fallback → Data Saver (identical route names).
      { source: '/data/:path*', destination: '/data-saver/:path*', permanent: false },
    ];
  },
};

module.exports = nextConfig;
