'use client';

// KAUSTUBH unified theme engine.
//
// One theme engine for all four application experiences. Every application
// (Trading Terminal, Data Saver, Services, Khumbha AI) keeps an INDEPENDENT,
// persistently stored theme preference keyed under `kaustubh-theme.<appId>`.
//
// The engine owns:
//   - a registry of 30+ professionally designed themes (multi + single color)
//     where every theme ships a complete light AND dark role palette;
//   - persistence of selectedThemeId, mode, customOverrides and advancedSettings;
//   - DOM application: writes CSS variables (design tokens) so the theme re-skins
//     the ENTIRE application (page, topbar, sidebar, cards, buttons, inputs,
//     status colours, chart accents) without a reload.
//
// Brightness modes: light, dark, system, amoled (system also re-renders live).
//
// Backwards compatible: the original 15 accent presets (saffron, emerald, ...)
// remain valid ids, so previously persisted states keep loading.

import { useSyncExternalStore } from 'react';
import type { AppId } from '@/lib/apps';

export type Phase2Brightness = 'light' | 'dark' | 'system' | 'amoled';

export type ThemeType = 'multi' | 'single';

/** Every role a theme can control, mapped onward to CSS variables. */
export type ThemePalette = {
  pageBackground: string;
  topbarBackground: string;
  sidebarBackground: string;
  sidebarActive: string;
  sidebarHover: string;
  sidebarSelectedText: string;
  cardBackground: string;
  cardBorder: string;
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  foreground: string;
  mutedForeground: string;
  hoverBackground: string;
  activeBackground: string;
  selectedText: string;
  disabled: string;
  buttonBackground: string;
  buttonHoverBackground: string;
  buttonText: string;
  inputBackground: string;
  inputBorder: string;
  inputFocus: string;
  modalBackground: string;
  glow: string;
};

/** Advanced / cosmetic settings (safe, UI only). */
export type ThemeAdvanced = {
  radius: number;        // px
  shadowIntensity: number; // 0..100
  cardTransparency: number; // 0..100 (as a % alpha of card bg)
  sidebarWidth: number;  // px (desktop expanded)
  density: 'comfortable' | 'compact' | 'spacious';
  reducedMotion: boolean;
};

export type Phase2ThemeDef = {
  id: string;
  name: string;
  type: ThemeType;
  description: string;
  /** Representative swatches shown on theme cards. */
  swatches: string[];
  /** Base hue used to derive the palette (0..360). */
  hue: number;
};

// ── Custom saved themes & favorites (per scope) ───────────────────────────

export type SavedCustomTheme = {
  id: string;
  name: string;
  themeId: string;
  brightness: Phase2Brightness;
  overrides: Partial<ThemePalette> | null;
  advanced: ThemeAdvanced;
  createdAt: number;
};

function customThemesStorageKey(appId: AppId, scope?: string | null): string {
  return scope ? `kaustubh-custom-themes.${appId}.${scope}` : `kaustubh-custom-themes.${appId}`;
}

function favoritesStorageKey(appId: AppId, scope?: string | null): string {
  return scope ? `kaustubh-favorites.${appId}.${scope}` : `kaustubh-favorites.${appId}`;
}

function loadCustomThemes(appId: AppId, scope?: string | null): SavedCustomTheme[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(customThemesStorageKey(appId, scope));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomThemes(appId: AppId, scope: string | null, themes: SavedCustomTheme[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(customThemesStorageKey(appId, scope), JSON.stringify(themes));
  } catch { /* ignore */ }
}

function loadFavorites(appId: AppId, scope?: string | null): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(favoritesStorageKey(appId, scope));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites(appId: AppId, scope: string | null, favs: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(favoritesStorageKey(appId, scope), JSON.stringify(favs));
  } catch { /* ignore */ }
}

/** Get all saved custom themes for the given scope. */
export function getSavedCustomThemes(appId: AppId, scope?: string | null): SavedCustomTheme[] {
  return loadCustomThemes(appId, scope);
}

/** Save a new custom theme to the current scope. */
export function saveCustomTheme(
  appId: AppId,
  scope: string | null,
  name: string,
  state: Phase2ThemeState,
): SavedCustomTheme {
  const themes = loadCustomThemes(appId, scope);
  const entry: SavedCustomTheme = {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    themeId: state.themeId,
    brightness: state.brightness,
    overrides: state.overrides,
    advanced: { ...state.advanced },
    createdAt: Date.now(),
  };
  themes.push(entry);
  saveCustomThemes(appId, scope, themes);
  return entry;
}

/** Delete a saved custom theme by its id. */
export function deleteCustomTheme(appId: AppId, scope: string | null, themeId: string): void {
  const themes = loadCustomThemes(appId, scope).filter((t) => t.id !== themeId);
  saveCustomThemes(appId, scope, themes);
}

/** Get favorites for the given scope. */
export function getFavorites(appId: AppId, scope?: string | null): string[] {
  return loadFavorites(appId, scope);
}

/** Toggle a theme id in the favorites list. Returns the new list. */
export function toggleFavorite(appId: AppId, scope: string | null, themeId: string): string[] {
  const favs = loadFavorites(appId, scope);
  const idx = favs.indexOf(themeId);
  if (idx >= 0) {
    favs.splice(idx, 1);
  } else {
    favs.push(themeId);
  }
  saveFavorites(appId, scope, favs);
  return favs;
}

export type Phase2CustomTheme = ThemePalette;

export type Phase2ThemeState = {
  themeId: string;
  brightness: Phase2Brightness;
  overrides: Partial<ThemePalette> | null;
  advanced: ThemeAdvanced;
};

// -----------------------------------------------------------------------------
// Theme registry
// -----------------------------------------------------------------------------
const list = (...items: Phase2ThemeDef[]): Phase2ThemeDef[] => items;

