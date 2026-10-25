'use client';

/**
 * Desktop (web / OS) notifications — policy and delivery.
 *
 * The PWA already had a Web Push path, but a notification arriving while the
 * app is OPEN in an ordinary browser tab never surfaced as a real system
 * notification: it only incremented a badge. This module closes that gap and,
 * just as importantly, decides *when not to* raise one.
 *
 * THE NOISE RULE (why this file exists)
 * --------------------------------------
 * A notification that re-fires every time the same problem is observed is
 * worse than no notification. Three independent guards, all of which must
 * pass before anything appears on screen:
 *
 *   1. Backend dedupe — the engine/reporter folds a repeat into one row and
 *      emits `notification_updated` (not `notification_created`). This module
 *      ignores update frames entirely, so a bump can never raise a popup.
 *   2. Session guard — a per-tag cooldown below, so a re-delivered SSE frame
 *      (reconnect replay, tab remount) cannot raise the same incident twice.
 *   3. Native `tag` — the browser replaces any visible notification carrying
 *      the same tag instead of stacking a new one. This is the guard that
 *      survives a page reload, which the other two cannot.
 *
 * Severity threshold is the fourth gate: informational noise stays in-app.
 */

export type DesktopSeverity = 'info' | 'success' | 'warning' | 'error' | 'critical';

const SEVERITY_RANK: Record<DesktopSeverity, number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/** Below this, a notification stays in the app and never pops the OS. */
export const DEFAULT_MIN_SEVERITY: DesktopSeverity = 'warning';

export function severityRank(s: string | undefined): number {
  return SEVERITY_RANK[(s ?? 'info') as DesktopSeverity] ?? 0;
}

/** Only real trouble is allowed to interrupt. */
export function isUrgent(s: string | undefined): boolean {
  return severityRank(s) >= SEVERITY_RANK.error;
}

const ICON = '/icon-192.png';
const BADGE = '/icon-192-maskable.png';

/* ------------------------------------------------------------------ */
/* Session dedupe guard                                                 */
/* ------------------------------------------------------------------ */

const _raisedAt = new Map<string, number>();

/** Re-raise the same incident at most this often, per page session. */
const SESSION_COOLDOWN_MS = 5 * 60 * 1000;

/** Bounded so a long-lived tab cannot grow this without limit. */
const MAX_TRACKED = 300;

/**
 * Claim the right to raise this tag.
 *
 * Returns false if the same incident was already raised inside the cooldown,
 * which is what stops a reconnect replay from re-popping the same alert.
 */
export function claimTag(tag: string, nowMs: number = Date.now()): boolean {
  const last = _raisedAt.get(tag);
  if (last != null && nowMs - last < SESSION_COOLDOWN_MS) return false;
  if (_raisedAt.size >= MAX_TRACKED) {
    // Drop the oldest half rather than the whole map.
    const entries = [..._raisedAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of entries.slice(0, Math.floor(entries.length / 2))) {
      _raisedAt.delete(k);
    }
  }
  _raisedAt.set(tag, nowMs);
  return true;
}

export function resetSessionGuard(): void {
  _raisedAt.clear();
}

/* ------------------------------------------------------------------ */
/* Payload shaping                                                      */
/* ------------------------------------------------------------------ */

export interface DesktopPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  severity: string;
  category: string;
  requireInteraction: boolean;
}

/**
 * Stable identity for the OS notification.
 *
 * Prefers the backend's `deduplication_key` because that is the incident
 * identity the server already agreed on — the exact same key that collapses
 * repeat rows. Falling back to the document id keeps unrelated notifications
 * from collapsing into each other.
 */
export function tagFor(n: Record<string, unknown>): string {
  const dedupe = String(n.deduplication_key ?? '').trim();
  if (dedupe) return `knb:${dedupe}`;
  const id = String(n._id ?? '').trim();
  return id ? `knb:n:${id}` : `knb:t:${String(n.title ?? '')}`;
}

/**
 * Build the OS notification, including the real diagnostic detail.
 *
 * The body is deliberately more than the headline: for an engine incident it
 * carries the from -> to transition and the engine's own reason, because the
 * point of a popup is that you can act on it without opening anything.
 */
