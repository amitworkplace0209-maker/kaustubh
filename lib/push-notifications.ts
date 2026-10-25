/**
 * Push notification helpers for the KAUSTUBH trading PWA.
 *
 * VAPID public key — pairs with `VAPID_PRIVATE_KEY` in `python-service/.env`
 * (generated 2026-10-07,ist). The backend `push_delivery` service signs pushes
 * with the private half; mismatched keys fail closed (subscription rejected).
 */
const VAPID_PUBLIC_KEY =
  'BMFSlZMbc77ro8IfEYhvEl-a8LmHon3t-nTEWjoW_rDlmN8N-v0I8VTlymAqZDFy4d1MZCgrQXQp1EegHn0g7xM';

const PUSH_SUBSCRIPTION_KEY = 'kaustubh_push_subscription';

// ---------------------------------------------------------------------------
// Capability checks
// ---------------------------------------------------------------------------

export function isPushNotificationSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function getNotificationPermission(): NotificationPermission {
  if (!isPushNotificationSupported()) return 'denied';
  return Notification.permission;
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isPushNotificationSupported()) return 'denied';

  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';

  const result = await Notification.requestPermission();
  return result;
}

// ---------------------------------------------------------------------------
// VAPID key resolution
// ---------------------------------------------------------------------------

let vapidKeyCache: string | null = null;

/**
 * The VAPID public key is normally the compiled-in one, but the backend is
 * the source of truth: if it ever rotates its key pair, the browser MUST use
 * the new public key or every subscription is rejected. So the backend is
 * asked once and the answer is cached for the session.
 */
export async function resolveVapidPublicKey(): Promise<string> {
  if (vapidKeyCache) return vapidKeyCache;
  try {
    const status = await fetchPushStatus();
    if (status?.vapidPublicKey) {
      vapidKeyCache = status.vapidPublicKey;
      return vapidKeyCache;
    }
  } catch {
    /* backend unreachable — fall back to the compiled-in key */
  }
  vapidKeyCache = VAPID_PUBLIC_KEY;
  return vapidKeyCache;
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function subscribeToPushNotifications(
  registration: ServiceWorkerRegistration
): Promise<PushSubscription | null> {
  if (!isPushNotificationSupported()) return null;
  if (Notification.permission !== 'granted') return null;

  try {
    const vapidKey = await resolveVapidPublicKey();
    let subscription = await registration.pushManager.getSubscription();

    // A subscription made with an OLD VAPID key is useless — the backend
    // signs with the new private key and rejects it. Detect that by
    // comparing the stored key with the current one and re-subscribing.
    if (subscription) {
      const storedKey = subscription.options?.applicationServerKey;
      const current = urlBase64ToUint8Array(vapidKey);
      const storedBytes = storedKey ? new Uint8Array(storedKey as ArrayBuffer) : null;
      const sameKey =
        storedBytes !== null &&
        storedBytes.byteLength === current.byteLength &&
        storedBytes.every((byte, i) => byte === current[i]);
      if (!sameKey) {
        await subscription.unsubscribe().catch(() => {});
        subscription = null;
      }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }

    // Persist to localStorage so the app can send it to the backend on login.
    localStorage.setItem(PUSH_SUBSCRIPTION_KEY, JSON.stringify(subscription.toJSON()));

    // Notify any open tab about the new subscription.
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'PUSH_SUBSCRIPTION_UPDATE',
      });
    }

    return subscription;
  } catch (err) {
    console.error('[Push] subscribe failed', err);
    return null;
  }
}

