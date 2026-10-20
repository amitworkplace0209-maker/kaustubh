/**
 * The backend base URL used by BROWSER code.
 *
 * In the browser this is deliberately the EMPTY string, so every request
 * becomes SAME-ORIGIN (`/api/...`). The rewrite in `next.config.js` forwards
 * any `/api` path that has no local route handler to the Python service, so
 * no call site needs to change.
 *
 * Why this matters more than it looks: an absolute `http://127.0.0.1:8000`
 * is resolved by the DEVICE, not by the server. On the machine that hosts the
 * backend it happens to work; on a phone — the whole point of a PWA — 127.0.0.1
 * is the phone itself, so every one of those requests fails. That is why the
 * live prices, the dummy terminal and the realtime socket were dead on a real
 * Android device while working perfectly on the developer's laptop.
 *
 * Server-side (Node/SSR) the absolute backend URL is correct and is kept.
 */
export const API_BASE =
  typeof window !== 'undefined'
    ? ''
    : process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';

/**
 * The realtime WebSocket URL.
 *
 * In the browser the socket must point at the page's own origin so it works
 * from a phone on the LAN, through a reverse proxy, or over HTTPS (where a
 * `ws://` socket would be blocked as mixed content).
 */
export function realtimeSocketUrl(): string {
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/realtime`;
  }
  const base = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000';
  try {
    const parsed = new URL(base);
    const proto = parsed.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${parsed.host}/ws/realtime`;
  } catch {
    return 'ws://127.0.0.1:8000/ws/realtime';
  }
}
