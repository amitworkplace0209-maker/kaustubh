'use client';

/**
 * Per-device Khumbha AI endpoint.
 *
 * The AI phase is served from the VM, but inference must run on the device the
 * user is holding. That means the endpoint is a *device* setting, not a build
 * setting. `NEXT_PUBLIC_AI_API_BASE` remains the default; the user can point the
 * bridge at another loopback/LAN port from `/ai/settings` and the choice is
 * stored in localStorage on that device only.
 *
 * The token is optional. Set `AI_BRIDGE_TOKEN` on the bridge, then paste the
 * same value in settings. It is sent as `X-Khumbha-AI-Token` and is never sent
 * to the VM.
 */

export const DEFAULT_AI_ENDPOINT =
  process.env.NEXT_PUBLIC_AI_API_BASE || 'http://127.0.0.1:8001';

const ENDPOINT_KEY = 'khumbha.ai.endpoint';
const TOKEN_KEY = 'khumbha.ai.token';

/** Validate + canonicalise a bridge URL. Returns null when invalid. */
export function normalizeAiEndpoint(value: string): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

/** The endpoint this browser should talk to. SSR falls back to the build default. */
export function getAiEndpoint(): string {
  if (typeof window === 'undefined') {
    return normalizeAiEndpoint(DEFAULT_AI_ENDPOINT) || DEFAULT_AI_ENDPOINT;
  }
  const stored = window.localStorage.getItem(ENDPOINT_KEY);
  return (
    normalizeAiEndpoint(stored || '') ||
    normalizeAiEndpoint(DEFAULT_AI_ENDPOINT) ||
    DEFAULT_AI_ENDPOINT
  );
}

/** Persist a new endpoint for this device. Throws on an invalid URL. */
export function setAiEndpoint(value: string): string {
  const normalized = normalizeAiEndpoint(value);
  if (!normalized) throw new Error('Enter a valid http:// or https:// endpoint');
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(ENDPOINT_KEY, normalized);
  }
  return normalized;
}

/** Remove the per-device override and fall back to the build default. */
export function resetAiEndpoint(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(ENDPOINT_KEY);
}

/** True when this device overrides the build-time default. */
export function hasAiEndpointOverride(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(normalizeAiEndpoint(window.localStorage.getItem(ENDPOINT_KEY) || ''));
}

export function getAiToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(TOKEN_KEY) || '';
}

export function setAiToken(value: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = String(value || '').trim();
  if (trimmed) window.localStorage.setItem(TOKEN_KEY, trimmed);
  else window.localStorage.removeItem(TOKEN_KEY);
}