export async function unsubscribeFromPushNotifications(
  registration?: ServiceWorkerRegistration
): Promise<boolean> {
  if (!isPushNotificationSupported()) return false;

  try {
    const reg = registration ?? (await navigator.serviceWorker?.ready);
    if (!reg) return false;

    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      localStorage.removeItem(PUSH_SUBSCRIPTION_KEY);
      return true;
    }

    const result = await subscription.unsubscribe();
    localStorage.removeItem(PUSH_SUBSCRIPTION_KEY);
    return result;
  } catch (err) {
    console.error('[Push] unsubscribe failed', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Returns the locally-cached push subscription (JSON-safe object) or null.
 * Useful for sending the subscription to the backend without re-querying
 * the ServiceWorker registration.
 */
export function getStoredPushSubscription(): PushSubscriptionJSON | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PUSH_SUBSCRIPTION_KEY);
    return raw ? (JSON.parse(raw) as PushSubscriptionJSON) : null;
  } catch {
    return null;
  }
}

/**
 * Returns true if a valid subscription exists locally.
 */
export function hasActivePushSubscription(): boolean {
  return getStoredPushSubscription() !== null;
}

// ---------------------------------------------------------------------------
// Backend registration
// ---------------------------------------------------------------------------

/**
 * The push endpoints are reached through the app's OWN origin (`/api/...`),
 * which `next.config.js` rewrites to the Python service.
 *
 * The previous implementation called `http://127.0.0.1:8000` directly. That
 * only works when the browser happens to run on the same machine as the
 * backend — on a real Android phone (or any other device on the LAN) the
 * phone's own loopback address is the PHONE, so every push registration
 * failed silently and the device never received a single notification.
 * Going through the same origin works on the phone, on the desktop and in
 * production, with no configuration.
 */
const PUSH_API = '';

async function pushApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PUSH_API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`push api ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  return (await res.json()) as T;
}

export interface PushStatus {
  ok: boolean;
  enabled: boolean;
  vapidPublicKey: string | null;
  subscriptions: number;
}

// In-flight dedupe: the Settings page reads this on mount and again after a
// push action. Without sharing the request, React StrictMode's double mount
// sends two identical status calls and the second one queues behind the first.
let _pushStatusInFlight: Promise<PushStatus> | null = null;

export async function fetchPushStatus(): Promise<PushStatus> {
  if (!_pushStatusInFlight) {
    _pushStatusInFlight = pushApi<PushStatus>('/api/notifications/push/status')
      .finally(() => { _pushStatusInFlight = null; });
  }
  return _pushStatusInFlight;
}

export async function registerPushSubscription(
  sub: PushSubscriptionJSON,
  label = '',
): Promise<{ ok: boolean; endpoint: string }> {
  return pushApi('/api/notifications/push/subscription', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: sub.keys,
      label,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    }),
  });
}

export async function unregisterPushSubscription(endpoint: string): Promise<{ ok: boolean }> {
  return pushApi(`/api/notifications/push/subscription?endpoint=${encodeURIComponent(endpoint)}`, {
    method: 'DELETE',
  });
}

export async function sendTestPush(): Promise<{ ok: boolean; sent: number }> {
  return pushApi('/api/notifications/push/test', { method: 'POST' });
}

/**
 * One-tap enable: permission → SW subscribe → backend register.
 * Returns an honest reason string when it cannot proceed.
 */
export async function enablePush(label = 'trading-pwa'): Promise<{ ok: boolean; reason?: string }> {
  if (!isPushNotificationSupported()) return { ok: false, reason: 'Push not supported on this browser.' };
  const perm = await requestNotificationPermission();
  if (perm !== 'granted') return { ok: false, reason: 'Notification permission not granted.' };
  const reg = await navigator.serviceWorker?.ready;
  if (!reg) return { ok: false, reason: 'Service worker not ready.' };
  const sub = await subscribeToPushNotifications(reg);
  if (!sub) return { ok: false, reason: 'Subscription failed.' };
  try {
    await registerPushSubscription(sub.toJSON(), label);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Backend register failed.' };
  }
  return { ok: true };
}

export async function disablePush(): Promise<{ ok: boolean }> {
  const stored = getStoredPushSubscription();
  if (stored?.endpoint) {
    try {
      await unregisterPushSubscription(stored.endpoint);
    } catch {
      /* backend already gone — still drop local state */
    }
  }
  return { ok: await unsubscribeFromPushNotifications() };
}
