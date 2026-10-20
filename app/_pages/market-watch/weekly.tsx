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
  AlertTriangle, FileText, ShieldCheck, Gauge, Play,
} from 'lucide-react';
import {
  MwReviewAction,
  MwWeeklyReport,
  MwWeeklyReportRow,
  MwWeeklyResponse,
  DASH,
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
      // cannot exist yet.
      const stored = await fetchWeeklyReport(data.reportWeekId ?? data.weekId);
      setReport(stored.report ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'weekly unavailable');
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const rows = useMemo(() => {
    const all = report?.rows ?? [];
    const filtered = reportFilter ? all.filter((r) => r.symbol.toUpperCase().includes(reportFilter.toUpperCase())) : all;
    if (!onlyChanged) return filtered;
    // "Changed only" = the operator actually recorded a decision this week, or
    // the report recommended a change. Read from the backend, never guessed.
    return filtered.filter((r) => decisions[r.symbol] || (r.recommendation === 'ADD' || r.recommendation === 'REMOVE'));
  }, [report?.rows, reportFilter, onlyChanged, decisions]);

  if (phase === 'loading') {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading weekly universe…</p>;
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
      {/* ---- Lock status (doc §6) ------------------------------------- */}
      <section className="rounded-lg border border-border/60 bg-card/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              {isLocked ? (
                <Lock className="h-4 w-4 text-emerald-500" aria-hidden />
              ) : (
                <LockOpen className="h-4 w-4 text-amber-500" aria-hidden />
              )}
              Reviewing week {weekId}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {isLocked ? (
                <>
                  LOCKED at version{' '}
                  <span className="font-mono">{weekly?.locked?.version ?? DASH}</span> with{' '}
                  <span className="font-mono">{weekly?.locked?.symbolCount ?? DASH}</span> symbols by{' '}
                  <span className="font-mono">{weekly?.locked?.lockedBy ?? DASH}</span>
                  {weekly?.locked?.lockedAt ? ` on ${weekly.locked.lockedAt}` : ''}. Membership is replaced by the
                  Friday scan; once locked, the Saturday review is read-only.
                </>
              ) : (
                <>
                  Not locked yet for <span className="font-mono">{weekId}</span> — the Friday scan normally locks
                  the upcoming week automatically. Until then the review below can still record decisions and lock
                  manually. The week the engine is running now is{' '}
                  <span className="font-mono">{weekly?.locked?.weekId ?? DASH}</span>
                  {weekly?.locked?.version ? ` v${weekly.locked.version}` : ''} with{' '}
                  <span className="font-mono">{weekly?.locked?.symbolCount ?? DASH}</span> symbols
                  {weekly?.config?.universeSource === 'LOCKED' && !weekly?.locked
                    ? '. Nothing is locked, so there is nothing to monitor.'
                    : '.'}
                </>
              )}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Report for the week that finished:{' '}
              <span className="font-mono">{reportWeekId || DASH}</span>
              {weekly?.nextReviewAt ? (
                <>
                  {' '}· next review{' '}
                  <span className="font-mono">{weekly.nextReviewAt}</span>
                </>
              ) : (
                ' · weekly review disabled'
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Chip label="Locked" value={fmtInt(weekly?.locked?.symbolCount ?? null)} />
            <Chip label="Added" value={fmtInt(weekly?.locked?.addedCount ?? null)} tone="success" />
            <Chip label="Removed" value={fmtInt(weekly?.locked?.removedCount ?? null)} tone="danger" />
            <Chip label="Kept" value={fmtInt(weekly?.locked?.keptCount ?? null)} />
            <Chip label="Engine resolved" value={fmtInt(weekly?.engine?.symbolCount ?? null)} tone="info" />
          </div>
        </div>

        {/* Verification verdict (doc §28 step 2) — shown honestly, never repaired. */}
        {(verify || engineVerify) && (
          <div
            className={`mt-3 rounded border px-3 py-2 text-xs ${
              (engineVerify?.ok ?? verify?.ok)
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
            }`}
          >
            <ShieldCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden />
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
          </div>
        )}

        {/* Friday 15:25 automatic universe refresh (doc §2). The schedule and
            every number below come from the backend; this page does not
            compute "next Friday" or re-run the screen locally. */}
        <div className="mt-4 rounded border border-border/60 bg-background/40 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                Friday universe scan
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal">
                  {friday?.scanHhmm ?? '15:25'} IST
                </span>
                {friday?.running && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-normal text-amber-400">
                    scanning…
                  </span>
                )}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Screens every NSE EQ for intraday eligibility, LTP below ₹
                {fmtNum(friday?.priceCap ?? 800, 0)} and margin ≥{' '}
                {fmtNum(friday?.marginMultiplierThreshold ?? 5, 1)}x. It locks the upcoming week and
                subscribes the surviving list through the Session Manager with no expiry, so live WebSocket ticks
                are persisted by the DB Writer.
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Next run <span className="font-mono">{friday?.nextScanAt ?? DASH}</span>
                {' · '}target week <span className="font-mono">{friday?.nextTargetWeekId ?? DASH}</span>
              </p>
              {fridayLast && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Chip label="Last scan" value={fmtInt(fridayLast.symbols ?? null)} tone="info" />
                  <Chip label="Universe week" value={fridayLast.targetWeekId ?? DASH} />
                  <Chip label="Version" value={fmtInt(fridayLast.version ?? null)} />
                  <Chip
                    label="Trigger"
                    value={fridayLast.trigger ?? DASH}
                    tone={fridayLast.trigger === 'auto' ? undefined : 'warning'}
                  />
                  {fridayLast.reason && (
                    <Chip label="Reason" value={fridayLast.reason} tone="warning" />
                  )}
                  <span className="font-mono text-muted-foreground">
                    {fridayLast.atIso
                      ? new Date(fridayLast.atIso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                      : DASH}
                  </span>
                </div>
              )}
            </div>
            <button
              onClick={onFridayScan}
              disabled={busy === 'friday-scan' || friday?.running}
              className="flex items-center gap-1.5 rounded border border-sky-600/60 bg-sky-600/15 px-2.5 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-600/25 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              {busy === 'friday-scan' ? 'Scanning…' : 'Run Friday scan now'}
            </button>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            A manual run is allowed on any day and replaces the active universe immediately. If the target week
            is already LOCKED, the scan refuses to overwrite it (doc §33).
          </p>
        </div>

        {/* Saturday commands (doc §32) */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
          <button
            onClick={onScan}
            disabled={busy === 'scan'}
            className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy === 'scan' ? 'animate-spin' : ''}`} aria-hidden />
            Run weekly scan (report)
          </button>
          {!isLocked && (
            <>
              <button
                onClick={onSeed}
                disabled={busy === 'seed'}
                className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
              >
                <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Seed draft from last lock
              </button>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Locked by
                <input
                  value={lockedBy}
                  onChange={(e) => setLockedBy(e.target.value)}
                  placeholder="operator"
                  className="w-28 rounded border border-border bg-background px-1.5 py-1 text-xs"
                />
              </label>
              <button
                onClick={onLock}
                disabled={busy === 'lock' || draftSymbols.size === 0}
                className="flex items-center gap-1.5 rounded border border-emerald-600/60 bg-emerald-600/15 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-600/25 disabled:opacity-50"
              >
                <Lock className="h-3.5 w-3.5" aria-hidden />
                LOCK {draftSymbols.size} symbols
              </button>
            </>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            Threshold ₹{fmtNum(weekly?.config?.rupeeThreshold, 0)} · danger circuit{' '}
            {fmtNum(weekly?.config?.dangerCircuitPct, 1)}% · 1% mover ±
            {fmtNum(weekly?.config?.moverThresholdPct, 1)}% · margin ≥
            {fmtNum(weekly?.config?.marginMultiplierThreshold, 1)}x
          </span>
        </div>

        {notice && (
          <p className="mt-2 rounded border border-border/60 bg-background/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {notice}
          </p>
        )}
      </section>

      {/* ---- Observability (doc §30) --------------------------------- */}
      <ObservabilityStrip />

      {/* ---- Weekly report (doc §5) ----------------------------------- */}
      <section className="rounded-lg border border-border/60 bg-card/60">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4" aria-hidden /> Weekly report
            {report && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {report.weekStart} → {report.weekEnd}
              </span>
            )}
          </h3>
          {report && (
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <Chip label="Reviewed" value={fmtInt(report.counts?.reviewed ?? null)} />
              <Chip label="With data" value={fmtInt(report.counts?.withData ?? null)} tone="success" />
              <Chip label="No data" value={fmtInt(report.counts?.withoutData ?? null)} tone="warning" />
              <Chip label="Adv ADD" value={fmtInt(report.counts?.recommendAdd ?? null)} tone="success" />
              <Chip label="Adv REMOVE" value={fmtInt(report.counts?.recommendRemove ?? null)} tone="danger" />
            </div>
          )}
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
                placeholder="Filter symbol…"
                className="w-40 rounded border border-border bg-background px-2 py-1 text-xs"
              />
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
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
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

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchObservability()
        .then((d) => alive && setData(d))
        .catch(() => {});
    void load();
    const id = setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

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