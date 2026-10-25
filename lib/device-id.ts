'use client';

/**
 * Stable per-browser device identity used by the 2-device login policy.
 *
 * This is NOT a security boundary (a user can clear storage); the authoritative
 * limits and IP logging live in MongoDB. It only lets a repeat login on the same
 * browser rotate its session instead of consuming the second device slot.
 */

const KEY = 'kaustubh_device_id';

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `dev_${crypto.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  return `dev_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing && /^[A-Za-z0-9_-]{8,80}$/.test(existing)) return existing;
    const created = randomId();
    window.localStorage.setItem(KEY, created);
    return created;
  } catch {
    return randomId();
  }
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

export function describeThisDevice(): string {
  if (typeof navigator === 'undefined') return 'This device';
  const ua = navigator.userAgent || '';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Firefox\//.test(ua) ? 'Firefox'
            : /Safari\//.test(ua) ? 'Safari'
              : 'Browser';
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iPhone / iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Mac OS X/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux'
              : 'Device';
  const pwa = isStandalonePwa() ? ' · PWA' : '';
  return `${browser} · ${os}${pwa}`;
}
