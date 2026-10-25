'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  getSettings,
  getSettingsRuntime,
  resetAllSettings as apiResetAll,
  resetSetting as apiResetSetting,
  updateSetting as apiUpdateSetting,
} from '@/lib/api';
import { subscribeSystemFrames } from '@/lib/system-sse';
import { FIELD_INDEX, LIVE_KEYS, SCHEMA_KEYS } from './schema';
import type { SettingsState } from './types';

/**
 * Data Saver Settings store — ONE authoritative client store for all backend
 * settings.
 *
 * - Persistence goes through the existing backend (MongoDB key-value store via
 *   `lib/api` → `/api/settings/...`, validated server-side).
 * - localStorage is only a read-cache with a version/migration guard so a
 *   schema bump never serves stale shapes.
 * - Optimistic writes: value updates instantly, then the backend confirms; the
 *   UI reflects the live saved state without any page reload.
 * - Cross-tab sync via the backend system SSE stream (`state_changed` on the
 *   `settings` entity) plus a periodic background refresh while hydrated.
 */

const CACHE_VERSION = 1;
const CACHE_KEY = `kaustubh-settings-cache-v${CACHE_VERSION}`;
const CACHE_MAX_AGE_MS = 60_000;
const REFRESH_INTERVAL_MS = 30_000;

const INITIAL: SettingsState = {
  settings: {},
  liveKeys: new Set(LIVE_KEYS),
  status: 'idle',
  syncedAt: null,
  pending: {},
  errors: {},
  activity: [],
};

let state: SettingsState = INITIAL;
const listeners = new Set<() => void>();
let hydratePromise: Promise<boolean> | null = null;
let sseOff: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function emit() {
  for (const fn of listeners) fn();
}

function pushActivity(entry: SettingsState['activity'][0]) {
  state = { ...state, activity: [entry, ...state.activity].slice(0, 60) };
}

function patch(partial: Partial<SettingsState>) {
  state = { ...state, ...partial };
  emit();
}

export function getSettingsState(): SettingsState {
  return state;
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Caching (localStorage read-cache, version-guarded)
// ---------------------------------------------------------------------------
function readCache(): { version: number; syncedAt: number; settings: Record<string, any> } | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CACHE_VERSION || !parsed.settings) return null;
    if (Date.now() - parsed.syncedAt > CACHE_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(settings: Record<string, any>) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ version: CACHE_VERSION, syncedAt: Date.now(), settings }),
    );
  } catch {
    /* storage disabled / full — cache is non-critical */
  }
}

export function clearLocalSettingsCache() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Hydration / refresh
// ---------------------------------------------------------------------------
export async function refreshSettings(): Promise<boolean> {
  try {
    const [list, runtime] = await Promise.all([
      getSettings(),
      getSettingsRuntime().catch(() => null),
    ]);
    const docs = (list?.settings ?? {}) as Record<string, { value?: any }>;
    const flat: Record<string, any> = {};
    for (const [key, doc] of Object.entries(docs)) {
      flat[key] = doc?.value;
    }
    const live = runtime?.liveKeys ? new Set<string>(runtime.liveKeys) : new Set(LIVE_KEYS);
    state = {
      ...state,
      settings: flat,
      liveKeys: live,
      status: 'ready',
      syncedAt: Date.now(),
      errors: {},
    };
    writeCache(flat);
    emit();
    return true;
  } catch (err: any) {
    patch({ status: 'error' });
    pushActivity({
      key: '__sync__',
      value: null,
      at: Date.now(),
      ok: false,
      err: err?.message || 'Sync failed',
    });
    return false;
  }
}

export function hydrateSettings(): Promise<boolean> {
  if (state.settings && Object.keys(state.settings).length) {
    return Promise.resolve(true);
  }
  if (hydratePromise) return hydratePromise;
  patch({ status: 'loading' });
  const cached = readCache();
  if (cached) {
    patch({ settings: cached.settings, status: 'ready', syncedAt: cached.syncedAt });
  }
  hydratePromise = refreshSettings().finally(() => {
    hydratePromise = null;
  });
  return hydratePromise;
}

function ensureRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshSettings();
  }, REFRESH_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Local-only settings (stored in localStorage, applied by the app directly)
