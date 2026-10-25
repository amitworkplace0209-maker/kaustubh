'use client';

/**
 * Canonical Market Watch engine phase / lifecycle indicator (doc §5, §8, §25).
 *
 * Rendered once by the canonical page shell, so every route and every phase
 * shell shows the SAME phase indicator driven by the SAME backend state.
 *
 * Hard rules honoured here:
 *  * the phase shown is whatever the engine reported — never a client guess,
 *    never a wall-clock estimate, never an interpolated "next" phase;
 *  * before the engine has reported a state the bar says "waiting for engine"
 *    rather than assuming PRE_MARKET;
 *  * counts come from the engine's own progress/status read;
 *  * socket state is surfaced honestly, and a disconnected socket downgrades the
 *    indicator instead of silently freezing the last value as if it were live.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Radio, Signal, Layers, ListChecks, Gauge, TrendingUp, TrendingDown, Minus, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  LIFECYCLE_STATES,
  lifecycleIndex,
  lifecycleLabel,
  lifecycleState,
  lifecycleChangedAtLabel,
  isLifecycleMonitoring,
  isLifecycleTerminal,
  useEngineProgress,
  RECONCILE_INTERVAL_MS,
  fetchWeeklyUniverse,
  type MwLifecycleState,
} from './mw-shared';

function toneOf(state: MwLifecycleState, liveCount: number, terminal: boolean) {
  if (state === 'UNKNOWN') return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  if (terminal) return 'border-slate-500/40 bg-slate-500/10 text-slate-300';
  if (!liveCount) return 'border-sky-500/40 bg-sky-500/10 text-sky-300';
  if (state === 'BLOCKING') return 'border-orange-500/40 bg-orange-500/10 text-orange-300';
  return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
}

function Count({ icon: Icon, label, value, hint }: {
  icon: typeof Layers;
  label: string;
  value: number | null | undefined;
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-card/40 px-2.5 py-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-sm font-semibold tabular-nums">
          {value == null ? <span className="text-muted-foreground">—</span> : value}
        </div>
      </div>
      {hint ? <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export default function MarketWatchStatusBar({ className }: { className?: string }) {
  // doc §25/§26 — `useEngineProgress` patches this from every
  // `market_watch.status` frame, including lifecycle transitions, so the REST
  // read is a slow reconciliation net rather than the update path.
  const { progress, state, loading, error, resolved, connected } = useEngineProgress(RECONCILE_INTERVAL_MS);

  // doc §2/§6/§7/§30 — the weekly lock is the ONLY thing that decides which
  // stocks are monitored. This reads the backend's own proof
  // (locked count vs. engine universe vs. subscribed count) so the page shows
  // the rule being obeyed instead of asserting it.
  const [universeProof, setUniverseProof] = useState<Awaited<ReturnType<typeof fetchWeeklyUniverse>> | null>(null);
  const [universeProofError, setUniverseProofError] = useState<string | null>(null);
  const loadUniverseProof = useCallback(async () => {
    try {
      setUniverseProof(await fetchWeeklyUniverse());
      setUniverseProofError(null);
    } catch (err: any) {
      setUniverseProofError(err?.message ?? 'weekly lock unavailable');
    }
  }, []);
  useEffect(() => {
    void loadUniverseProof();
    // The weekly lock only changes on user actions on the Weekly page, and the
    // engine progress above is already frame-driven. Slow reconcile — rest for
    // the minute right after a load, then refresh as a low-frequency net.
    let lastLoaded = Date.now();
    const iv = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (connected && Date.now() - lastLoaded < RECONCILE_INTERVAL_MS) return;
      lastLoaded = Date.now();
      void loadUniverseProof();
    }, RECONCILE_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [loadUniverseProof, connected]);

  const counts = progress.statusCounts ?? {};
  const liveCount = counts.LIVE ?? 0;
  const monitoring = isLifecycleMonitoring(state);
  const terminal = isLifecycleTerminal(state);
  const activeIndex = lifecycleIndex(state);
  const unknown = state === 'UNKNOWN';

  const universe = progress.universe ?? null;
  const ranking = progress.ranking ?? null;
  const gainers = ranking?.gainers ?? null;
  const losers = ranking?.losers ?? null;
  const unchanged = ranking?.unchanged ?? null;

  // doc §30 — the rule is "locked list = subscription list". All three numbers
  // must agree AND the engine's own week verification must pass.
  const universeProofVerifyOk = Boolean(
    universeProof?.locked &&
      universeProof.locked.symbolCount === universeProof.engineUniverseSize &&
      universeProof.engineUniverseSize === universeProof.subscribedTokenCount &&
      universeProof.universeVerify?.ok,
  );

  const nextLabel = useMemo(() => {
    const next = progress.lifecycle?.nextState;
    if (!next || !resolved || terminal) return null;
    const mins = progress.lifecycle?.minutesToNext;
    return `${lifecycleLabel(lifecycleState(next))}${typeof mins === 'number' ? ` in ${mins}m` : ''}`;
  }, [progress.lifecycle?.nextState, progress.lifecycle?.minutesToNext, resolved, terminal]);

  return (
    <section
      className={`rounded-lg border border-border/60 bg-card/60 p-3 ${className ?? ''}`}
      aria-label="Market Watch engine status"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Phase / lifecycle state */}
        <div className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${toneOf(state, liveCount, terminal)}`}>
          <Activity className="h-4 w-4" aria-hidden />
          <div className="leading-tight">
            <div className="text-[10px] uppercase tracking-wide opacity-80">Engine Phase</div>
            <div className="text-sm font-semibold">
              {loading ? 'Reading engine…' : unknown ? 'Waiting for engine' : lifecycleLabel(state)}
            </div>
          </div>
        </div>

        {/* Lifecycle rail — position only, never a client-side transition */}
        {!unknown ? (
          <ol className="flex flex-wrap items-center gap-1" aria-label="Lifecycle progress">
            {LIFECYCLE_STATES.map((s, i) => {
              const done = activeIndex > i;
              const current = i === activeIndex;
              return (
                <li
                  key={s}
                  title={lifecycleLabel(s)}
                  aria-current={current ? 'step' : undefined}
                  className={[
                    'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                    current
                      ? 'bg-primary text-primary-foreground'
                      : done
                        ? 'bg-emerald-500/15 text-emerald-300/90'
                        : 'bg-muted/60 text-muted-foreground/60',
                  ].join(' ')}
                >
                  {lifecycleLabel(s)}
                </li>
              );
            })}
          </ol>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {error ? (
            <span className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-300">
              Progress read failed: {error}
            </span>
          ) : null}
          {resolved ? (
            <span className="rounded border border-border/60 px-2 py-0.5">
              since {lifecycleChangedAtLabel(progress.lifecycle?.changedAt) ?? '—'}
              {progress.lifecycle?.previousState
                ? ` · was ${lifecycleLabel(lifecycleState(progress.lifecycle.previousState))}`
                : ''}
            </span>
          ) : null}
          {nextLabel ? <span className="rounded border border-border/60 px-2 py-0.5">Next: {nextLabel}</span> : null}
          <span
            className={`flex items-center gap-1 rounded border px-2 py-0.5 ${
              connected ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300'
            }`}
            title={connected ? 'Realtime connected' : 'Realtime disconnected — REST polling only'}
          >
            {connected ? <Signal className="h-3 w-3" aria-hidden /> : <Radio className="h-3 w-3" aria-hidden />}
            {connected ? 'Realtime' : 'Polling only'}
          </span>
          <span
            className={`rounded border px-2 py-0.5 ${
              monitoring && liveCount > 0 ? 'border-emerald-500/40 text-emerald-300' : 'border-border/60'
            }`}
          >
            {monitoring && liveCount > 0 ? 'Data active' : terminal ? 'Engine stopped' : 'Not data-active'}
          </span>
        </div>
      </div>

      {/* Real engine counters */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Count icon={Layers} label="Universe" value={universe?.total} />
        <Count icon={ListChecks} label="Eligible" value={progress.lifecycle?.eligibleCount ?? universe?.eligible} />
        <Count icon={Signal} label="Subscribed" value={progress.subscribed ?? progress.lifecycle?.subscribedCount} />
        <Count icon={Gauge} label="Priced" value={progress.withLivePrice} hint={liveCount ? `${liveCount} LIVE` : undefined} />
        <Count icon={TrendingUp} label="Gainers" value={gainers} />
        <Count icon={TrendingDown} label="Losers" value={losers} />
        <Count icon={Minus} label="Unchanged" value={unchanged} />
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Feed <span className="font-mono">{progress.feedState ?? '—'}</span>
        {' · '}universe state <span className="font-mono">{progress.lifecycle?.universeState ?? '—'}</span>
        {' · '}index <span className="font-mono">v{progress.indexVersion ?? '—'}</span>
        {progress.generatedAt ? ` · generated ${progress.generatedAt}` : ''}
        {resolved ? '' : ' · engine has not reported a lifecycle state yet'}
      </p>

      {/* doc §2/§7/§30 — "locked list = intended Market Watch subscription list".
          Three backend-reported numbers side by side: if they agree, membership
          came from the Saturday lock and nothing was added behind its back. If
          they disagree, say so here instead of letting the page imply the rule
          is holding. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-[11px]">
        {universeProofError ? (
          <span className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
            <ShieldAlert className="h-3 w-3" aria-hidden />
            Weekly lock unreadable — {universeProofError}
          </span>
        ) : !universeProof ? (
          <span className="rounded border border-border/60 px-2 py-0.5 text-muted-foreground">Reading weekly lock…</span>
        ) : universeProof.locked ? (
          <>
            <span className="flex items-center gap-1.5 rounded border border-border/60 px-2 py-0.5">
              <Lock className="h-3 w-3" aria-hidden />
              Week <span className="font-mono">{universeProof.locked.weekId}</span> v
              <span className="font-mono">{universeProof.locked.version}</span> · {universeProof.locked.status}
            </span>
            <span
              className={`flex items-center gap-1.5 rounded border px-2 py-0.5 ${
                universeProofVerifyOk
                  ? 'border-emerald-500/40 text-emerald-300'
                  : 'border-red-500/40 text-red-300'
              }`}
              title="doc §30 — locked list vs. engine universe vs. broker subscription count"
            >
              {universeProofVerifyOk ? <ShieldCheck className="h-3 w-3" aria-hidden /> : <ShieldAlert className="h-3 w-3" aria-hidden />}
              Locked <span className="font-mono">{universeProof.locked.symbolCount}</span>
              {' · '}universe <span className="font-mono">{universeProof.engineUniverseSize}</span>
              {' · '}subscribed <span className="font-mono">{universeProof.subscribedTokenCount}</span>
            </span>
            {!universeProofVerifyOk && universeProof.universeVerify?.reason ? (
              <span className="rounded border border-red-500/40 px-2 py-0.5 text-red-300">
                {universeProof.universeVerify.reason}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              effective {universeProof.locked.effectiveFrom?.slice(0, 10) ?? '—'} →{' '}
              {universeProof.locked.effectiveTo?.slice(0, 10) ?? '—'}
              {universeProof.locked.lockedBy ? ` · locked by ${universeProof.locked.lockedBy}` : ''}
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
            <ShieldAlert className="h-3 w-3" aria-hidden />
            No locked universe — Market Watch is monitoring an empty set until the Saturday review locks one
          </span>
        )}
      </div>
    </section>
  );
}
