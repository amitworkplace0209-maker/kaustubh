'use client';

/**
 * Universal Theme Studio — the SINGLE canonical theme customization component
 * used across all phases and terminals.
 *
 * Renders the exact same UI and feature set everywhere, but scope determines
 * independent theme persistence.  The active appId + scope is set in the
 * theme store when the component mounts, and reset on unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Heart,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Search,
  Settings2,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { SectionCard } from '@/components/design-system';
import type { AppId } from '@/lib/apps';
import {
  THEME_CUSTOM_ROLES,
  MULTI_COLOR_THEMES,
  SINGLE_COLOR_THEMES,
  THEME_REGISTRY,
  ACCENT_PRESETS,
  DEFAULT_ACCENT_PRESET_ID,
  DEFAULT_ADVANCED,
  buildThemePalette,
  cssToHex,
  buildAccentOverrides,
  getPhase2ThemeStore,
  applyPhase2Theme,
  usePhase2Theme,
  setPhase2CurrentApp,
  getAccentPreset,
  getSavedCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  getFavorites,
  toggleFavorite,
  resolveSystemBrightness,
  type Phase2Brightness,
  type Phase2ThemeState,
  type ThemePalette,
  type AccentPreset,
  type SavedCustomTheme,
} from '@/lib/phase2-theme';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ThemeStudioScope {
  appId: AppId;
  /** Terminal scope within the trading app (dummy | kotak-neo | shoonya). */
  scope: string | null;
  /** Human-readable label shown in the UI (e.g. "Kotak Neo Terminal"). */
  label?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────

const MODES: [Phase2Brightness, React.ElementType, string][] = [
  ['light', Sun, 'Light'],
  ['dark', Moon, 'Dark'],
  ['system', Monitor, 'System'],
  ['amoled', Smartphone, 'Amoled'],
];

type FilterTab = 'all' | 'multi' | 'single' | 'dark' | 'light' | 'custom';

