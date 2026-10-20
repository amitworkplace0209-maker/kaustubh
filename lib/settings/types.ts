export type SettingsType = 'boolean' | 'number' | 'string' | 'select' | 'color' | 'time';

/**
 * How a persisted key takes effect at runtime.
 *
 *  - `live`     → the backend runtime engine (scheduler / WS supervisor / tick
 *                 pipeline) consumes it from the TTL cache within ~5s.
 *  - `restart`  → applied when the Python backend restarts (read-once config).
 *  - `saved`    → persisted server-side; no immediate runtime consumer yet (the
 *                 UI never hides this, but never claims it "applies now").
 */
export type SettingsApply = 'live' | 'restart' | 'saved';

export interface SettingsFieldDef {
  key: string;
  label: string;
  description?: string;
  type: SettingsType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Persisted backend settings key (constant per field). */
  sourceKey: string;
  apply?: SettingsApply;
  group?: string;
  placeholder?: string;
  /** Render as a masked/password-style input. */
  sensitive?: boolean;
  /** Excluded from export/import bundles. */
  excludeFromExport?: boolean;
  /** Informational read-only value (derived from live status, not a control). */
  readOnly?: boolean;
  hidden?: boolean;
}

export interface SettingsGroupDef {
  id: string;
  label: string;
  description?: string;
  fields: SettingsFieldDef[];
}

export interface SettingsSectionDef {
  id: string;
  label: string;
  shortLabel?: string;
  icon: string;
  description: string;
  keywords: string[];
  /** Whether the section appears in the internal settings sidebar. */
  nav: boolean;
  groups: SettingsGroupDef[];
}

export interface SettingsState {
  /** Flat persisted settings map (backend keys → values). */
  settings: Record<string, any>;
  /** Backend keys the runtime engine consumes live. */
  liveKeys: Set<string>;
  /** Backend unreachable or still loading. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Last sync time (epoch ms). */
  syncedAt: number | null;
  /** Pending outbound writes (optimistic). */
  pending: Record<string, any>;
  /** Recent persist errors (key → message). */
  errors: Record<string, string>;
  /** Recent settings activity (newest first). */
  activity: { key: string; value: any; at: number; ok?: boolean; err?: string }[];
}