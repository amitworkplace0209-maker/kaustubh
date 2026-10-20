// KAUSTUBH service worker — v9.
//
// Three jobs, in this order of importance:
//
//   1. APP SHELL / OFFLINE  — a navigation that fails (no network) must still
//      render the app instead of the browser's dinosaur. The last good HTML
//      for that exact route is served, and a dedicated offline page is the
//      final fallback.
//   2. OFFLINE DATA         — every read-only API response is kept so the
//      screens still show their last known, REAL values when the network
//      drops. Nothing is invented: a stale value is served with a marker so
//      the UI can label it as stale.
//   3. PUSH / NOTIFICATIONS  — background Web Push delivery plus the
//      notificationclick routing that opens the right page inside the app.
//
// Caching rules
//   • navigations      → network-first, fall back to the cached page, then to
//                        the offline page.
//   • Next.js assets   → network-first with a cache fill (a stale JS chunk is
//                        far worse than a slow one).
//   • static assets    → cache-first with a background revalidate.
//   • read-only APIs   → stale-while-revalidate.
//   • everything else  → network-first with a cache fill.

const CACHE_VERSION = 'v9';
const CACHE_NAME = `kaustubh-shell-${CACHE_VERSION}`;
const DATA_CACHE = `kaustubh-data-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';

const STATIC_ASSETS = [
  '/',
  '/login',
  OFFLINE_URL,
  '/manifest.json',
  '/manifest-data.json',
  '/manifest-trading.json',
  '/manifest-services.json',
  '/manifest-ai.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-192-maskable.png',
  '/icon-512-maskable.png',
];

/** API paths whose response must NEVER be cached (identity / session / liveness). */
const NEVER_CACHE = [
  '/api/auth/',
  '/api/demo/login',
  '/api/demo/logout',
  '/api/phase2/login',
  '/api/phase2/logout',
  // The liveness probe is used to decide whether the app is online — a
  // cached "ok" would hide a dead connection.
  '/api/health',
];

const isNextAsset = (url) =>
  url.pathname.startsWith('/_next/') ||
  url.pathname.startsWith('/__nextjs') ||
  url.pathname.startsWith('/_nextjs');

const isNeverCache = (pathname) =>
  NEVER_CACHE.some((p) => pathname === p || pathname.startsWith(p));

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------
const TRADING_URL = '/trading/dashboard';
const NOTIF_ICON = '/icon-192.png';
const NOTIF_BADGE = '/icon-192-maskable.png';

const NOTIFICATION_TYPES = {
  ORDER_EXECUTED: 'order_executed',
  ORDER_TARGET: 'target',
  ORDER_STOP_LOSS: 'stop_loss',
  PRICE_ALERT: 'price_alert',
  AI_SUGGESTION: 'ai_suggestion',
};

/**
 * Normalizes a push payload into a consistent
 * { title, body, tag, icon, badge, actions } shape regardless of the
 * originating notification type.
 */
function normalizeNotification(data) {
  const kind = data?.kind ?? data?.type ?? 'executed';
  const symbol = data?.symbol ?? data?.tradingSymbol ?? data?.trading_symbol ?? 'SYMBOL';
  const side = (data?.side ?? data?.transactionType ?? '').toUpperCase();
  const price = data?.price ?? data?.executedPrice ?? data?.executed_price ?? data?.ltp;
  const orderId = data?.orderId ?? data?.order_id ?? data?.squareOffOrderId ?? null;

  let title = 'Trading Alert';
  let body = '';
  let icon = NOTIF_ICON;
  let badge = NOTIF_BADGE;
  const priceTxt =
    price != null && Number.isFinite(Number(price))
      ? ` @ ${Number(price).toLocaleString('en-IN')}`
      : '';

  // --- Order alerts ---
  if (kind === NOTIFICATION_TYPES.ORDER_TARGET) {
    title = 'Target Hit';
    body = `Target hit for ${symbol}${priceTxt}`;
  } else if (kind === NOTIFICATION_TYPES.ORDER_STOP_LOSS) {
    title = 'Stop Loss Triggered';
    body = `Stop loss triggered for ${symbol}${priceTxt}`;
  } else if (kind === NOTIFICATION_TYPES.ORDER_EXECUTED) {
    if (side === 'SELL') title = 'Sell Order Executed';
    else if (side === 'BUY') title = 'Buy Order Executed';
    body = `${side || 'ORDER'} order executed — ${symbol}${priceTxt}`;
  }

  // --- Price alerts ---
  else if (kind === NOTIFICATION_TYPES.PRICE_ALERT) {
    const direction = data?.direction ?? data?.condition ?? '';
    const targetPrice = data?.targetPrice ?? data?.target_price ?? '';
    title = `Price Alert: ${symbol}`;
    body = `${symbol} hit${direction ? ` ${direction}` : ''} ${targetPrice || price || ''}${priceTxt}`;
  }

  // --- AI suggestions ---
  else if (kind === NOTIFICATION_TYPES.AI_SUGGESTION) {
    const strategy = data?.strategy ?? data?.model ?? 'AI';
    title = `AI Suggestion — ${strategy}`;
    body = data?.message ?? data?.suggestion ?? `New suggestion for ${symbol}`;
    icon = data?.icon ?? NOTIF_ICON;
    badge = data?.badge ?? NOTIF_BADGE;
  }

  // --- Fallback ---
  else {
    if (side === 'SELL') title = 'Sell Order Executed';
    else if (side === 'BUY') title = 'Buy Order Executed';
    body = `${side || 'ORDER'} order — ${symbol}${priceTxt}`;
  }

  const tag = `kaustubh-${orderId ?? `${kind}-${symbol}-${Date.now()}`}`;

  const defaultActions = [
    { action: 'view', title: 'View' },
    { action: 'dismiss', title: 'Dismiss' },
  ];

  return {
    title: data?.title || title,
    body: data?.body || body,
    tag,
    icon: data?.icon || icon,
    badge: data?.badge || badge,
    actions: data?.actions || defaultActions,
  };
}

// ---------------------------------------------------------------------------
// push event
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  if (!('Notification' in self) || self.Notification.permission !== 'granted') return;

  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const { title, body, tag, icon, badge, actions } = normalizeNotification(data);

  const options = {
    body,
    icon,
    badge,
    tag,
    renotify: true,
    vibrate: [120, 60, 120],
    silent: !!data?.silent,
    timestamp: Date.now(),
    data: {
      url: data?.url || TRADING_URL,
      receivedAt: Date.now(),
      kind: data?.kind ?? data?.type ?? 'executed',
      symbol: data?.symbol ?? null,
    },
    actions,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---------------------------------------------------------------------------
// notificationclick — focus the running app and open the target page
// ---------------------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || TRADING_URL;

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of all) {
        if (!('focus' in client)) continue;
        try {
          const clientOrigin = new URL(client.url).origin;
          if (clientOrigin === self.location.origin) {
            await client.focus();
            // Only navigate when the app is actually on a different page —
            // re-navigating the same URL would reset the app state.
            const current = new URL(client.url);
            const target = new URL(targetUrl, self.location.origin);
            if (current.pathname !== target.pathname && client.navigate) {
              await client.navigate(targetUrl);
            }
            return;
          }
        } catch {
          /* keep looking */
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});

// ---------------------------------------------------------------------------
// notificationclose — analytics / cleanup hook
// ---------------------------------------------------------------------------
self.addEventListener('notificationclose', (event) => {
  const data = event.notification?.data || {};
  if (data.kind || data.symbol) {
    console.log('[SW] notification closed', data);
  }
});

// ---------------------------------------------------------------------------
// message — in-page "show notification" + update control
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'NOTIFY') {
    const { title, body, tag, icon, badge, actions } = normalizeNotification(msg.payload ?? {});
    const options = {
      body,
      icon,
      badge,
      tag,
      silent: true,
      data: { url: msg.payload?.url || TRADING_URL, receivedAt: Date.now() },
      actions,
    };
    event.waitUntil(self.registration.showNotification(title, options));
  }

  // Activate a waiting worker immediately (the "Update app" button).
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// Install / Activate
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // One failed asset must not abort the whole precache.
        Promise.all(
          STATIC_ASSETS.map((asset) => cache.add(asset).catch(() => undefined)),
        ),
      )
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const keep = new Set([CACHE_NAME, DATA_CACHE]);
      await Promise.all(
        keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
      // Navigation preload makes the network round-trip start before the
      // navigation handler is even called.
      try {
        if ('navigationPreload' in self.registration) {
          await self.registration.navigationPreload.enable();
        }
      } catch {
        /* not supported — the plain fetch path still works */
      }
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch — cache strategy per request type
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // --- Next.js build assets: network-first ------------------------------
  if (isNextAsset(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // --- Navigations: network-first, then the cached page, then offline ---
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const preload = await event.preloadResponse;
          console.log('[SW] preload resolved', preload ? 'with response' : 'empty');
          if (preload) {
            const copy = preload.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch((e) => console.log('[SW] cache.put failed', e));
            return preload;
          }
        } catch (e) {
          console.log('[SW] preload rejected', e && e.message);
        }
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch((e) => console.log('[SW] cache.put failed', e));
          }
          return response;
        } catch (e) {
          console.log('[SW] navigation fetch failed', e && e.message);
          // Offline: serve the last good copy of THIS page…
          const cached = await caches.match(request, { ignoreSearch: true });
          if (cached) return cached;
          // …and if we never had one, the dedicated offline page.
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
              '<body style="font-family:system-ui;background:#060a08;color:#e6e6e6;' +
              'display:flex;min-height:100vh;align-items:center;justify-content:center;' +
              'margin:0"><div style="text-align:center"><h1>You are offline</h1>' +
              '<p>Reconnect to open KAUSTUBH.</p></div></body>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  // --- Static assets: cache-first with a background revalidate ----------
  if (
    request.destination === 'style' ||
    request.destination === 'font' ||
    request.destination === 'image' ||
    request.destination === 'script'
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      }),
    );
    return;
  }

  // --- Read-only API: stale-while-revalidate ---------------------------
  // The offline screens show the last REAL values the backend returned; the
  // payload is never fabricated.
  if (url.pathname.startsWith('/api/') && !isNeverCache(url.pathname)) {
    event.respondWith(
      caches.open(DATA_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const fetchAndCache = fetch(request)
            .then((response) => {
              if (response.ok) {
                const copy = response.clone();
                cache.put(request, copy).catch(() => {});
              }
              return response;
            })
            .catch(() => {
              if (cached) return cached;
              return new Response(
                JSON.stringify({ error: 'offline', cached: false }),
                {
                  status: 503,
                  headers: { 'Content-Type': 'application/json' },
                },
              );
            });
          if (cached) {
            fetchAndCache.catch(() => {});
            return cached;
          }
          return fetchAndCache;
        }),
      ),
    );
    return;
  }

  // --- Auth / session endpoints: always live, never cached --------------
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    return;
  }

  // --- Everything else: network-first with a cache fill -----------------
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});

// ---------------------------------------------------------------------------
// Background sync — revalidate the cached API data when the network returns
// ---------------------------------------------------------------------------
self.addEventListener('sync', (event) => {
  if (event.tag !== 'kaustubh-revalidate') return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(DATA_CACHE);
      const keys = await cache.keys();
      await Promise.all(
        keys.map(async (request) => {
          try {
            const response = await fetch(request);
            if (response.ok) await cache.put(request, response);
          } catch {
            /* still offline */
          }
        }),
      );
    })(),
  );
});
