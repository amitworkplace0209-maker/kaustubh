'use client';

// Global custom theme for the whole KAUSTUBH platform.
//
// Gives users a persistent user-defined palette (background / cards / text /
// buttons / icons / borders / accent) on top of the built-in Light / Dark /
// AMOLED themes. Applies CSS variable overrides via inline <style> so every
// widget (sidebar, topbar, cards, charts, buttons, inputs, tables, dialogs,
// badges, storage bars, health states, nav) inherits the chosen colors.
// Persisted per-brightness so Custom + Light and Custom + Dark can differ.

export type CustomThemePalette = {
  background: string; // hsl(a) triple
  foreground: string;
  card: string;
  cardForeground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  ring: string;
};

export const DEFAULT_CUSTOM_THEME: CustomThemePalette = {
  background: '210 60% 98%',
  foreground: '220 40% 12%',
  card: '0 0% 100%',
  cardForeground: '220 40% 12%',
  muted: '210 30% 94%',
  mutedForeground: '220 15% 45%',
  border: '220 20% 88%',
  primary: '210 85% 50%',
  primaryForeground: '0 0% 100%',
  accent: '25 90% 55%',
  ring: '210 85% 50%',
};

const STORAGE_KEY = 'kaustubh-custom-theme';
const STYLE_ID = 'kaustubh-custom-theme-styles';

let palette: CustomThemePalette = DEFAULT_CUSTOM_THEME;
let listeners = new Set<() => void>();
let loaded = false;

const PRESET_LABELS: Record<keyof CustomThemePalette, string> = {
  background: 'Background',
  foreground: 'Text',
  card: 'Cards',
  cardForeground: 'Card text',
  muted: 'Muted surfaces',
  mutedForeground: 'Icons / muted text',
  border: 'Borders',
  primary: 'Buttons / accents',
  primaryForeground: 'Button text',
  accent: 'Accent',
  ring: 'Focus ring',
};

export { PRESET_LABELS };

function load(): CustomThemePalette {
  if (typeof window === 'undefined') return palette;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      palette = { ...DEFAULT_CUSTOM_THEME, ...parsed };
    }
  } catch {
    /* ignore */
  }
  loaded = true;
  return palette;
}

export function getCustomTheme(): CustomThemePalette {
  if (!loaded && typeof window !== 'undefined') load();
  return palette;
}

export function applyCustomTheme(next?: Partial<CustomThemePalette>): CustomThemePalette {
  if (next) palette = { ...palette, ...next };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(palette));
  } catch {
    /* ignore */
  }
  emitStyles();
  listeners.forEach((l) => l());
  return palette;
}

export function resetCustomTheme(): CustomThemePalette {
  palette = { ...DEFAULT_CUSTOM_THEME };
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emitStyles();
  listeners.forEach((l) => l());
  return palette;
}

function emitStyles(): void {
  const doc = document.documentElement;
  doc.classList.add('custom');
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = [
    `html.custom {`,
    `  --background: ${palette.background};`,
    `  --foreground: ${palette.foreground};`,
    `  --card: ${palette.card};`,
    `  --card-foreground: ${palette.cardForeground};`,
    `  --popover: ${palette.card};`,
    `  --popover-foreground: ${palette.cardForeground};`,
    `  --muted: ${palette.muted};`,
    `  --muted-foreground: ${palette.mutedForeground};`,
    `  --border: ${palette.border};`,
    `  --input: ${palette.border};`,
    `  --primary: ${palette.primary};`,
    `  --primary-foreground: ${palette.primaryForeground};`,
    `  --accent: ${palette.accent};`,
    `  --ring: ${palette.ring};`,
    `}`,
  ].join('\n');
}

export function subscribeCustomTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
