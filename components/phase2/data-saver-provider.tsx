'use client'

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react'
import { getCached } from '@/lib/request-cache'
import { realtimeClient } from '@/lib/realtime-ws'

/**
 * Shared Data Saver data provider — the SINGLE data loop for the whole Data
 * Saver workspace. It feeds the dashboard from BOTH transports, so the page is
 * always fed by whichever one is alive:
 *
 *   1. WEBSOCKET (fast lane, primary)  — the ONE shared `/ws/realtime` socket
 *      (WS#3). The backend owns a `dashboard` snapshot channel: it pushes the
 *      authoritative live document the instant a client subscribes, re-pushes
 *      when the state actually changes, and re-sends fast telemetry on a 6s
 *      cadence. The provider shallow-merges every frame into the latest
 *      snapshot, so counters and states update the moment the backend knows.
 *
 *   2. REST (fallback + slow-sync)     — polls the canonical
 *      `/api/data-saver/dashboard` envelope (full detail: events trail, alerts,
 *      storage categories, quality window, states cards). Cadence adapts: 10s
 *      when the socket is down, 25s when WS frames are flowing (the socket is
 *      carrying the live values; REST only re-syncs the heavy lists).
 *
 * Guarantees:
 *  - EXACTLY ONE REST polling loop + ONE snapshot subscription per mounted
 *    provider (no per-card loops).
 *  - One in-flight request per resource: overlapping calls (interval +
 *    visibility-refresh + manual refresh) share a single fetch through the
 *    request cache — never stacked duplicates.
 *  - Last-good-data is ALWAYS preserved: an API failure or a dropped socket
 *    never replaces the rendered values with null/—/0.
 *  - A WS frame never blanks a REST value: null fields in the live document
 *    are skipped (the backend sends null only for "not measured here").
 *  - Tab-hidden -> polling pauses + merges stop; returning to a visible tab ->
 *    ONE controlled refresh (never a second timer).
 *  - No `window.location.reload`.
 */
const POLL_MS = 10000
const POLL_WS_LIVE_MS = 25000 // REST slow-sync while WS frames are flowing
const POLL_BACKOFF_MAX_MS = 45000
const DASH_MAX_AGE_MS = 12000
const DASH_SWR_MS = 30000
// Hard client-side ceiling: the Next route can take 5-13s+ when the backend is
// slow (quality rebuild / 95% RAM). Without this the browser fetch hangs with
// no feedback and the Refresh button appears dead ("stuck, kuch nahi hota").
// Past this the request is aborted and treated as a normal failure with
// backoff — last-good-data stays on screen.
const DASH_FETCH_TIMEOUT_MS = 15000
/** A WS frame younger than this keeps the transport flagged "live". */
const WS_FRESH_MS = 15000

export interface DataSaverStatus {
  wsConnected: boolean
  dbConnected: boolean
  alertCount: number
  schedulerRunning: boolean
  schedulerState: string
  sessionActive: boolean
  internetOk: boolean
}

export type DataSaverTransport = 'live' | 'poll'

interface DataSaverContextValue extends DataSaverStatus {
  data: any | null
  updatedAt: string | null
  error: boolean
  errorReason: string | null
  loading: boolean
  /** true once the first successful payload has arrived */
  hasData: boolean
  /** count of consecutive failed refreshes (0 while healthy) */
  consecutiveFailures: number
  paused: boolean
  setPaused: (paused: boolean) => void
  refresh: () => void
  /** which transport delivered the newest data: 'live' (WS#3) or 'poll' (REST) */
  transport: DataSaverTransport
  /** ISO timestamp of the newest WS push (null while REST-only) */
  liveUpdatedAt: string | null
  /** the shared /ws/realtime socket state (DISCONNECTED…CONNECTED/ERROR) */
  socketState: string
}

const DataSaverContext = createContext<DataSaverContextValue>({
  data: null,
  updatedAt: null,
  error: false,
  errorReason: null,
  loading: true,
  hasData: false,
  consecutiveFailures: 0,
  paused: false,
  wsConnected: false,
  dbConnected: false,
  alertCount: 0,
  schedulerRunning: false,
  schedulerState: 'UNKNOWN',
  sessionActive: false,
  internetOk: false,
  setPaused: () => {},
  refresh: () => {},
  transport: 'poll',
  liveUpdatedAt: null,
  socketState: 'DISCONNECTED',
})

const DASH_KEY = 'data-saver/dashboard'

