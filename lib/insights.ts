'use client';

import { istDateKey } from './ist';
import { API_BASE as browserApiBase } from './api-base';

// Typed client for the Data SAVer Intelligence, Event, Audit and Reporting
// Center backend surface (`/api/data-saver/insights/*`).
//
// The backend NEVER fabricates metrics: every value is derived from real
// runtime/MongoDB state and responds with nulls ("Not available") when a metric
// cannot be measured. The types below mirror those responses one-to-one so the
// UI can stay honest (the null handling lives in the pages, not here).

import { useEffect, useRef } from 'react';
import { useRealtime } from '@/components/realtime-provider';

const API_INSIGHTS = '/api/data-saver/insights';

export const INSIGHT_REPORT_TYPES = [
  'websocket', 'tick', 'quality', 'api', 'persistence', 'errors', 'system',
] as const;

export type InsightReportType = (typeof INSIGHT_REPORT_TYPES)[number];

// ---------------------------------------------------------------------------
// Ledger events
// ---------------------------------------------------------------------------
export interface LedgerEvent {
  event_id?: string;
  source?: string;
  event?: string;
  event_type?: string;
  status?: string;
  severity?: string;
  category?: string;
  market_date?: string;
  reason?: string;
  reason_code?: string;
  component?: string;
  details?: string;
  duration?: number;
  duration_ms?: number;
  resolved_at?: string;
  connection_id?: string;
  session_id?: string;
  symbol?: string;
  token?: string;
  exchange?: string;
  segment?: string;
  message?: string;
  timestamp?: string;
  meta?: Record<string, any>;
}