// ---------------------------------------------------------------------------
const LOCAL_KEYS: Record<string, any> = {};
export function getLocalSetting<T>(key: string, fallback: T): T {
  if (key in LOCAL_KEYS) return LOCAL_KEYS[key] as T;
  try {
    const raw = localStorage.getItem(`kaustubh.local.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function setLocalSetting(key: string, value: any) {
  LOCAL_KEYS[key] = value;
  try {
    localStorage.setItem(`kaustubh.local.${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
export function clearLocalSettings() {
  for (const key of Object.keys(LOCAL_KEYS)) delete LOCAL_KEYS[key];
  try {
    const prefix = 'kaustubh.local.';
    const removals: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) removals.push(k);
    }
    for (const k of removals) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Writes (optimistic + backend-confirmed)
// ---------------------------------------------------------------------------
export async function setSettingValue(key: string, value: any): Promise<{ ok: boolean; error?: string }> {
  const previous = state.settings[key];
  // Optimistic commit — instant UI, no reload.
  state = {
    ...state,
    settings: { ...state.settings, [key]: value },
    pending: { ...state.pending, [key]: value },
    errors: { ...state.errors },
    activity: [
      { key, value, at: Date.now(), ok: true, err: undefined },
      ...state.activity,
    ].slice(0, 60),
  };
  emit();

  try {
    await apiUpdateSetting(key, value);
    const errs = { ...state.errors };
    delete errs[key];
    const pending = { ...state.pending };
    delete pending[key];
    patch({ errors: errs, pending, syncedAt: Date.now() });
    writeCache(state.settings);
    return { ok: true };
  } catch (err: any) {
    const errs = { ...state.errors, [key]: err?.message || 'Failed to save' };
    patch({ errors: errs });
    pushActivity({ key, value, at: Date.now(), ok: false, err: err?.message || 'Failed to save' });
    // Revert so the UI never shows a value the backend rejected.
    if (previous !== undefined) {
      patch({ settings: { ...state.settings, [key]: previous } });
    } else {
      const next = { ...state.settings };
      delete next[key];
      patch({ settings: next });
    }
    return { ok: false, error: err?.message || 'Failed to save' };
  }
}

export async function resetSettingValue(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = (await apiResetSetting(key)) as any;
    const value = res?.setting?.value;
    if (value !== undefined) {
      patch({ settings: { ...state.settings, [key]: value } });
      pushActivity({ key, value, at: Date.now(), ok: true });
      writeCache(state.settings);
    }
    return { ok: true };
  } catch (err: any) {
    pushActivity({ key, value: null, at: Date.now(), ok: false, err: err?.message });
    return { ok: false, error: err?.message };
  }
}

export async function resetAllSettingsValues(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = (await apiResetAll()) as any;
    const docs = (res?.settings ?? {}) as Record<string, { value?: any }>;
    const flat: Record<string, any> = {};
    for (const [key, doc] of Object.entries(docs)) {
      flat[key] = doc?.value;
    }
    if (Object.keys(flat).length) {
      patch({ settings: flat, syncedAt: Date.now(), activity: [] });
      writeCache(flat);
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message };
  }
}

// ---------------------------------------------------------------------------
// Export / import (secrets excluded; validated against the backend schema)
// ---------------------------------------------------------------------------
export function exportSettingsBundle(): string {
  const bundle: Record<string, any> = {};
  for (const key of SCHEMA_KEYS) {
    const field = FIELD_INDEX.get(key);
    if (!field) continue;
    if (field.excludeFromExport || field.sensitive) continue;
    if (key in state.settings) bundle[key] = state.settings[key];
  }
  return JSON.stringify(
    {
      app: 'kaustubh-data-saver',
      kind: 'settings-export',
      version: CACHE_VERSION,
      exportedAt: new Date().toISOString(),
      settings: bundle,
    },
    null,
    2,
  );
}

export function parseSettingsBundle(json: string): {
  ok: boolean;
  valid: number;
  error?: string;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, valid: 0, error: 'Invalid JSON' };
  }
  const settings = parsed?.settings;
  if (!settings || typeof settings !== 'object') {
    return { ok: false, valid: 0, error: 'Not a settings export bundle' };
  }
  const entries = Object.entries(settings).filter(
    ([key]) => SCHEMA_KEYS.includes(key) && FIELD_INDEX.get(key)?.sensitive !== true,
  );
  if (!entries.length) return { ok: false, valid: 0, error: 'No importable settings found' };
  return { ok: true, valid: entries.length };
}

export async function importSettingsBundle(json: string): Promise<{
  ok: boolean;
  applied: number;
  failed: number;
  errors: string[];
}> {
  const check = parseSettingsBundle(json);
  if (!check.ok) return { ok: false, applied: 0, failed: 0, errors: [check.error ?? 'Invalid bundle'] };
  const parsed = JSON.parse(json);
  const entries = Object.entries(parsed.settings).filter(
    ([key]) => SCHEMA_KEYS.includes(key) && FIELD_INDEX.get(key)?.sensitive !== true,
  );
  const results = await Promise.all(entries.map(([key, value]) => setSettingValue(key, value)));
  const applied = results.filter((r) => r.ok).length;
  const errors = results
    .map((r, i) => (r.ok ? null : `${entries[i][0]}: ${r.error}`))
    .filter(Boolean) as string[];
  return { ok: applied > 0, applied, failed: results.length - applied, errors };
}

// ---------------------------------------------------------------------------
// Real-time cross-tab sync (the SHARED system SSE stream — one connection for
// the whole app; the settings store only listens to its entity's frames)
// ---------------------------------------------------------------------------
function ensureSse() {
  if (sseOff || typeof EventSource === 'undefined') return;
  sseOff = subscribeSystemFrames((raw) => {
    try {
      const frame = JSON.parse(raw);
      if (frame?.type === 'state_changed' && frame?.entity === 'settings') {
        patch({ syncedAt: Date.now() });
        refreshSettings();
      }
    } catch {
      /* not a JSON frame */
    }
  });
}

export function disconnectSse() {
  if (sseOff) {
    sseOff();
    sseOff = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// React binding (one hook for the whole settings area)
// ---------------------------------------------------------------------------
export function useSettings(): SettingsState {
  const snapshot = useSyncExternalStore(subscribeSettings, getSettingsState, getSettingsState);

  useEffect(() => {
    void hydrateSettings();
    ensureRefreshTimer();
    ensureSse();
    return disconnectSse;
  }, []);

  return useMemo(() => snapshot, [snapshot]);
}

export function useSettingValue(key: string): any {
  const snapshot = useSettings();
  return snapshot.settings[key];
}