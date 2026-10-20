'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { getSystemStreamUrl, getSystemStreamStatus } from '@/lib/api';

export type AppConnectionState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'OFFLINE';

export type RealtimeNotification = {
  _id: string;
  category?: string;
  level?: string;
  severity?: string;
  title?: string;
  message?: string;
  source?: string;
  event_type?: string;
  status?: string;
  read?: boolean;
  reason?: string;
  reason_code?: string;
  symbol?: string;
  related_alert_id?: string;
  related_event_id?: string;
  created_at?: string;
  ts?: string;
};

export type RealtimeAlert = {
  alert_id?: string;
  _id?: string;
  rule_id?: string;
  category?: string;
  severity?: string;
  title?: string;
  message?: string;
  status?: string;
  symbol?: string;
  reason?: string;
  reason_code?: string;
  occurrence_count?: number;
  acknowledged?: boolean;
  resolved?: boolean;
  component?: string;
  created_at?: string;
  triggered_at?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  expires_at?: string;
  resolved_at?: string;
  duration_ms?: number;
};

export type RealtimeNotificationsState = {
  unreadCount: number;
  activeAlerts: number;
  checkedAt?: string;
  latestNotifications: RealtimeNotification[];
  latestAlerts: RealtimeAlert[];
};

export type RealtimeContextValue = {
  /** Application ↔ backend SSE connection state. */
  appConnection: AppConnectionState;
  /** Current centralized backend state merged from the initial snapshot + deltas. */
  state: Record<string, any>;
  /** True once the first state_snapshot has been received from the backend. */
  hydrated: boolean;
  /** Session status from the backend (never defaults to false → fixes flicker). */
  sessionActive: boolean | 'UNKNOWN';
  sessionStatus: string;
  /** Broker WebSocket connection state. */
  brokerWsConnected: boolean | 'UNKNOWN';
  brokerWsState: string;
  /** Current market state from the backend (state.market). */
  marketState: Record<string, any> | null;
  /** Backend internet connectivity (null = unknown). */
  internetConnected: boolean | null;
  lastEventAt: number | null;
  /** Live Notification Center entity (unread + active alert counts, latest items). */
  notificationsState: RealtimeNotificationsState;
  /** Bumped on every notification/alert frame — key page refetches on this. */
  notifEpoch: number;
  /** Bumped on every ws_live frame — live WS/pipeline cards re-render. */
  liveEpoch: number;
  /** Real Mongo tick-persistence events pushed by the backend (bounded, newest first). */
  pipelineEvents: PipelineEvent[];
  /** Bumped on every pipeline persist/error frame. */
  pipelineEpoch: number;
  /** Latest coalesced Tick Analytics realtime frame (published ~1 Hz by the
   *  backend). Null until the first frame arrives -- never a fabricated object. */
  tickAnalytics: Record<string, any> | null;
  /** Bumped on every tick_analytics frame so the analytics snapshot re-renders. */
  tickAnalyticsEpoch: number;
  /** Register a listener for every notification/alert realtime frame. */
  subscribeToNotificationEvents: (cb: (frame: Record<string, unknown>) => void) => () => void;
};

export type PipelineEvent = {
  id: string;
  kind: 'saved' | 'error';
  eventType: string;
  status: string;
  message: string;
  /** Backend wall-clock ms of the Mongo write (or failure) — NOT browser time. */
  timestamp: number;
  meta: Record<string, unknown>;
};

const EMPTY_NOTIF_STATE: RealtimeNotificationsState = {
  unreadCount: 0,
  activeAlerts: 0,
  latestNotifications: [],
  latestAlerts: [],
};

const EMPTY_VALUE: RealtimeContextValue = {
  appConnection: 'CONNECTING',
  state: {},
  hydrated: false,
  sessionActive: 'UNKNOWN',
  sessionStatus: 'UNKNOWN',
  brokerWsConnected: 'UNKNOWN',
  brokerWsState: 'UNKNOWN',
  marketState: null,
  internetConnected: null,
  lastEventAt: null,
  notificationsState: EMPTY_NOTIF_STATE,
  notifEpoch: 0,
  liveEpoch: 0,
  pipelineEvents: [],
  pipelineEpoch: 0,
  tickAnalytics: null,
  tickAnalyticsEpoch: 0,
  subscribeToNotificationEvents: () => () => {},
};

const RealtimeContext = createContext<RealtimeContextValue>(EMPTY_VALUE);

export function useRealtime() {
  return useContext(RealtimeContext);
}

