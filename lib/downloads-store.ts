import { useSyncExternalStore } from 'react';

export type DownloadsState = {
  selectedFormats: string[];
  selectedStocks: string[];
  stockMode: string;
  selectedFields: string[];
  fieldMode: string;
  startDate: string;
  endDate: string;
  datePreset: string;
};

const STORAGE_KEY = 'dc_download_state';

const DEFAULTS: DownloadsState = {
  selectedFormats: [],
  selectedStocks: [],
  stockMode: 'custom',
  selectedFields: [],
  fieldMode: 'custom',
  startDate: '',
  endDate: '',
  datePreset: 'custom',
};

let _state: DownloadsState = { ...DEFAULTS };
let _initialized = false;
let _listeners: Array<() => void> = [];

function hydrateFromStorage(): void {
  if (_initialized || typeof window === 'undefined') return;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      _state = { ...DEFAULTS, ...parsed };
    }
  } catch {
    _state = { ...DEFAULTS };
  }
  _initialized = true;
}

function persist(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
  } catch {}
}

function emit(): void {
  for (const fn of _listeners) fn();
}

export function getDownloadsState(): DownloadsState {
  hydrateFromStorage();
  return _state;
}

export function updateDownloadsState(patch: Partial<DownloadsState>): void {
  hydrateFromStorage();
  _state = { ..._state, ...patch };
  persist();
  emit();
}

function subscribe(fn: () => void): () => void {
  _listeners.push(fn);
  return () => {
    _listeners = _listeners.filter((l) => l !== fn);
  };
}

function getSnapshot(): DownloadsState {
  hydrateFromStorage();
  return _state;
}

function getServerSnapshot(): DownloadsState {
  return { ...DEFAULTS };
}

export function useDownloadsState(): DownloadsState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