/**
 * 12 multi-color themes — each is one coordinated palette (multiple hues),
 * but stored as a single selectable theme id for clarity and performance.
 * Light + dark palettes are derived from the base hue + accent hues and are
 * guaranteed to differ (a full UI palette, not a single tint).
 */
export const MULTI_COLOR_THEMES: Phase2ThemeDef[] = list(
  { id: 'aurora-dream', name: 'Aurora Dream', type: 'multi', hue: 262, swatches: ['#7C3AED', '#06B6D4', '#3B82F6', '#10B981'], description: 'Purple, cyan, blue and green in a calm gradient' },
  { id: 'sunset-glow', name: 'Sunset Glow', type: 'multi', hue: 17, swatches: ['#F97316', '#EC4899', '#EF4444', '#A855F7'], description: 'Orange, pink, red and purple like a warm dusk' },
  { id: 'oceanic-wave', name: 'Oceanic Wave', type: 'multi', hue: 199, swatches: ['#06B6D4', '#14B8A6', '#3B82F6'], description: 'Cyan, teal and deep blue surf' },
  { id: 'royal-purple', name: 'Royal Purple', type: 'multi', hue: 262, swatches: ['#7C3AED', '#8B5CF6', '#3B82F6'], description: 'Purple, violet and blue regalia' },
  { id: 'cyberpunk', name: 'Cyberpunk', type: 'multi', hue: 320, swatches: ['#EC4899', '#A855F7', '#06B6D4'], description: 'Magenta, purple and cyan neon' },
  { id: 'forest-whisper', name: 'Forest Whisper', type: 'multi', hue: 160, swatches: ['#10B981', '#22C55E', '#14B8A6'], description: 'Emerald, green and teal woodland' },
  { id: 'candy-pop', name: 'Candy Pop', type: 'multi', hue: 330, swatches: ['#EC4899', '#D946EF', '#8B5CF6'], description: 'Pink, magenta and purple confection' },
  { id: 'warm-coffee', name: 'Warm Coffee', type: 'multi', hue: 24, swatches: ['#92400E', '#D97706', '#F97316'], description: 'Brown, amber and orange roasted tones' },
  { id: 'nordic-blue', name: 'Nordic Blue', type: 'multi', hue: 217, swatches: ['#3B82F6', '#64748B', '#06B6D4'], description: 'Blue, slate and cyan glacial tones' },
  { id: 'crimson-edge', name: 'Crimson Edge', type: 'multi', hue: 350, swatches: ['#DC2626', '#B91C1C', '#F97316'], description: 'Red, crimson and orange aggressive' },
  { id: 'synthwave', name: 'Synthwave', type: 'multi', hue: 285, swatches: ['#8B5CF6', '#EC4899', '#22D3EE'], description: 'Purple, pink and cyan retro neon' },
  { id: 'golden-hour', name: 'Golden Hour', type: 'multi', hue: 40, swatches: ['#EAB308', '#F59E0B', '#F97316'], description: 'Yellow, amber and orange warm light' },
  { id: 'saffron-blue', name: 'Saffron Blue', type: 'multi', hue: 28, swatches: ['#FF7849', '#3B82F6', '#06B6D4'], description: 'Warm saffron against cool ocean blue' },
  { id: 'blue-cyan', name: 'Blue Cyan', type: 'multi', hue: 210, swatches: ['#3B82F6', '#06B6D4', '#0EA5E9'], description: 'Deep blue flowing into bright cyan' },
  { id: 'purple-pink', name: 'Purple Pink', type: 'multi', hue: 280, swatches: ['#8B5CF6', '#EC4899', '#D946EF'], description: 'Purple and pink gradient elegance' },
  { id: 'green-teal', name: 'Green Teal', type: 'multi', hue: 155, swatches: ['#22C55E', '#14B8A6', '#10B981'], description: 'Lush green merging with deep teal' },
  { id: 'orange-red', name: 'Orange Red', type: 'multi', hue: 15, swatches: ['#F97316', '#EF4444', '#DC2626'], description: 'Fiery orange and red intensity' },
  { id: 'blue-violet', name: 'Blue Violet', type: 'multi', hue: 240, swatches: ['#3B82F6', '#7C3AED', '#8B5CF6'], description: 'Blue and violet cosmic blend' },
  { id: 'teal-emerald', name: 'Teal Emerald', type: 'multi', hue: 170, swatches: ['#14B8A6', '#10B981', '#059669'], description: 'Teal and emerald jewel tones' },
  { id: 'amber-purple', name: 'Amber Purple', type: 'multi', hue: 35, swatches: ['#D97706', '#8B5CF6', '#7C3AED'], description: 'Warm amber against regal purple' },
  { id: 'rose-orange', name: 'Rose Orange', type: 'multi', hue: 340, swatches: ['#E11D48', '#F97316', '#EC4899'], description: 'Rose and orange vibrant warmth' },
  { id: 'cyan-indigo', name: 'Cyan Indigo', type: 'multi', hue: 225, swatches: ['#06B6D4', '#4F46E5', '#3B82F6'], description: 'Cyan and indigo deep space' },
  { id: 'mint-lime', name: 'Mint Lime', type: 'multi', hue: 140, swatches: ['#34D399', '#65A30D', '#22C55E'], description: 'Fresh mint and lime zest' },
  { id: 'coral-rose', name: 'Coral Rose', type: 'multi', hue: 355, swatches: ['#FB7185', '#E11D48', '#EC4899'], description: 'Soft coral and rose petals' },
  { id: 'midnight-ocean', name: 'Midnight Ocean', type: 'multi', hue: 220, swatches: ['#1E3A5F', '#2563EB', '#06B6D4'], description: 'Deep midnight blue to bright cyan' },
  { id: 'autumn-blaze', name: 'Autumn Blaze', type: 'multi', hue: 22, swatches: ['#EA580C', '#D97706', '#DC2626'], description: 'Autumn leaves in blazing orange' },
  { id: 'cherry-blossom', name: 'Cherry Blossom', type: 'multi', hue: 340, swatches: ['#F472B6', '#EC4899', '#A855F7'], description: 'Delicate pink cherry blossom bloom' },
  { id: 'deep-space', name: 'Deep Space', type: 'multi', hue: 250, swatches: ['#4F46E5', '#7C3AED', '#06B6D4'], description: 'Indigo and violet cosmic void' },
  { id: 'tropical-paradise', name: 'Tropical Paradise', type: 'multi', hue: 165, swatches: ['#14B8A6', '#22C55E', '#06B6D4'], description: 'Tropical teal and emerald lagoon' },
);

