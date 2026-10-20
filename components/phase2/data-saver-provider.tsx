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

/**
 * Shared Data Saver data provider — the SINGLE polling loop for the whole
 * Data Saver workspace. Polls the canonical `/api/data-saver/dashboard`
 * endpoint (one centralized shape, single-flight backend) every POLL_MS and
 * hands the snapshot to ANY consumer (dashboard, topbar status indicators,
 * etc.) via `useDataSaver()`.
 *
 * Guarantees:
 *  - EXACTLY ONE polling loop per mounted provider (no per-card loops).
 *  - One in-flight request per resource: overlapping calls (interval +
 *    visibility-refresh + manual refresh) share a single fetch through the
 *    request cache — never stacked duplicates.
 *  - Last-good-data is ALWAYS preserved: an API failure never replaces the
 *    rendered values with null/—/0.
 *  - Tab-hidden -> polling pauses; returning to a visible tab -> ONE
 *    controlled refresh (never a second timer).
 *  - No `window.location.reload`.
 */
const POLL_MS = 10000
const POLL_BACKOFF_MAX_MS = 45000
const DASH_MAX_AGE_MS = 12000
const DASH_SWR_MS = 30000
// Hard client-side ceiling: the Next route can take 5-13s+ when the backend is
// slow (quality rebuild / 95% RAM). Without this the browser fetch hangs with
// no feedback and the Refresh button appears dead ("stuck, kuch nahi hota").
// Past this the request is aborted and treated as a normal failure with
// backoff — last-good-data stays on screen.
const DASH_FETCH_TIMEOUT_MS = 15000

export interface DataSaverStatus {
  wsConnected: boolean
  dbConnected: boolean
  alertCount: number
  schedulerRunning: boolean
  schedulerState: string
  sessionActive: boolean
  internetOk: boolean
}

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
})

const DASH_KEY = 'data-saver/dashboard'

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

  const mountedRef = useRef(true)
  const pausedRef = useRef(paused)
  const inflightRef = useRef<AbortController | null>(null)
  const hasDataRef = useRef(false)
  const consecutiveFailuresRef = useRef(0)
  pausedRef.current = paused

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
      hasDataRef.current = true
      setData(res.data)
      setError(false)
      setErrorReason(null)
      consecutiveFailuresRef.current = 0
      setConsecutiveFailures(0)
      setLoading(false)
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
  }, [])

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
      const delay =
        failures === 0
          ? POLL_MS
          : Math.min(POLL_BACKOFF_MAX_MS, Math.round(POLL_MS * Math.pow(1.5, failures)))
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
      internetOk: Boolean(ws.internetOk),
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
      ...status,
    }),
    [data, error, errorReason, loading, paused, consecutiveFailures, setPaused, refresh, status],
  )

  return <DataSaverContext.Provider value={value}>{children}</DataSaverContext.Provider>
}

export function useDataSaver(): DataSaverContextValue {
  return useContext(DataSaverContext)
}