export function buildPayload(n: Record<string, unknown>): DesktopPayload {
  const meta = (n.metadata && typeof n.metadata === 'object' ? n.metadata : {}) as Record<string, unknown>;
  const severity = String(n.severity ?? 'info');

  const lines: string[] = [];
  const message = String(n.message ?? '').trim();
  if (message) lines.push(message);

  const engine = String(meta.engine ?? n.component ?? '').trim();
  const from = String(meta.fromState ?? '').trim();
  const to = String(meta.toState ?? '').trim();
  if (engine && (from || to)) {
    lines.push(`${engine}: ${from || '?'} → ${to || '?'}`);
  } else if (engine) {
    lines.push(engine);
  }

  const reason = String(n.reason ?? meta.reason ?? '').trim();
  if (reason && !lines.some((l) => l.includes(reason))) {
    lines.push(reason);
  }

  const occurrences = Number(n.occurrence_count ?? 0);
  if (Number.isFinite(occurrences) && occurrences > 1) {
    lines.push(`Seen ${occurrences}×`);
  }

  const id = String(n._id ?? '');
  return {
    title: String(n.title ?? 'Notification').trim() || 'Notification',
    body: lines.join('\n') || 'No further detail was reported.',
    tag: tagFor(n),
    url: id ? `/data-saver/notifications/${id}` : '/data-saver/notifications',
    severity,
    category: String(n.category ?? 'SYSTEM'),
    requireInteraction: isUrgent(severity),
  };
}

/* ------------------------------------------------------------------ */
/* Delivery                                                             */
/* ------------------------------------------------------------------ */

export function desktopSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function desktopPermission(): NotificationPermission | 'unsupported' {
  if (!desktopSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestDesktopPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!desktopSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Resolve the active service worker WITHOUT blocking delivery.
 *
 * `navigator.serviceWorker.ready` only settles once a service worker is
 * activated for the scope. If registration is missing, failing, or stuck
 * activating, that promise never resolves — and awaiting it would swallow the
 * notification silently, forever. Racing it against a short deadline means the
 * plain `Notification` path always gets a chance to fire.
 */
/**
 * Resolve the active service worker registration WITHOUT blocking delivery.
 *
 * `navigator.serviceWorker.ready` only settles once a worker is activated for
 * the scope. If registration is missing, failing, or stuck activating, that
 * promise never resolves — and awaiting it would swallow the notification
 * silently, forever. Racing it against a short deadline means the plain
 * `Notification` path always gets a chance to fire.
 *
 * Note it is the *registration* that exposes `showNotification`, never the
 * controlling `ServiceWorker`, so that is all this resolves.
 */
async function readyServiceWorker(timeoutMs = 1200): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    return (ready as ServiceWorkerRegistration | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Raise the notification.
 *
 * Prefers the service worker: it is the only path that works on mobile, keeps
 * working after the page is backgrounded, and supports `requireInteraction`.
 * Falls back to the plain constructor — including when the worker exists but is
 * not ready yet, which must never mean "no notification".
 */
export async function deliverDesktopNotification(p: DesktopPayload): Promise<'sw' | 'window' | 'skipped'> {
  if (!desktopSupported() || Notification.permission !== 'granted') return 'skipped';

  const options: NotificationOptions & { renotify?: boolean } = {
    body: p.body,
    icon: ICON,
    badge: BADGE,
    // Replaces any visible notification for this incident instead of stacking.
    tag: p.tag,
    requireInteraction: p.requireInteraction,
    renotify: false,
    data: { url: p.url, category: p.category, severity: p.severity },
  };

  const reg = await readyServiceWorker();
  if (reg?.showNotification) {
    try {
      await reg.showNotification(p.title, options);
      return 'sw';
    } catch {
      // fall through to the window path
    }
  }

  try {
    const n = new Notification(p.title, options);
    n.onclick = () => {
      window.focus();
      window.location.href = p.url;
      n.close();
    };
    return 'window';
  } catch {
    return 'skipped';
  }
}
