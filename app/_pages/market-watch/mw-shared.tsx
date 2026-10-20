'use client';

import { useEffect, useRef, useState } from 'react';
import {
  RealtimeChannelSpec,
  RealtimeEnvelope,
  RealtimeTickView,
} from '@/lib/realtime-ws';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';

/**
 * Shared types + helpers for the Market Watch workspace (doc §9–§23).
 * Every value here models a REAL backend field; missing data stays null and
 * renders as "—"/PENDING — nothing is ever fabricated client-side.
 *
 * doc §24 is a hard boundary: this module TYPES backend-owned values and
 * RENDERS them. It never derives LTP change, change %, circuit distance,
 * timeframe movement, rankings, margin, eligibility or weekly membership.
 * Where a helper looks like arithmetic it is formatting only (`fmt*`).
 */

/** doc §27 stock-level business state (distinct from the feed `status` below). */
export type MwStockState =
  | 'ACTIVE'
  | 'DANGER'
  | 'INTRADAY_UNAVAILABLE'
  | 'STALE'
  | 'NO_DATA'
  | 'INVALID';

/** doc §20 classification with the documented precedence. */
export type MwClassification = 'DANGER' | 'INTRADAY_UNAVAILABLE' | 'GAINER' | 'LOSER' | 'NORMAL';

/** doc §14 circuit status — UNKNOWN means the broker gave us no circuit prices. */
export type MwCircuitStatus = 'SAFE' | 'NEAR' | 'DANGER' | 'HIT' | 'UNKNOWN';

/** doc §15/§17 eligibility + margin status. */
export type MwIntradayStatus = 'ELIGIBLE' | 'UNAVAILABLE' | 'UNKNOWN';
export type MwMarginStatus = 'AUTHORITATIVE' | 'BELOW_THRESHOLD' | 'UNAVAILABLE';

/** doc §27 engine-level states. */
export const ENGINE_STATES = [
  'OFFLINE',
  'PRE_MARKET',
  'WEEKLY_LOCKED',
  'STARTING',
  'SUBSCRIBING',
  'MONITORING',
  'DEGRADED',
  'BLOCKING',
  'STOPPING',
  'STOPPED',
  'REPORTING',
] as const;
export type MwEngineState = (typeof ENGINE_STATES)[number];

export const STOCK_STATES: readonly MwStockState[] = [
  'ACTIVE',
  'DANGER',
  'INTRADAY_UNAVAILABLE',
  'STALE',
  'NO_DATA',
  'INVALID',
];

export const CLASSIFICATIONS: readonly MwClassification[] = [
  'DANGER',
  'INTRADAY_UNAVAILABLE',
  'GAINER',
  'LOSER',
  'NORMAL',
];

export const CIRCUIT_STATUSES: readonly MwCircuitStatus[] = ['SAFE', 'NEAR', 'DANGER', 'HIT', 'UNKNOWN'];

export const INTRADAY_STATUSES: readonly MwIntradayStatus[] = ['ELIGIBLE', 'UNAVAILABLE', 'UNKNOWN'];

export const MARGIN_STATUSES: readonly MwMarginStatus[] = ['AUTHORITATIVE', 'BELOW_THRESHOLD', 'UNAVAILABLE'];

/** doc §32 weekly review commands. */
export type MwReviewAction = 'ADD' | 'REMOVE' | 'KEEP';
export const REVIEW_ACTIONS: readonly MwReviewAction[] = ['ADD', 'REMOVE', 'KEEP'];

/** doc §6 weekly universe lock status. */
export type MwWeekStatus = 'DRAFT' | 'LOCKED' | 'SUPERSEDED';

/** doc §5 advisory recommendation. Never acted on by the UI. */
export type MwRecommendation = 'ADD' | 'REMOVE' | 'KEEP' | 'REVIEW';

export interface MWRow {
  token: string;
  symbol: string;
  name?: string;
  exchange?: string;
  segment?: string;
  /** Per-token FEED status — freshness, not business state. */
  status?: string;
  ltp?: number | null;
  change?: number | null;
  changePercent?: number | null;
  volume?: number | null;
  oi?: number | null;
  tradedValue?: number | null;
  spread?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  avgPrice?: number | null;
  fiveMinPercent?: number | null;
  tenMinPercent?: number | null;
  dataAgeSec?: number | null;
  lastTickAt?: number | null;
  upperCircuit?: number | null;
  lowerCircuit?: number | null;
  yearlyHigh?: number | null;
  yearlyLow?: number | null;
  buySellRatio?: number | null;
  lastTradeTime?: string | null;
  intradayEligible?: boolean;

  // ---- doc §14 circuit: backend-owned distance + status ----
  circuitDistanceUpperPct?: number | null;
  circuitDistanceLowerPct?: number | null;
  /** Minimum valid distance across both sides — doc §14 danger input. */
  circuitDistancePct?: number | null;
  circuitBandPct?: number | null;
  circuitStatus?: MwCircuitStatus | null;

  // ---- doc §17 margin: authoritative broker values only ----
  marginValue?: number | null;
  marginMultiplier?: number | null;
  marginStatus?: MwMarginStatus | null;

  // ---- doc §15 intraday eligibility ----
  intradayStatus?: MwIntradayStatus | null;

  // ---- doc §19 flat per-timeframe change (rendered, never computed here) ----
  change_1m?: number | null;
  change_1m_pct?: number | null;
  change_2m?: number | null;
  change_2m_pct?: number | null;
  change_5m?: number | null;
  change_5m_pct?: number | null;
  change_10m?: number | null;
  change_10m_pct?: number | null;
  change_30m?: number | null;
  change_30m_pct?: number | null;

  // ---- doc §20/§21/§27 classification ----
  classification?: MwClassification | null;
  stockState?: MwStockState | null;
  movementFlags?: Partial<Record<'1m' | '2m' | '5m' | '10m' | '30m', boolean>> | null;