const BASE_DELAY = 1000;
const MAX_DELAY = 15000;

function parseFrame(buf: string): any | null {
  const trimmed = buf.trim();
  if (!trimmed) return null;
  const lines = trimmed.split('\n');
  // EventSource delivers the *decoded* payload (no `data:` prefix); raw-stream
  // consumers get `data:`-prefixed lines. Handle both, and ignore comments.
  const body = lines.some((l) => l.startsWith('data:'))
    ? lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
    : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** ISO-8601 string or epoch (sec/ms) → epoch ms. Null when unparseable. */
function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isNotificationFrame(type: string): boolean {
  return type.startsWith('notification_');
}

function isAlertFrame(type: string): boolean {
  return type.startsWith('alert_');
}

/**
 * Centralized realtime bridge from the backend SSE stream
 * (/api/websocket/system/stream). Maintains ONE EventSource with exponential
 * backoff + a last-resort HTTP status poll, and exposes merged state to every
 * bar/panel so no component runs its own redundant polling loop for system
 * state that the backend already pushes.
 *
 * Also consumes the Notification Center realtime frames (notification_* /
 * alert_*) into a single live `notificationsState` entity — unread count,
 * active-alert count and the latest items/events — so the topbar badges, the
 * bell and the Notifications/Alerts pages update instantly without polling.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Record<string, any>>({});
  const [notificationsState, setNotificationsState] =
    useState<RealtimeNotificationsState>(EMPTY_NOTIF_STATE);
  const [notifEpoch, setNotifEpoch] = useState(0);
  const [appConnection, setAppConnection] = useState<AppConnectionState>('CONNECTING');
  const [hydrated, setHydrated] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [liveEpoch, setLiveEpoch] = useState(0);
  const [pipelineEvents, setPipelineEvents] = useState<PipelineEvent[]>([]);
  const [pipelineEpoch, setPipelineEpoch] = useState(0);
  const [tickAnalytics, setTickAnalytics] = useState<Record<string, any> | null>(null);
  const [tickAnalyticsEpoch, setTickAnalyticsEpoch] = useState(0);
  const retryRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenersRef = useRef<Set<(frame: Record<string, unknown>) => void>>(new Set());

  const subscribeToNotificationEvents = useCallback(
    (cb: (frame: Record<string, unknown>) => void) => {
      listenersRef.current.add(cb);
      return () => {
        listenersRef.current.delete(cb);
      };
    },
    [],
  );

  const applyFrame = useCallback((frame: Record<string, unknown>) => {
    const type = String(frame.type ?? '');

    // Insights / incident frames: pure op-data for listeners (Data Insights
    // pages + alerts). Notifications state is not synthesized from them.
    if (type.startsWith('insight_') || type === 'incident_created' || type === 'incident_resolved') {
      for (const cb of listenersRef.current) {
        try { cb(frame); } catch { /* listener errors must never break the stream */ }
      }
      return;
    }

    if (isNotificationFrame(type) || isAlertFrame(type)) {
      const notif = (frame.notification as RealtimeNotification) ?? null;
      const alert = (frame.alert as RealtimeAlert) ?? null;
      const nid = String(frame.notification_id ?? notif?._id ?? '');
      const aid = String(frame.alert_id ?? alert?.alert_id ?? alert?._id ?? '');

      setNotificationsState((prev) => {
        const unreadCount = typeof frame.unreadCount === 'number' ? frame.unreadCount : prev.unreadCount;
        const activeCount = typeof frame.activeCount === 'number' ? frame.activeCount : prev.activeAlerts;
        const kind = isNotificationFrame(type) ? 'notif' : 'alert';

        const notifs = prev.latestNotifications;
        const alerts = prev.latestAlerts;

        // Notification delete frames carry a single id or a bulk list; update
        // frames carrying a boolean `read` plus ids flip local read state so
        // mark-many / delete-read reflect instantly on any open page.
        const deletedIds =
          Array.isArray(frame.notification_ids)
            ? frame.notification_ids.map(String)
            : type === 'notification_deleted' && nid
              ? [nid]
              : [];
        const bulkUpdateIds =
          type === 'notification_updated' && Array.isArray(frame.notification_ids)
            ? frame.notification_ids.map(String)
            : [];
        const hasBulkRead =
          bulkUpdateIds.length > 0 && typeof frame.read === 'boolean';

        const nextNotifs =
          kind === 'alert'
            ? notifs
            : deletedIds.length > 0
              ? notifs.filter((n) => !deletedIds.includes(String(n._id)))
              : hasBulkRead
                ? notifs.map((n) =>
                    bulkUpdateIds.includes(String(n._id))
                      ? { ...n, read: Boolean(frame.read), status: frame.read ? 'read' : 'unread' }
                      : n,
                  )
                : (() => {
                    const entry = notif ?? (nid ? { _id: nid } as RealtimeNotification : null);
                    if (!entry) return notifs;
                    const entryId = String(entry._id ?? '');
                    // Merge update/read frames into an existing row when known.
                    const isUpdate = type === 'notification_updated';
                    if (isUpdate && entryId) {
                      return notifs.some((n) => String(n._id) === entryId)
                        ? notifs.map((n) =>
                            String(n._id) === entryId
                              ? {
                                  ...n,
                                  ...(typeof frame.changes === 'object' && frame.changes
                                    ? (frame.changes as Record<string, unknown>)
                                    : {}),
                                }
                              : n,
                          )
                        : [{ _id: entryId, ...(typeof frame.changes === 'object' && frame.changes ? frame.changes as Record<string, unknown> : {}) } as RealtimeNotification, ...notifs];
                    }
                    return notifs.some((n) => String(n._id) === entryId)
                      ? notifs
                      : [entry, ...notifs].slice(0, 50);
                  })();

        // Alerts: delete frames remove matching ids (single or bulk list);
        // update/resolved frames merge into the existing row; create frames
        // prepend without duplicating an already-known id.
        const deletedAlertIds =
          Array.isArray(frame.alert_ids)
            ? frame.alert_ids.map(String)
            : aid
              ? [aid]
              : [];
        const nextAlerts =
          kind === 'notif'
            ? alerts
            : deletedAlertIds.length > 0
              ? alerts.filter((a) => !deletedAlertIds.includes(String(a.alert_id ?? a._id ?? '')))
              : (() => {
                  const entry = alert ?? (aid ? { alert_id: aid } as RealtimeAlert : null);
                  if (!entry) return alerts;
                  const entryId = String(entry.alert_id ?? entry._id ?? '');
                  const exists = alerts.some((a) => String(a.alert_id ?? a._id ?? '') === entryId);
                  const merged = exists
                    ? alerts.map((a) =>
                        String(a.alert_id ?? a._id ?? '') === entryId ? { ...a, ...entry } : a,
                      )
                    : [entry, ...alerts];
                  return merged.slice(0, 50);
                })();

        return {
          unreadCount,
          activeAlerts: kind === 'alert' ? activeCount : prev.activeAlerts,
          checkedAt: new Date().toISOString(),
          latestNotifications: nextNotifs,
          latestAlerts: nextAlerts,
        };
      });
      setNotifEpoch((e) => e + 1);
      for (const cb of listenersRef.current) {
        try {
          cb(frame);
        } catch {
          // listener errors must never break the stream
        }
      }
    }
  }, []);

  const openStream = useCallback(() => {
    if (!mountedRef.current) return;
    setAppConnection('CONNECTING');
    let es: EventSource;
    try {
      es = new EventSource(getSystemStreamUrl());
    } catch {
      return;
    }
    esRef.current = es;

    es.onopen = () => {
      retryRef.current = 0;
      setAppConnection('CONNECTED');
    };

    es.onmessage = (ev) => {
      const frame = parseFrame(ev.data ?? '');
      if (!frame) return;
      setLastEventAt(Date.now());
      const type = frame.type;
      if (type === 'state_snapshot') {
        setState(frame);
        setHydrated(true);
        if (frame.notifications) {
          const ent = frame.notifications as Partial<RealtimeNotificationsState>;
          setNotificationsState((prev) => ({
            ...prev,
            unreadCount: typeof ent.unreadCount === 'number' ? ent.unreadCount : prev.unreadCount,
            activeAlerts: typeof ent.activeAlerts === 'number' ? ent.activeAlerts : prev.activeAlerts,
            checkedAt: ent.checkedAt ?? prev.checkedAt,
          }));
        }
      } else if (type === 'state_changed' && frame.entity) {
        setState((prev) => {
          const next = {
            ...prev,
            [frame.entity]: { ...(prev[frame.entity] ?? {}), ...(frame.changes ?? {}) },
          };
          return next;
        });
        if (frame.entity === 'notifications') {
          const ch = (frame.changes ?? {}) as Record<string, unknown>;
          setNotificationsState((prev) => ({
            ...prev,
            unreadCount: typeof ch.unreadCount === 'number' ? ch.unreadCount : prev.unreadCount,
            activeAlerts: typeof ch.activeAlerts === 'number' ? ch.activeAlerts : prev.activeAlerts,
            checkedAt: String(ch.checkedAt ?? prev.checkedAt),
          }));
        }
      } else if (type === 'service_changed' && frame.service) {
        setState((prev) => {
          const services = { ...(prev.services ?? {}) };
          services[frame.service] = {
            ...(services[frame.service] ?? {}),
            ...(frame.changes ?? {}),
            updatedAt: frame.timestamp,
          };
          return { ...prev, services };
        });
      } else if (type === 'ws_live') {
        // Backend pushes the CURRENT supervisor live frame ~every 3s so the
        // WebSocket monitor's Live cards keep ticking (values stay backend-driven).
        setState((prev) => {
          if (frame.live == null) return prev;
          const ws = { ...(prev.websocket ?? {}) };
          ws.live = frame.live;
          ws.pipeline = frame.pipeline ?? ws.pipeline;
          ws._liveFrameAt = String(frame.timestamp ?? '');
          return { ...prev, websocket: ws };
        });
        setLiveEpoch((e) => e + 1);
      } else if (type === 'pipeline_saved' || type === 'pipeline_error') {
        const ts = toMs(frame.timestamp);
        const ev: PipelineEvent = {
          id: `${type}-${frame.timestamp ?? String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
          kind: type === 'pipeline_saved' ? 'saved' : 'error',
          eventType: String(frame.event_type ?? type),
          status: String(frame.status ?? (type === 'pipeline_saved' ? 'ok' : 'error')),
          message: String(frame.message ?? ''),
          timestamp: ts ?? Date.now(),
          meta: (frame.meta ?? {}) as Record<string, unknown>,
        };
        setPipelineEvents((prev) => [ev, ...prev].slice(0, 40));
        setPipelineEpoch((e) => e + 1);
      } else if (type === 'tick_analytics') {
        // Coalesced ~1 Hz Tick Analytics summary pushed by the backend. One
        // frame per second (never one per tick) -- the page only re-renders
        // its live snapshot block from this.
        const data = (frame.data ?? null) as Record<string, any> | null;
        if (data && typeof data === 'object') {
          setTickAnalytics({ ...data, _frameAt: String(frame.timestamp ?? '') });
          setTickAnalyticsEpoch((e) => e + 1);
        }
      } else if (isNotificationFrame(type) || isAlertFrame(type) || type === 'notification_count_changed') {
        applyFrame(frame);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; only bump our backoff bookkeeping when it
      // actually errors/closed so we don't double-open a stream.
      es.close();
      esRef.current = null;
      setAppConnection((cur) => (cur === 'CONNECTED' ? 'RECONNECTING' : cur));
      scheduleReconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFrame]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    const delay = Math.min(BASE_DELAY * 2 ** retryRef.current, MAX_DELAY);
    retryRef.current += 1;
    setAppConnection('RECONNECTING');
    pollTimerRef.current = setTimeout(() => openStream(), delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconciliation poll. It used to run ONLY while the SSE stream was down,
  // which meant a stream that merely *looked* connected but was silently
  // stalled — or a single missed `state_changed` delta — left the GlobalTopBar
  // indicators (WEBSOCKET / SCHEDULER / SESSION especially) frozen for minutes
  // until the socket finally reconnected. It now runs ALWAYS: faster while the
  // stream is down (fast recovery) and paced while it is up (self-heal), so no
  // indicator can ever be stale for more than a few seconds. The payload is a
  // few KB now that the session bloat is gone, so this is cheap.
  useEffect(() => {
    const intervalMs = appConnection === 'CONNECTED' ? 5000 : 2500;
    let inFlight = false;
    const reconcile = () => {
      if (inFlight) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      inFlight = true;
      getSystemStreamStatus()
        .then((snap) => {
          if (!snap || !mountedRef.current) return;
          setState((prev) => ({ ...prev, ...snap, hydrated: true }));
          setHydrated(true);
          setLastEventAt(Date.now());
          if ((snap as any).notifications) {
            const ent = (snap as any).notifications as Partial<RealtimeNotificationsState>;
            setNotificationsState((prev) => ({
              ...prev,
              unreadCount: typeof ent.unreadCount === 'number' ? ent.unreadCount : prev.unreadCount,
              activeAlerts: typeof ent.activeAlerts === 'number' ? ent.activeAlerts : prev.activeAlerts,
              checkedAt: ent.checkedAt ?? prev.checkedAt,
            }));
          }
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    // Heal immediately on mount / connection change, then on the cadence.
    reconcile();
    const id = setInterval(reconcile, intervalMs);
    return () => clearInterval(id);
  }, [appConnection]);

  useEffect(() => {
    mountedRef.current = true;
    openStream();
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (esRef.current) esRef.current.close();
      esRef.current = null;
    };
  }, [openStream]);

  // Navigator online/offline — the appConnection state goes OFFLINE the moment
  // the browser reports no network (independent of the backend stream), and a
  // stream is reopened on return. Consumers (WebSocket / Ticks / Analytics
  // pages) turn their indicators red without any extra polling.
  useEffect(() => {
    const goOffline = () => setAppConnection('OFFLINE');
    const goOnline = () => {
      setAppConnection((cur) => (cur === 'OFFLINE' ? 'CONNECTING' : cur));
      if (esRef.current == null && mountedRef.current) openStream();
    };
    if (typeof navigator !== 'undefined' && !navigator.onLine) goOffline();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [openStream]);

  // ---- Derived status (tri-state: never a fabricated false on first paint) ----
  const sessionRec = state.session ?? {};
  const sessionStatus = String(sessionRec.status ?? 'UNKNOWN');
  let sessionActive: boolean | 'UNKNOWN' = 'UNKNOWN';
  if (hydrated) {
    sessionActive = Boolean(
      sessionRec.status === 'WS_ACTIVE' || sessionRec.status === 'SESSION_ACTIVE' || sessionRec.active,
    );
  }

  const brokerSvc = state.services?.broker_ws;
  // Live frames (pushed every ~2s as `state_changed` → websocket.live) carry the
  // CURRENT supervisor state, so the WEBSOCKET indicator can tick in real time
  // instead of waiting for a rare transition or a full snapshot. `supervisorState`
  // is the canonical connection state (CONNECTED / CONNECTING / RECONNECTING /
  // STOPPED / FAILED …); it is preferred over the snapshot's `websocket.state`,
  // which only refreshes on a transition or a stream reconnect.
  const wsLive = state.websocket?.live as Record<string, any> | undefined;
  const brokerState = String(
    wsLive?.supervisorState ??
      state.websocket?.state ??
      state.websocket?.connState ??
      state.websocket?.lifecycleState ??
      brokerSvc?.status ??
      'UNKNOWN',
  );

  function deriveBrokerWsConnected(state: string): boolean | 'UNKNOWN' {
    switch (state) {
      case 'SUPERVISOR_CONNECTED':
      case 'CONNECTED':
      case 'RUNNING':
      case 'STARTED':
        return true;
      case 'SUPERVISOR_DISCONNECTED':
      case 'SUPERVISOR_STOPPED':
      case 'SUPERVISOR_ERROR':
      case 'DISCONNECTED':
      case 'STOPPED':
      case 'STOPPING':
      case 'FAILED':
      case 'ERROR':
      case 'AUTH_FAILED':
        return false;
      case 'SUPERVISOR_CONNECTING':
      case 'SUPERVISOR_RECONNECTING':
      case 'CONNECTING':
      case 'RECONNECTING':
      case 'WAITING_FOR_MARKET_WINDOW':
      case 'NETWORK_OFFLINE':
      case 'AUTH_REQUIRED':
      case 'BROKER_UNAVAILABLE':
      case 'SUPERVISOR_WAITING':
      case 'SUPERVISOR_AUTH_REQUIRED':
      case 'SUPERVISOR_NETWORK_OFFLINE':
        return false;
      default:
        return 'UNKNOWN';
    }
  }

  const brokerWsConnected = hydrated ? deriveBrokerWsConnected(brokerState) : 'UNKNOWN';

  const marketState = state.market ?? null;

  const internetConnected = state.internet?.connected ?? null;

  const value: RealtimeContextValue = {
    appConnection,
    state,
    hydrated,
    sessionActive,
    sessionStatus,
    brokerWsConnected,
    brokerWsState: brokerState,
    marketState,
    internetConnected,
    lastEventAt,
    notificationsState,
    notifEpoch,
    liveEpoch,
    pipelineEvents,
    pipelineEpoch,
    tickAnalytics,
    tickAnalyticsEpoch,
    subscribeToNotificationEvents,
  };

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}