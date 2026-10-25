/**
 * KAUSTUBH — custom Next.js server with a WebSocket reverse proxy.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The browser talks to the Python backend over a single WebSocket
 * (`/ws/realtime`, WS#3 down + WS#4 up). The frontend resolves that socket
 * against its OWN origin (`lib/api-base.ts` → `realtimeSocketUrl()`), so the
 * browser opens `ws://<page-host>/ws/realtime`.
 *
 * Next.js' built-in server CANNOT proxy WebSocket upgrades:
 * `next/dist/server/next-server.js` → `handleUpgrade()` is an explicit no-op
 * ("The web server does not support web sockets, it's only used for HMR in
 * development"), and `next.config.js` `rewrites()` only cover HTTP requests.
 * Verified against this repo: `ws://127.0.0.1:3000/ws/realtime` never opens,
 * while `ws://127.0.0.1:8000/ws/realtime` (direct to the backend) opens fine.
 *
 * That single fact is why every "realtime" consumer in this UI had silently
 * degraded to REST polling: the socket never connected, so the pages fell
 * back to their interval fetches.
 *
 * This server fixes that by tunnelling the HTTP `Upgrade` for `/ws/*` to the
 * Python backend, so:
 *   - LOCAL  → browser → :3000 (this server) → :8000 (backend WS)  ✓
 *   - SELF-HOSTED → same path, one origin, no CORS, no mixed content ✓
 *   - VERCEL → the frontend is serverless and CANNOT hold a socket, so the
 *     UI falls back to REST polling. There is no public backend/WS host to
 *     leak (see `lib/api-base.ts`); this server is not involved there.
 *
 * The tunnel is a raw TCP relay: the client's handshake is replayed to the
 * backend, the backend's `101 Switching Protocols` response is replayed back,
 * and then both directions are piped byte-for-byte. Nothing is parsed or
 * rewritten, so WebSocket extensions (e.g. `permessage-deflate`) negotiated by
 * the backend keep working.
 *
 * SECURITY: `/ws/*` is only tunnelled when the request carries the
 * HMAC-signed `kaustubh_session` cookie. The browser cannot set custom headers
 * on a WebSocket handshake, so the cookie is the only credential that can ride
 * along — and the same signature the Next proxy checks is verified here before
 * a single byte reaches the backend.
 *
 * Usage:
 *   node server.mjs            → production (NODE_ENV=production)
 *   NODE_ENV=development node server.mjs → dev mode with HMR
 */

