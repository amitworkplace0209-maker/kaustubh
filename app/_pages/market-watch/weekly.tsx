'use client';

/**
 * Weekly Review tab — docs/engines/MARKET_WATCH.md §4, §5, §6, §7, §30, §32, §33.
 *
 * This is the ONLY place weekly membership can change, and it does so by
 * calling the backend commands — never by editing a list locally.
 *
 *   Saturday:  REVIEW -> REPORT -> ADD / REMOVE / KEEP -> LOCK
 *   Mon-Fri:   the locked list is read-only here.
 *
 * doc §24 compliance: every number shown comes from the backend report. The tab
 * performs no market arithmetic — the ₹800 counters, circuit distances, margin
 * multipliers and recommendations are all server-computed and merely rendered.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock, RefreshCw, Lock, LockOpen, Plus, Minus, Check,
  AlertTriangle, FileText, ShieldCheck, Gauge, Play, Download,
} from 'lucide-react';
import {
  MwReviewAction,
  MwWeeklyReport,
  MwWeeklyReportRow,
  MwWeeklyResponse,
  DASH,
  fetchJson,
  fetchWeekly,
  fetchWeeklyReport,
  fetchObservability,
  lockWeeklyUniverse,
  recordWeeklyDecision,
  runFridayScan,
  runWeeklyScan,
  seedWeeklyDraft,
  fmtInt,
  fmtNum,
  fmtPct,
  toneClass,
} from './mw-shared';
import {
  getRealtimeConnectionState, subscribeRealtime,
} from '@/lib/realtime-store';

type Phase = 'loading' | 'scan' | 'review' | 'locked' | 'error';

const RECOMMENDATION_TONE: Record<string, string> = {
  ADD: 'text-emerald-500',
  REMOVE: 'text-red-500',
  KEEP: 'text-muted-foreground',
  REVIEW: 'text-amber-500',
};

export default function WeeklyTab() {
  const [weekly, setWeekly] = useState<MwWeeklyResponse | null>(null);
  const [report, setReport] = useState<MwWeeklyReport | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lockedBy, setLockedBy] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [reportFilter, setReportFilter] = useState<string>('');
  const [reportWeek, setReportWeek] = useState<string>('');
  const [reportOptions, setReportOptions] = useState<{ weekId: string; generatedAt?: string; reviewed?: number }[]>([]);
  const [recFilter, setRecFilter] = useState<string>('ALL');
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchWeekly();
      setWeekly(data);
      setError(null);
      // doc §2 — the review works on the UPCOMING week. ``locked`` describes the
      // week the engine is running RIGHT NOW (which is normally already locked),
      // so keying the phase off it wrongly reported the pending review as frozen
      // and hid every review command. Only the TARGET week being locked means
      // there is nothing left to decide.
      const targetLocked = data.targetWeekLocked ?? (data.weekId === data.locked?.weekId);
      setPhase(targetLocked ? 'locked' : data.draft ? 'review' : 'scan');
      setLockedBy((prev) => prev || data.config?.lockDefaultUser || '');
      // The report describes the week that FINISHED, which is not the target
      // week — reading ``weekId`` here would always look for a report that
      // cannot exist yet. If that week has no stored report (normal until the
      // report job runs), fall back to the newest report the backend DOES have
      // instead of pretending nothing exists anywhere.
      const wanted = data.reportWeekId ?? data.weekId;
      let options: { weekId: string; generatedAt?: string; reviewed?: number }[] = [];
      try {
        const listed = await fetchJson<{ reports?: { weekId: string; generatedAt?: string; counts?: { reviewed?: number } }[] }>(
          '/api/market-watch/weekly/reports?limit=12',
        );
        options = (listed.reports ?? []).map((r) => ({
          weekId: r.weekId,
          generatedAt: r.generatedAt,
          reviewed: r.counts?.reviewed,
        }));
      } catch {
        // The stored-report index is best-effort; the direct read below still runs.
      }
      setReportOptions(options);
      let resolved = wanted;
      let stored = await fetchWeeklyReport(wanted);
      if (!stored.report) {
        const latest = options[0]?.weekId;
        if (latest && latest !== wanted) {
          resolved = latest;
          stored = await fetchWeeklyReport(latest);
        }
      }
      setReport(stored.report ?? null);
      setReportWeek(resolved);
      setLastLoadedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'weekly unavailable');
      setPhase('error');
    }
  }, []);

  const selectReportWeek = useCallback(async (id: string) => {
    if (!id) return;
    setBusy('report');
    setNotice(null);
    try {
      const stored = await fetchWeeklyReport(id);
      setReport(stored.report ?? null);
      setReportWeek(id);
      setNotice(stored.report ? `Showing stored report ${id}.` : `No stored report exists for ${id}.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not load weekly report');
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While the Friday scan is in flight, poll the same backend-owned weekly
  // payload so the phase rail and the last outcome update without a reload.
  useEffect(() => {
    // The local busy flag covers the window between the click and the first
    // /weekly response that reports ``running``. Without it the rail would sit
    // idle for the whole request even though the scan is already in flight.
    if (!weekly?.fridayScan?.running && busy !== 'friday-scan') return;
    const id = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(id);
  }, [weekly?.fridayScan?.running, busy, load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(null);
    }
  };

  const onScan = () =>
    run('scan', async () => {
      const res = await runWeeklyScan();
      // The scan endpoint returns the freshly built rows; re-reading the stored
      // report afterwards keeps this tab on the SAME payload the backend
      // persisted, so what is displayed is what was saved.
      if (res.persisted) {
        const stored = await fetchWeeklyReport(res.weekId);
        setReport(stored.report ?? null);
      } else {
        setReport((prev) => prev);
      }
      setNotice(
        res.persisted
          ? `Weekly report generated and stored for ${res.weekId} (${res.counts?.reviewed ?? 0} symbols).`
          : 'Report built but NOT stored — the DB Writer is unavailable. Nothing was written directly, so reload will not find it.',
      );
    });

  // Friday 15:25 — the backend-owned full-universe screen. Running it on
  // demand is allowed on any day, but it changes the ACTIVE universe, so it is
  // never fired implicitly by this page.
  const onFridayScan = () => {
    const confirmed = window.confirm(
      'Run the full-universe Friday scan now?\n\n' +
        'It screens every NSE equity for intraday eligibility, LTP below the cap and the required margin ' +
        'multiplier, then LOCKS and subscribes the survivors for the upcoming week. The active universe ' +
        'is replaced immediately.',
    );
    if (!confirmed) return;
    return run('friday-scan', async () => {
      const res = await runFridayScan();
      if (!res.ok) {
        setNotice(
          `${res.reason ?? 'SCAN REFUSED'}${res.detail ? `: ${res.detail}` : ''}` +
            (res.message ? ` — ${res.message}` : ''),
        );
        return;
      }
      setNotice(
        `${res.message ?? 'Friday scan completed.'} ` +
          `(${res.scan?.candidates ?? 0} candidates, ${res.scan?.priced ?? 0} priced, ` +
          `${res.scan?.rejectedCount ?? 0} rejected by the screen.)`,
      );
    });
  };

  // doc §2 — every review command targets the UPCOMING week. ``targetWeekId``
  // is resolved by the backend so the UI never computes an ISO week itself.
  const targetWeekId = weekly?.targetWeekId ?? weekly?.weekId ?? '';

  const onDecide = (symbol: string, action: MwReviewAction) =>
    run(`decide:${symbol}`, async () => {
      const res = await recordWeeklyDecision(targetWeekId, symbol, action, { by: lockedBy || undefined });
      if (!res.ok) {
        setNotice(`${res.reason ?? 'REJECTED'}${res.detail ? `: ${res.detail}` : ''}`);
        return;
      }
      setNotice(`${action} recorded for ${symbol} in ${targetWeekId}.`);
    });

  const onSeed = () =>
    run('seed', async () => {
      const res = await seedWeeklyDraft(targetWeekId);
      setNotice(res.ok ? `Draft for ${targetWeekId} seeded from the previous lock.` : (res.reason ?? 'could not seed draft'));
    });

  const onLock = () =>
    run('lock', async () => {
      const res = await lockWeeklyUniverse(targetWeekId, { by: lockedBy || undefined });
      if (!res.ok) {
        setNotice(`${res.reason ?? 'LOCK REFUSED'}${res.detail ? `: ${res.detail}` : ''}`);
        return;
      }
      setNotice(
        `Week ${res.weekId} LOCKED at version ${res.version} with ${res.symbolCount} symbols. Membership is now frozen.`,
      );
    });

  const weekId = targetWeekId;
  const isLocked = phase === 'locked';
  const reportWeekId = weekly?.reportWeekId ?? '';
  const decisions = useMemo(() => weekly?.decisions ?? {}, [weekly?.decisions]);
  const draftSymbols = useMemo(() => new Set(weekly?.draftSymbols ?? []), [weekly?.draftSymbols]);
  const verify = weekly?.verify;
  const engineVerify = weekly?.engine?.universeVerify;
  const friday = weekly?.fridayScan;
  const fridayLast = friday?.lastScan;
  const scanBusy = busy === 'friday-scan' || Boolean(friday?.running);

  const reportRows = useMemo(() => report?.rows ?? [], [report?.rows]);

  const recCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: reportRows.length };
    for (const r of reportRows) {
      const key = r.recommendation ?? 'REVIEW';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [reportRows]);

  const rows = useMemo(() => {
    let filtered = reportRows;
    if (reportFilter) {
      const q = reportFilter.toUpperCase();
      filtered = filtered.filter((r) =>
        r.symbol.toUpperCase().includes(q) ||
        String(r.companyName ?? '').toUpperCase().includes(q),
      );
    }
    if (recFilter !== 'ALL') {
      filtered = filtered.filter((r) => (r.recommendation ?? 'REVIEW') === recFilter);
    }
    if (!onlyChanged) return filtered;
    // "Changed only" = the operator actually recorded a decision this week, or
    // the report recommended a change. Read from the backend, never guessed.
    return filtered.filter((r) => decisions[r.symbol] || (r.recommendation === 'ADD' || r.recommendation === 'REMOVE'));
  }, [reportRows, reportFilter, recFilter, onlyChanged, decisions]);

  const exportReportCsv = useCallback(() => {
    if (!rows.length) return;
    const header = [
      'symbol', 'company', 'latest_ltp', 'weekly_min', 'weekly_max', 'weekly_change_pct',
      'above_threshold', 'below_threshold', 'circuit_distance_pct', 'margin_status',
      'margin_multiplier', 'data_completeness', 'recommendation', 'decision',
    ];
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = rows.map((r) => [
      r.symbol, r.companyName, r.latestLtp, r.weeklyMinLtp, r.weeklyMaxLtp,
      r.weeklyChangePercent, r.observationsAboveThreshold, r.observationsAtOrBelowThreshold,
      r.minCircuitDistancePct, r.marginStatus, r.marginMultiplier, r.dataCompleteness,
      r.recommendation, decisions[r.symbol]?.action ?? '',
    ].map(escape).join(','));
    const blob = new Blob([[header.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weekly-report-${report?.weekId ?? reportWeek ?? 'latest'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows, decisions, report?.weekId, reportWeek]);

  if (phase === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-28 animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl border border-border/60 bg-muted/30" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-xl border border-border/60 bg-muted/20" />
        <p className="text-center text-xs text-muted-foreground">
          Loading weekly universe and the newest stored report…
        </p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-6">
        <h3 className="flex items-center gap-2 font-semibold text-red-300">
          <AlertTriangle className="h-4 w-4" aria-hidden /> Weekly universe unavailable
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <button onClick={() => void load()} className="mt-3 text-xs underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ---- Universe command center (doc §4, §6, §28) --------------- */}
      <section className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-card via-card to-muted/30 shadow-sm">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(760px_240px_at_0%_0%,hsl(var(--primary)/0.12),transparent_62%),radial-gradient(620px_220px_at_100%_0%,rgba(16,185,129,0.08),transparent_60%)]"
        />
        <div className="relative p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                <CalendarClock className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold tracking-tight">Universe command center</h2>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${
                      isLocked
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300'
                    }`}
                  >
                    {isLocked ? 'Locked' : 'Open review'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Week <span className="font-mono font-semibold text-foreground">{weekId}</span>
                  <span className="mx-1.5 text-border">·</span>
                  report <span className="font-mono">{reportWeekId || DASH}</span>
                  {weekly?.nextReviewAt ? (
                    <>
                      <span className="mx-1.5 text-border">·</span>
                      next review <span className="font-mono">{weekly.nextReviewAt}</span>
                    </>
                  ) : null}
                </p>
                <p className="mt-1 max-w-3xl text-[11px] text-muted-foreground">
                  {isLocked
                    ? 'The target week is locked. Review is read-only until the next cycle.'
                    : 'The Friday scan locks the upcoming week automatically. Manual review commands remain available until then.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-1">
                {isLocked ? <Lock className="h-3 w-3 text-emerald-500" /> : <LockOpen className="h-3 w-3 text-amber-500" />}
                {isLocked ? 'Target frozen' : 'Target editable'}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-1 text-muted-foreground">
                <ShieldCheck className="h-3 w-3" /> engine {engineVerify?.ok ? 'verified' : 'check'}
              </span>
              {lastLoadedAt ? (
                <span className="text-[10px] text-muted-foreground">
                  loaded {lastLoadedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Refresh weekly data"
              >
                <RefreshCw className="h-3 w-3" /> Refresh
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <CommandStat
              label="Target week"
              value={weekId || DASH}
              hint={isLocked ? 'locked for trading' : 'awaiting lock'}
              tone={isLocked ? 'success' : 'warning'}
              icon={CalendarClock}
            />
            <CommandStat
              label="Locked symbols"
              value={fmtInt(weekly?.locked?.symbolCount ?? null)}
              hint={weekly?.locked ? `v${weekly.locked.version} · ${weekly.locked.lockedBy ?? DASH}` : 'no lock yet'}
              tone="info"
              icon={Lock}
            />
            <CommandStat
              label="Engine resolved"
              value={fmtInt(weekly?.engine?.symbolCount ?? null)}
              hint={engineVerify?.ok ? 'matches locked list' : 'verification needed'}
              tone={engineVerify?.ok ? 'success' : 'warning'}
              icon={Gauge}
            />
            <CommandStat
              label="Next scan"
              value={friday?.scanHhmm ?? '15:25'}
              hint={friday?.nextTargetWeekId ?? 'target pending'}
              tone="neutral"
              icon={Play}
            />
          </div>

          {/* Verification verdict (doc §28 step 2) — shown honestly, never repaired. */}
          {(verify || engineVerify) && (
            <div
              className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
                (engineVerify?.ok ?? verify?.ok)
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
              }`}
            >
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <p>
                {engineVerify?.ok ? (
                  <>
                    Locked week verified: <span className="font-mono">{engineVerify.loadedWeekId}</span> v
                    <span className="font-mono">{engineVerify.version}</span> — the monitored universe equals the locked
                    list.
                  </>
                ) : (
                  <>
                    Not verifiable: <span className="font-mono">{engineVerify?.reason ?? verify?.reason ?? 'UNKNOWN'}</span>
                    {engineVerify?.expectedWeekId ? ` (expected ${engineVerify.expectedWeekId})` : ''}
                    {engineVerify?.loadedWeekId ? `, loaded ${engineVerify.loadedWeekId}` : ''}. The engine is not
                    substituting a wider universe.
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ---- Friday universe scan (doc §2) ----------------------------- */}
      <section className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 bg-muted/20 px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
              <CalendarClock className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                Friday universe scan
                <span className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                  {friday?.scanHhmm ?? '15:25'} IST
                </span>
              </h3>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Full NSE EQ screen · target <span className="font-mono">{friday?.nextTargetWeekId ?? weekId ?? DASH}</span>
                <span className="mx-1.5 text-border">·</span>
                next run <span className="font-mono">{friday?.nextScanAt ?? DASH}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium ${
                scanBusy
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300'
                  : fridayLast?.reason
                    ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300'
                    : fridayLast
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                      : 'border-border/60 bg-background/60 text-muted-foreground'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${scanBusy ? 'animate-pulse bg-amber-500' : fridayLast?.reason ? 'bg-red-500' : fridayLast ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />
              {scanBusy ? 'Running' : fridayLast?.reason ? 'Attention' : fridayLast ? 'Complete' : 'Ready'}
            </span>
            <button
              onClick={onFridayScan}
              disabled={scanBusy || isLocked}
              title={isLocked ? 'Target week is already locked — the scan refuses to overwrite it.' : undefined}
              className="flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {scanBusy
                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
                : <Play className="h-3.5 w-3.5" aria-hidden />}
              {scanBusy ? 'Scanning…' : 'Run scan now'}
            </button>
          </div>
        </header>

        <div className="p-4">
          <div className="grid gap-2 sm:grid-cols-3">
            <ScanRule icon={ShieldCheck} label="Eligibility" value="Intraday eligible" detail="NSE EQ instruments only" />
            <ScanRule icon={Gauge} label="Price cap" value={`LTP < ₹${fmtNum(friday?.priceCap ?? 800, 0)}`} detail="Strictly below the cap" />
            <ScanRule icon={Check} label="Margin" value={`≥ ${fmtNum(friday?.marginMultiplierThreshold ?? 5, 1)}x`} detail="Broker-confirmed multiplier" />
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[0.95fr_1.05fr]">
            <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Execution path</p>
                <span className="text-[10px] text-muted-foreground">4 stages</span>
              </div>
              <ScanFlow running={scanBusy} last={fridayLast ?? null} />
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Last outcome</p>
                {fridayLast?.atIso && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {new Date(fridayLast.atIso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                  </span>
                )}
              </div>
              {fridayLast ? (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] sm:grid-cols-4">
                    <Outcome label="Selected" value={fmtInt(fridayLast.symbols ?? null)} />
                    <Outcome label="Week" value={fridayLast.targetWeekId ?? DASH} mono />
                    <Outcome label="Version" value={fmtInt(fridayLast.version ?? null)} />
                    <Outcome label="Trigger" value={fridayLast.trigger ?? DASH} />
                  </div>
                  {fridayLast.reason ? (
                    <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                      {fridayLast.reason}
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                      Survivors locked and queued for a no-expiry Session Manager subscription.
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {scanBusy
                    ? 'Scanning the full NSE EQ universe now. The outcome and locked week will appear here when it finishes.'
                    : 'No scan recorded in this process. The schedule above still runs automatically on the next trading Friday.'}
                </p>
              )}
            </div>
          </div>

          <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
            A manual run is allowed on any day and replaces the active universe immediately. If the target week is
            already LOCKED, the scan refuses to overwrite it (doc §33). Zero survivors keep the previous universe and
            record <span className="font-mono">NO_SYMBOLS_SELECTED</span>.
          </p>
        </div>
      </section>

      {/* ---- Operator review (doc §32) -------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-muted/20 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ShieldCheck className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h3 className="text-sm font-semibold">Operator review</h3>
              <p className="text-[11px] text-muted-foreground">
                Manual commands target <span className="font-mono">{weekId || DASH}</span> · draft{' '}
                <span className="font-mono">{draftSymbols.size}</span> symbols
              </p>
            </div>
          </div>
          <span className={`rounded-full border px-2 py-1 text-[10px] font-medium ${isLocked ? 'border-border/60 text-muted-foreground' : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300'}`}>
            {isLocked ? 'Read-only' : 'Commands available'}
          </span>
        </header>

        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <button
            onClick={onScan}
            disabled={busy === 'scan'}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy === 'scan' ? 'animate-spin' : ''}`} aria-hidden />
            Run weekly report scan
          </button>
          {!isLocked && (
            <>
              <button
                onClick={onSeed}
                disabled={busy === 'seed'}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Seed draft from last lock
              </button>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                Locked by
                <input
                  value={lockedBy}
                  onChange={(e) => setLockedBy(e.target.value)}
                  placeholder="operator"
                  className="w-28 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                />
              </label>
              <button
                onClick={onLock}
                disabled={busy === 'lock' || draftSymbols.size === 0}
                className="flex items-center gap-1.5 rounded-lg border border-emerald-600/50 bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-emerald-600/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Lock className="h-3.5 w-3.5" aria-hidden />
                Lock {draftSymbols.size} symbols
              </button>
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/40 px-4 py-2 text-[10px] text-muted-foreground">
          <span>Threshold ₹{fmtNum(weekly?.config?.rupeeThreshold, 0)}</span>
          <span>Danger circuit {fmtNum(weekly?.config?.dangerCircuitPct, 1)}%</span>
          <span>1% mover ±{fmtNum(weekly?.config?.moverThresholdPct, 1)}%</span>
          <span>Margin ≥ {fmtNum(weekly?.config?.marginMultiplierThreshold, 1)}x</span>
        </div>

        {notice && (
          <div className="border-t border-border/40 bg-muted/20 px-4 py-2.5">
            <p className="text-[11px] text-muted-foreground">{notice}</p>
          </div>
        )}
      </section>

      {/* ---- Observability (doc §30) --------------------------------- */}
      <ObservabilityStrip />

      {/* ---- Weekly report (doc §5) ----------------------------------- */}
      <section className="rounded-lg border border-border/60 bg-card/60">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4" aria-hidden /> Weekly report
            {report && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {report.weekStart} → {report.weekEnd}
              </span>
            )}
            {reportOptions.length > 0 && (
              <select
                value={reportWeek}
                onChange={(e) => void selectReportWeek(e.target.value)}
                disabled={busy === 'report'}
                className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-normal text-foreground"
                aria-label="Stored weekly report week"
              >
                {reportOptions.map((o) => (
                  <option key={o.weekId} value={o.weekId}>
                    {o.weekId}{o.reviewed != null ? ` · ${o.reviewed} rows` : ''}
                  </option>
                ))}
              </select>
            )}
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {report && (
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <Chip label="Reviewed" value={fmtInt(report.counts?.reviewed ?? null)} />
                <Chip label="With data" value={fmtInt(report.counts?.withData ?? null)} tone="success" />
                <Chip label="No data" value={fmtInt(report.counts?.withoutData ?? null)} tone="warning" />
                <Chip label="Adv ADD" value={fmtInt(report.counts?.recommendAdd ?? null)} tone="success" />
                <Chip label="Adv REMOVE" value={fmtInt(report.counts?.recommendRemove ?? null)} tone="danger" />
              </div>
            )}
            {report && (
              <button
                type="button"
                onClick={exportReportCsv}
                className="inline-flex items-center gap-1 rounded border border-border/60 bg-background/60 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                title="Download the currently filtered report rows as CSV"
              >
                <Download className="h-3 w-3" /> CSV
              </button>
            )}
          </div>
          {report && reportWeek && reportWeek !== reportWeekId ? (
            <p className="w-full text-[10px] text-amber-600 dark:text-amber-400">
              {reportWeekId || 'The current report week'} has no stored report yet — showing the newest stored
              report <span className="font-mono">{reportWeek}</span>.
            </p>
          ) : null}
        </header>

        {!report ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No weekly report yet. Run the weekly scan to build one from Monday-Friday saved data.
          </p>
        ) : (
          <>
            {report.notes?.length ? (
              <ul className="space-y-0.5 border-b border-border/50 px-4 py-2 text-[11px] text-muted-foreground">
                {report.notes.map((n) => (
                  <li key={n}>• {n}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 border-b border-border/50 px-4 py-2 text-xs">
              <input
                value={reportFilter}
                onChange={(e) => setReportFilter(e.target.value)}
                placeholder="Filter symbol / company…"
                className="w-44 rounded border border-border bg-background px-2 py-1 text-xs"
              />
              <div className="flex flex-wrap items-center gap-1">
                {(['ALL', 'ADD', 'REMOVE', 'KEEP', 'REVIEW'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setRecFilter(key)}
                    className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                      recFilter === key
                        ? 'border-primary bg-primary/10 font-medium text-primary'
                        : 'border-border/60 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {key} {recCounts[key] ?? 0}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={onlyChanged}
                  onChange={(e) => setOnlyChanged(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Only decided / recommended-change rows
              </label>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {rows.length} of {report.rows?.length ?? 0} rows
              </span>
            </div>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-card text-left text-[10px] uppercase tracking-wide text-muted-foreground shadow-sm">
                  <tr>
                    <th className="px-3 py-2 font-medium">Symbol</th>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 text-right font-medium">Latest</th>
                    <th className="px-3 py-2 text-right font-medium">Wk min</th>
                    <th className="px-3 py-2 text-right font-medium">Wk max</th>
                    <th className="px-3 py-2 text-right font-medium">Wk chg %</th>
                    <th className="px-3 py-2 text-right font-medium" title="Observations above / at-or-below the threshold (doc §16)">
                      ≥₹ / ≤₹
                    </th>
                    <th className="px-3 py-2 text-right font-medium" title="Minimum valid circuit distance (doc §14)">
                      Circ dist
                    </th>
                    <th className="px-3 py-2 text-right font-medium" title="Authoritative broker margin (doc §17)">
                      Margin
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Mult</th>
                    <th className="px-3 py-2 text-right font-medium">Complete</th>
                    <th className="px-3 py-2 font-medium">Advised</th>
                    <th className="px-3 py-2 text-center font-medium">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <ReportRow
                      key={row.symbol}
                      row={row}
                      locked={isLocked}
                      busy={busy === `decide:${row.symbol}`}
                      decision={decisions[row.symbol]?.action ?? null}
                      onDecide={onDecide}
                    />
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={13} className="px-3 py-6 text-center text-muted-foreground">
                        No rows match the current filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* ---- Lock history (doc §6 audit trail) ----------------------- */}
      {weekly?.history?.length ? (
        <section className="rounded-lg border border-border/60 bg-card/60">
          <header className="border-b border-border/60 px-4 py-2.5">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Gauge className="h-4 w-4" aria-hidden /> Lock history
            </h3>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Week</th>
                  <th className="px-3 py-2 text-right font-medium">Version</th>
                  <th className="px-3 py-2 text-right font-medium">Symbols</th>
                  <th className="px-3 py-2 text-right font-medium">+ / − / =</th>
                  <th className="px-3 py-2 font-medium">Locked at</th>
                  <th className="px-3 py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody>
                {weekly.history.map((h, i) => (
                  <tr key={`${h.weekId}-${h.version}-${i}`} className="border-t border-border/40">
                    <td className="px-3 py-1.5 font-mono">{h.weekId}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{h.version}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{h.symbolCount}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                      {h.addedCount} / {h.removedCount} / {h.keptCount}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[11px]">{h.lockedAt ?? DASH}</td>
                    <td className="px-3 py-1.5 font-mono text-[11px]">{h.lockedBy ?? DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function CommandStat({
  label,
  value,
  hint,
  tone = 'neutral',
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'success' | 'warning' | 'info' | 'neutral';
  icon: React.ElementType;
}) {
  const color =
    tone === 'success'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warning'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'info'
          ? 'text-sky-600 dark:text-sky-400'
          : 'text-muted-foreground';
  return (
    <div className="rounded-xl border border-border/60 bg-background/70 p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
        <Icon className={`h-3.5 w-3.5 ${color}`} aria-hidden />
      </div>
      <p className="mt-1 font-mono text-lg font-bold tabular-nums text-foreground">{value}</p>
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function ScanRule({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <div>
        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
        <p className="text-xs font-semibold">{value}</p>
        <p className="text-[10px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function ScanFlow({ running, last }: { running: boolean; last: Record<string, unknown> | null }) {
  const done = Boolean(last && !last.reason);
  const error = Boolean(last?.reason);
  const steps = [
    { label: 'Screen', detail: 'NSE EQ · intraday · price · margin' },
    { label: 'Lock', detail: 'Freeze upcoming week' },
    { label: 'Subscribe', detail: 'Session Manager · no expiry' },
    { label: 'Live', detail: 'WS ticks → DB Writer' },
  ];
  return (
    <div className="mt-3 grid grid-cols-4 gap-1.5">
      {steps.map((step, i) => {
        const state = done ? 'done' : running ? (i === 0 ? 'active' : 'pending') : error ? (i === 0 ? 'error' : 'pending') : 'idle';
        const bar =
          state === 'done'
            ? 'bg-emerald-500'
            : state === 'active'
              ? 'animate-pulse bg-amber-500'
              : state === 'error'
                ? 'bg-red-500'
                : 'bg-muted-foreground/20';
        const text =
          state === 'done'
            ? 'text-emerald-600 dark:text-emerald-400'
            : state === 'active'
              ? 'text-amber-600 dark:text-amber-400'
              : state === 'error'
                ? 'text-red-600 dark:text-red-400'
                : 'text-muted-foreground';
        return (
          <div key={step.label}>
            <div className={`h-1 rounded-full ${bar}`} />
            <p className={`mt-1.5 text-[10px] font-medium ${text}`}>{step.label}</p>
            <p className="text-[9px] leading-tight text-muted-foreground">{step.detail}</p>
          </div>
        );
      })}
    </div>
  );
}

function Outcome({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className={`text-xs ${mono ? 'font-mono' : 'font-semibold'}`}>{value}</p>
    </div>
  );
}

function Chip({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' | 'warning' | 'info' }) {
  const color =
    tone === 'success'
      ? 'text-emerald-500'
      : tone === 'danger'
        ? 'text-red-500'
        : tone === 'warning'
          ? 'text-amber-500'
          : tone === 'info'
            ? 'text-sky-500'
            : 'text-muted-foreground';
  return (
    <span className="rounded border border-border/60 bg-background/60 px-1.5 py-0.5">
      <span className="text-muted-foreground">{label} </span>
      <span className={`font-mono ${color}`}>{value}</span>
    </span>
  );
}

function ReportRow({
  row,
  locked,
  busy,
  decision,
  onDecide,
}: {
  row: MwWeeklyReportRow;
  locked: boolean;
  busy: boolean;
  decision: MwReviewAction | null;
  onDecide: (symbol: string, action: MwReviewAction) => void;
}) {
  return (
    <tr className="border-t border-border/40 hover:bg-accent/30">
      <td className="px-3 py-1.5 font-mono font-medium">{row.symbol}</td>
      <td className="max-w-[160px] truncate px-3 py-1.5 text-muted-foreground" title={row.companyName ?? ''}>
        {row.companyName ?? DASH}
      </td>
      <td className="px-3 py-1.5 text-right font-mono">{fmtNum(row.latestLtp)}</td>
      <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtNum(row.weeklyMinLtp)}</td>
      <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtNum(row.weeklyMaxLtp)}</td>
      <td className={`px-3 py-1.5 text-right font-mono ${toneClass((row.weeklyChangePercent ?? 0) > 0 ? 'LIVE' : (row.weeklyChangePercent ?? 0) < 0 ? 'DANGER' : 'NORMAL')}`}>
        {fmtPct(row.weeklyChangePercent)}
      </td>
      <td className="px-3 py-1.5 text-right font-mono text-[11px] text-muted-foreground" title={`Threshold ₹${row.threshold ?? DASH}`}>
        {row.observationsAboveThreshold ?? DASH} / {row.observationsAtOrBelowThreshold ?? DASH}
      </td>
      <td className="px-3 py-1.5 text-right font-mono">
        {row.minCircuitDistancePct != null ? `${fmtNum(row.minCircuitDistancePct)}%` : DASH}
        {row.circuitDangerObservations ? (
          <span className="ml-1 text-[10px] text-red-500">({row.circuitDangerObservations}d)</span>
        ) : null}
      </td>
      <td className="px-3 py-1.5 text-right font-mono">
        {row.marginValue != null ? `₹${fmtInt(row.marginValue)}` : DASH}
      </td>
      <td className="px-3 py-1.5 text-right font-mono">{row.marginMultiplier != null ? `${fmtNum(row.marginMultiplier)}x` : DASH}</td>
      <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
        {row.dataCompleteness != null ? `${Math.round(row.dataCompleteness * 100)}%` : DASH}
      </td>
      <td className={`px-3 py-1.5 font-mono text-[11px] ${RECOMMENDATION_TONE[row.recommendation ?? 'REVIEW'] ?? ''}`}>
        {row.recommendation ?? DASH}
      </td>
      <td className="px-3 py-1.5">
        {locked ? (
          <span className="text-[11px] text-muted-foreground">{decision ?? DASH}</span>
        ) : (
          <div className="flex items-center justify-center gap-1">
            <button
              onClick={() => onDecide(row.symbol, 'ADD')}
              disabled={busy}
              title="ADD"
              className={`rounded border p-1 hover:bg-accent disabled:opacity-50 ${decision === 'ADD' ? 'border-emerald-500 bg-emerald-500/20' : 'border-border'}`}
            >
              <Plus className="h-3 w-3" aria-hidden />
            </button>
            <button
              onClick={() => onDecide(row.symbol, 'REMOVE')}
              disabled={busy}
              title="REMOVE"
              className={`rounded border p-1 hover:bg-accent disabled:opacity-50 ${decision === 'REMOVE' ? 'border-red-500 bg-red-500/20' : 'border-border'}`}
            >
              <Minus className="h-3 w-3" aria-hidden />
            </button>
            <button
              onClick={() => onDecide(row.symbol, 'KEEP')}
              disabled={busy}
              title="KEEP"
              className={`rounded border p-1 hover:bg-accent disabled:opacity-50 ${decision === 'KEEP' ? 'border-sky-500 bg-sky-500/20' : 'border-border'}`}
            >
              <Check className="h-3 w-3" aria-hidden />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

/** doc §30 — the tracking metrics, read straight from the backend. */
function ObservabilityStrip() {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchObservability>> | null>(null);
  const [socketUp, setSocketUp] = useState(false);
  useEffect(() => (
    subscribeRealtime(() => setSocketUp(getRealtimeConnectionState() === 'CONNECTED'))
  ), []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchObservability()
        .then((d) => alive && setData(d))
        .catch(() => {});
    void load();
    // The observability aggregation is not yet a WS document, so REST remains
    // its carrier — but only at the original 15s cadence while the socket is
    // down; a healthy socket reconciles the numbers every 60s instead.
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, socketUp ? 60000 : 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [socketUp]);

  const m = data?.metrics;
  if (!m) return null;
  return (
    <section className="rounded-lg border border-border/60 bg-card/60 px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Observability (doc §30)
      </h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4 lg:grid-cols-6">
        <Metric label="Locked universe" value={fmtInt(m.locked_universe_count)} />
        <Metric label="Active subs" value={fmtInt(m.active_subscription_count)} />
        <Metric label="Received ticks" value={fmtInt(m.received_tick_count)} />
        <Metric label="Validated" value={fmtInt(m.validated_tick_count)} />
        <Metric label="Invalid" value={fmtInt(m.invalid_tick_count)} tone={m.invalid_tick_count ? 'danger' : undefined} />
        <Metric label="DANGER" value={fmtInt(m.danger_count)} tone={m.danger_count ? 'danger' : undefined} />
        <Metric label="Intraday unavail" value={fmtInt(m.intraday_unavailable_count)} tone={m.intraday_unavailable_count ? 'warning' : undefined} />
        <Metric label="Gainers" value={fmtInt(m.top_gainers_count)} />
        <Metric label="Losers" value={fmtInt(m.top_losers_count)} />
        <Metric label="1% 1m" value={fmtInt(m.movers_1m_count)} />
        <Metric label="1% 5m" value={fmtInt(m.movers_5m_count)} />
        <Metric label="1% 10m" value={fmtInt(m.movers_10m_count)} />
        <Metric label="1% 30m" value={fmtInt(m.movers_30m_count)} />
        <Metric label="Process latency" value={m.processing_latency_ms != null ? `${fmtNum(m.processing_latency_ms, 1)}ms` : DASH} />
        <Metric label="Publish latency" value={m.publish_latency_ms != null ? `${fmtNum(m.publish_latency_ms, 1)}ms` : DASH} />
        <Metric label="WebSocket" value={m.websocket_status ?? DASH} tone={m.websocket_status === 'CONNECTED' ? 'success' : 'warning'} />
      </div>
      {m.invalid_tick_reasons && Object.keys(m.invalid_tick_reasons).length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Invalid reasons:{' '}
          {Object.entries(m.invalid_tick_reasons)
            .map(([k, v]) => `${k}=${v}`)
            .join(' · ')}
        </p>
      )}
      {m.weekly?.unresolvedSymbolCount ? (
        <p className="mt-1 text-[11px] text-amber-500">
          {m.weekly.unresolvedSymbolCount} locked symbol(s) not resolvable in the instrument master:{' '}
          {(m.weekly.unresolvedSymbols ?? []).slice(0, 12).join(', ')}
        </p>
      ) : null}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' | 'warning' }) {
  const color = tone === 'success' ? 'text-emerald-500' : tone === 'danger' ? 'text-red-500' : tone === 'warning' ? 'text-amber-500' : '';
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className={`font-mono ${color}`}>{value}</span>
    </div>
  );
}