  // ---- doc §16 ₹800 observation counters ----
  observationsAboveThreshold?: number | null;
  observationsAtOrBelowThreshold?: number | null;

  dataCompleteness?: number | null;
  eligibilityStatus?: string | null;
  blockReason?: string | null;
  /** doc §12 feed quality: LIVE / IN_PROGRESS / COMPLETE / INCOMPLETE / STALE / UNAVAILABLE. */
  dataQuality?: string | null;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Weekly locked universe (doc §2, §4, §5, §6, §7, §16, §17, §30, §32, §33)
// ---------------------------------------------------------------------------

export interface MwUniverseLock {
  weekId: string;
  version: number;
  status: MwWeekStatus;
  symbolCount: number;
  addedCount: number;
  removedCount: number;
  keptCount: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  lockedAt?: string | null;
  lockedBy?: string | null;
  sourceWeekId?: string | null;
  notes?: string | null;
}

export interface MwUniverseVerify {
  ok: boolean;
  reason?: string | null;
  expectedWeekId?: string | null;
  loadedWeekId?: string | null;
  version?: number | null;
  symbolCount?: number;
  detail?: string;
}

export interface MwWeeklyConfig {
  enabled?: boolean;
  reviewWeekday?: number;
  reviewHhmm?: string;
  universeSource?: string;
  lockEnabled?: boolean;
  lockDefaultUser?: string;
  lockHistoryRetentionWeeks?: number;
  rupeeThreshold?: number;
  rupeeObservationIntervalSeconds?: number;
  marginMultiplierThreshold?: number;
  dangerCircuitPct?: number;
  moverThresholdPct?: number;
  normalThresholdPct?: number;
  lockedUniverseRequired?: boolean;
}

export interface MwReviewDecision {
  weekId: string;
  symbol: string;
  action: MwReviewAction;
  note?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
}

/** doc §5 weekly report row — every field is nullable by design. */
export interface MwWeeklyReportRow {
  symbol: string;
  tradingSymbol?: string | null;
  companyName?: string | null;
  exchange?: string | null;
  segment?: string | null;
  token?: string | null;
  instrumentType?: string | null;
  series?: string | null;
  lotSize?: number | null;
  tickSize?: number | null;
  precision?: number | null;
  multiplier?: number | null;
  isin?: string | null;
  latestLtp?: number | null;
  weeklyMinLtp?: number | null;
  weeklyMaxLtp?: number | null;
  observationsAboveThreshold?: number | null;
  observationsAtOrBelowThreshold?: number | null;
  threshold?: number | null;
  firstObservedPrice?: number | null;
  lastObservedPrice?: number | null;
  weeklyChange?: number | null;
  weeklyChangePercent?: number | null;
  tradingDaysObserved?: number | null;
  intradayEligible?: boolean | null;
  upperCircuit?: number | null;
  lowerCircuit?: number | null;
  minCircuitDistancePct?: number | null;
  circuitDangerObservations?: number | null;
  marginValue?: number | null;
  marginMultiplier?: number | null;
  marginStatus?: string | null;
  marginMeetsThreshold?: boolean | null;
  marginThresholdMultiplier?: number | null;
  volume?: number | null;
  dataCompleteness?: number | null;
  timeframes?: string[] | null;
  recommendation?: MwRecommendation | null;
}

export interface MwWeeklyReport {
  weekId: string;
  weekStart?: string;
  weekEnd?: string;
  tradingDays?: string[];
  generatedAt?: string;
  sourceWeekId?: string | null;
  universeSize?: number;
  threshold?: number;
  dangerCircuitPct?: number;
  marginThresholdMultiplier?: number;
  counts?: {
    reviewed?: number;
    withData?: number;
    withoutData?: number;
    recommendAdd?: number;
    recommendRemove?: number;
    recommendKeep?: number;
    recommendReview?: number;
  };
  rows?: MwWeeklyReportRow[];
  notes?: string[];
}

export interface MwWeeklyResponse {
  ok: boolean;
  weekId: string;
  /** doc §2 — the week whose membership the operator decides and then locks. */
  targetWeekId?: string;
  /** True once ``targetWeekId`` is locked; further changes are then refused. */
  targetWeekLocked?: boolean;
  /** doc §5 — the week the advisory report READS (the one that just finished). */
  reportWeekId?: string;
  /** IST timestamp of the next scheduled Saturday review. */
  nextReviewAt?: string | null;
  locked?: MwUniverseLock | null;
  draft?: MwUniverseLock | null;
  draftSymbols?: string[];
  decisions?: Record<string, MwReviewDecision>;
  history?: MwUniverseLock[];
  verify?: MwUniverseVerify;
  config?: MwWeeklyConfig;
  /** Friday 15:25 automatic universe refresh (backend-resolved schedule). */
  fridayScan?: MwFridayScan;
  engine?: {
    weekId?: string | null;
    version?: number | null;
    symbolCount?: number;
    universeVerify?: MwUniverseVerify;
  };
}

export interface MwFridayScan {
  enabled?: boolean;
  scanWeekday?: number;
  scanHhmm?: string;
  nextScanAt?: string | null;
  nextTargetWeekId?: string | null;
  priceCap?: number | null;
  marginMultiplierThreshold?: number | null;
  running?: boolean;
  lastScan?: {
    scanWeekId?: string | null;
    targetWeekId?: string | null;
    weekId?: string | null;
    symbols?: number | null;
    version?: number | null;
    trigger?: string | null;
    reason?: string | null;
    at?: number | null;
    atIso?: string | null;
  } | null;
}

export interface MwFridayScanResponse {
  ok: boolean;
  triggered?: boolean;
  trigger?: string;
  scanWeekId?: string;
  targetWeekId?: string;
  weekId?: string;
  symbolCount?: number;
  version?: number;
  reason?: string | null;
  detail?: string;
  message?: string;
  scan?: {
    candidates?: number;
    priced?: number;
    marginResolved?: number;
    marginUnavailable?: number;
    selectedCount?: number;
    rejectedCount?: number;
    reasonCounts?: Record<string, number>;
  };
}

export interface MwScanResponse {
  ok: boolean;
  weekId: string;
  persisted: boolean;
  counts?: MwWeeklyReport['counts'];
  threshold?: number;
  rows?: MwWeeklyReportRow[];
}

/** doc §30 observability contract. */
export interface MwObservability {
  generatedAt?: string;
  metrics: {
    locked_universe_count: number | null;
    active_subscription_count: number | null;
    received_tick_count: number | null;
    validated_tick_count: number | null;
    invalid_tick_count: number | null;
    invalid_tick_reasons?: Record<string, number>;
    danger_count: number | null;
    intraday_unavailable_count: number | null;
    top_gainers_count: number | null;
    top_losers_count: number | null;
    movers_1m_count: number | null;
    movers_5m_count: number | null;
    movers_10m_count: number | null;
    movers_30m_count: number | null;
    last_tick_at: number | null;
    processing_latency_ms: number | null;
    publish_latency_ms: number | null;
    websocket_status: string | null;
    stockStates?: Record<string, number>;
    classificationCounts?: Record<string, number>;
    weekly?: MwWeeklyEngineInfo;
    feedState?: string | null;
  };
  thresholds?: {
    dangerCircuitPct?: number;
    moverThresholdPct?: number;
    normalThresholdPct?: number;
    rupeeThreshold?: number;
    marginMultiplierThreshold?: number;
  };
}

export interface MwWeeklyEngineInfo {
  universeSource?: string;
  weekId?: string | null;
  version?: number | null;
  status?: string | null;
  lockedAt?: string | null;
  lockedBy?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  addedCount?: number | null;
  removedCount?: number | null;
  keptCount?: number | null;
  resolvedSymbolCount?: number;
  unresolvedSymbolCount?: number;
  unresolvedSymbols?: string[];
  verify?: MwUniverseVerify;
  engineState?: MwEngineState;
}

/** doc §22 board names the backend owns. */
export interface MwBoardsResponse {
  ok: boolean;
  counts: Record<string, number>;
  moverThresholdPct?: number;
  dangerCircuitPct?: number;
  boards: Record<string, MWRow[]>;
}

export interface Pinned {
  token: string;
  symbol: string;
  appearances?: number;
  lastRank?: number;
  lastSeen?: number;
  name?: string;
  exchange?: string;
  segment?: string;
  [k: string]: unknown;
}

export interface PinsInfo {
  ok: boolean;
  tradingDate: string;
  gainers: Pinned[];
  losers: Pinned[];
  manual: Pinned[];
  manualCount?: number;
  maxManualPins?: number;
}

export interface UiPayload {
  ok: boolean;
  tradingDate: string;
  indexVersion: number;
  generatedAt: string;
  feedState: string;
  liveStateCount: number;
  universeSize: number;
  subscribedTokenCount?: number;
  statusCounts: Record<string, number>;
  /** doc §16: stocks above mwr_price_max leave the list + tick feed. */
  priceCappedCount?: number;
  priceCap?: number | null;
  watchableCount?: number;
}

/**
 * One entry of the controlled publish payload (doc §16). `/api/market-watch/ui`
 * returns `sections` as an ORDERED ARRAY of these — it is NOT keyed by section
 * name like `/api/market-watch/sections` (see `SectionsPayload`). Keeping the
 * two shapes in one module stops a caller from typing one and reading the other,
 * which silently renders an always-empty panel.
 */
export interface MwUiSection {
  section: string;
  indexVersion?: number;
  generatedAt?: string;
  items: MWRow[];
}

/** `GET /api/market-watch/ui` — the controlled publish read (doc §16). */
export interface UiPublishPayload extends UiPayload {
  sections: MwUiSection[];
  pinned?: { gainers?: MWRow[]; losers?: MWRow[] };
}

/** Look up one section by its `section` key, case/format tolerant. */
export function uiSection(payload: UiPublishPayload | null | undefined, name: string): MWRow[] {
  if (!payload?.sections) return [];
  const wanted = name.toLowerCase();
  const hit = payload.sections.find((s) => String(s?.section ?? '').toLowerCase() === wanted);
  return hit?.items ?? [];
}

export interface RankingInfo {
  ok: boolean;
  tradingDate: string;
  lastSnapshotAt: number | null;
  snapshotCount: number;
  latest: { timestamp: string; topGainers: string[]; topLosers: string[] } | null;
  gainers?: string[];
  losers?: string[];
}

export interface SectionsPayload {
  ok: boolean;
  tradingDate: string;
  indexVersion: number;
  generatedAt: string;
  feedState: string;
  liveStateCount: number;
  universeSize: number;
  statusCounts: Record<string, number>;
  sections: Record<string, MWRow[]>;
}

export interface ConfigResponse {
  ok: boolean;
  tradingDate: string;
  feedState: string;
  engine: Record<string, any>;
  ranking: { intervalSeconds?: number; maxGainerPins?: number; maxLoserPins?: number; trackedTopN?: number };
  limits: { maxManualPins?: number; pageSize?: number; initialSectionLimit?: number };
  filterCatalog: FilterCatalogEntry[];
  statusCounts: Record<string, number>;
}

export type FilterType = 'range' | 'minimum' | 'enum' | 'text';

export interface FilterCatalogEntry {
  key: string;
  label: string;
  type: FilterType;
  options?: string[];
}

export interface SavedFilter {
  filterId: string;
  name: string;
  description: string;
  limit: number;
  createdAt?: string;
}

export interface SavedFilterDetail extends SavedFilter {
  criteria: FilterCriterion[];
}

export interface FilterCriterion {
  key: string;
  op: string;
  value: number | number[] | string | string[];
}

export interface RankResponse {
  ok: boolean;
  tradingDate: string;
  generatedAt: string;
  indexVersion: number;
  feedState: string;
  offset: number;
  limit: number;
  count: number;
  total: number;
  hasMore: boolean;
  sortBy: string;
  sortDir: string;
  items: MWRow[];
}

export interface SymbolDetail {
  ok: boolean;
  symbol: string;
  token: string;
  tradingDate?: string;
  generatedAt?: string;
  feedState?: string;
  state: { status: string; dataAgeSec?: number | null; intradayEligible: boolean; priceSource: string };
  quote?: Record<string, any>;
  depth: { source: string; buy: DepthLevel[]; sell: DepthLevel[]; available: boolean };
  record: MWRow;
  circuit: { upperCircuit?: number | null; lowerCircuit?: number | null; circuitAvailable: boolean };
  manualPinned: boolean;
}

export interface DepthLevel {
  price?: number | null;
  quantity?: number | null;
  orders?: number | null;
}

export const WATCH_CHANNEL = 'market_watch';

/**
 * doc §26 — the maximum number of raw per-token tick streams one Market Watch
 * tab may hold open at once. §26 permits the browser to follow *visible*,
 * pinned and selected stocks, not the whole locked universe at tick rate; this
 * is the explicit budget that keeps a rendered page inside that envelope.
 * Exceeding it is surfaced in the UI rather than silently truncated.
 */
export const RAW_TICK_BUDGET = 120;

/**
 * doc §25/§26 — REST reconciliation interval.
 *
 * Realtime `market_watch.status` / `.ranking` / `.pins` frames already carry
 * these payloads, so this is deliberately SLOW: it is a safety net for a dropped
 * socket or a missed frame, not the primary update path. The page used to
 * re-fetch the whole `/ui` + `/sections` + `/pins` set every 12 s regardless of
 * whether anything had changed.
 *
 * Retained under the old name for callers that still reference it; no Market
 * Watch tab uses it as its update path any more.
 */
export const POLL_INTERVAL_MS = 12000;
/** Safety-net cadence for the realtime-driven tabs. */
export const RECONCILE_INTERVAL_MS = 60000;

export const FRESHNESS_STALE_S = 3;
export const FRESHNESS_PENDING_S = 12;

// ---------------------------------------------------------------------------
// Lifecycle / phase contract (docs/engines/MARKET_WATCH.md §5, §8).
//
// The engine owns every transition. The frontend never advances a phase, never
// derives one from the wall clock, and never invents an intermediate state — it
// renders whatever `GET /api/market-watch/progress` reports. LIFECYCLE_STATES
// only mirrors the backend's ordered tuple (services/market_watch_lifecycle.py)
// so the UI can draw progress rails and label the current position.
// ---------------------------------------------------------------------------

export const LIFECYCLE_STATES = [
  'PRE_MARKET',
  'DISCOVERY',
  'FILTERING',
  'SUBSCRIBED',
  'MONITORING',
  'BLOCKING',
  'FINAL_MONITORING',
  'MARKET_WATCH_STOPPED',
  'REPORTING',
  'COMPLETED',
  'RUNTIME_INACTIVE',
] as const;

export type MwLifecycleState = (typeof LIFECYCLE_STATES)[number] | 'UNKNOWN';

/** doc §8 — the operator-configured runtime window, published by the engine. */
export interface MwRuntimeSchedule {
  runtimeStart?: string | null;
  runtimeStop?: string | null;
  preMarket?: string | null;
  discovery?: string | null;
  filterStart?: string | null;
  filterWindowEnd?: string | null;
  subscriptionEnd?: string | null;
  activeFrom?: string | null;
  finalMonitoring?: string | null;
  stop?: string | null;
  report?: string | null;
  reportReady?: string | null;
}

/** Backend `LifecycleSnapshot.to_dict()` subset carried on /progress + frames. */
export interface MwLifecycle {
  state?: string | null;
  previousState?: string | null;
  /** Epoch seconds (float) as emitted by the engine — not an ISO string. */
  changedAt?: number | string | null;
  tradingDate?: string | null;
  serverTime?: string | null;
  nextState?: string | null;
  minutesToNext?: number | null;
  dataActive?: boolean | null;
  monitoring?: boolean | null;
  states?: string[] | null;
  eligibleCount?: number | null;
  subscribedCount?: number | null;
  universeState?: string | null;
  /** doc §8 — the engine's own "is now inside the runtime window" verdict. */
  runtimeActive?: boolean | null;
  schedule?: MwRuntimeSchedule | null;
  report_ready?: boolean | null;
}

/** `08:50`-style config value rendered with the IST timezone label. */
export function runtimeWindowLabel(schedule?: MwRuntimeSchedule | null): string | null {
  const start = schedule?.runtimeStart;
  const stop = schedule?.runtimeStop;
  if (!start || !stop) return null;
  return `${start} – ${stop} IST`;
}

/** `GET /api/market-watch/progress` — the canonical engine progress read. */
export interface MwProgress {
  ok?: boolean;
  feedState?: string | null;
  lifecycle?: MwLifecycle;
  universe?: { total?: number | null; known?: number | null; eligible?: number | null } | null;
  subscribed?: number | null;
  withLivePrice?: number | null;
  statusCounts?: Record<string, number> | null;
  indexVersion?: number | null;
  ranking?: Record<string, any> | null;
  generatedAt?: string | null;
}

/** Terminal states — the engine is done; the UI must not imply live work. */
const LIFECYCLE_TERMINAL: ReadonlySet<string> = new Set(['MARKET_WATCH_STOPPED', 'REPORTING', 'COMPLETED', 'RUNTIME_INACTIVE']);

/** Phases where the engine actively maintains live per-symbol state (doc §8). */
const LIFECYCLE_MONITORING: ReadonlySet<string> = new Set(['MONITORING', 'BLOCKING', 'FINAL_MONITORING']);

/** Normalise an arbitrary backend state string for display. */
export function lifecycleState(raw: string | null | undefined): MwLifecycleState {
  const s = String(raw ?? '').trim().toUpperCase();
  return (LIFECYCLE_STATES as readonly string[]).includes(s) ? (s as MwLifecycleState) : 'UNKNOWN';
}

export function lifecycleIndex(state: MwLifecycleState): number {
  return state === 'UNKNOWN' ? -1 : LIFECYCLE_STATES.indexOf(state);
}

export function isLifecycleMonitoring(state: MwLifecycleState): boolean {
  return LIFECYCLE_MONITORING.has(state);
}

export function isLifecycleTerminal(state: MwLifecycleState): boolean {
  return LIFECYCLE_TERMINAL.has(state);
}

/**
 * Format a lifecycle transition timestamp. The engine emits `changedAt` as
 * epoch SECONDS (float), so it is rendered in IST to match the engine's own
 * schedule clock rather than the browser's timezone.
 */
export function lifecycleChangedAtLabel(value: number | string | null | undefined): string | null {
  if (value == null) return null;
  const epochSec = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(epochSec)) return String(value);
  try {
    return new Date(epochSec * 1000).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
}

export function lifecycleLabel(state: MwLifecycleState): string {
  if (state === 'UNKNOWN') return 'Unknown';
  return state
    .split('_')
    .map((w) => (w === 'MW' ? 'MW' : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

export const STATUSES: Record<string, { tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }> = {
  LIVE: { tone: 'success', label: 'LIVE' },
  STALE: { tone: 'warning', label: 'STALE' },
  PENDING: { tone: 'info', label: 'PENDING' },
  NO_DATA: { tone: 'danger', label: 'NO DATA' },
  INACTIVE: { tone: 'neutral', label: 'INACTIVE' },
};

export const SORT_FIELDS: { key: string; label: string }[] = [
  { key: 'changePercent', label: 'Change %' },
  { key: 'ltp', label: 'LTP' },
  { key: 'volume', label: 'Volume' },
  { key: 'turnover', label: 'Turnover' },
  { key: 'fiveMinPercent', label: '5 min' },
  { key: 'tenMinPercent', label: '10 min' },
  { key: 'spread', label: 'Spread' },
  { key: 'oi', label: 'Open Interest' },
  { key: 'symbol', label: 'Symbol' },
  // doc §19/§23 — sorting by a backend-owned field is reading it, not deriving
  // it, so these are safe to offer as sort keys.
  { key: 'change_1m_pct', label: '1 min %' },
  { key: 'change_30m_pct', label: '30 min %' },
  { key: 'circuitDistancePct', label: 'Circuit dist %' },
  { key: 'marginMultiplier', label: 'Margin mult' },
  { key: 'tickCount', label: 'Ticks' },
];

// ---------------------------------------------------------------------------
// Formatting helpers.
//
// These are the ONLY arithmetic in this module and they are presentation-only:
// they take a backend value and render it. Nothing here derives a market fact
// (doc §24).
// ---------------------------------------------------------------------------

export const DASH = '—';

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** doc §20/§27 — render a backend classification. Never inferred from a sign. */
export function classificationOf(row: MWRow): MwClassification | null {
  const value = row.classification;
  return value && (CLASSIFICATIONS as readonly string[]).includes(value) ? (value as MwClassification) : null;
}

export function stockStateOf(row: MWRow): MwStockState | null {
  const value = row.stockState;
  return value && (STOCK_STATES as readonly string[]).includes(value) ? (value as MwStockState) : null;
}

export function isNonActive(row: MWRow): boolean {
  const state = stockStateOf(row);
  return state === 'DANGER' || state === 'INTRADAY_UNAVAILABLE';
}

/** doc §21 — per-timeframe mover flags, rendered from the backend booleans. */
export function moverFlag(row: MWRow, tf: '1m' | '2m' | '5m' | '10m' | '30m'): boolean {
  return row.movementFlags?.[tf] === true;
}

/** Tone for a backend-provided movement value. Presentation only. */
export function movementTone(pct: number | null | undefined): 'up' | 'down' | 'flat' | 'none' {
  if (!isNum(pct)) return 'none';
  if (pct > 0) return 'up';
  if (pct < 0) return 'down';
  return 'flat';
}

export function fmtPct(pct: number | null | undefined, digits = 2): string {
  return isNum(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%` : DASH;
}

export function fmtNum(value: number | null | undefined, digits = 2): string {
  return isNum(value) ? value.toFixed(digits) : DASH;
}

export function fmtInt(value: number | null | undefined): string {
  return isNum(value) ? Math.round(value).toLocaleString('en-IN') : DASH;
}

/** doc §14 — circuit distance as the backend reported it. */
export function fmtCircuitDistance(row: MWRow): string {
  const value = row.circuitDistancePct;
  return isNum(value) ? `${value.toFixed(2)}%` : DASH;
}

/** doc §17 — margin is either the broker value or explicitly unavailable. */
export function fmtMargin(row: MWRow): string {
  if (isNum(row.marginValue)) return `₹${row.marginValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  return DASH;
}

export function fmtLeverage(row: MWRow): string {
  return isNum(row.marginMultiplier) ? `${row.marginMultiplier.toFixed(2)}x` : DASH;
}

/** doc §16 — the ₹800 observation counters. */
export function fmtThresholdSplit(row: MWRow): string {
  const above = row.observationsAboveThreshold;
  const below = row.observationsAtOrBelowThreshold;
  if (!isNum(above) && !isNum(below)) return DASH;
  return `${above ?? 0} / ${below ?? 0}`;
}

const TONE_CLASS: Record<string, string> = {
  success: 'text-emerald-500',
  danger: 'text-red-500',
  warning: 'text-amber-500',
  info: 'text-sky-500',
  neutral: 'text-muted-foreground',
};

/** Presentation map for backend state labels. Renders; never derives. */
export const STATE_TONES: Record<string, keyof typeof TONE_CLASS> = {
  ACTIVE: 'success',
  LIVE: 'success',
  GAINER: 'success',
  DANGER: 'danger',
  INTRADAY_UNAVAILABLE: 'danger',
  HIT: 'danger',
  STALE: 'warning',
  NEAR: 'warning',
  BELOW_THRESHOLD: 'warning',
  UNAVAILABLE: 'warning',
  NO_DATA: 'neutral',
  INVALID: 'danger',
  UNKNOWN: 'neutral',
  NORMAL: 'neutral',
  LOSER: 'danger',
  SAFE: 'success',
  ELIGIBLE: 'success',
  AUTHORITATIVE: 'success',
};

export function toneClass(tone: string | null | undefined): string {
  return TONE_CLASS[String(tone ?? '').toUpperCase()] ?? 'text-muted-foreground';
}

// ---------------------------------------------------------------------------
// Weekly locked-universe API (doc §4, §5, §6, §32, §33)
//
// These calls are the ONLY way the UI can change membership, and each one maps
// to a single doc §32 command. The UI never edits the universe locally.
// ---------------------------------------------------------------------------

export async function fetchWeekly(weekId?: string): Promise<MwWeeklyResponse> {
  const q = weekId ? `?weekId=${encodeURIComponent(weekId)}` : '';
  return fetchJson<MwWeeklyResponse>(`/api/market-watch/weekly${q}`);
}

export async function fetchWeeklyUniverse(): Promise<{
  ok: boolean;
  locked: MwUniverseLock | null;
  symbols: string[];
  engineUniverseSize: number;
  subscribedTokenCount: number;
  universeVerify: MwUniverseVerify;
  boardCounts: Record<string, number>;
}> {
  return fetchJson('/api/market-watch/weekly/universe');
}

export async function runWeeklyScan(weekId?: string): Promise<MwScanResponse> {
  return fetchJson<MwScanResponse>('/api/market-watch/weekly/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(weekId ? { weekId } : {}),
  });
}

/**
 * Run the Friday-style full-universe scan on demand.
 *
 * The backend screens every NSE EQ instrument (intraday, LTP below the cap,
 * margin >= multiplier), locks the upcoming week and applies the no-expiry
 * Session Manager subscription intent. The UI never filters locally.
 */
export async function runFridayScan(targetWeekId?: string): Promise<MwFridayScanResponse> {
  return fetchJson<MwFridayScanResponse>('/api/market-watch/friday-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(targetWeekId ? { targetWeekId } : {}),
  });
}

export async function fetchWeeklyReport(weekId?: string): Promise<{
  ok: boolean;
  weekId: string;
  report: MwWeeklyReport | null;
  reason?: string;
}> {
  const q = weekId ? `?weekId=${encodeURIComponent(weekId)}` : '';
  return fetchJson(`/api/market-watch/weekly/report${q}`);
}

export async function recordWeeklyDecision(
  weekId: string,
  symbol: string,
  action: MwReviewAction,
  opts: { by?: string; note?: string } = {},
): Promise<{ ok: boolean; reason?: string; detail?: string; weekId?: string; draft?: MwUniverseLock | null }> {
  return fetchJson('/api/market-watch/weekly/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weekId, symbol, action, lockedBy: opts.by, note: opts.note }),
  });
}

export async function lockWeeklyUniverse(
  weekId: string,
  opts: { by?: string; notes?: string; symbols?: string[] } = {},
): Promise<{ ok: boolean; reason?: string; detail?: string; verify?: MwUniverseVerify; symbolCount?: number } & MwUniverseLock> {
  return fetchJson('/api/market-watch/weekly/lock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weekId, lockedBy: opts.by, notes: opts.notes, symbols: opts.symbols }),
  });
}

export async function seedWeeklyDraft(
  weekId: string,
): Promise<{ ok: boolean; reason?: string; weekId?: string; draft?: MwUniverseLock | null }> {
  return fetchJson('/api/market-watch/weekly/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weekId }),
  });
}

export async function fetchWeeklyHistory(
  limit = 26,
): Promise<{ ok: boolean; history: MwUniverseLock[] }> {
  return fetchJson(`/api/market-watch/weekly/history?limit=${limit}`);
}

/** doc §30 observability read. */
export async function fetchObservability(): Promise<MwObservability> {
  return fetchJson<MwObservability>('/api/market-watch/observability');
}

/** doc §22 — every backend-owned board, including the 1% movers. */
export async function fetchBoards(): Promise<MwBoardsResponse> {
  return fetchJson<MwBoardsResponse>('/api/market-watch/boards');
}

export const BOARD_LABELS: Record<string, string> = {
  top_gainers: 'Top Gainers',
  top_losers: 'Top Losers',
  highest_volume: 'Highest Volume',
  most_active: 'Most Active',
  circuit_near: 'Circuit Near',
  circuit_danger: 'Circuit Danger',
  movers_1pct_1m: 'Top 1% — 1m',
  decliners_1pct_1m: 'Bottom 1% — 1m',
  movers_1pct_5m: 'Top 1% — 5m',
  decliners_1pct_5m: 'Bottom 1% — 5m',
  movers_1pct_10m: 'Top 1% — 10m',
  decliners_1pct_10m: 'Bottom 1% — 10m',
  movers_1pct_30m: 'Top 1% — 30m',
  decliners_1pct_30m: 'Bottom 1% — 30m',
  movers_1m: 'Movers 1m',
  movers_5m: 'Movers 5m',
  movers_10m: 'Movers 10m',
  movers_30m: 'Movers 30m',
};

export function boardLabel(name: string): string {
  return BOARD_LABELS[name] ?? name.replace(/_/g, ' ');
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Build the /rank query string for the full-universe table. */
export function rankQuery({ offset = 0, limit = 200, sortBy = 'changePercent', sortDir = 'desc' }: {
  offset?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: string;
}): string {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit), sortBy, sortDir });
  return `/api/market-watch/rank?${params.toString()}`;
}