/**
 * Shallow-merge the WS live document (``live``) OVER the REST snapshot
 * (``rest``). Per top-level key: when both sides are plain objects the REST
 * value wins for fields the live document does not know (it carries the heavy
 * detail), and the live fields override the same-named ones. Null live values
 * are skipped entirely — "not measured here" must never blank a measurement.
 */
function mergeLiveFrame(rest: any | null, live: any | null): any {
  const base: any = rest && typeof rest === 'object' ? rest : {}
  if (!live || typeof live !== 'object') return base
  const out: any = { ...base }
  for (const [key, value] of Object.entries(live)) {
    if (key === 'generatedAt') {
      out.updatedAt = value as string
      continue
    }
    if (value == null) continue
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = { ...base[key], ...value }
    } else {
      out[key] = value
    }
  }
  return out
}

export function DataSaverProvider({
  children,
  initialPaused = false,
}: {
  children: React.ReactNode
  initialPaused?: boolean
}) {
  const [data, setData] = useState<any | null>(null)
  const [error, setError] = useState(false)
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [paused, setPausedState] = useState(initialPaused)
  const [consecutiveFailures, setConsecutiveFailures] = useState(0)
  const [transport, setTransport] = useState<DataSaverTransport>('poll')
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<string | null>(null)
  const [socketState, setSocketState] = useState<string>('DISCONNECTED')

  const mountedRef = useRef(true)
  const pausedRef = useRef(paused)
  const inflightRef = useRef<AbortController | null>(null)
  const hasDataRef = useRef(false)
  const consecutiveFailuresRef = useRef(0)
  /** Latest REST envelope (full detail, its own freshness). */
  const restRef = useRef<any | null>(null)
  /** Latest WS#3 `dashboard` live document (its own freshness). */
  const liveRef = useRef<any | null>(null)
  const lastWsFrameAtRef = useRef(0)
  /** A live frame older than this is dropped so a dead socket never shadows
   *  fresher REST values. */
  const WS_LIVE_TTL_MS = 60000
  pausedRef.current = paused

  /** Recompute the rendered snapshot: REST as base, fresh live frame on top. */
  const publish = useCallback(() => {
    if (!mountedRef.current || pausedRef.current) return
    const liveFresh = lastWsFrameAtRef.current > 0
      && Date.now() - lastWsFrameAtRef.current < WS_LIVE_TTL_MS
    if (!liveFresh) liveRef.current = null
    const merged = mergeLiveFrame(restRef.current, liveRef.current)
    if (merged == null) return
    hasDataRef.current = true
    setData(merged)
  }, [])

  useEffect(() => {
    consecutiveFailuresRef.current = consecutiveFailures
  }, [consecutiveFailures])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      inflightRef.current?.abort()
      inflightRef.current = null
    }
  }, [])

  const load = useCallback(async (force = false) => {
    if (pausedRef.current) return
    if (inflightRef.current) {
      // A manual retry while a slow fetch hangs must actually do something —
      // otherwise the Refresh button looks dead and the page feels "stuck".
      // Abort the stale attempt and let the forced load start fresh. The
      // aborted (old) load exits silently without clearing the new controller
      // (guarded by identity check below).
      if (!force) return
      inflightRef.current.abort()
      inflightRef.current = null
      // Yield so the aborted shared fetch settles and the request-cache
      // single-flight clears before we start the replacement fetch — without
      // this the new load would join the just-aborted task and also report
      // aborted.
      await new Promise((r) => setTimeout(r, 50))
      if (pausedRef.current) return
      if (inflightRef.current) return
    }

    // Abort controller only protects the real network call; the request cache
    // single-flights overlapping refreshes so no duplicate fetch is issued.
    const controller = new AbortController()
    inflightRef.current = controller

    const res = await getCached(
      DASH_KEY,
      async () => {
        const startedAt = performance.now()
        // `refresh=1` asks the Next proxy to bypass its own 30s payload cache, so
        // a forced refresh reflects backend state (e.g. a just-completed manual
        // login) instead of re-serving the pre-action snapshot.
        const url = force ? '/api/data-saver/dashboard?refresh=1' : '/api/data-saver/dashboard'
        let timedOut = false
        const timeoutId = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, DASH_FETCH_TIMEOUT_MS)
        try {
          const r = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store',
          })
          const contentType = r.headers.get('content-type') ?? ''
          if (!r.ok) {
            console.warn(
              `[DASHBOARD] fetch failed: url=${url} status=${r.status} ${Math.round(performance.now() - startedAt)}ms`,
            )
            return { status: r.status, data: null }
          }
          if (!contentType.includes('application/json')) {
            console.warn(
              `[DASHBOARD] non-JSON response: url=${url} status=${r.status} type=${contentType}`,
            )
            return { status: r.status, data: null }
          }
          const d = await r.json()
          return { status: r.status, data: d }
        } catch (err: any) {
          const aborted = err?.name === 'AbortError'
          if (timedOut) {
            // Our own 15s ceiling fired: the server is too slow, not the tab
            // hiding. Surface as a genuine failure (backoff + banner) instead
            // of a silent abort so the user sees "Offline — retrying" rather
            // than a frozen page with no feedback.
            console.warn(
              `[DASHBOARD] fetch timed out after ${DASH_FETCH_TIMEOUT_MS}ms: url=${url} — backing off, keeping last-good-data`,
            )
            return { status: 0, data: null }
          }
          if (!aborted) {
            console.error(
              `[DASHBOARD] network error: url=${url} name=${err?.name ?? 'unknown'} message=${err?.message ?? ''} ${Math.round(performance.now() - startedAt)}ms`,
            )
          }
          return { status: 0, data: null, aborted }
        } finally {
          clearTimeout(timeoutId)
        }
      },
      { maxAgeMs: DASH_MAX_AGE_MS, swrMs: DASH_SWR_MS, force },
    )

    if (inflightRef.current === controller) inflightRef.current = null
    if (!mountedRef.current) return

    // An aborted request (tab hidden / unmount), OR the shared single-flight
    // fetch aborted by a sibling poller, is not a failure. The cache now
    // propagates `aborted` so this caller (whose own controller is NOT the one
    // that aborted) still does the right thing instead of logging a false error.
    if (controller.signal.aborted || res.aborted) return

    if (res.data != null) {
      restRef.current = res.data
      setError(false)
      setErrorReason(null)
      consecutiveFailuresRef.current = 0
      setConsecutiveFailures(0)
      setLoading(false)
      publish()
      return
    }

    // No cache, genuine failure — surface the error without losing last-good data.
    // Exponential backoff is applied by the scheduler below so we don't hammer
    // a struggling backend (95% RAM case). Throttle logging after 3 failures.
    setError(true)
    setErrorReason(
      res.status >= 400
        ? `Dashboard fetch failed (HTTP ${res.status})`
        : 'Dashboard fetch failed (network unreachable)',
    )
    const nextFailures = consecutiveFailuresRef.current + 1
    consecutiveFailuresRef.current = nextFailures
    setConsecutiveFailures(nextFailures)
    setLoading(false)
    // Throttle spam: log every failure up to 3, then every 3rd
    if (nextFailures <= 3 || nextFailures % 3 === 0) {
      console.error(`[DASHBOARD] refresh failed: status=${res.status} (failure #${nextFailures}) — backing off`)
    } else {
      console.warn(`[DASHBOARD] refresh failed: status=${res.status} (throttled, #${nextFailures})`)
    }
  }, [publish])

  // ------------------------------------------------------------------ //
  // WS live lane — subscribe once to the `dashboard` snapshot channel.
  // Frames shallow-merge into the rendered snapshot on arrival; the REST
  // loop keeps running as the fallback + slow-sync (heavy lists). Same
  // driver-store pattern as `lib/data-center-store.ts` (no per-tick React
  // re-render at market rate — the document changes at state boundaries
  // plus a 6s telemetry re-push).
  // ------------------------------------------------------------------ //
  useEffect(() => {
    if (typeof window === 'undefined') return
    let frameOff: (() => void) | null = null
    let stateOff: (() => void) | null = null
    let unsubscribed = false

    const subscribe = () => {
      void realtimeClient.subscribe([{ channel: 'dashboard' }]).catch(() => {})
    }

    frameOff = realtimeClient.onFrame((frame) => {
      if (unsubscribed || pausedRef.current) return
      if (frame.type !== 'dashboard.snapshot') return
      const body: any = frame.data
      if (!body || typeof body !== 'object') return
      // `_state_snapshot_frame` nests the channel document under `payload`
      // (the broadcast bridge nests under `data` — accept both, never invent).
      const doc: any = body.payload ?? body.data ?? null
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return
      lastWsFrameAtRef.current = Date.now()
      liveRef.current = doc
      setTransport('live')
      setLiveUpdatedAt(String(body.generatedAt ?? doc.generatedAt ?? new Date().toISOString()))
      publish()
    })

    stateOff = realtimeClient.onStateChange((state) => {
      if (unsubscribed) return
      setSocketState(state)
      if (state === 'CONNECTED') {
        // A fresh socket needs a fresh subscription (the client also replays
        // its own tracked subs — harmless duplicate ack).
        subscribe()
      } else {
        setTransport('poll')
        setLiveUpdatedAt(null)
      }
    })

    // Subscription is queued: when the socket is not open yet the client
    // stores it and subscribes as soon as the shared socket opens.
    subscribe()

    // Mark the transport poll when no frame has arrived for a while.
    const freshness = setInterval(() => {
      if (unsubscribed) return
      const connected = realtimeClient.getState() === 'CONNECTED'
      setSocketState(realtimeClient.getState())
      if (connected && lastWsFrameAtRef.current > 0) {
        const live = Date.now() - lastWsFrameAtRef.current < WS_FRESH_MS
        setTransport(live ? 'live' : 'poll')
        if (!live) setLiveUpdatedAt(null)
      }
    }, 5000)

    return () => {
      unsubscribed = true
      frameOff?.()
      stateOff?.()
      clearInterval(freshness)
      void realtimeClient.unsubscribe([{ channel: 'dashboard' }]).catch(() => {})
    }
  }, [publish])

  // Visibility: pause when hidden, do ONE controlled refresh when visible.
  const userPausedRef = useRef(initialPaused)
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        inflightRef.current?.abort()
        pausedRef.current = true
      } else if (!userPausedRef.current) {
        pausedRef.current = false
        void load()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [load])

  const setPaused = useCallback(
    (p: boolean) => {
      userPausedRef.current = p
      setPausedState(p)
      pausedRef.current = p
      if (!p) void load()
    },
    [load],
  )

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const schedule = () => {
      if (cancelled) return
      const failures = consecutiveFailuresRef.current
      // Exponential backoff: 10s, 15s, 22s, 34s ... capped at 45s.
      // Gives backend breathing room after repeated 502s instead of
      // hammering every 10s and flooding console.errors.
      // When WS frames are flowing the REST sync deliberately slows to 25s —
      // the socket is carrying the live values, REST only re-syncs lists.
      const wsLive = lastWsFrameAtRef.current > 0
        && Date.now() - lastWsFrameAtRef.current < WS_FRESH_MS * 3
      const base = failures === 0 ? (wsLive ? POLL_WS_LIVE_MS : POLL_MS) : null
      const delay = base ?? Math.min(POLL_BACKOFF_MAX_MS, Math.round(POLL_MS * Math.pow(1.5, failures)))
      // Small jitter to de-sync multiple tabs
      const jitter = Math.round(Math.random() * 800)
      timeoutId = setTimeout(async () => {
        if (cancelled) return
        await load()
        schedule()
      }, delay + jitter)
    }

    // Initial immediate load
    void load().finally(schedule)

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [load])

  const refresh = useCallback(() => {
    // Forced: aborts a hung fetch and retries immediately so the button never
    // looks dead while a slow backend holds the poll loop.
    void load(true)
  }, [load])

  // Derive topbar/status-related fields from the single dashboard snapshot so
  // the whole workspace reads ONE source of truth instead of N pollers.
  const status = useMemo<DataSaverStatus>(() => {
    const d: any = data ?? {}
    const ws = d.ws && typeof d.ws === 'object' ? d.ws : {}
    const mongo = d.mongo && typeof d.mongo === 'object' ? d.mongo : {}
    const sess = d.session && typeof d.session === 'object' ? d.session : {}
    const sched = d.scheduler && typeof d.scheduler === 'object' ? d.scheduler : {}
    const alerts = Array.isArray(d.alerts) ? d.alerts : []
    let alertCount = 0
    for (const a of alerts) if (a && a.status !== 'resolved') alertCount += 1
    return {
      wsConnected: Boolean(ws.connected),
      dbConnected: Boolean(mongo.connected),
      alertCount,
      schedulerRunning: Boolean(sched.running),
      schedulerState: String(sched.state ?? 'UNKNOWN'),
      sessionActive: Boolean(sess.active),
      internetOk: Boolean(ws.internetOk ?? (d.net && d.net.internetOk)),
    }
  }, [data])

  const value = useMemo<DataSaverContextValue>(
    () => ({
      data,
      updatedAt: data?.updatedAt ?? null,
      error,
      errorReason,
      loading,
      hasData: hasDataRef.current,
      consecutiveFailures,
      paused,
      setPaused,
      refresh,
      transport,
      liveUpdatedAt,
      socketState,
      ...status,
    }),
    [data, error, errorReason, loading, paused, consecutiveFailures, setPaused, refresh, transport, liveUpdatedAt, socketState, status],
  )

  return <DataSaverContext.Provider value={value}>{children}</DataSaverContext.Provider>
}

export function useDataSaver(): DataSaverContextValue {
  return useContext(DataSaverContext)
}