const FILTER_TABS: [FilterTab, string][] = [
  ['all', 'All'],
  ['multi', 'Multi'],
  ['single', 'Single'],
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['custom', 'Custom'],
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function hueOfHex(hex: string): number {
  let h = (hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return 14;
  const n = parseInt(h, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 14;
  let hh = 0;
  if (max === r) hh = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  return Math.round(((hh / 6) * 360 + 360) % 360);
}

function accentOverridesFor(mode: 'light' | 'dark', preset: AccentPreset): Partial<ThemePalette> {
  return buildAccentOverrides(preset.hue, mode);
}

function isDarkMode(themeId: string): boolean {
  const def = THEME_REGISTRY.find((t) => t.id === themeId);
  return def ? def.hue > 200 && def.hue < 340 : false;
}

// ─── Main Component ───────────────────────────────────────────────────────

export function ThemeStudio({ scope }: { scope: ThemeStudioScope }) {
  const { toast } = useToast();
  const theme = usePhase2Theme();
  const hasSetScope = useRef(false);

  // Set the active app/scope in the theme store on mount.
  useEffect(() => {
    setPhase2CurrentApp(scope.appId, scope.scope);
    hasSetScope.current = true;
    return () => {
      // On unmount, restore the persisted theme so a live preview never
      // lingers after leaving the Theme Studio.
      const store = getPhase2ThemeStore();
      applyPhase2Theme(store.getState(scope.appId));
    };
  }, [scope.appId, scope.scope]);

  // Local draft state
  const [draftId, setDraftId] = useState(theme.themeId);
  const [draftBrightness, setDraftBrightness] = useState<Phase2Brightness>(theme.brightness);
  const [custom, setCustom] = useState<Partial<ThemePalette>>(theme.overrides ?? {});
  const [appliedId, setAppliedId] = useState(theme.themeId);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [customThemes, setCustomThemes] = useState<SavedCustomTheme[]>([]);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [activeCustomId, setActiveCustomId] = useState<string | null>(null);
  const [hexInput, setHexInput] = useState('#F28C28');

  // Load persisted data
  useEffect(() => {
    if (!hasSetScope.current) return;
    setFavorites(getFavorites(scope.appId, scope.scope));
    setCustomThemes(getSavedCustomThemes(scope.appId, scope.scope));
  }, [scope.appId, scope.scope, theme]);

  // Sync draft with persisted state
  useEffect(() => {
    if (hasSetScope.current) {
      setDraftId(theme.themeId);
      setDraftBrightness(theme.brightness);
      setCustom(theme.overrides ?? {});
      setAppliedId(theme.themeId);
    }
  }, [theme.themeId, theme.brightness, theme.overrides]);

  // Derived values
  const resolvedMode = resolveSystemBrightness(draftBrightness);
  const basePalette = useMemo(() => buildThemePalette(draftId, resolvedMode), [draftId, resolvedMode]);
  const pickedDef = THEME_REGISTRY.find((t) => t.id === draftId) ?? null;

  // Hex input sync
  useEffect(() => {
    setHexInput(cssToHex(basePalette.primary));
  }, [basePalette.primary]);

  // Live preview: apply draft to DOM without persisting.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const preview: Phase2ThemeState = {
      themeId: draftId,
      brightness: draftBrightness,
      overrides: Object.keys(custom).length > 0 ? custom : null,
      advanced: { ...DEFAULT_ADVANCED },
    };
    applyPhase2Theme(preview);
  }, [draftId, draftBrightness, custom]);

  // ── Handlers ────────────────────────────────────────────────────────

  const pickAccent = useCallback(
    (presetId: string) => {
      const preset = getAccentPreset(presetId);
      if (!preset) return;
      setCustom((prev) => ({ ...prev, ...accentOverridesFor(resolvedMode, preset) }));
      toast({ title: 'Accent updated', description: `${preset.name} accent applied.` });
    },
    [resolvedMode, toast],
  );

  const applyCustomAccent = useCallback(
    (hex: string) => {
      if (!/^#?[0-9a-fA-F]{6}$/.test(hex.trim())) return;
      const normalized = hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`;
      const hue = hueOfHex(normalized);
      const overrides = accentOverridesFor(resolvedMode, { id: 'custom', name: 'Custom', hex: normalized, hue });
      setCustom((prev) => ({ ...prev, ...overrides }));
      setHexInput(normalized);
    },
    [resolvedMode],
  );

  const resetAccent = useCallback(() => {
    const preset = getAccentPreset(DEFAULT_ACCENT_PRESET_ID);
    if (!preset) return;
    setCustom((prev) => {
      const next = { ...prev };
      delete next.primary;
      delete next.buttonBackground;
      delete next.buttonHoverBackground;
      delete next.sidebarActive;
      delete next.sidebarSelectedText;
      delete next.inputFocus;
      delete next.glow;
      return Object.keys(next).length ? next : {};
    });
    setHexInput(preset.hex);
    toast({ title: 'Accent reset', description: 'Back to the default Saffron accent.' });
  }, [toast]);

  const apply = useCallback(() => {
    setBusy(true);
    try {
      const store = getPhase2ThemeStore();
      const appId = store.getCurrentApp();
      const next: Phase2ThemeState = {
        themeId: draftId,
        brightness: draftBrightness,
        overrides: Object.keys(custom).length > 0 ? custom : null,
        advanced: store.getState(appId).advanced,
      };
      store.applyFullState(appId, next);
      setAppliedId(draftId);
      toast({ title: 'Theme applied', description: `"${pickedDef?.name ?? draftId}" is now live.` });
    } catch {
      toast({ title: 'Failed to apply theme', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }, [draftId, draftBrightness, custom, pickedDef, toast]);

  const reset = useCallback(() => {
    const store = getPhase2ThemeStore();
    store.reset(store.getCurrentApp());
    const state = store.getState(store.getCurrentApp());
    setDraftId(state.themeId);
    setDraftBrightness(state.brightness);
    setCustom(state.overrides ?? {});
    setAppliedId(state.themeId);
    setConfirmReset(false);
    toast({ title: 'Theme reset', description: 'Back to the default theme for this context.' });
  }, [toast]);

  const selectTheme = useCallback((id: string) => {
    setDraftId(id);
    setCustom({});
    setActiveCustomId(null);
  }, []);

  const handleToggleFavorite = useCallback(
    (themeId: string) => {
      const newFavs = toggleFavorite(scope.appId, scope.scope, themeId);
      setFavorites(newFavs);
    },
    [scope.appId, scope.scope],
  );

  const handleSaveCustom = useCallback(() => {
    if (!saveName.trim()) return;
    const store = getPhase2ThemeStore();
    const state: Phase2ThemeState = {
      themeId: draftId,
      brightness: draftBrightness,
      overrides: Object.keys(custom).length > 0 ? custom : null,
      advanced: store.getState(store.getCurrentApp()).advanced,
    };
    saveCustomTheme(scope.appId, scope.scope, saveName.trim(), state);
    setCustomThemes(getSavedCustomThemes(scope.appId, scope.scope));
    setSaveDialogOpen(false);
    setSaveName('');
    toast({ title: 'Custom theme saved', description: `"${saveName.trim()}" saved to your collection.` });
  }, [scope.appId, scope.scope, draftId, draftBrightness, custom, saveName, toast]);

  const handleDeleteCustom = useCallback(
    (themeId: string) => {
      deleteCustomTheme(scope.appId, scope.scope, themeId);
      setCustomThemes(getSavedCustomThemes(scope.appId, scope.scope));
      toast({ title: 'Custom theme deleted' });
    },
    [scope.appId, scope.scope, toast],
  );

  const handleApplyCustomTheme = useCallback((saved: SavedCustomTheme) => {
    setDraftId(saved.themeId);
    setDraftBrightness(saved.brightness);
    setCustom(saved.overrides ?? {});
    setActiveCustomId(saved.id);
  }, []);

  // ── Filtering ───────────────────────────────────────────────────────

  const filteredThemes = useMemo(() => {
    let list: typeof THEME_REGISTRY;

    if (filter === 'custom') {
      // Show saved custom themes as pseudo-theme cards
      return customThemes;
    }

    switch (filter) {
      case 'multi':
        list = MULTI_COLOR_THEMES;
        break;
      case 'single':
        list = SINGLE_COLOR_THEMES;
        break;
      case 'dark':
        list = THEME_REGISTRY.filter((t) => isDarkMode(t.id));
        break;
      case 'light':
        list = THEME_REGISTRY.filter((t) => !isDarkMode(t.id));
        break;
      default:
        list = THEME_REGISTRY;
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.type.includes(q),
      );
    }

    return list;
  }, [filter, search, customThemes]);

  // ── Compute counts for filter badges ────────────────────────────────
  const applied = appliedId === draftId;

  return (
    <div className="space-y-4">
      {/* Scope label */}
      {scope.label && (
        <p className="text-sm text-muted-foreground">
          Configuring theme for <span className="font-medium text-foreground">{scope.label}</span>
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── Left column: Theme picker ──────────────────────────────── */}
        <div className="space-y-3 min-w-0">
          {/* Filter tabs + search */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 flex-wrap">
              {FILTER_TABS.map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setFilter(id)}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                    filter === id
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                  {id === 'custom' && customThemes.length > 0 && (
                    <span className="ml-1 text-[10px] text-muted-foreground">({customThemes.length})</span>
                  )}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[140px] max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search themes…"
                className="h-8 pl-8 text-xs"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {filter === 'custom' ? customThemes.length : (filteredThemes as typeof THEME_REGISTRY).length} themes
            </span>
          </div>

          {/* Theme grid — custom themes */}
          {filter === 'custom' && (
            <div className="space-y-3">
              {customThemes.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
                  <Palette className="mx-auto h-8 w-8 text-muted-foreground/50" />
                  <p className="mt-2 text-sm font-medium">No custom themes yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Customize a theme and save it as a custom preset for this context.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {customThemes.map((ct) => {
                    const ctDef = THEME_REGISTRY.find((t) => t.id === ct.themeId);
                    const active = activeCustomId === ct.id;
                    return (
                      <div
                        key={ct.id}
                        className={cn(
                          'theme-shadow rounded-xl border p-3 text-left transition-all',
                          active
                            ? 'border-primary ring-2 ring-primary/30 bg-card'
                            : 'border-border bg-card/50 hover:bg-card hover:border-primary/30',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="flex gap-1">
                            {(ctDef?.swatches ?? [cssToHex(basePalette.primary)]).slice(0, 3).map((sw, i) => (
                              <span
                                key={i}
                                className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
                                style={{ backgroundColor: sw }}
                              />
                            ))}
                          </span>
                          <button
                            onClick={() => handleDeleteCustom(ct.id)}
                            className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                            aria-label="Delete custom theme"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5">
                          <p className="text-sm font-semibold leading-tight">{ct.name}</p>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground capitalize">
                          {ctDef?.type === 'multi' ? 'Multi-colour' : 'Single-colour'} · {ct.brightness} mode
                        </p>
                        <button
                          onClick={() => handleApplyCustomTheme(ct)}
                          className="mt-2 w-full rounded-lg border border-border bg-muted/40 px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        >
                          Load
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Theme grid — built-in presets */}
          {filter !== 'custom' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {(filteredThemes as typeof THEME_REGISTRY).map((themeDef) => {
                const active = draftId === themeDef.id;
                const isApplied = appliedId === themeDef.id;
                const isFav = favorites.includes(themeDef.id);
                return (
                  <div
                    key={themeDef.id}
                    onClick={() => selectTheme(themeDef.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectTheme(themeDef.id);
                      }
                    }}
                    aria-pressed={active}
                    className={cn(
                      'theme-shadow rounded-xl border p-3 text-left cursor-pointer transition-all hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                      active
                        ? 'border-primary ring-2 ring-primary/30 bg-card'
                        : 'border-border bg-card/50 hover:bg-card',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex gap-1">
                        {themeDef.swatches.slice(0, 4).map((sw, i) => (
                          <span
                            key={i}
                            className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
                            style={{ backgroundColor: sw }}
                          />
                        ))}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleFavorite(themeDef.id);
                          }}
                          className={cn(
                            'shrink-0 transition-colors',
                            isFav ? 'text-rose-500' : 'text-muted-foreground/40 hover:text-rose-400',
                          )}
                          aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                        >
                          <Heart className={cn('h-3.5 w-3.5', isFav && 'fill-current')} />
                        </button>
                        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {themeDef.type}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5">
                      <p className="text-sm font-semibold leading-tight">{themeDef.name}</p>
                      {isApplied && <Check className="h-3.5 w-3.5 text-success" />}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{themeDef.description}</p>
                  </div>
                );
              })}
            </div>
          )}

          {filter !== 'custom' && (filteredThemes as typeof THEME_REGISTRY).length === 0 && search && (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
              <Search className="mx-auto h-8 w-8 text-muted-foreground/50" />
              <p className="mt-2 text-sm font-medium">No themes match &ldquo;{search}&rdquo;</p>
              <p className="mt-1 text-xs text-muted-foreground">Try a different search term.</p>
            </div>
          )}
        </div>

        {/* ── Right column: Settings + preview ──────────────────────── */}
        <div className="space-y-3 scroll-mt-20 min-w-0">
          {/* Selected theme card */}
          <SectionCard
            title="Selected theme"
            headerRight={
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  applied ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                )}
              >
                {applied ? <Check className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                {applied ? 'Applied' : 'Preview'}
              </span>
            }
          >
            <div className="flex items-center gap-3">
              <span
                className="flex h-12 w-12 items-center justify-center rounded-xl"
                style={{ backgroundColor: cssToHex(basePalette.primary) }}
              >
                <span
                  className="h-4 w-4 rounded-full"
                  style={{ backgroundColor: cssToHex(basePalette.pageBackground) }}
                />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{pickedDef?.name ?? 'Custom'}</p>
                <p className="text-[11px] capitalize text-muted-foreground">
                  {pickedDef?.type === 'multi' ? 'Multi-colour' : 'Single-colour'} · {resolvedMode} mode
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Accent: {ACCENT_PRESETS.find((p) => Math.abs(hueOfHex(cssToHex(custom.primary ?? basePalette.primary)) - p.hue) < 22)?.name ?? 'Custom'}
                </p>
              </div>
            </div>
          </SectionCard>

          {/* Mode */}
          <SectionCard title="Mode" icon={Monitor}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {MODES.map(([b, Icon, label]) => (
                <button
                  key={b}
                  onClick={() => setDraftBrightness(b)}
                  aria-pressed={draftBrightness === b}
                  aria-label={`${label} mode`}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-lg border px-1 py-2.5 text-[10px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary min-h-[52px]',
                    draftBrightness === b
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </SectionCard>

          {/* Accent color */}
          <SectionCard
            title="Accent color"
            icon={Palette}
            headerRight={
              <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={resetAccent}>
                <RotateCcw className="h-3 w-3 mr-1" /> Reset
              </Button>
            }
          >
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {ACCENT_PRESETS.map((preset) => {
                  const overridePrimary = custom.primary ?? basePalette.primary;
                  const activeAccent = Math.abs(hueOfHex(cssToHex(overridePrimary)) - preset.hue) < 22;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => pickAccent(preset.id)}
                      aria-pressed={activeAccent}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors hover:border-primary/50 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                        activeAccent ? 'border-primary bg-primary/10 text-primary' : 'border-border',
                      )}
                    >
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/10"
                        style={{ backgroundColor: preset.hex }}
                      />
                      <span className="truncate">{preset.name}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Custom accent"
                  value={hexInput}
                  onChange={(e) => applyCustomAccent(e.target.value)}
                  className="h-8 w-10 cursor-pointer rounded border border-input bg-background p-0.5"
                />
                <Input
                  value={hexInput}
                  onChange={(e) => setHexInput(e.target.value)}
                  onBlur={() => applyCustomAccent(hexInput)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyCustomAccent(hexInput);
                  }}
                  className="h-8 w-28 text-xs font-mono tabular-nums"
                  placeholder="#F28C28"
                />
                <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => applyCustomAccent(hexInput)}>
                  Apply
                </Button>
              </div>
            </div>
          </SectionCard>

          {/* Preview */}
          <SectionCard title="Preview" icon={Sparkles}>
            <div className="space-y-2.5 rounded-lg border border-border bg-card p-3">
              <p className="text-sm font-semibold">Sample card</p>
              <p className="text-xs text-muted-foreground">Live preview using actual theme tokens.</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">Primary</Button>
                <Button size="sm" variant="outline">Outline</Button>
                <Button size="sm" variant="ghost">Ghost</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" /> Connected
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning" /> Warning
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                  <span className="h-1.5 w-1.5 rounded-full bg-destructive" /> Error
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-2.5 py-1.5">
                <span className="h-3.5 w-3.5 rounded bg-primary" />
                <span className="text-xs font-medium text-primary">Active navigation item</span>
              </div>
              <div className="rounded-lg border border-border bg-background p-2">
                <div className="flex items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-success" />
                  <div className="h-2 flex-1 rounded bg-muted" />
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-warning" />
                  <div className="h-2 w-3/4 rounded bg-muted" />
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-destructive" />
                  <div className="h-2 w-1/2 rounded bg-muted" />
                </div>
              </div>
              <input
                type="text"
                readOnly
                value="Input field preview"
                className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-muted-foreground"
              />
            </div>
          </SectionCard>

          {/* Customize */}
          <SectionCard
            title="Customize"
            icon={Settings2}
            headerRight={
              <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setCustom({})}>
                <RotateCcw className="h-3 w-3 mr-1" /> Defaults
              </Button>
            }
          >
            <div className="space-y-1.5">
              {THEME_CUSTOM_ROLES.map((role) => {
                const value = cssToHex(custom[role.key] ?? basePalette[role.key]);
                return (
                  <label key={role.key} className="flex items-center justify-between gap-2 rounded-lg px-1 py-1">
                    <span className="text-xs text-muted-foreground">{role.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 rounded ring-1 ring-black/10" style={{ backgroundColor: value }} />
                      <input
                        type="color"
                        aria-label={role.label}
                        value={value}
                        onChange={(e) => setCustom((prev) => ({ ...prev, [role.key]: e.target.value }))}
                        className="h-7 w-10 cursor-pointer rounded border border-input bg-background p-0.5"
                      />
                    </span>
                  </label>
                );
              })}
            </div>
          </SectionCard>

          {/* Actions */}
          <div className="flex gap-2">
            <Button className="flex-1" onClick={apply} disabled={busy}>
              <Sparkles className="h-4 w-4 mr-1.5" />
              {busy ? 'Applying…' : 'Apply theme'}
            </Button>
            {confirmReset ? (
              <Button variant="destructive" onClick={reset} disabled={busy} className="flex-1">
                Confirm reset? (this context only)
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setConfirmReset(true)} disabled={busy}>
                <RotateCcw className="h-4 w-4 mr-1.5" />
                Reset
              </Button>
            )}
          </div>
          {confirmReset && (
            <button
              onClick={() => setConfirmReset(false)}
              className="w-full text-center text-[10px] text-muted-foreground hover:text-foreground"
            >
              Cancel reset
            </button>
          )}

          {/* Save as custom */}
          <div>
            {saveDialogOpen ? (
              <div className="rounded-xl border border-border bg-card p-3 space-y-2">
                <p className="text-xs font-medium">Save as custom theme</p>
                <div className="flex gap-2">
                  <Input
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="My Trading Dark"
                    className="h-8 text-xs flex-1"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveCustom();
                      if (e.key === 'Escape') setSaveDialogOpen(false);
                    }}
                  />
                  <Button size="sm" className="h-8 text-[11px]" onClick={handleSaveCustom} disabled={!saveName.trim()}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-[11px]"
                    onClick={() => {
                      setSaveDialogOpen(false);
                      setSaveName('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  This saves the current configuration as a custom preset for this context only.
                </p>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setSaveDialogOpen(true)}
              >
                Save as Custom Theme
              </Button>
            )}
          </div>

          <p className="text-center text-[10px] text-muted-foreground">
            Changes persist across reload &amp; the installed PWA.
          </p>
        </div>
      </div>
    </div>
  );
}