import { createServer } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import next from 'next';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `--production` is the cross-platform switch (inline `NODE_ENV=x cmd` does
// not work on Windows shells, and this project is developed on Windows).
const isProdFlag = process.argv.slice(2).some((a) => a === '--production' || a === '--prod');
const dev = !isProdFlag && process.env.NODE_ENV !== 'production';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOST || '0.0.0.0';

/** Backend that owns the `/ws/realtime` gateway. */
const backendRaw =
  process.env.WS_BACKEND_URL ||
  process.env.BACKEND_URL ||
  'http://127.0.0.1:8000';

/** Only `/ws/...` is tunnelled; everything else stays with Next.js. */
const WS_PATH_PREFIX = '/ws/';

const SESSION_COOKIE = 'kaustubh_session';
let sessionSecretCache = null;

/**
 * Resolve the same HMAC secret as `lib/auth-crypto.ts`:
 * AUTH_SESSION_SECRET → APP_SESSION_SECRET → `.auth/session-secret`.
 * The file is created with `wx` so a simultaneous Next process cannot produce
 * two different secrets; whichever writes first wins and both re-read it.
 */
function resolveSessionSecret() {
  if (sessionSecretCache) return sessionSecretCache;

  const fromEnv = (process.env.AUTH_SESSION_SECRET || process.env.APP_SESSION_SECRET || '').trim();
  if (fromEnv.length >= 32) {
    sessionSecretCache = fromEnv;
    return sessionSecretCache;
  }

  const dir = path.join(__dirname, '.auth');
  const file = path.join(dir, 'session-secret');
  const readStored = () => {
    try {
      if (!existsSync(file)) return '';
      const stored = readFileSync(file, 'utf-8').trim();
      return stored.length >= 32 ? stored : '';
    } catch {
      return '';
    }
  };

  const existing = readStored();
  if (existing) {
    sessionSecretCache = existing;
    return sessionSecretCache;
  }

  try {
    mkdirSync(dir, { recursive: true });
    const generated = randomBytes(48).toString('hex');
    try {
      writeFileSync(file, generated, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    sessionSecretCache = readStored() || null;
  } catch (err) {
    console.error('[WS-PROXY] could not initialise the session secret:', err?.message ?? err);
    sessionSecretCache = null;
  }
  return sessionSecretCache;
}

function readSessionCookie(header) {
  if (!header || typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return trimmed.slice(eq + 1);
    }
  }
  return '';
}

/** Verify the HMAC-signed session cookie before touching the backend socket. */
function hasValidSession(req) {
  const secret = resolveSessionSecret();
  if (!secret) return false;

  const token = readSessionCookie(req.headers.cookie);
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return false;

  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    if (!payload || payload.authenticated !== true) return false;
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

const HEADER_ALLOW_LIST = [
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'origin',
  'user-agent',
  'cookie',
  'x-forwarded-for',
  'x-real-ip',
];

function titleCase(name) {
  return name
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('-');
}

function isWebSocketPath(url) {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return pathname === '/ws' || pathname.startsWith(WS_PATH_PREFIX);
}

/**
 * Relay one WebSocket connection to the backend.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} clientSocket
 * @param {Buffer} head
 */
function proxyWebSocket(req, clientSocket, head) {
  let backend;
  try {
    backend = new URL(backendRaw);
  } catch {
    console.error(`[WS-PROXY] invalid backend URL: ${backendRaw}`);
    clientSocket.destroy();
    return;
  }

  const secure = backend.protocol === 'https:' || backend.protocol === 'wss:';
  const backendPort = Number(backend.port || (secure ? 443 : 80));
  const targetPath = req.url || '/ws/realtime';
  const key = req.headers['sec-websocket-key'];

  if (!key) {
    // Not a WebSocket handshake — nothing to tunnel.
    clientSocket.destroy();
    return;
  }

  const connectOptions = { host: backend.hostname, port: backendPort };
  const upstream = secure
    ? tls.connect({ ...connectOptions, servername: backend.hostname })
    : net.connect(connectOptions);

  let upgraded = false;
  let handshakeBuffer = Buffer.alloc(0);

  const destroyBoth = () => {
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
  };

  upstream.on('error', (err) => {
    if (!upgraded) {
      console.warn(`[WS-PROXY] upstream ${backend.host}:${backendPort} unreachable —`, err?.message ?? err);
    }
    destroyBoth();
  });

  clientSocket.on('error', () => {
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  });

  const requestHeaders = [
    `GET ${targetPath} HTTP/1.1`,
    `Host: ${backend.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  for (const name of HEADER_ALLOW_LIST) {
    const value = req.headers[name];
    if (value) requestHeaders.push(`${titleCase(name)}: ${value}`);
  }

  const onUpstreamData = (chunk) => {
    if (upgraded) return; // after the handshake the pipe owns the stream
    handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
    const boundary = handshakeBuffer.indexOf('\r\n\r\n');
    if (boundary === -1) {
      // Guard against a pathological upstream never terminating the headers.
      if (handshakeBuffer.length > 64 * 1024) destroyBoth();
      return;
    }

    upgraded = true;
    upstream.off('data', onUpstreamData);

    // Replay the backend handshake (101 + headers) to the browser.
    clientSocket.write(handshakeBuffer.subarray(0, boundary + 4));
    const remainder = handshakeBuffer.subarray(boundary + 4);
    if (remainder.length) clientSocket.write(remainder);

    clientSocket.setTimeout(0);
    clientSocket.setNoDelay(true);
    upstream.setTimeout(0);
    upstream.setNoDelay(true);

    // Bidirectional byte relay from here on.
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  };

  upstream.on('data', onUpstreamData);

  upstream.on('connect', () => {
    upstream.write(`${requestHeaders.join('\r\n')}\r\n\r\n`);
    // Bytes the browser already sent after the handshake request.
    if (head && head.length) upstream.write(head);
  });

  if (secure) {
    upstream.on('secureConnect', () => {
      /* connection ready — the 'connect' event covers plain sockets */
    });
  }

  clientSocket.on('close', () => {
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  });
  upstream.on('close', () => {
    try {
      clientSocket.end();
    } catch {
      /* ignore */
    }
  });
}

async function main() {
  const app = next({ dev, hostname, port, dir: __dirname });
  await app.prepare();

  // `app.requestHandler` (not `app.getRequestHandler()`) is deliberate:
  // `getRequestHandler()` lazily calls `setupWebSocketHandler()`, which
  // attaches Next's OWN 'upgrade' listener to this http server. That would
  // double-handle the HMR socket (Next's handler plus ours) and break hot
  // reload. Using the raw handler keeps us the single owner of 'upgrade'.
  const handle = app.requestHandler;
  // Next's own upgrade handler — only used for HMR (`/_next/hmr`) in dev.
  const nextUpgrade = app.upgradeHandler;

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[HTTP] request failed:', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    if (isWebSocketPath(req.url)) {
      if (!hasValidSession(req)) {
        console.warn(`[WS-PROXY] rejected unauthenticated upgrade for ${req.url}`);
        try {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        } catch {
          /* ignore */
        }
        socket.destroy();
        return;
      }
      proxyWebSocket(req, socket, head);
      return;
    }
    // Everything else (HMR in dev) stays with Next.js.
    Promise.resolve(nextUpgrade(req, socket, head)).catch(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  // Keep the AGENTS.md / CLAUDE.md managed block in sync.
  // `next dev` does this through `start-server.js` → `logAppInfo`, which a
  // custom server bypasses — so we call the same helper directly to keep the
  // documented behaviour intact.
  if (dev) {
    try {
      const { writeAgentFiles } = require('next/dist/server/lib/generate-agent-files.js');
      writeAgentFiles(__dirname);
    } catch {
      /* the managed block is a convenience — never block startup on it */
    }
  }

  server.listen(port, hostname, () => {
    console.log(`> KAUSTUBH ready on http://${hostname}:${port} (${dev ? 'dev' : 'production'})`);
    console.log(`> WS proxy: /ws/* → ${backendRaw}${WS_PATH_PREFIX}realtime`);
  });

  const shutdown = (signal) => {
    console.log(`\n> ${signal} received — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
