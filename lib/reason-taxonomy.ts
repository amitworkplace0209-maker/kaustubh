/**
 * Centralized Data Saver reason taxonomy.
 *
 * Single source of truth for every machine-emittable reason/code across the
 * dashboard, alerts, event history and telemetry. Every code is grounded in a
 * REAL backend evidence source:
 *   - `services/event_history.py` event names (login_*, logout_*, state:*, started,
 *     stopped, connect, disconnect, reconnect, flush, write_error, quality, config …)
 *   - `ws_socket/ws_manager.py` `WS_REASON_CODES` disconnect-reason taxonomy
 *     (scheduled_disconnect, session_expired, manual_logout, broker_closed,
 *     broker_rejected, authentication_failed, network_error, internet_disconnected,
 *     websocket_error, heartbeat_timeout, server_restart, application_shutdown,
 *     market_closed, duplicate_connection_prevented, unknown_error)
 *
 * Nothing here is fabricated: codes only exist if the backend can actually
 * emit the corresponding event. Unknown/missing evidence maps to `system`.
 */

export interface ReasonCode {
  code: string;
  label: string;
  kind: string;
  description: string;
}

export const REASON_TAXONOMY: readonly ReasonCode[] = [
  { code: 'session_login', label: 'Session Login', kind: 'session', description: 'Successful manual or scheduled login' },
  { code: 'session_logout', label: 'Session Logout', kind: 'session', description: 'Session ended via logout' },
  { code: 'session_manual', label: 'Manual Session', kind: 'session', description: 'A manual (user-triggered) session was created' },
  { code: 'session_failed', label: 'Session Failed', kind: 'session', description: 'Login or re-auth failed' },
  { code: 'session_expired', label: 'Session Expired', kind: 'session', description: 'Broker session reached its expiry' },
  { code: 'state_change', label: 'Scheduler State Change', kind: 'scheduler', description: 'Scheduler transitioned between states' },
  { code: 'pipeline_started', label: 'Pipeline Started', kind: 'pipeline', description: 'Collection / capture process started' },
  { code: 'pipeline_stopped', label: 'Pipeline Stopped', kind: 'pipeline', description: 'Collection / capture process stopped' },
  { code: 'ws_connect', label: 'WebSocket Connect', kind: 'websocket', description: 'Market data feed connected' },
  { code: 'ws_disconnect', label: 'WebSocket Disconnect', kind: 'websocket', description: 'Market data feed disconnected' },
  { code: 'ws_reconnect', label: 'WebSocket Reconnect', kind: 'websocket', description: 'Feed re-established after a drop' },
  { code: 'ws_scheduled_disconnect', label: 'Scheduled Disconnect', kind: 'websocket', description: 'Feed closed by the scheduled window (ws_stop_time)' },
  { code: 'ws_auth_failed', label: 'Authentication Failed', kind: 'websocket', description: 'Feed rejected credentials or subscription' },
  { code: 'ws_network_error', label: 'Network Error', kind: 'websocket', description: 'Transport-level network failure on the feed' },
  { code: 'ws_internet_disconnect', label: 'Internet Disconnect', kind: 'websocket', description: 'Internet connectivity lost while the feed was up' },
  { code: 'ws_broker_closed', label: 'Broker Closed Feed', kind: 'websocket', description: 'Broker closed/disallowed the connection' },
  { code: 'ws_heartbeat_timeout', label: 'Heartbeat Timeout', kind: 'websocket', description: 'No heartbeat from the feed within the timeout' },
  { code: 'ws_market_closed', label: 'Market Closed', kind: 'websocket', description: 'Feed disconnected after market close' },
  { code: 'db_write', label: 'Database Write', kind: 'storage', description: 'Ticks persisted to MongoDB' },
  { code: 'db_write_error', label: 'Database Write Error', kind: 'storage', description: 'A bulk persist attempt failed' },
  { code: 'quality_bad', label: 'Quality Breach', kind: 'quality', description: 'A quality metric breached its threshold' },
  { code: 'config', label: 'Configuration Change', kind: 'system', description: 'Runtime configuration was modified' },
  { code: 'system', label: 'System Event', kind: 'system', description: 'Miscellaneous backend/system event' },
] as const;

/** Backend event-name → taxonomy code. */
const EVENT_TO_CODE: Record<string, string> = {
  login_ok: 'session_login',
  login_error: 'session_failed',
  logout_ok: 'session_logout',
  logout_error: 'session_failed',
  manual_session: 'session_manual',
  session_end: 'session_logout',
  session_expired: 'session_expired',
  started: 'pipeline_started',
  stopped: 'pipeline_stopped',
  start: 'pipeline_started',
  stop: 'pipeline_stopped',
  connect: 'ws_connect',
  disconnect: 'ws_disconnect',
  reconnect: 'ws_reconnect',
  ws_connect: 'ws_connect',
  ws_disconnect: 'ws_disconnect',
  ws_reconnect: 'ws_reconnect',
  flush: 'db_write',
  write_error: 'db_write_error',
  save_failure: 'db_write_error',
  quality: 'quality_bad',
  config: 'config',
  startup: 'system',
  shutdown: 'system',
  process: 'system',
  alert: 'system',
};

/** ws_manager `WS_REASON_CODES` → taxonomy code. */
const WS_REASON_TO_CODE: Record<string, string> = {
  scheduled_disconnect: 'ws_scheduled_disconnect',
  session_expired: 'session_expired',
  manual_logout: 'session_logout',
  logout: 'session_logout',
  broker_closed: 'ws_broker_closed',
  broker_rejected: 'ws_auth_failed',
  authentication_failed: 'ws_auth_failed',
  network_error: 'ws_network_error',
  internet_disconnected: 'ws_internet_disconnect',
  websocket_error: 'ws_disconnect',
  heartbeat_timeout: 'ws_heartbeat_timeout',
  server_restart: 'system',
  application_shutdown: 'system',
  market_closed: 'ws_market_closed',
  duplicate_connection_prevented: 'ws_disconnect',
  unknown_error: 'ws_disconnect',
};

/** Classify a raw backend event name into a taxonomy code. */
export function classifyEvent(eventName: string | null | undefined): string {
  const evt = String(eventName ?? '').trim().toLowerCase();
  if (!evt) return 'system';
  if (evt.startsWith('state:')) return 'state_change';
  return EVENT_TO_CODE[evt] ?? 'system';
}

/** Classify a ws_manager disconnect reason (code or human phrase) into a code. */
export function classifyWsReason(reason: string | null | undefined): string {
  const value = String(reason ?? '').trim().toLowerCase();
  if (!value || value === 'unknown') return 'ws_disconnect';
  return WS_REASON_TO_CODE[value] ?? 'ws_disconnect';
}

export function codeOf(c: string): ReasonCode {
  return REASON_TAXONOMY.find((r) => r.code === c) ?? REASON_TAXONOMY[REASON_TAXONOMY.length - 1];
}

/** Occurrence counts per taxonomy code derived from REAL events only. */
export function reasonBreakdown(events: ReadonlyArray<{ event?: unknown }>): Array<ReasonCode & { count: number }> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    const code = classifyEvent(typeof e === 'object' && e ? (e as any).event : undefined);
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return REASON_TAXONOMY.map((r) => ({ ...r, count: counts[r.code] ?? 0 }));
}