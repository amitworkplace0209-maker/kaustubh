'use client';

/**
 * System Engines — shared types, constants, links and polling hooks.
 *
 * Single source of truth for BOTH the Service Control Center main page
 * (`/services/system`) and every engine profile/detail page
 * (`/services/system/[engineId]` + `/services/system/profile/[engineId]`).
 *
 * Every value rendered from these helpers comes from the Engine Registry API
 * (`/api/services/engines*`). Missing values surface as N/A — never invented.
 */

import {
  Activity, Database, HardDrive, Server, ShoppingCart, Wifi, Zap,
  type LucideIcon,
} from 'lucide-react';

export const ENGINES_API = '/api/services/engines';

/* ------------------------------------------------------------------ */
/* Types (mirror python-service/core/engines/engine_base.py snapshots) */
/* ------------------------------------------------------------------ */

export type EngineMetrics = {
  eventCount: number;
  errorCount: number;
  warningCount: number;
  lastOperationAt: number;
  lastOperationDurationMs: number;
  queueSize: number;
  workload: number;
  custom: Record<string, unknown>;
};

export type EngineErrorEntry = {
  timestamp: number;
  code: string;
  message: string;
};

export type EngineActivityEntry = {
  timestamp: number;
  type: string;
  message: string;
};

export type EngineStatus = {
  engineId: string;
  engineName: string;
  engineCategory: string;
  version: string;
  state: string;
  health: string;
  healthReason: string;
  startedAt: number;
  startedAtAgo: number | null;
  lastHeartbeat: number;
  heartbeatAge: number | null;
  metrics: EngineMetrics;
  recentErrors: EngineErrorEntry[];
  dependencies: string[];
  dependents: string[];
  configSummary: Record<string, unknown>;
  connectionState: string;
};

export type EngineDependencies = {
  engineId: string;
  dependencies: string[];
  dependents: string[];
  statuses: Record<string, { state: string; health: string }>;
};

export type BrokerStatus = {
  broker: string;
  displayName: string;
  implemented: boolean;
  state: string;
  sessionActive?: boolean;
  subscribedSymbols?: number;
  ticksPerSecond?: number;
  reconnectCount?: number;
  lastTickAt?: string;
  heartbeatAge?: number;
  latencyMs?: number;
  capabilities?: Record<string, unknown>;
  message?: string;
};

export type BrokerOption = {
  id: string;
  name: string;
  capabilities?: {
    trading?: boolean;
    marketData?: boolean;
    [key: string]: unknown;
  };
};

export type BrokerSwitchResult = {
  ok: boolean;
  error?: string;
  message?: string;
  previous?: string;
  current?: string;
  requiresConfirmation?: boolean;
};

export type SystemSummary = {
  overall: string;
  total: number;
  states: Record<string, number>;
  healths: Record<string, number>;
};

/* ------------------------------------------------------------------ */
/* Presentation constants                                              */
/* ------------------------------------------------------------------ */

export const STATE_COLORS: Record<string, string> = {
  RUNNING: 'bg-success/10 text-success border-success/20',
  HEALTHY: 'bg-success/10 text-success border-success/20',
  REGISTERED: 'bg-muted text-muted-foreground border-muted',
  STARTING: 'bg-warning/10 text-warning border-warning/20',
  STOPPED: 'bg-muted text-muted-foreground border-muted',
  STOPPING: 'bg-warning/10 text-warning border-warning/20',
  DEGRADED: 'bg-warning/10 text-warning border-warning/20',
  ERROR: 'bg-destructive/10 text-destructive border-destructive/20',
  DISCONNECTED: 'bg-destructive/10 text-destructive border-destructive/20',
  STALE: 'bg-warning/10 text-warning border-warning/20',
  DISABLED: 'bg-muted text-muted-foreground border-muted',
  DEPENDENCY_ERROR: 'bg-destructive/10 text-destructive border-destructive/20',
  RESTARTING: 'bg-warning/10 text-warning border-warning/20',
  UNKNOWN: 'bg-muted text-muted-foreground border-muted',
};

export const HEALTH_COLORS: Record<string, string> = {
  HEALTHY: 'text-success',
  DEGRADED: 'text-warning',
  UNHEALTHY: 'text-destructive',
  UNKNOWN: 'text-muted-foreground',
};

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  CORE: Server,
  TRADING: ShoppingCart,
  MARKET_DATA: Wifi,
  DATA: Database,
  CONTROL: Activity,
  STORAGE: HardDrive,
  AI: Zap,
};