/** 24 single-color themes (original presets included + new ones). */
export const SINGLE_COLOR_THEMES: Phase2ThemeDef[] = list(
  { id: 'emerald', name: 'Emerald', type: 'single', hue: 160, swatches: ['#059669'], description: 'Fresh green' },
  { id: 'teal', name: 'Teal', type: 'single', hue: 175, swatches: ['#0D9488'], description: 'Deep teal' },
  { id: 'ocean', name: 'Ocean', type: 'single', hue: 217, swatches: ['#2563EB'], description: 'Cool blue' },
  { id: 'blue', name: 'Blue', type: 'single', hue: 210, swatches: ['#3B82F6'], description: 'Classic blue' },
  { id: 'indigo', name: 'Indigo', type: 'single', hue: 243, swatches: ['#4F46E5'], description: 'Deep indigo' },
  { id: 'violet', name: 'Violet', type: 'single', hue: 262, swatches: ['#7C3AED'], description: 'Violet' },
  { id: 'purple', name: 'Purple', type: 'single', hue: 272, swatches: ['#8B5CF6'], description: 'Rich purple' },
  { id: 'fuchsia', name: 'Fuchsia', type: 'single', hue: 300, swatches: ['#D946EF'], description: 'Bright fuchsia' },
  { id: 'pink', name: 'Pink', type: 'single', hue: 330, swatches: ['#EC4899'], description: 'Pink' },
  { id: 'rose', name: 'Rose', type: 'single', hue: 350, swatches: ['#E11D48'], description: 'Rose red' },
  { id: 'red', name: 'Red', type: 'single', hue: 0, swatches: ['#DC2626'], description: 'Red' },
  { id: 'orange', name: 'Orange', type: 'single', hue: 24, swatches: ['#EA580C'], description: 'Orange' },
  { id: 'amber', name: 'Amber', type: 'single', hue: 35, swatches: ['#D97706'], description: 'Amber' },
  { id: 'saffron', name: 'Saffron', type: 'single', hue: 14, swatches: ['#FF7849'], description: 'Warm orange' },
  { id: 'sunset', name: 'Sunset', type: 'single', hue: 20, swatches: ['#EA580C'], description: 'Orange sunset' },
  { id: 'yellow', name: 'Yellow', type: 'single', hue: 50, swatches: ['#EAB308'], description: 'Yellow' },
  { id: 'lime', name: 'Lime', type: 'single', hue: 84, swatches: ['#65A30D'], description: 'Fresh lime' },
  { id: 'green', name: 'Green', type: 'single', hue: 140, swatches: ['#22C55E'], description: 'Green' },
  { id: 'mint', name: 'Mint', type: 'single', hue: 170, swatches: ['#34D399'], description: 'Soft mint' },
  { id: 'forest', name: 'Forest', type: 'single', hue: 150, swatches: ['#166534'], description: 'Deep forest' },
  { id: 'cyan', name: 'Cyan', type: 'single', hue: 190, swatches: ['#0891B2'], description: 'Bright cyan' },
  { id: 'sky', name: 'Sky', type: 'single', hue: 199, swatches: ['#0EA5E9'], description: 'Sky blue' },
  { id: 'slate', name: 'Slate', type: 'single', hue: 215, swatches: ['#64748B'], description: 'Neutral slate' },
  { id: 'zinc', name: 'Zinc', type: 'single', hue: 240, swatches: ['#71717A'], description: 'Neutral zinc' },
);

export const THEME_REGISTRY: Phase2ThemeDef[] = [...MULTI_COLOR_THEMES, ...SINGLE_COLOR_THEMES];
export const TOTAL_THEME_COUNT = THEME_REGISTRY.length;

const THEME_BY_ID = new Map(THEME_REGISTRY.map((t) => [t.id, t]));

export function getThemeById(id: string): Phase2ThemeDef | undefined {
  return THEME_BY_ID.get(id);
}

// -----------------------------------------------------------------------------
// Palette generation (single source of truth for every role)
// -----------------------------------------------------------------------------
function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

/**
 * Derive a complete light OR dark UI palette from a theme's base hue.
 * Every role is deliberately a different shade (never a single tint) so the
 * page, sidebar, topbar, cards, buttons, inputs, status colours and accents all
 * remain readable and coordinated in both modes.
 *
 * IMPORTANT: the neutral surface/text values below are chosen so that
 *   light mode  -> light surfaces + dark readable text
 *   dark mode   -> dark surfaces + light readable text
 * Accent/status colours come from the hue but are always legible in both modes.
 */
