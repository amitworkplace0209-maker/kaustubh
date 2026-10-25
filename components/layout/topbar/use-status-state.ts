'use client';

import { useMemo } from 'react';
import { useRealtime } from '@/components/realtime-provider';
import { useSystem } from '@/components/system-provider';
import {
  canonicalSessionState,
  deriveStatus,
  isManualLoginState,
  marketLoginGate,
  schedulerTimeline,
  summarize,
  type CanonicalSessionState,
  type MarketLoginGate,
  type SchedulerTimeline,
  type StatusEntry,
  type StatusLinks,
} from '@/lib/topbar-status';

export type StatusCluster = {
  /** EXACTLY four indicators: net · ws · sched · sess — never more. */
  entries: StatusEntry[];
  summary: ReturnType<typeof summarize>;
  hydrated: boolean;
  appConnection: string;
  sysState: 'loading' | 'ok' | 'error';
  lastUpdated: number | null;
  /**
   * The ONE backend Scheduler plan shared by the WS / Scheduler / Session
   * indicators, so those three pills can never disagree about what happens
   * next or when the socket/session comes up and goes down.
   */
  timeline: SchedulerTimeline;
  /** Canonical session verdict (ACTIVE / INACTIVE / EXPIRED / …). */
  canonical: CanonicalSessionState;
  /** True only when the backend really needs a login action. */
  manualLogin: boolean;
  /** Honest market-closed verdict + the configured scheduler logout instant. */
  gate: MarketLoginGate;
};

/** The four served to the GlobalTopBar, in display order. */
const CORE_IDS = ['net', 'ws', 'sched', 'sess'] as const;

/**
 * Single source of truth for the four GlobalTopBar indicators (INTERNET,
 * WEBSOCKET, SCHEDULER, SESSION). Derives every value from the ONE global
 * realtime snapshot + the ONE /api/system poll. Never fabricates a value;
 * unknown fields resolve to UNKNOWN/gray and pre-flight windows to CHECKING/
 * amber while a real check is actually in progress.
 *
 * `links` come from the active ShellConfig (per-phase accurate), so picking an
 * indicator jumps to the right detail page in every phase.
 *
 * NOTE ON THE CLOCK: no `nowMs` is passed in here on purpose. A per-second
 * tick at this level would re-render the entire topbar every second. The
 * indicators instead render their "in 4h 12m" line from the backend's own
 * `remaining_seconds`, and each open pill opts into a local 1s tick (see
 * `use-now-tick.ts`) for live interpolation exactly where the user is looking.
 */
export function useStatusState(links: StatusLinks): StatusCluster {
  const rt = useRealtime();
  const sys = useSystem();

  return useMemo(() => {
    const sessionRec = rt.state?.session ?? null;
    const schedulerRec = rt.state?.scheduler ?? null;
    const timeline = schedulerTimeline(schedulerRec?.info ?? null, null);

    /*
     * Market calendar source.
     *
     * The backend's SSE `state_snapshot` (`python-service/api/websocket.py`)
     * carries session / scheduler / websocket / database / internet / services /
     * notifications / metrics — but NO `market` key, so `rt.marketState` is
     * always undefined and the MARKET indicator was permanently UNKNOWN. The
     * ONE `/api/system/market` poll (already running in SystemProvider) DOES
     * return the real calendar, so it is the authoritative fallback. Realtime
     * still wins whenever the backend does start publishing a market frame.
     */
    const marketRec = rt.marketState ?? sys.market ?? null;

    const core = deriveStatus({
      hydrated: rt.hydrated,
      appConnection: rt.appConnection,
      internetConnected: rt.internetConnected ?? sys.data?.internetConnected ?? null,
      brokerWsConnected: rt.brokerWsConnected,
      brokerWsState: rt.brokerWsState,
      wsRec: rt.state?.websocket ?? null,
      schedulerRec,
      dbRec: rt.state?.database ?? null,
      sessionRec,
      sessionActive: rt.sessionActive,
      sessionStatus: rt.sessionStatus,
      marketRec,
      systemData: sys.data,
      links,
      nowMs: null,
    });

    const entries = CORE_IDS.map((id) => core.find((e) => e.id === id)).filter(
      (e): e is StatusEntry => Boolean(e),
    );

    const canonical = canonicalSessionState(sessionRec?.status ?? rt.sessionStatus);

    return {
      entries,
      summary: summarize(entries),
      hydrated: rt.hydrated,
      appConnection: rt.appConnection,
      sysState: sys.state,
      lastUpdated: sys.lastUpdated,
      timeline,
      canonical,
      manualLogin: isManualLoginState(canonical),
      gate: marketLoginGate({
        hydrated: rt.hydrated,
        timeline,
        marketRec,
        nowMs: Date.now(),
      }),
    };
  }, [
    rt.hydrated,
    rt.appConnection,
    rt.internetConnected,
    rt.brokerWsConnected,
    rt.brokerWsState,
    rt.marketState,
    rt.sessionActive,
    rt.sessionStatus,
    rt.state?.websocket,
    rt.state?.scheduler,
    rt.state?.database,
    rt.state?.session,
    sys.data,
    sys.market,
    sys.state,
    sys.lastUpdated,
    links,
  ]);
}