'use client';

import { useSyncExternalStore, useEffect } from 'react';

export const DUMMY_ACCENTS = ['emerald', 'teal', 'cyan', 'purple', 'violet', 'orange', 'rose'] as const;
export type DummyAccent = (typeof DUMMY_ACCENTS)[number];

export type DummyTheme = {
  accent: DummyAccent;
  customColor: string | null;
  appearance: 'auto' | 'light' | 'dark';
  density: 'compact' | 'comfortable' | 'spacious';
  fontScale: 'sm' | 'md' | 'lg';
  numberFormat: 'indian' | 'international';
};

const DEFAULT_THEME: DummyTheme = {
  accent: 'emerald',
  customColor: null,
  appearance: 'auto',
  density: 'comfortable',
  fontScale: 'md',
  numberFormat: 'indian',
};

const STORAGE_KEY = 'kaustubh_dummy_theme';

const ACCENT_HEX: Record<DummyAccent, string> = {
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  purple: '#a855f7',
  violet: '#8b5cf6',
  orange: '#f97316',
  rose: '#f43f5e',
};

export const ACCENT_TONE: Record<DummyAccent, 'success' | 'teal' | 'cyan' | 'purple' | 'violet' | 'orange' | 'danger'> = {
  emerald: 'success',
  teal: 'teal',
  cyan: 'cyan',
  purple: 'purple',
  violet: 'violet',
  orange: 'orange',
  rose: 'danger',
};

const HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

export function accentHex(accent: DummyAccent): string {
  return ACCENT_HEX[accent];
}

export function activeAccentHex(theme: Pick<DummyTheme, 'accent' | 'customColor'>): string {
  if (theme.customColor && HEX_RE.test(theme.customColor)) return theme.customColor;
  return ACCENT_HEX[theme.accent];
}

type Listener = () => void;

class DummyThemeStore {
  private theme: DummyTheme = { ...DEFAULT_THEME };
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.theme = { ...DEFAULT_THEME };
  }

  loadFromStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          (DUMMY_ACCENTS as readonly string[]).includes(parsed?.accent) &&
          (parsed?.customColor == null || HEX_RE.test(parsed.customColor)) &&
          ['auto', 'light', 'dark'].includes(parsed?.appearance) &&
          ['compact', 'comfortable', 'spacious'].includes(parsed?.density) &&
          ['sm', 'md', 'lg'].includes(parsed?.fontScale) &&
          ['indian', 'international'].includes(parsed?.numberFormat)
        ) {
          this.theme = {
            accent: parsed.accent,
            customColor: parsed.customColor,
            appearance: parsed.appearance,
            density: parsed.density,
            fontScale: parsed.fontScale,
            numberFormat: parsed.numberFormat,
          };
        }
      }
    } catch {
      /* ignore */
    }
    this.persist();
    this.notify();
  }

  getTheme(): DummyTheme {
    return this.theme;
  }

  set(patch: Partial<DummyTheme>): DummyTheme {
    const next = {
      accent: patch.accent ?? this.theme.accent,
      customColor: patch.customColor ?? this.theme.customColor,
      appearance: patch.appearance ?? this.theme.appearance,
      density: patch.density ?? this.theme.density,
      fontScale: patch.fontScale ?? this.theme.fontScale,
      numberFormat: patch.numberFormat ?? this.theme.numberFormat,
    };
    if (
      (patch.accent && !(DUMMY_ACCENTS as readonly string[]).includes(patch.accent)) ||
      (patch.customColor != null && !HEX_RE.test(patch.customColor)) ||
      !['auto', 'light', 'dark'].includes(next.appearance) ||
      !['compact', 'comfortable', 'spacious'].includes(next.density) ||
      !['sm', 'md', 'lg'].includes(next.fontScale) ||
      !['indian', 'international'].includes(next.numberFormat)
    ) {
      return this.theme;
    }
    this.theme = next;
    this.persist();
    this.notify();
    return this.theme;
  }

  reset(): DummyTheme {
    this.theme = { ...DEFAULT_THEME };
    this.persist();
    this.notify();
    return this.theme;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist() {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.theme));
    } catch {
      /* ignore */
    }
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }
}

let _store: DummyThemeStore | null = null;

export function getDummyThemeStore(): DummyThemeStore {
  if (!_store) _store = new DummyThemeStore();
  return _store;
}

function subscribeTheme(listener: Listener): () => void {
  return getDummyThemeStore().subscribe(listener);
}

export function useDummyTheme(): DummyTheme {
  const store = getDummyThemeStore();
  useSyncExternalStore(
    subscribeTheme,
    () => store.getTheme(),
    () => DEFAULT_THEME,
  );
  useEffect(() => {
    store.loadFromStorage();
  }, []);
  return store.getTheme();
}

export function useDummyThemeAccent(): DummyAccent {
  return useDummyTheme().accent;
}

export function setDummyAccent(accent: DummyAccent): void {
  getDummyThemeStore().set({ accent });
}

export function setDummyDensity(density: DummyTheme['density']): void {
  getDummyThemeStore().set({ density });
}

export function setDummyNumberFormat(numberFormat: DummyTheme['numberFormat']): void {
  getDummyThemeStore().set({ numberFormat });
}

export function setDummyAppearance(appearance: DummyTheme['appearance']): void {
  getDummyThemeStore().set({ appearance });
}

export function setDummyCustomColor(customColor: string | null): void {
  getDummyThemeStore().set({ customColor });
}

export function setDummyFontScale(fontScale: DummyTheme['fontScale']): void {
  getDummyThemeStore().set({ fontScale });
}

export function resetDummyTheme(): void {
  getDummyThemeStore().reset();
}

export const DENSITY_GAP: Record<DummyTheme['density'], string> = {
  compact: 'space-y-3',
  comfortable: 'space-y-4',
  spacious: 'space-y-6',
};

export const FONT_SIZE: Record<DummyTheme['fontScale'], string> = {
  sm: '14px',
  md: '15px',
  lg: '17px',
};