/** Real LTP freshness tier — derived from real status, never guessed. */
export function freshnessOf(row: MWRow): { tier: 'live' | 'stale' | 'pending' | 'nodata'; label: string } {
  const status = row.status ?? 'PENDING';
  if (status === 'LIVE') {
    return { tier: 'live', label: 'LIVE' };
  }
  if (status === 'STALE') return { tier: 'stale', label: 'STALE' };
  if (status === 'NO_DATA') return { tier: 'nodata', label: 'NO DATA' };
  if (status === 'INACTIVE') return { tier: 'nodata', label: 'INACTIVE' };
  return { tier: 'pending', label: 'PENDING' };
}

/**
 * Realtime hook for the market_watch channel (doc §24).
 *  * state frames (market_watch.ranking / .pins / .status) update in near-real-time;
 *  * per-token LIVE ticks overlay the LATEST REST rows (fresher wins client-side).
 *
 * doc §26 — raw ticks are a *bounded* publication channel, not the whole
 * universe. Every consumer passes only the tokens it is currently rendering
 * (the virtualised rank window, the visible movers boards, the pin set). The
 * socket is a single shared resource, so token ownership is reference counted
 * here, inside the Market Watch module: a token is unsubscribed only when the
 * LAST hook wanting it lets it go. Subscribing first and releasing second means
 * a token moving between two hooks is never briefly dropped mid-frame.
 *
 * Without this the subscription set only ever grew (a 400-row scroll ended at
 * 400 raw streams to the browser), which is the §26 violation the 500/400 caps
 * were band-aiding over.
 */

