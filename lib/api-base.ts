/**
 * The backend base URL used by BROWSER code.
 *
 * In the browser this is deliberately the EMPTY string, so every request
 * becomes SAME-ORIGIN (`/api/...`). The rewrite in `next.config.js` forwards
 * any `/api` path that has no local route handler to the Python service, so
 * no call site needs to change.
 *
 * The real backend origin (`BACKEND_URL`) is server-only. It is never inlined
 * into the client bundle and never shown in the UI — the browser only ever
 * sees this origin.
 *
 * Why this matters more than it looks: an absolute `http://127.0.0.1:8000`
 * is resolved by the DEVICE, not by the server. On the machine that hosts the
 * backend it happens to work; on a phone — the whole point of a PWA — 127.0.0.1
 * is the phone itself, so every one of those requests fails. That is why the
 * live prices, the dummy terminal and the realtime socket were dead on a real
 * Android device while working perfectly on the developer's laptop.
 */
export const API_BASE =
  typeof window !== 'undefined'
    ? ''
    : process.env.BACKEND_URL || 'http://127.0.0.1:8000';

/**
 * The realtime WebSocket URL.
 *
 * The socket always targets the page's own origin
 * (`ws(s)://<page-host>/ws/realtime`). `server.mjs` tunnels `/ws/*` to the
 * Python backend, so the browser works from a phone on the LAN, behind a
 * reverse proxy and over HTTPS without mixed-content errors.
 *
 * Serverless (Vercel): there is no long-lived process to tunnel the upgrade,
 * so an explicitly configured `NEXT_PUBLIC_WS_URL` (the public HTTPS tunnel's
 * `wss://.../ws/realtime`) is used instead. The gateway still requires a
 * short-lived `?token=` for every connection, and no credential is embedded
 * in this URL. When it is unset the browser keeps the same-origin behaviour;
 * on Vercel realtime then degrades to REST polling, which is the honest
 * fallback rather than a socket that can never open.
 */
export function realtimeSocketUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_WS_URL || '').trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') {
        return parsed.toString();
      }
    } catch {
      /* invalid override — fall through to the same-origin URL */
    }
  }

  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/realtime`;
  }
  const base = process.env.WS_BACKEND_URL || process.env.BACKEND_URL || 'http://127.0.0.1:8000';
  try {
    const parsed = new URL(base);
    const proto = parsed.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${parsed.host}/ws/realtime`;
  } catch {
    return 'ws://127.0.0.1:8000/ws/realtime';
  }
}
