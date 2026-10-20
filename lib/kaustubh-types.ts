/**
 * Shared TypeScript contracts for the KAUSTUBH platform.
 *
 * These mirror the backend response shapes served by the Python FastAPI
 * backend (C:\project\python-service). Frontend components and API routes
 * should consume these types so the UI never invents fields the backend does
 * not actually provide.
 *
 * Optional markers (?:) mean "may be absent from a real response" — the UI
 * must render an honest Stale/Unavailable/— state, never fabricate a value.
 */

export type HealthState =
  | 'live'
  | 'stale'
  | 'offline'
  | 'stopped'
  | 'disconnected'
  | 'market_closed'
  | 'no_data'
  | 'loading'
  | 'error';

export interface SessionInfo {
  logged_in: boolean;
  view_token_present: boolean;
  session_id_present: boolean;
  trade_token_present: boolean;
  user_id?: string | null;
  exchanges?: string[];
  products?: string[];
  last_login_at?: string | null;
  last_logout_at?: string | null;
  login_count?: number;
  session_active: boolean;
  session_validated_at?: string | null;
  login_source?: string | null;
  last_login_error?: string | null;
  last_reauth_at?: string | null;
}

export interface WebSocketState {
  connected: boolean;
  state: string;
  subscribed_symbols?: number;
  tick_count?: number;
  last_tick_at?: string | null;
  connected_at?: string | null;
  disconnected_at?: string | null;
  disconnect_reason?: string | null;
  reconnect_count?: number;
  connection_history?: Array<{
    event: string;
    at?: string | null;
    status?: string;
    reason?: string;
    durationSec?: number | null;
  }>;
}

export interface SchedulerState {
  running?: boolean;
  state: string;
  state_since?: string | null;
  session_owner?: string | null;
  login_attempts?: number;
  login_error?: string | null;
  ws_attempts?: number;
  ws_error?: string | null;
  is_trading_day?: boolean;
  in_login_window?: boolean;
  in_ws_window?: boolean;
  login_time?: string;
  logout_time?: string;
  ws_start_time?: string;
  ws_stop_time?: string;
  next_login?: string | null;
  next_logout?: string | null;
  next_ws_start?: string | null;
  next_ws_stop?: string | null;
  manual_expire_at?: string | null;
}

export interface MongoStats {
  connected: boolean;
  database?: string | null;
  collections?: number | null;
  objects?: number | null;
  dataSize?: number | null;
  storageSize?: number | null;
  indexes?: number | null;
  indexSize?: number | null;
}

export interface TickStats {
  bufferLength?: number;
  totalReceived?: number;
  totalWritten?: number;
  totalWriteErrors?: number;
  ticksPerSecond?: number;
  writesPerSecond?: number;
  activeTickStocks?: number;
  lastTickAt?: number | null;
  lastWriteAt?: number | null;
  lastFlushAt?: number | null;
  lastFlushDurationMs?: number | null;
  lastError?: string | null;
  feedLatencyMs?: {
    currentMs?: number;
    avgMs?: number;
    minMs?: number;
    maxMs?: number;
    samples?: number;
  } | null;
}

export interface StorageInfo {
  total?: number | null;
  used?: number | null;
  free?: number | null;
  categories?: Array<{
    key: string;
    bytes: number;
    label?: string;
  }>;
  measuredAt?: string | null;
}

export interface Quote {
  symbol?: string;
  tradingSymbol?: string;
  instrumentToken?: string;
  exchangeSegment?: string;
  ltp?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  change?: number | null;
  changePercent?: number | null;
  volume?: number | null;
  trdVolumeNotional?: number | null;
  upper_circuit?: number | null;
  lower_circuit?: number | null;
  lastUpdateTs?: string | null;
  source?: 'live' | 'last_known' | 'stale' | 'unavailable';
}

export interface Position {
  instrument_token?: string;
  exchange_segment?: string;
  product?: string;
  sym?: string;
  trdSym?: string;
  net_qty?: number;
  buy_quantity?: number;
  sell_quantity?: number;
  buy_avg?: number;
  sell_avg?: number;
  net_average_price?: number;
  ltp?: number | null;
  market_value?: number;
  realized?: number;
  unrealised?: number;
  net_pnl?: number;
  position_status?: 'OPEN' | 'CLOSED' | 'FLAT';
  charges_known?: boolean;
  last_known_ltp?: number | null;
}

export interface Order {
  order_id?: string;
  status?: string;
  symbol?: string;
  exchange?: string;
  product?: string;
  side?: string;
  quantity?: number | null;
  price?: number | null;
  filled_quantity?: number | null;
  avg_price?: number | null;
  created_at?: string | null;
}

export interface Notification {
  id?: string;
  type?: string;
  title?: string;
  message?: string;
  severity?: 'info' | 'success' | 'warning' | 'error';
  timestamp?: string | null;
  read?: boolean;
  source?: string;
}

export interface AuditEvent {
  source?: string;
  type?: string;
  severity?: 'info' | 'warning' | 'error';
  timestamp?: string | null;
  reason?: string | null;
  message?: string;
  metadata?: Record<string, unknown>;
  duration?: number | null;
  status?: string;
}

export interface QualityMetrics {
  missing_rate?: number | null;
  duplicate_rate?: number | null;
  out_of_order_rate?: number | null;
  timestamp_errors?: number | null;
  schema_errors?: number | null;
  save_failures?: number | null;
  invalid_records?: number | null;
  quality_score?: number | null;
  total_ticks?: number | null;
}

// ---- AI (Khumbha AI) ----
export interface AIModel {
  id?: string;
  name?: string;
  version?: string;
  type?: string;
  status?: 'idle' | 'loading' | 'ready' | 'error';
  created?: string | null;
  last_run?: string | null;
}

export interface AIJob {
  id?: string;
  kind?: 'training' | 'inference';
  model?: string;
  dataset?: string;
  status?: string;
  progress?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface AIHardware {
  cpu_percent?: number | null;
  ram_percent?: number | null;
  ram_used_bytes?: number | null;
  gpu_available?: boolean;
  vram_used_bytes?: number | null;
  disk_percent?: number | null;
  temperature_c?: number | null;
}

export interface ReportRecord {
  timestamp?: string | null;
  event?: string;
  severity?: string;
  reason?: string | null;
  impact?: string;
  duration?: number | null;
  recovery?: string;
  current_state?: string;
}

export interface SystemSnapshot {
  websocketConnected?: boolean;
  mongo?: MongoStats;
  schedulerRunning?: boolean;
  schedulerState?: SchedulerState;
  pythonStatus?: SessionInfo & {
    subscribed_symbols?: number;
    reconnect_count?: number;
    ws_state?: string;
  };
  internetConnected?: boolean;
  node?: {
    disk?: Record<string, never>;
  };
  ticks?: TickStats;
  storage?: StorageInfo;
  quality?: QualityMetrics;
}