/** token -> number of `useMarketWatchRealtime` consumers currently wanting it. */
const MW_TOKEN_REFS = new Map<string, number>();

/** Take N references; return the tokens that just came ONTO the wire. */
function mwAcquire(list: string[]): string[] {
  const added: string[] = [];
  for (const t of list) {
    const n = MW_TOKEN_REFS.get(t) ?? 0;
    MW_TOKEN_REFS.set(t, n + 1);
    if (n === 0) added.push(t);
  }
  return added;
}

/** Drop N references; return the tokens that just came OFF the wire. */
function mwRelease(list: string[]): string[] {
  const removed: string[] = [];
  for (const t of list) {
    const n = (MW_TOKEN_REFS.get(t) ?? 0) - 1;
    if (n <= 0) {
      MW_TOKEN_REFS.delete(t);
      if (n === 1) removed.push(t);
    } else {
      MW_TOKEN_REFS.set(t, n);
    }
  }
  return removed;
}

function mwSpecs(tokens: string[]): RealtimeChannelSpec[] {
  return tokens.map((t) => ({
    channel: WATCH_CHANNEL,
    instruments: [{ exchange_segment: 'nse_cm', instrument_token: t }],
  }));
}

export function useMarketWatchRealtime(tokens: string[]) {
  const { subscribe, unsubscribe, onFrame, connected, ticks, tickEpoch } = useFrontendRealtime();
  const [frames, setFrames] = useState<Record<string, RealtimeEnvelope>>({});
  const mineRef = useRef<Set<string>>(new Set());
  const stateSubRef = useRef(false);
  // Serialise the requested set so a new array identity with identical contents
  // does not re-run the reconcile effect (doc §29: never resubscribe per render).
  const tokenKey = tokens.filter(Boolean).join(',');

  useEffect(() => {
    const wanted = tokenKey ? tokenKey.split(',') : [];
    const wantedSet = new Set(wanted);
    const prev = mineRef.current;

    const entering = wanted.filter((t) => !prev.has(t));
    const leaving = Array.from(prev).filter((t) => !wantedSet.has(t));

    const toSubscribe = mwAcquire(entering);
    const toUnsubscribe = mwRelease(leaving);
    mineRef.current = wantedSet;

    const stateSpecs: RealtimeChannelSpec[] = [];
    if (!stateSubRef.current) {
      stateSpecs.push({ channel: WATCH_CHANNEL });
      stateSubRef.current = true;
    }
    if (stateSpecs.length) void subscribe(stateSpecs).catch(() => {});
    if (toUnsubscribe.length) void unsubscribe(mwSpecs(toUnsubscribe)).catch(() => {});
    if (toSubscribe.length) void subscribe(mwSpecs(toSubscribe)).catch(() => {});
    // NOTE: no cleanup here on purpose. A cleanup returned from this effect would
    // also run on every `tokenKey` change, releasing the whole previous set
    // *before* the reconcile above could diff against it — which is exactly the
    // churn the reference counting exists to avoid. Unmount release lives in its
    // own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenKey, subscribe, unsubscribe]);

  // Unmount-only release: read the ref (always current) so a closed tab stops
  // costing socket traffic. Deps are the stable callbacks only.
  useEffect(
    () => () => {
      const release = mwRelease(Array.from(mineRef.current));
      mineRef.current = new Set();
      stateSubRef.current = false;
      if (release.length) void unsubscribe(mwSpecs(release)).catch(() => {});
    },
    [unsubscribe],
  );

  useEffect(() => {
    // Throttle per frame type: a high-rate status broadcast must not drive a
    // React render per message (that froze the whole shell). Latest value wins.
    const lastApplied = new Map<string, number>();
    const MIN_INTERVAL_MS = 1000;
    return onFrame((frame) => {
      const type = frame?.type;
      if (type !== 'market_watch.status' && type !== 'market_watch.ranking' && type !== 'market_watch.pins') {
        return; // ignore per-tick frames
      }
      const now = Date.now();
      const last = lastApplied.get(type) ?? 0;
      if (now - last < MIN_INTERVAL_MS) return;
      lastApplied.set(type, now);
      setFrames((s) => ({ ...s, [type as string]: frame }));
    });
  }, [onFrame]);

  return {
    ticks,
    tickEpoch,
    connectionState: connected ? 'CONNECTED' : 'DISCONNECTED',
    connected,
    failureReason: '',
    frames,
  };
}

export function tickOf(ticks: Map<string, RealtimeTickView>, token: string): RealtimeTickView | undefined {
  if (!token) return undefined;
  return ticks.get(`nse_cm|${token}`) ?? ticks.get(`NSE|${token}`);
}

/** Overlay the freshest realtime values onto a REST row. */
export function overlayTick(row: MWRow, tick?: RealtimeTickView): MWRow {
  if (!tick) return row;
  const next: MWRow = { ...row };
  if (tick.ltp != null) next.ltp = tick.ltp;
  if (tick.netChange != null) next.change = tick.netChange;
  if (tick.netChangePct != null) next.changePercent = tick.netChangePct;
  if (tick.volume != null) next.volume = tick.volume;
  if (tick.open != null) next.open = tick.open;
  if (tick.high != null) next.high = tick.high;
  if (tick.low != null) next.low = tick.low;
  if (tick.avgPrice != null) next.avgPrice = tick.avgPrice;
  return next;
}

export function overlayRows(rows: MWRow[], ticks: Map<string, RealtimeTickView>): MWRow[] {
  if (!ticks.size) return rows;
  return rows.map((r) => overlayTick(r, tickOf(ticks, r.token)));
}

export function dedupe(rows: MWRow[]): MWRow[] {
  const seen = new Set<string>();
  const out: MWRow[] = [];
  for (const r of rows) {
    if (seen.has(r.token)) continue;
    seen.add(r.token);
    out.push(r);
  }
  return out;
}

export function realtimeTokenOfEnvelope(frame: RealtimeEnvelope): string {
  return String(frame.instrument_token ?? frame.data?.instrumentToken ?? '');
}

// ---------------------------------------------------------------------------
// Engine progress (phase / lifecycle) — REST snapshot + realtime status frames.
//
// The engine emits TWO shapes of `market_watch.status` frame on the same
// channel (services/market_watch_engine.py):
//   * the periodic broadcast  -> feedState / universeSize / statusCounts /
//     subscribedTokenCount / liveStateCount / indexVersion
//   * a lifecycle transition   -> LifecycleSnapshot.to_dict() (state, dataActive,
//     nextState, ...) plus eligibleCount / subscribedCount / universeState
// Both are merged field-by-field here, so neither shape can erase the other and
// the UI never has to guess which one it received.
// ---------------------------------------------------------------------------

function mergeStatusFrame(base: MwProgress, frame: RealtimeEnvelope | undefined): MwProgress {
  if (!frame) return base;
  const d = (frame.data ?? {}) as Record<string, any>;
  const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const lifecycle: MwLifecycle = { ...(base.lifecycle ?? {}) };

  // Lifecycle-transition frames carry the state fields at the top level.
  for (const key of [
    'state',
    'previousState',
    'changedAt',
    'tradingDate',
    'serverTime',
    'nextState',
    'minutesToNext',
    'dataActive',
    'monitoring',
    'states',
    'universeState',
  ] as const) {
    if (d[key] != null) (lifecycle as Record<string, any>)[key] = d[key];
  }
  if (num(d.eligibleCount) != null) lifecycle.eligibleCount = num(d.eligibleCount);
  if (num(d.subscribedCount) != null) lifecycle.subscribedCount = num(d.subscribedCount);

  const universeSize = num(d.universeSize) ?? num(d.eligibleUniverseCount) ?? base.universe?.total ?? null;
  const eligible = num(d.eligibleCount) ?? lifecycle.eligibleCount ?? base.universe?.eligible ?? null;

  return {
    ...base,
    lifecycle,
    feedState: d.feedState ?? base.feedState ?? null,
    universe: { total: universeSize, known: universeSize, eligible: eligible ?? null },
    subscribed: num(d.subscribedTokenCount) ?? lifecycle.subscribedCount ?? base.subscribed ?? null,
    withLivePrice: num(d.liveStateCount) ?? base.withLivePrice ?? null,
    statusCounts: (d.statusCounts as Record<string, number>) ?? base.statusCounts ?? null,
    indexVersion: num(d.indexVersion) ?? base.indexVersion ?? null,
    generatedAt: d.generatedAt ?? base.generatedAt ?? null,
  };
}

export interface EngineProgress {
  progress: MwProgress;
  state: MwLifecycleState;
  loading: boolean;
  error: string | null;
  /** True once a real backend lifecycle state has been observed. */
  resolved: boolean;
  connected: boolean;
}

/**
 * Canonical engine-progress read. REST is the source of truth; the existing
 * single socket's `market_watch.status` frame only patches it in between polls.
 * No second socket, no per-tick subscription, no frontend-computed phase.
 */
export function useEngineProgress(intervalMs = RECONCILE_INTERVAL_MS): EngineProgress {
  const { subscribe, onFrame, connected } = useFrontendRealtime();
  const [progress, setProgress] = useState<MwProgress>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await fetchJson<MwProgress>('/api/market-watch/progress');
        if (!alive) return;
        setProgress((prev) => ({
          ...prev,
          ...data,
          // Keep the richer frame-only lifecycle fields (dataActive / nextState /
          // states) that /progress does not echo, but let REST win on the rest.
          lifecycle: { ...(prev.lifecycle ?? {}), ...(data.lifecycle ?? {}) },
        }));
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'progress unavailable');
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const id = setInterval(() => void load(), intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  // Subscribe to the shared socket's market_watch channel for status frames.
  // Depend on the STABLE callbacks — keying on the provider value object
  // re-issued a WS#4 subscribe on every socket flush (~4Hz).
  useEffect(() => {
    const specs: RealtimeChannelSpec[] = [{ channel: WATCH_CHANNEL }];
    void subscribe(specs).catch(() => {});
    return onFrame((frame) => {
      if (frame.type === 'market_watch.status') {
        setProgress((p) => mergeStatusFrame(p, frame));
      }
    });
  }, [subscribe, onFrame]);

  const state = lifecycleState(progress.lifecycle?.state);
  return {
    progress,
    state,
    loading: loading && state === 'UNKNOWN',
    error,
    resolved: state !== 'UNKNOWN',
    connected,
  };
}