export const CATEGORY_COLORS: Record<string, string> = {
  CORE: 'text-blue-500',
  TRADING: 'text-amber-500',
  MARKET_DATA: 'text-cyan-500',
  DATA: 'text-purple-500',
  CONTROL: 'text-emerald-500',
  STORAGE: 'text-orange-500',
  AI: 'text-pink-500',
};

/**
 * Engine → its dedicated workspace page inside this project.
 * Engines without a dedicated page have no entry — cards then hide the
 * "Open workspace" button instead of linking to a 404.
 */
export const ENGINE_WORKSPACE_LINKS: Record<string, { href: string; label: string }> = {
  audit_engine: { href: '/services/audit-engine', label: 'Audit Engine' },
  connection_manager: { href: '/services/connection-manager', label: 'Connection Manager' },
  db_writer_engine: { href: '/services/db-writer', label: 'DB Writer' },
  feature_engine: { href: '/services/feature-engine', label: 'Feature Engine' },
  market_watch: { href: '/services/market-watch', label: 'Market Watch' },
  notification_engine: { href: '/services/notifications', label: 'Notifications' },
  order_engine: { href: '/services/order-engine', label: 'Order Engine' },
  scheduler_engine: { href: '/services/scheduler', label: 'Scheduler' },
  search_engine: { href: '/services/search', label: 'Search' },
  session_manager: { href: '/services/session-manager', label: 'Session Manager' },
  squareoff_engine: { href: '/services/squareoff', label: 'Square-Off' },
  storage_engine: { href: '/services/storage', label: 'Storage' },
  websocket_engine: { href: '/services/websocket-engine', label: 'WebSocket Engine' },
  position_engine: { href: '/services/broker-terminal', label: 'Broker Terminal' },
};

/** Canonical profile/detail routes for one engine. */
export const engineProfileHref = (engineId: string) =>
  `/services/system/${encodeURIComponent(engineId)}`;

/* ------------------------------------------------------------------ */
/* Engine settings — declarative schema + validated writes            */
/* ------------------------------------------------------------------ */

/**
 * One engine setting, exactly as the backend declares it.
 *
 * `value` is the current effective value, `applied` is what the engine reports
 * it is actually using. They differ only when a write landed but the engine has
 * not taken it up yet — that is what `pending` flags, so the UI can say
 * "saved, pending restart" instead of claiming a change took effect.
 */
export type EngineConfigField = {
  key: string;
  label: string;
  summary: string;
  type: 'number' | 'boolean' | 'select' | 'text' | 'json';
  min: number | null;
  max: number | null;
  step: number | null;
  unit: string;
  options: unknown[];
  help: string;
  group: string;
  editable: boolean;
  restartRequired: boolean;
  value: unknown;
  applied: unknown;
  pending: boolean;
};

export type EngineConfig = {
  engineId: string;
  engineName: string;
  fields: EngineConfigField[];
  editable: number;
  readOnly: number;
};

export const engineConfigPath = (engineId: string): string =>
  `${ENGINES_API}/${encodeURIComponent(engineId)}/config`;

export type EngineConfigSaveResult = {
  ok: boolean;
  written?: Record<string, unknown>;
  errors?: Record<string, string>;
  config?: EngineConfig;
};

/** Save a settings patch. Per-field errors come back so the form can mark the
 *  exact input that was refused rather than showing a blanket failure. */