function buildPalette(hue: number, mode: 'light' | 'dark'): ThemePalette {
  const hh = ((hue % 360) + 360) % 360;
  const sat = Math.min(78, Math.max(45, 62)); // primary saturation
  const light = mode === 'light';

  // Neutrals scale with mode while keeping a subtle tint of the hue.
  const bgL = light ? 98 : 6;          // page background
  const fgL = light ? 12 : 92;         // primary text
  const cardL = light ? 100 : 9;       // cards / surfaces
  const mutedFgL = light ? 42 : 62;    // secondary text
  const borderL = light ? 88 : 18;     // borders
  const inputL = light ? 87 : 18;      // input borders
  const hoverBgL = light ? 96 : 14;    // hover surfaces

  const primaryL = light ? 46 : 55;    // primary (accent) base
  const secondaryL = light ? 45 : 40;

  const successH = 150, warnH = 38, dangerH = 0, infoH = 199;

  return {
    pageBackground: hsl(hh, Math.max(5, sat - 32), bgL),
    topbarBackground: hsl(hh, Math.max(4, sat - 38), light ? 100 : cardL),
    sidebarBackground: hsl(hh, Math.max(4, sat - 36), light ? 100 : 8),
    sidebarActive: hsla(hh, sat, light ? 40 : 50, 0.14),
    sidebarHover: hsla(hh, Math.max(6, sat - 32), light ? 94 : 16, 0.5),
    sidebarSelectedText: hsl(hh, sat, light ? 36 : 76),
    cardBackground: hsl(hh, Math.max(4, sat - 36), cardL),
    cardBorder: hsl(hh, Math.max(8, sat - 40), borderL),
    primary: hsl(hh, sat, primaryL),
    secondary: hsl(hh, Math.min(70, sat + 6), secondaryL),
    accent: hsl(38, 95, light ? 50 : 55),
    success: hsl(successH, 70, light ? 42 : 48),
    warning: hsl(warnH, 92, light ? 46 : 52),
    danger: hsl(dangerH, 76, light ? 48 : 52),
    info: hsl(infoH, 86, light ? 46 : 52),
    foreground: hsl(hh, Math.max(4, sat - 40), fgL),
    mutedForeground: hsl(hh, Math.max(4, sat - 40), mutedFgL),
    hoverBackground: hsl(hh, Math.max(5, sat - 36), hoverBgL),
    activeBackground: hsla(hh, sat, light ? 44 : 50, light ? 0.14 : 0.24),
    selectedText: hsl(hh, sat, light ? 34 : 78),
    disabled: hsl(hh, 8, light ? 45 : 60),
    buttonBackground: hsl(hh, sat, primaryL),
    buttonHoverBackground: hsl(hh, Math.min(80, sat + 6), light ? primaryL - 6 : primaryL + 8),
    buttonText: hsl(0, 0, 100),
    inputBackground: hsl(hh, Math.max(4, sat - 38), light ? 100 : 10),
    inputBorder: hsl(hh, Math.max(8, sat - 40), inputL),
    inputFocus: hsl(hh, sat, primaryL),
    modalBackground: hsl(hh, Math.max(4, sat - 36), light ? 100 : Math.min(100, cardL + 1)),
    glow: hsla(hh, sat, light ? primaryL : 40, 0.45),
  };
}

function hsla(h: number, s: number, l: number, a: number): string {
  const hh = ((h % 360) + 360) % 360;
  return `hsla(${Math.round(hh)} ${Math.round(s)}% ${Math.round(l)}% / ${a})`;
}

export function buildThemePalette(themeId: string, mode: 'light' | 'dark'): ThemePalette {
  const def = getThemeById(themeId);
  return buildPalette(def?.hue ?? 14, mode);
}

// -----------------------------------------------------------------------------
// Persisted state
// -----------------------------------------------------------------------------
const STYLE_ID = 'kaustubh-theme-vars';

export const DEFAULT_ADVANCED: ThemeAdvanced = {
  radius: 12,
  shadowIntensity: 40,
  cardTransparency: 0,
  sidebarWidth: 256,
  density: 'comfortable',
  reducedMotion: false,
};