export interface EventsResponse {
  events: LedgerEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface LedgerDigest {
  categories: Record<string, number>;
  severity: Record<string, number>;
  total: number;
  hasData: boolean;
}

// ---------------------------------------------------------------------------
// Error Center
// ---------------------------------------------------------------------------
export interface ErrorGroup {
  fingerprint: string;
  groupId: string;
  category?: string;
  eventType?: string;
  reasonCode?: string;
  component?: string;
  source?: string;
  severity?: string;
  occurrences: number;
  firstSeen?: string;
  lastSeen?: string;
  resolved: boolean;
  sampleMessage?: string;
  sampleDetails?: string;
  sampleEventId?: string;
}

export interface ErrorsResponse {
  groups: ErrorGroup[];
  total: number;
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------
export interface Incident {
  incident_id: string;
  kind?: string;
  severity?: string;
  title?: string;
  message?: string;
  source?: string;
  status?: 'open' | 'resolved' | string;
  detected_at?: string;
  impact_started_at?: string;
  alerted_at?: string | null;
  acknowledged_at?: string | null;
  recovery_started_at?: string | null;
  recovered_at?: string | null;
  resolved_at?: string | null;
  recovery?: string | null;
  root_cause?: string | null;
  impact?: string | null;
  duration_sec?: number | null;
  connection_id?: string | null;
  symbol?: string | null;
  token?: string | null;
  related_event_ids?: string[];
  metadata?: Record<string, any>;
  created_at?: string;
}

export interface IncidentsResponse {
  incidents: Incident[];
  total: number;
}

// ---------------------------------------------------------------------------
// Telemetry (tick pipeline + websocket minute buckets)
// ---------------------------------------------------------------------------
export interface TelemetryPoint {
  bucket?: string;
  timestamp?: string;
  received: number;
  written: number;
  errors: number;
  ticksPerSecond?: number | null;
  writesPerSecond?: number | null;
  activeSymbols?: number | null;
  bufferLength?: number | null;
  feedLatencyMs?: number | null;
  pipelineRunning?: boolean;
  wsConnected?: boolean | null;
  wsMessagesReceived?: number;
  wsSubscriptionCount?: number | null;
  wsReconnectCount?: number | null;
  wsLifecycleState?: string | null;
}

export interface TelemetryResponse {
  series: TelemetryPoint[];
}

// ---------------------------------------------------------------------------
// API telemetry (FastAPI request buckets)
// ---------------------------------------------------------------------------
export interface ApiEndpointSummary {
  route?: string;
  requests: number;
  errors: number;
  clientErrors: number;
  serverErrors: number;
  success: number;
  successPct?: number | null;
  avgMs?: number | null;
}

export interface ApiTelemetrySummary {
  requests: number;
  errors: number;
  success: number;
  successPct?: number | null;
  errorPct?: number | null;
  avgLatencyMs?: number | null;
  p50Ms?: number | null;
  p95Ms?: number | null;
  p99Ms?: number | null;
  clientErrors: number;
  serverErrors: number;
  endpoints: ApiEndpointSummary[];
  hasData: boolean;
  dbRelatedFailures: number;
}

// ---------------------------------------------------------------------------
// Core cards
// ---------------------------------------------------------------------------
export interface CardsResponse {
  window: { range_hours?: number; market_date?: string | null };
  events: LedgerDigest;
  errors: {
    groupTotal: number;
    occurrences: number;
    open: number;
    resolved: number;
  };
  telemetry: {
    buckets: number;
    ticksReceived: number;
    ticksWritten: number;
    tickErrors: number;
    writeSuccessPct?: number | null;
    series: TelemetryPoint[];
  };
  api: ApiTelemetrySummary;
  incidents: number;
}

// ---------------------------------------------------------------------------
// LIVE NOW snapshot
// ---------------------------------------------------------------------------
export interface LiveSnapshot {
  generatedAt?: string;
  market: {
    marketState?: string | null;
    reasonCode?: string | null;
    reasonMessage?: string | null;
    tradingDay?: boolean | null;
    dayClass?: string | null;
    session?: string | null;
  };
  websocket: {
    connected?: boolean;
    lifecycleState?: string | null;
    feedState?: string | null;
    connectedAt?: string | null;
    disconnectReason?: string | null;
    subscriptionCount?: number;
    reconnectCount?: number;
  };
  pipeline: {
    running?: boolean;
    ticksPerSecond?: number | null;
    writesPerSecond?: number | null;
    bufferLength?: number | null;
    activeSymbols?: number | null;
    lastTickAt?: string | null;
    lastFlushAt?: string | null;
    feedLatencyMs?: number | null;
  };
  database: { connected?: boolean };
  scheduler: { running?: boolean; state?: string };
  session: { active?: boolean; status?: string | null; mode?: string | null };
  quality: {
    score?: number | null;
    grade?: string | null;
    freshness?: number | null;
    timestamp?: string | null;
    totalTicks?: number;
  };
  alerts: { activeAlerts?: number };
  notifications: { unread?: number };
  lastEvent?: LedgerEvent | null;
}

// ---------------------------------------------------------------------------
// TODAY / ATTENTION / compare
// ---------------------------------------------------------------------------
export interface TodaySummaryResponse {
  marketDate?: string;
  generatedAt?: string;
  summary: {
    total_events?: number;
    critical_events?: number;
    warnings?: number;
    errors?: number;
    ticks?: number;
    alerts?: number;
    notifications?: number;
    recoveries?: number;
  };
  highlights: Array<{
    timestamp?: string;
    category?: string;
    severity?: string;
    event_type?: string;
    event?: string;
    type?: string;
    source?: string;
    message?: string;
    event_id?: string;
  }>;
  recoveries: Array<{
    type?: string;
    name?: string;
    at?: string;
    message?: string;
    event_id?: string;
    event_type?: string;
    duration_sec?: number | null;
    recovery?: string;
    incident_id?: string;
  }>;
  timeline: Array<Record<string, unknown>>;
  incidents: {
    total?: number;
    resolved?: number;
    open?: number;
    incidents?: Incident[];
  };
  report?: DailyReport;
}

export interface AttentionResponse {
  items: Array<{
    kind?: string;
    severity?: string;
    title?: string;
    message?: string;
    since?: string | null;
    incidentId?: string;
    groupId?: string;
  }>;
  critical: number;
  warning: number;
}

// ---------------------------------------------------------------------------
// Aggregated overview (GET /summary â€” one authoritative request per page)
// ---------------------------------------------------------------------------
export interface InsightsSummaryResponse {
  generatedAt?: string;
  marketDate?: string;
  live: LiveSnapshot;
  attention: {
    count: number;
    critical: number;
    warning: number;
    preview: AttentionResponse['items'];
  };
  activity: {
    count: number;
    hasData: boolean;
    categories: Record<string, number>;
    severity: Record<string, number>;
    lastEventAt?: string | null;
    lastEvent?: LedgerEvent | null;
  };
  errors: {
    total: number;
    open: number;
    resolved: number;
    occurrences: number;
    preview: ErrorGroup[];
  };
  today: {
    marketDate?: string;
    total: number;
    events: TodaySummaryResponse['summary'];
    alerts: number;
    notifications: number;
    ticks: number;
    incidents: number;
    highlights: TodaySummaryResponse['highlights'];
  };
  health: {
    database: boolean;
    websocket: boolean;
    pipeline: boolean;
    scheduler: boolean;
  };
}

export interface ErrorGroupDetailResponse {
  group: ErrorGroup;
  count: number;
  occurrences: LedgerEvent[];
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export interface ReportRow {
  report_id?: string;
  report_type?: string;
  report_date?: string;
  generated_at?: string;
  status?: string;
  health_score?: number | null;
  health_grade?: string | null;
  ticks?: number | null;
  events?: number | null;
  alerts?: number | null;
  notifications?: number | null;
  incidents?: number | null;
  errors?: number | null;
  has_health?: boolean;
}

export interface ReportsResponse {
  reports: ReportRow[];
  total: number;
}

export interface DailyReportHealth {
  score?: number | null;
  grade?: string | null;
  dimensions?: Record<string, number | null> | null;
  status?: string;
}

export interface DailyReport {
  report_id?: string;
  report_type?: string;
  report_date?: string;
  generated_at?: string;
  overall_health?: DailyReportHealth;
  market?: Record<string, any>;
  tick_summary?: Record<string, any>;
  websocket_summary?: Record<string, any>;
  quality_summary?: Record<string, any>;
  notification_summary?: Record<string, any>;
  api_summary?: ApiTelemetrySummary & Record<string, any>;
  scheduler_summary?: Record<string, any>;
  pipeline_summary?: Record<string, any>;
  database_summary?: Record<string, any>;
  alert_summary?: Record<string, any>;
  error_summary?: Record<string, any>;
  incident_summary?: Record<string, any>;
  telemetry?: TelemetryPoint[];
  timeline?: Array<Record<string, unknown>>;
  highlights?: Array<Record<string, unknown>>;
  recoveries?: Array<Record<string, unknown>>;
  event_totals?: { total?: number; by_category?: Record<string, number>; by_severity?: Record<string, number> };
  summary?: {
    total_events?: number;
    critical_events?: number;
    warnings?: number;
    errors?: number;
    ticks?: number;
    alerts?: number;
    notifications?: number;
    recoveries?: number;
  };
  error?: string;
  [key: string]: any;
}

export interface WeeklyReport {
  report_id?: string;
  report_type?: string;
  report_date?: string;
  from_date?: string;
  to_date?: string;
  weeks?: number;
  generated_at?: string;
  days: ReportRow[];
  totals: {
    ticks: number;
    errors: number;
    alerts: number;
    notifications: number;
    events: number;
    incidents: number;
    downtimeEvents: number;
  };
  average_health?: number | null;
  healthy_days?: number;
  error?: string;
}

export interface TypeReport {
  reportType?: string;
  reportDate?: string;
  generatedAt?: string;
  error?: string;
  [key: string]: any;
}

export interface CompareResponse {
  today?: ReportRow | null;
  previous?: ReportRow | null;
  previousDate?: string | null;
  hasComparison: boolean;
  comparisons?: Record<string, {
    today?: number | null;
    previous?: number | null;
    delta?: number | null;
    changePct?: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Realtime stream frames (centralized /api/websocket/system/stream channel)
// ---------------------------------------------------------------------------
export interface InsightStreamFrame {
  type: string;
  event_id?: string;
  event_type?: string;
  category?: string;
  severity?: string;
  source?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  market_date?: string;
  incident?: Partial<Incident>;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------
type Q = Record<string, string | number | boolean | undefined | null>;

function qs(params?: Q): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v) !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function insightsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Same-origin in the browser — see lib/api-base.ts. An absolute
  // `127.0.0.1:8000` resolves to the DEVICE on a phone.
  const res = await fetch(`${browserApiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...((init?.headers as Record<string, string>) ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`.trim());
  }
  return res.json() as Promise<T>;
}

export function getInsightsLive(): Promise<LiveSnapshot> {
  return insightsFetch(`${API_INSIGHTS}/live`);
}

export function getInsightsSummary(): Promise<InsightsSummaryResponse> {
  return insightsFetch(`${API_INSIGHTS}/summary`);
}

export function getInsightsCards(rangeHours?: number, marketDate?: string): Promise<CardsResponse> {
  return insightsFetch(`${API_INSIGHTS}/cards${qs({ range_hours: rangeHours, market_date: marketDate })}`);
}

export function getInsightsEvents(params?: {
  limit?: number; offset?: number; rangeHours?: number; marketDate?: string;
  fromIso?: string; toIso?: string; category?: string; severity?: string;
  source?: string; eventType?: string; search?: string; symbol?: string; oldestFirst?: boolean;
}): Promise<EventsResponse> {
  return insightsFetch(`${API_INSIGHTS}/events${qs({
    limit: params?.limit, offset: params?.offset, range_hours: params?.rangeHours,
    market_date: params?.marketDate, from_iso: params?.fromIso, to_iso: params?.toIso,
    category: params?.category, severity: params?.severity, source: params?.source,
    event_type: params?.eventType, q: params?.search, symbol: params?.symbol,
    oldest_first: params?.oldestFirst,
  })}`);
}

export function getInsightsEventDetail(eventId: string): Promise<LedgerEvent> {
  return insightsFetch(`${API_INSIGHTS}/events/${encodeURIComponent(eventId)}`);
}

export function getInsightsErrors(rangeHours?: number, marketDate?: string, includeWarnings = true): Promise<ErrorsResponse> {
  return insightsFetch(`${API_INSIGHTS}/errors${qs({ range_hours: rangeHours, market_date: marketDate, include_warnings: includeWarnings })}`);
}

export function getInsightsErrorGroup(groupId: string, rangeHours = 24): Promise<ErrorGroupDetailResponse> {
  return insightsFetch(`${API_INSIGHTS}/errors/${encodeURIComponent(groupId)}${qs({ range_hours: rangeHours })}`);
}

export function getInsightsIncidents(params?: {
  limit?: number; status?: string; kind?: string; marketDate?: string;
}): Promise<IncidentsResponse> {
  return insightsFetch(`${API_INSIGHTS}/incidents${qs({
    limit: params?.limit, status: params?.status, kind: params?.kind, market_date: params?.marketDate,
  })}`);
}

export function getInsightsToday(): Promise<TodaySummaryResponse> {
  return insightsFetch(`${API_INSIGHTS}/today`);
}

export function getInsightsAttention(): Promise<AttentionResponse> {
  return insightsFetch(`${API_INSIGHTS}/attention`);
}

export function getInsightsTelemetry(hours = 24, marketDate?: string, resolutionMin = 1): Promise<TelemetryResponse> {
  return insightsFetch(`${API_INSIGHTS}/telemetry${qs({ hours, market_date: marketDate, resolution_min: resolutionMin })}`);
}

export function getInsightsApiTelemetry(rangeHours = 24, marketDate?: string): Promise<ApiTelemetrySummary> {
  return insightsFetch(`${API_INSIGHTS}/api-telemetry${qs({ range_hours: rangeHours, market_date: marketDate })}`);
}

export function getInsightsSearch(search: string, marketDate?: string, limit = 50): Promise<EventsResponse> {
  return insightsFetch(`${API_INSIGHTS}/search${qs({ q: search, limit, market_date: marketDate })}`);
}

export function getInsightsReports(params?: {
  reportType?: string; limit?: number; fromDate?: string; toDate?: string;
}): Promise<ReportsResponse> {
  return insightsFetch(`${API_INSIGHTS}/reports${qs({
    report_type: params?.reportType, limit: params?.limit,
    from_date: params?.fromDate, to_date: params?.toDate,
  })}`);
}

export function getInsightsDailyReport(date: string): Promise<DailyReport> {
  return insightsFetch(`${API_INSIGHTS}/reports/daily/${encodeURIComponent(date)}`);
}

export function generateInsightsReport(marketDate?: string): Promise<DailyReport> {
  return insightsFetch(`${API_INSIGHTS}/reports/generate${qs({ market_date: marketDate })}`, { method: 'POST' });
}

export function getInsightsWeeklyReport(weeks = 1): Promise<WeeklyReport> {
  return insightsFetch(`${API_INSIGHTS}/reports/weekly${qs({ weeks })}`);
}

export function getInsightsTypeReport(reportType: InsightReportType, marketDate?: string, hours?: number): Promise<TypeReport> {
  return insightsFetch(`${API_INSIGHTS}/reports/${reportType}${qs({ market_date: marketDate, hours })}`);
}

export function getInsightsCompare(today?: string, previous?: string): Promise<CompareResponse> {
  return insightsFetch(`${API_INSIGHTS}/compare${qs({ today, previous })}`);
}

export async function exportInsightsEvents(params: Q): Promise<{ format: string; count: number; contentType: string; content: string }> {
  return insightsFetch(`${API_INSIGHTS}/events/export`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function flushInsightsTelemetry(): Promise<{ written: number }> {
  return insightsFetch(`${API_INSIGHTS}/telemetry/flush`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Formatting helpers (IST-aware; honest â€” null input renders as 'â€”')
// ---------------------------------------------------------------------------
export const fmtCount = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? 'â€”' : v.toLocaleString('en-IN');

export const fmtCompact = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return 'â€”';
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return String(v);
};

export const fmtPercent = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? 'â€”' : `${v}%`;

export const fmtMs = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? 'â€”' : `${v.toLocaleString('en-IN')} ms`;

/** Today's IST date (YYYY-MM-DD) â€” the market-date key used backend-side. */
export function istDateNow(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return istDateKey();
  }
}

/** ISO â†’ IST HH:MM:SS (empty when unparseable â€” never fakes a time). */
export function fmtTime(iso?: string | null, seconds = true): string {
  if (!iso) return 'â€”';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'â€”';
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
    hour12: false,
  };
  if (seconds) opts.second = '2-digit';
  return d.toLocaleTimeString('en-IN', opts).replace('24:', '00:');
}

/** ISO â†’ IST full date-time. */
export function fmtDateTime(iso?: string | null): string {
  if (!iso) return 'â€”';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'â€”';
  const date = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  return `${date} Â· ${fmtTime(iso)}`;
}

/** Relative "Xs ago / Xm ago / Xh ago / Xd ago" from an ISO timestamp. */
export function fmtAgo(iso?: string | null): string {
  if (!iso) return 'â€”';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'â€”';
  const diff = Math.max(0, Date.now() - d.getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const SEVERITY_STATES: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  critical: 'danger', error: 'danger', warning: 'warning', info: 'info',
  success: 'success', ok: 'success', resolved: 'success', open: 'warning',
  unknown: 'neutral',
};

export const severityState = (sev?: string | null): 'success' | 'warning' | 'danger' | 'info' | 'neutral' =>
  (sev && SEVERITY_STATES[String(sev).toLowerCase()]) || 'neutral';

// ---------------------------------------------------------------------------
// Realtime subscription â€” ONE listener on the centralized SSE channel through
// the shared RealtimeProvider (no per-page EventSource).
// ---------------------------------------------------------------------------
export function useInsightsStream(onFrame: (frame: InsightStreamFrame) => void): { connected: boolean } {
  const { appConnection, subscribeToNotificationEvents } = useRealtime();
  const handlerRef = useRef(onFrame);
  handlerRef.current = onFrame;

  useEffect(() => {
    return subscribeToNotificationEvents((frame) => {
      const type = String(frame.type ?? '');
      if (type.startsWith('insight_') || type === 'incident_created' || type === 'incident_resolved') {
        handlerRef.current(frame as InsightStreamFrame);
      }
    });
  }, [subscribeToNotificationEvents]);

  return { connected: appConnection === 'CONNECTED' };
}