export async function saveEngineConfig(
  engineId: string,
  settings: Record<string, unknown>,
): Promise<EngineConfigSaveResult> {
  try {
    const res = await fetch(engineConfigPath(engineId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      return {
        ok: true,
        written: body.data?.written ?? {},
        errors: body.data?.errors ?? {},
        config: body.data?.config ?? null,
      };
    }
    // The backend reports refusals inside `error` on a non-ok envelope.
    const detail = body?.error ?? body?.data?.error ?? body?.data;
    const errors: Record<string, string> =
      detail && typeof detail === 'object' && !Array.isArray(detail) && detail.errors
        ? detail.errors
        : { '*': typeof detail === 'string' ? detail : `HTTP ${res.status}` };
    return { ok: false, errors };
  } catch (e: unknown) {
    return { ok: false, errors: { '*': e instanceof Error ? e.message : 'request failed' } };
  }
}

/* ------------------------------------------------------------------ */
/* Control-plane document (WebSocket `engines` channel)               */
/* ------------------------------------------------------------------ */

/**
 * The WHOLE control plane in one document.
 *
 * The backend pushes this on the `engines` WebSocket channel (every engine +
 * the registry summary + the broker registry), so the Service Control Center
 * renders from ONE socket subscription instead of four REST polls.
 */
export type EnginesDocument = {
  /** Engine status keyed by engine id. */
  engines: Record<string, EngineStatus>;
  count: number;
  summary: SystemSummary | null;
  brokers: {
    trading: BrokerStatus | null;
    marketData: BrokerStatus | null;
    list: BrokerOption[];
  } | null;
  generatedAt: string | null;
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Normalise the control plane into one shape.
 *
 * Accepts both carriers of the same facts:
 *   * the WebSocket document — `engines` is an OBJECT keyed by engine id;
 *   * the REST `/overview` payload — `engines` is an ARRAY of statuses.
 */
export function normalizeEnginesDocument(raw: unknown): EnginesDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = asRecord(raw);
  const body = asRecord(root.data ?? root);

  const rawEngines = body.engines ?? root.engines;
  const engines: Record<string, EngineStatus> = {};
  if (Array.isArray(rawEngines)) {
    for (const row of rawEngines) {
      const record = asRecord(row);
      const id = String(record.engineId ?? '');
      if (id) engines[id] = record as EngineStatus;
    }
  } else {
    for (const [id, row] of Object.entries(asRecord(rawEngines))) {
      engines[id] = asRecord(row) as EngineStatus;
    }
  }

  const brokersRaw = asRecord(body.brokers ?? root.brokers);
  const summaryRaw = asRecord(body.summary ?? root.summary);

  return {
    engines,
    count: Number(body.count ?? root.count ?? Object.keys(engines).length),
    summary: Object.keys(summaryRaw).length ? (summaryRaw as SystemSummary) : null,
    brokers: {
      trading: (asRecord(brokersRaw.trading) as BrokerStatus) ?? null,
      marketData: (asRecord(brokersRaw.marketData ?? brokersRaw['market-data']) as BrokerStatus) ?? null,
      list: asArray(brokersRaw.list) as BrokerOption[],
    },
    generatedAt: (body.generatedAt ?? root.generatedAt ?? null) as string | null,
  };
}

/**
 * One-shot REST load of the same control plane (the socket's fallback).
 *
 * Hits `/api/services/engines/overview` — ONE request for the engines, the
 * summary and the broker registry.
 */
export async function loadEnginesOverview(): Promise<EnginesDocument> {
  const res = await fetch(`${ENGINES_API}/overview`, { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const normalized = normalizeEnginesDocument(body?.data ?? body);
  if (!normalized) throw new Error('malformed control-plane payload');
  return normalized;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers (N/A for missing — never invented)               */
/* ------------------------------------------------------------------ */

export function fmtAgo(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'N/A';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s ago`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
}

/** Backend epoch-seconds (float) → IST clock label, or N/A. */
export function fmtEpoch(epochSec: number | null | undefined): string {
  if (epochSec == null || !Number.isFinite(epochSec) || epochSec <= 0) return 'N/A';
  try {
    return new Date(epochSec * 1000).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return 'N/A';
  }
}

export function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'N/A';
  return Math.round(v).toLocaleString('en-IN');
}

export function fmtValue(v: unknown): string {
  if (v == null) return 'N/A';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : 'N/A';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v === '' ? 'N/A' : v;
  try {
    const s = JSON.stringify(v);
    return s == null ? 'N/A' : (s.length > 120 ? `${s.slice(0, 120)}…` : s);
  } catch {
    return 'N/A';
  }
}

export function isRunningState(state: string): boolean {
  return ['RUNNING', 'HEALTHY', 'DEGRADED'].includes(state);
}

/* ------------------------------------------------------------------ */
/* Action helpers                                                      */
/* ------------------------------------------------------------------ */

export async function postEngineAction(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; error?: string; requiresConfirmation?: boolean }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? '{}' : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: !!data.ok && res.ok,
      error: data.error ?? data?.data?.error,
      requiresConfirmation: data.requiresConfirmation,
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'request failed' };
  }
}

/** Numeric custom metrics only — the chartable subset of metrics.custom. */
export function numericCustomMetrics(custom: Record<string, unknown> | undefined): { name: string; value: number }[] {
  if (!custom) return [];
  const out: { name: string; value: number }[] = [];
  for (const [name, v] of Object.entries(custom)) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ name, value: v });
  }
  return out.slice(0, 12);
}

/** Bucket activity entries per minute for the timeline chart. */
export function bucketActivityPerMinute(entries: EngineActivityEntry[]): { time: string; ops: number }[] {
  if (!entries || entries.length === 0) return [];
  const buckets = new Map<number, number>();
  for (const e of entries) {
    if (e?.timestamp == null || !Number.isFinite(e.timestamp)) continue;
    const minute = Math.floor(e.timestamp / 60) * 60;
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-30)
    .map(([epoch, ops]) => ({
      time: new Date(epoch * 1000).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
      }),
      ops,
    }));
}