/** Resolve the 'system' brightness to 'light' or 'dark' based on OS preference. */
export function resolveSystemBrightness(brightness: Phase2Brightness): 'light' | 'dark' {
  if (brightness === 'system') {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return brightness === 'dark' || brightness === 'amoled' ? 'dark' : 'light';
}

const APP_IDS: AppId[] = ['trading', 'data-saver', 'services'];

/** Fresh default per application — used until the user overrides a preference. */
const DEFAULT_PER_APP: Record<AppId, { themeId: string; brightness: Phase2Brightness }> = {
  trading: { themeId: 'saffron', brightness: 'light' },
  'data-saver': { themeId: 'saffron', brightness: 'light' },
  services: { themeId: 'ocean', brightness: 'system' },
};

const LEGACY_LOCAL_STORAGE_KEY = 'phase2_theme_state';

/** Storage key for an application's theme state. Within the trading workspace a
 *  terminal scope (KOTAK NEO / DUMMY / SHOONYA) must keep an INDEPENDENT theme,
 *  so the key becomes `kaustubh-theme.trading.<scope>`. Every other app keeps
 *  the plain `kaustubh-theme.<appId>` key. */
export function storageKeyForApp(appId: AppId, scope?: string | null): string {
  return scope ? `kaustubh-theme.${appId}.${scope}` : `kaustubh-theme.${appId}`;
}

const DEFAULT_SNAPSHOT: Phase2ThemeState = {
  themeId: 'saffron', brightness: 'light', overrides: null, advanced: { ...DEFAULT_ADVANCED },
};

type Listener = () => void;

const VALID_BRIGHTNESS = new Set<Phase2Brightness>(['light', 'dark', 'system', 'amoled']);
const VALID_DENSITY = new Set<ThemeAdvanced['density']>(['comfortable', 'compact', 'spacious']);

function normalizeAdvanced(raw: any, base: ThemeAdvanced): ThemeAdvanced {
  const clamp = (v: any, min: number, max: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
  return {
    radius: clamp(raw?.radius, 0, 24, base.radius),
    shadowIntensity: clamp(raw?.shadowIntensity, 0, 100, base.shadowIntensity),
    cardTransparency: clamp(raw?.cardTransparency, 0, 90, base.cardTransparency),
    sidebarWidth: clamp(raw?.sidebarWidth, 200, 320, base.sidebarWidth),
    density: VALID_DENSITY.has(raw?.density) ? raw.density : base.density,
    reducedMotion: Boolean(raw?.reducedMotion ?? base.reducedMotion),
  };
}

function validateState(raw: any, fallback: { themeId: string; brightness: Phase2Brightness }): Phase2ThemeState {
  const themeId: string = raw?.themeId
    ? (THEME_BY_ID.has(raw.themeId) ? raw.themeId : raw.presetId && THEME_BY_ID.has(raw.presetId) ? raw.presetId : fallback.themeId)
    : (raw?.presetId && THEME_BY_ID.has(raw.presetId) ? raw.presetId : fallback.themeId);
  const brightness: Phase2Brightness = VALID_BRIGHTNESS.has(raw?.brightness) ? raw.brightness : fallback.brightness;
  const overrides =
    raw?.overrides && typeof raw.overrides === 'object'
      ? ({ ...raw.overrides } as Partial<ThemePalette>)
      : null;
  return {
    themeId,
    brightness,
    overrides,
    advanced: normalizeAdvanced(raw?.advanced, DEFAULT_ADVANCED),
  };
}

class Phase2ThemeStore {
  private stateMap: Record<string, Phase2ThemeState> = {};
  private currentApp: AppId = 'data-saver';
  /** Terminal scope for the trading workspace (kotak-neo | dummy | shoonya).
   *  When set, trading theme state is read/written under a scoped storage key so
   *  each terminal keeps an INDEPENDENT theme. */
  private currentScope: string | null = null;
  private listeners: Set<Listener> = new Set();
  private mql: MediaQueryList | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.loadAllFromLocalStorage();
      this.installSystemListener();
      this.applyToDOM();
    }
  }

  /** Composite state key: `trading:<scope>` when scoped, else the AppId. */
  private composite(appId: AppId): string {
    return appId === 'trading' && this.currentScope ? `trading:${this.currentScope}` : appId;
  }

  /** Storage key for the composite state key. */
  private storageKey(key: string): string {
    if (key.startsWith('trading:')) {
      return storageKeyForApp('trading', key.slice('trading:'.length));
    }
    return storageKeyForApp(key as AppId);
  }

  // ── current application ────────────────────────────────────────────
  setCurrentApp(appId: AppId, scope?: string | null) {
    const nextScope = scope != null && scope !== '' ? scope : null;
    if (this.currentApp === appId && this.currentScope === nextScope) return;
    this.currentApp = appId;
    this.currentScope = nextScope;
    this.applyToDOM();
    this.notify();
  }

  getCurrentApp(): AppId {
    return this.currentApp;
  }

  getCurrentScope(): string | null {
    return this.currentScope;
  }

  // ── persistence ────────────────────────────────────────────────────
  private loadAllFromLocalStorage(): void {
    for (const id of APP_IDS) {
      try {
        const raw = window.localStorage.getItem(storageKeyForApp(id));
        if (raw) {
          this.stateMap[id] = validateState(JSON.parse(raw), DEFAULT_PER_APP[id]);
          continue;
        }
      } catch {
        /* corrupted cache -> keep default */
      }
      if (id === 'data-saver') {
        try {
          const legacy = window.localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
          if (legacy) {
            this.stateMap[id] = validateState(JSON.parse(legacy), DEFAULT_PER_APP[id]);
            continue;
          }
        } catch {
          /* ignore */
        }
      }
      this.stateMap[id] = { ...DEFAULT_PER_APP[id], overrides: null, advanced: { ...DEFAULT_ADVANCED } };
    }
  }

  /** Load (and lazily seed/migrate) the state for a composite key.
   *  Scoped keys fall back to the unscoped legacy theme once, then persist the
   *  migrated snapshot so every terminal starts from the user's prior theme. */
  private loadScoped(key: string, appId: AppId): Phase2ThemeState {
    const existing = this.stateMap[key];
    if (existing) return existing;
    if (typeof window === 'undefined') {
      return { ...DEFAULT_PER_APP[appId], overrides: null, advanced: { ...DEFAULT_ADVANCED } };
    }
    try {
      const scopedRaw = window.localStorage.getItem(this.storageKey(key));
      if (scopedRaw) {
        const parsed = validateState(JSON.parse(scopedRaw), DEFAULT_PER_APP[appId]);
        this.stateMap[key] = parsed;
        return parsed;
      }
    } catch {
      /* corrupted scoped cache -> migrate */
    }
    if (key.startsWith('trading:')) {
      const legacy = this.stateMap[appId] ?? this.loadLegacyScoped(appId);
      if (legacy) {
        const migrated = { ...legacy, advanced: { ...legacy.advanced } };
        this.stateMap[key] = migrated;
        try {
          window.localStorage.setItem(this.storageKey(key), JSON.stringify(migrated));
        } catch { /* ignore */ }
        return migrated;
      }
    }
    const fresh = { ...DEFAULT_PER_APP[appId], overrides: null, advanced: { ...DEFAULT_ADVANCED } };
    this.stateMap[key] = fresh;
    return fresh;
  }

  private loadLegacyScoped(appId: AppId): Phase2ThemeState | null {
    try {
      const raw = window.localStorage.getItem(storageKeyForApp(appId));
      if (raw) return validateState(JSON.parse(raw), DEFAULT_PER_APP[appId]);
    } catch { /* ignore */ }
    return null;
  }

  private saveToLocalStorage(state: Phase2ThemeState, key: string): void {
    try {
      window.localStorage.setItem(this.storageKey(key), JSON.stringify(state));
    } catch {
      /* storage full/unavailable */
    }
  }

  // ── system brightness ──────────────────────────────────────────────
  getResolvedBrightness(state: Phase2ThemeState): Exclude<Phase2Brightness, 'system'> {
    return this.resolvedBrightness(state);
  }

  private resolvedBrightness(state: Phase2ThemeState): Exclude<Phase2Brightness, 'system'> {
    if (state.brightness !== 'system' || typeof window === 'undefined') {
      return state.brightness === 'system' ? 'dark' : state.brightness;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private installSystemListener(): void {
    if (this.mql || typeof window === 'undefined') return;
    this.mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const needsRebuild = APP_IDS.some((id) =>
        (this.stateMap[id] ?? fitDefault(id)).brightness === 'system',
      );
      if (needsRebuild) {
        this.applyToDOM();
        this.notify();
      }
    };
    if (typeof this.mql.addEventListener === 'function') {
      this.mql.addEventListener('change', onChange);
    } else if (typeof this.mql.addListener === 'function') {
      this.mql.addListener(onChange);
    }
  }

  // ── public read / write ────────────────────────────────────────────
  getState(appId: AppId = this.currentApp): Phase2ThemeState {
    return this.loadScoped(this.composite(appId), appId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  private update(appId: AppId, next: Partial<Phase2ThemeState>) {
    const key = this.composite(appId);
    const prev = this.getState(appId);
    const merged: Phase2ThemeState = {
      themeId: next.themeId ?? prev.themeId,
      brightness: next.brightness ?? prev.brightness,
      overrides: next.overrides !== undefined ? next.overrides : prev.overrides,
      advanced: next.advanced ?? prev.advanced,
    };
    this.stateMap[key] = merged;
    this.saveToLocalStorage(merged, key);
    if (appId === this.currentApp) {
      this.applyToDOM();
    }
    this.notify();
  }

  setTheme(appId: AppId, id: string) {
    this.update(appId, { themeId: id });
  }

  setBrightness(appId: AppId, brightness: Phase2Brightness) {
    this.update(appId, { brightness });
  }

  setOverrides(appId: AppId, overrides: Partial<ThemePalette> | null) {
    this.update(appId, { overrides });
  }

  setAdvanced(appId: AppId, advanced: ThemeAdvanced) {
    this.update(appId, { advanced });
  }

  applyFullState(appId: AppId, state: Phase2ThemeState) {
    const key = this.composite(appId);
    this.stateMap[key] = { ...state, advanced: { ...state.advanced } };
    this.saveToLocalStorage(this.stateMap[key]!, key);
    if (appId === this.currentApp) this.applyToDOM();
    this.notify();
  }

  reset(appId: AppId) {
    const key = this.composite(appId);
    const d = DEFAULT_PER_APP[appId];
    this.stateMap[key] = { ...d, overrides: null, advanced: { ...DEFAULT_ADVANCED } };
    this.saveToLocalStorage(this.stateMap[key]!, key);
    if (appId === this.currentApp) this.applyToDOM();
    this.notify();
  }

  // ── resolved palette ───────────────────────────────────────────────
  resolvePalette(state: Phase2ThemeState, mode: 'light' | 'dark'): ThemePalette {
    const base = buildThemePalette(state.themeId, mode);
    return { ...base, ...(state.overrides ?? {}) };
  }

  // ── DOM application ────────────────────────────────────────────────
  applyToDOM(stateOverride?: Phase2ThemeState) {
    if (typeof document === 'undefined') return;
    const state = stateOverride ?? this.getState(this.currentApp);
    const html = document.documentElement;
    html.setAttribute('data-kaustubh-app', this.currentApp);
    if (this.currentScope) {
      html.setAttribute('data-kaustubh-scope', this.currentScope);
    } else {
      html.removeAttribute('data-kaustubh-scope');
    }
    html.setAttribute('data-phase2-theme', state.themeId);

    const b = this.resolvedBrightness(state);
    const isAmoled = state.brightness === 'amoled';
    html.classList.toggle('light', b === 'light' && !isAmoled);
    html.classList.toggle('dark', b === 'dark' || isAmoled);
    html.classList.toggle('amoled', isAmoled);

    const roots = Array.from(document.querySelectorAll<HTMLElement>('.ws-phase2'));
    for (const el of roots) {
      for (const id of THEME_REGISTRY) {
        el.classList.toggle(`p2-theme-${id.id}`, state.themeId === id.id);
      }
    }

    this.applyPalette(state, b === 'dark' || isAmoled ? 'dark' : 'light', state.advanced);
  }

  private applyPalette(state: Phase2ThemeState, mode: 'light' | 'dark', advanced: ThemeAdvanced) {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();

    const p = this.resolvePalette(state, mode);
    const amoled = state.brightness === 'amoled';
    const transparency = Math.max(0, Math.min(90, advanced.cardTransparency));
    // AMOLED demands a true pure-black background; override the derived dark
    // palette surfaces so pixels are genuinely off.
    const amoledBlack = '#000';
    const effPage = amoled ? amoledBlack : p.pageBackground;
    const effCard = amoled ? '#000' : p.cardBackground;
    const effPopover = amoled ? '#000' : p.modalBackground;
    const cardBg = hexToHsla(effCard, 1 - transparency / 100);
    const modalBg = hexToHsla(effPopover, 1 - transparency / 100);
    const cardAlpha = 1 - transparency / 100;

    const shadow = `0 ${Math.round(advanced.shadowIntensity / 20)}px ${Math.round(4 + advanced.shadowIntensity / 3)}px -2px hsla(${hexHslOf(p.foreground)} / ${0.08 + (advanced.shadowIntensity / 400)})`;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      :root, .ws-phase2 {
        --background: ${hexHslStr(effPage)};
        --foreground: ${hexHslStr(p.foreground)};
        --card: ${cardBg};
        --card-foreground: ${hexHslStr(p.foreground)};
        --popover: ${modalBg};
        --popover-foreground: ${hexHslStr(p.foreground)};
        --primary: ${hexHslStr(p.primary)};
        --primary-foreground: ${hexHslStr(p.buttonText)};
        --secondary: ${hexHslStr(p.secondary)};
        --secondary-foreground: ${hexHslStr(amoled ? '#fff' : p.foreground)};
        --muted: ${hexHslStr(p.hoverBackground)};
        --muted-foreground: ${hexHslStr(p.mutedForeground)};
        --accent: ${hexHslStr(p.accent)};
        --accent-foreground: ${hexHslStr('#1a1a1a')};
        --destructive: ${hexHslStr(p.danger)};
        --destructive-foreground: ${hexHslStr('#fff')};
        --success: ${hexHslStr(p.success)};
        --warning: ${hexHslStr(p.warning)};
        --info: ${hexHslStr(p.info)};
        --purple: ${hexHslStr(p.secondary)};
        --teal: ${hexHslStr(p.success)};
        --border: ${hexHslStr(p.inputBorder)};
        --input: ${hexHslStr(p.inputBorder)};
        --ring: ${hexHslStr(p.inputFocus)};
        --chart-1: ${hexHslStr(p.primary)};
        --chart-2: ${hexHslStr(p.accent)};
        --chart-3: ${hexHslStr(p.secondary)};
        --chart-4: ${hexHslStr(p.danger)};
        --chart-5: ${hexHslStr(p.success)};
        --radius: ${advanced.radius}px;
        --theme-shadow: ${shadow};
        --card-alpha: ${cardAlpha};
      }
      .ws-phase2 {
        --sidebar-bg: ${amoled ? hexHslStr(amoledBlack) : p.sidebarBackground};
        --sidebar-active-bg: ${p.sidebarActive};
        --sidebar-hover-bg: ${p.sidebarHover};
        --sidebar-selected-text: ${p.sidebarSelectedText};
        --topbar-bg: ${amoled ? hexHslStr(amoledBlack) : p.topbarBackground};
        --sidebar-width-expanded: ${advanced.sidebarWidth}px;
        --sidebar-width-collapsed: 4rem;
        --button-bg: ${p.buttonBackground};
        --button-hover-bg: ${p.buttonHoverBackground};
        --button-text: ${p.buttonText};
        --input-bg: ${p.inputBackground};
        --input-focus: ${p.inputFocus};
        --modal-bg: ${p.modalBackground};
        --theme-glow: ${p.glow};
      }
    `;

    if (advanced.reducedMotion) {
      style.textContent += `\n@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }`;
    }

    document.head.appendChild(style);
  }
}

function fitDefault(appId: AppId): Phase2ThemeState {
  const d = DEFAULT_PER_APP[appId] ?? DEFAULT_PER_APP['data-saver'];
  return { ...d, overrides: null, advanced: { ...DEFAULT_ADVANCED } };
}

// Various small colour helpers
function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hexRgb(hex: string): [number, number, number] {
  let h = (hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return [128, 128, 128];
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexHslOf(hex: string): [number, number, number] {
  const [r, g, b] = hexRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hexHslStr(hex: string): string {
  return hexToHsla(hex, 1);
}

/** Convert a hex/hsl colour to an "H S% L% / alpha" string for hsl(var()) tokens. */
export function cssHsl(hex: string, alpha?: number): string {
  return hexToHsla(hex, alpha ?? 1);
}

function hexToHsla(color: string, alpha: number): string {
  const c = (color || '').trim();
  if (c.startsWith('hsl')) {
    return c.replace(/hsla?\(/, '') .replace(/\)$/, '') + `${alpha < 1 ? ` / ${alpha}` : ''}`;
  }
  const [h, s, l] = hexHslOf(c);
  return `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%${alpha < 1 ? ` / ${alpha}` : ''}`;
}

let _store: Phase2ThemeStore | null = null;

export function getPhase2ThemeStore(): Phase2ThemeStore {
  if (!_store) {
    _store = new Phase2ThemeStore();
  }
  return _store;
}

export function getPhase2CurrentApp(): AppId {
  return getPhase2ThemeStore().getCurrentApp();
}

export function setPhase2CurrentApp(appId: AppId, scope?: string | null): void {
  getPhase2ThemeStore().setCurrentApp(appId, scope);
}

export function getPhase2ThemeStateForApp(appId: AppId): Phase2ThemeState {
  return getPhase2ThemeStore().getState(appId);
}

export function getPhase2ThemeState(): Phase2ThemeState {
  return getPhase2ThemeStore().getState();
}

function subscribePhase2Theme(listener: Listener): () => void {
  return getPhase2ThemeStore().subscribe(listener);
}

// ── Public API (kept backwards compatible) ───────────────────────────
export type Phase2ThemeId = (typeof THEME_REGISTRY)[number]['id'];

export function setPhase2ThemePreset(id: string): void {
  getPhase2ThemeStore().setTheme(getPhase2ThemeStore().getCurrentApp(), id);
}

export function setPhase2Theme(id: string): void {
  getPhase2ThemeStore().setTheme(getPhase2ThemeStore().getCurrentApp(), id);
}

export function setPhase2Brightness(brightness: Phase2Brightness): void {
  getPhase2ThemeStore().setBrightness(getPhase2ThemeStore().getCurrentApp(), brightness);
}

export function setPhase2CustomTheme(custom: Phase2CustomTheme): void {
  getPhase2ThemeStore().setOverrides(getPhase2ThemeStore().getCurrentApp(), custom);
}

export function setPhase2Overrides(overrides: Partial<ThemePalette> | null): void {
  getPhase2ThemeStore().setOverrides(getPhase2ThemeStore().getCurrentApp(), overrides);
}

export function setPhase2Advanced(advanced: ThemeAdvanced): void {
  getPhase2ThemeStore().setAdvanced(getPhase2ThemeStore().getCurrentApp(), advanced);
}

export function applyPhase2ThemeState(appId: AppId, state: Phase2ThemeState): void {
  getPhase2ThemeStore().applyFullState(appId, state);
}

export function resetPhase2Theme(): void {
  getPhase2ThemeStore().reset(getPhase2ThemeStore().getCurrentApp());
}

export function applyPhase2Theme(state: Phase2ThemeState): void {
  if (typeof document === 'undefined') return;
  getPhase2ThemeStore().applyToDOM(state);
}

export function setAccentPreset(presetId: string): void {
  const preset = getAccentPreset(presetId);
  if (!preset) return;
  setAccentFromHue(preset.hue, preset.id);
}

export function setCustomAccentColor(hex: string): void {
  const [h, s] = hexHslOf(hex);
  setAccentFromHue(h, 'custom', s);
}

/**
 * Compute the accent override roles (primary, buttons, focus, nav-active,
 * selected text, glow) from a hue. Works for both light and dark modes.
 * Exported so the settings UI can preview accents without persisting.
 */
export function buildAccentOverrides(hue: number, mode: 'light' | 'dark', sat?: number): Partial<ThemePalette> {
  const light = mode === 'light';
  const s = Math.min(85, Math.max(45, sat != null && Number.isFinite(sat) ? sat + 10 : 72));
  const primaryL = light ? 42 : 55;
  const primary = hsl(hue, s, primaryL);
  const hoverL = light ? primaryL - 6 : primaryL + 8;
  const buttonHover = hsl(hue, s, hoverL);
  const activeL = light ? 88 : 14;
  const activeBg = hsla(hue, Math.min(80, s), activeL, light ? 0.18 : 0.25);
  const selText = hsl(hue, Math.min(80, s), light ? 35 : 76);
  const inputF = hsl(hue, Math.min(80, s), light ? 42 : 62);
  const glowC = hsla(hue, Math.min(80, s), light ? primaryL : 40, 0.45);
  return {
    primary,
    buttonBackground: primary,
    buttonHoverBackground: buttonHover,
    sidebarActive: activeBg,
    sidebarSelectedText: selText,
    inputFocus: inputF,
    glow: glowC,
  };
}

function setAccentFromHue(hue: number, /* unused id */ _id: string, sat?: number): void {
  const store = getPhase2ThemeStore();
  const state = store.getState();
  const mode = store.getResolvedBrightness(state) as 'light' | 'dark';
  const overrides = buildAccentOverrides(hue, mode, sat);
  const currentOverrides = state.overrides ?? {};
  store.setOverrides(store.getCurrentApp(), { ...currentOverrides, ...overrides });
}

export function usePhase2Theme(): Phase2ThemeState {
  return useSyncExternalStore(
    subscribePhase2Theme,
    () => getPhase2ThemeStore().getState(),
    () => DEFAULT_SNAPSHOT,
  );
}

// Re-export the preset list shape for the topbar (a flat list of themes).
export const PHASE2_THEME_PRESETS = THEME_REGISTRY.map((t) => ({
  id: t.id,
  name: t.name,
  type: t.type,
  primary: t.swatches[0],
  secondary: t.swatches[1] ?? t.swatches[0],
  description: t.description,
}));

export const Phase2ThemePreset = {};

export type Phase2ThemePresetT = (typeof PHASE2_THEME_PRESETS)[number];

// ── Accent color presets ──────────────────────────────────────────────
export type AccentPreset = {
  id: string;
  name: string;
  hex: string;
  hue: number;
};

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'saffron', name: 'Saffron', hex: '#F28C28', hue: 28 },
  { id: 'blue', name: 'Blue', hex: '#3B82F6', hue: 217 },
  { id: 'green', name: 'Green', hex: '#22C55E', hue: 142 },
  { id: 'purple', name: 'Purple', hex: '#8B5CF6', hue: 262 },
  { id: 'red', name: 'Red', hex: '#EF4444', hue: 0 },
  { id: 'teal', name: 'Teal', hex: '#14B8A6', hue: 168 },
];

export const DEFAULT_ACCENT_PRESET_ID = 'saffron';

export function getAccentPreset(id: string): AccentPreset | undefined {
  return ACCENT_PRESETS.find((p) => p.id === id);
}

// -----------------------------------------------------------------------------
// Editing helpers (used by the Theme Settings customization panel)
// -----------------------------------------------------------------------------

/** The roles (and human labels) a user can override with a real color picker. */
export const THEME_CUSTOM_ROLES: { key: keyof ThemePalette; label: string }[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'accent', label: 'Accent' },
  { key: 'pageBackground', label: 'Page background' },
  { key: 'cardBackground', label: 'Card background' },
  { key: 'sidebarBackground', label: 'Sidebar background' },
  { key: 'topbarBackground', label: 'Top bar background' },
  { key: 'foreground', label: 'Text' },
  { key: 'success', label: 'Success' },
  { key: 'warning', label: 'Warning' },
  { key: 'danger', label: 'Danger' },
  { key: 'info', label: 'Info' },
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Convert any CSS colour (hex, hsl, hsla, rgb, rgba) to #rrggbb. */
export function cssToHex(color: string): string {
  const c = (color || '').trim();
  if (!c || c === 'transparent') return '#888888';
  if (c.startsWith('#')) {
    let h = c.replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return h.length === 6 ? `#${h}` : '#888888';
  }
  if (c.startsWith('hsl')) {
    const m = c.match(/[\d.]+/g);
    if (!m || m.length < 3) return '#888888';
    const [h, s, l] = [+m[0], +m[1], +m[2]];
    const ss = clamp(s, 0, 100) / 100;
    const ll = clamp(l, 0, 100) / 100;
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const a = ss * Math.min(ll, 1 - ll);
      return ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    const to = (v: number) => clampByte(f(v) * 255);
    return `#${[to(0), to(8), to(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  // rgb / rgba
  const m = c.match(/[\d.]+/g);
  if (!m || m.length < 3) return '#888888';
  const to = (v: string) => clampByte(+v);
  return `#${[to(m[0]), to(m[1]), to(m[2])].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Resolve the effective palette for a theme+mode and return each editable role
 * as a #rrggbb value (for native colour pickers / preview swatches).
 */
export function resolvePaletteHex(
  themeId: string,
  mode: 'light' | 'dark',
  overrides?: Partial<ThemePalette> | null,
): Partial<Record<keyof ThemePalette, string>> {
  const base = buildThemePalette(themeId, mode);
  const out: Partial<Record<keyof ThemePalette, string>> = {};
  (Object.keys(base) as (keyof ThemePalette)[]).forEach((k) => {
    out[k] = cssToHex(overrides?.[k] ?? base[k]);
  });
  return out;
}
