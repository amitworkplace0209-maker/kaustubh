'use client';

/**
 * Reports tab — docs/engines/MARKET_WATCH.md §26 (daily EOD) and §5 (weekly).
 *
 * Two backend-owned report surfaces are read here and NOTHING is recomputed in
 * the browser (doc §24):
 *
 *   DAILY  — `GET /api/market-watch/report/daily` and `.../daily/{date}`.
 *            Generated automatically near the close of each trading day
 *            (lifecycle state REPORTING).
 *   WEEKLY — `GET /api/market-watch/weekly/reports` and `.../weekly/report`.
 *            The advisory Saturday review. Per doc §5 the report NEVER changes
 *            membership — ADD/REMOVE/KEEP and the LOCK live in the Weekly Review
 *            tab, which is the only place membership may change.
 *
 * Every figure below is rendered from the stored report. A value the backend did
 * not compute renders as a dash, never as a zero or an estimate (doc §21).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, FileText, RefreshCw } from 'lucide-react';
import {
  DASH,
  fetchJson,
  fetchWeeklyReport,
  fmtInt,
  fmtNum,
  fmtPct,
  toneClass,
  type MwRecommendation,
  type MwWeeklyReport,
  type MwWeeklyReportRow,
} from './mw-shared';

// ---------------------------------------------------------------------------
// Shapes
//
// `changePct` is the backend field name (`services/market_watch_report._row`).
// It was previously typed here as `changePercent`, which is why the Change %
// column rendered blank for every stored report.
// ---------------------------------------------------------------------------

interface DailyReportRow {
  rank?: number | null;
  symbol?: string | null;
  instrumentToken?: string | null;
  blocked?: boolean;
  ltp?: number | null;
  change?: number | null;
  changePct?: number | null;
  volume?: number | null;
  vwap?: number | null;
  turnover?: number | null;
  tickCount?: number | null;
  dataQuality?: string | null;
  lastTickTime?: string | null;
  circuitDistanceUpperPct?: number | null;
  circuitDistanceLowerPct?: number | null;
  timeframes?: Record<string, Record<string, number | string | null> | null> | null;
}

interface DailyReport {
  date?: string;
  generatedAt?: string;
  generationDurationMs?: number | null;
  counts?: Record<string, number | null> | null;
  movers?: {
    topGainers?: DailyReportRow[];
    topDeclinersByPriceChange?: DailyReportRow[];
  } | null;
  highestVolume?: DailyReportRow[];
  mostActive?: DailyReportRow[];
  circuitNear?: DailyReportRow[];
  blocked?: DailyReportRow[];
  blockReasons?: Record<string, number | null> | null;
  dataQuality?: { bySymbol?: Record<string, string>; vocabulary?: string[] } | null;
  notes?: string[];
}

interface DailyListItem {
  date?: string | null;
  generatedAt?: string | null;
  counts?: Record<string, number | null> | null;
}

interface WeeklyListItem {
  weekId?: string | null;
  generatedAt?: string | null;
  counts?: MwWeeklyReport['counts'];
}

type View = 'daily' | 'weekly';

const RECOVERY_TONE: Record<MwRecommendation, string> = {
  ADD: 'text-emerald-500',
  REMOVE: 'text-red-500',
  KEEP: 'text-sky-500',
  REVIEW: 'text-amber-500',
};

export default function ReportTab() {
  const [view, setView] = useState<View>('daily');

  const [dailyList, setDailyList] = useState<DailyListItem[] | null>(null);
  const [dailyDate, setDailyDate] = useState<string | null>(null);
  const [daily, setDaily] = useState<DailyReport | null>(null);

  const [weeklyList, setWeeklyList] = useState<WeeklyListItem[] | null>(null);
  const [weeklyWeek, setWeeklyWeek] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<MwWeeklyReport | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDaily = useCallback(async (date: string) => {
    const res = await fetchJson<{ ok: boolean; report: DailyReport | null }>(
      `/api/market-watch/report/daily/${encodeURIComponent(date)}`,
    );
    return res.report ?? null;
  }, []);

  const fetchWeekly = useCallback(async (weekId: string) => {
    const res = await fetchWeeklyReport(weekId);
    return res.report ?? null;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Both lists are independent; failing one must not hide the other.
      const [dailyRes, weeklyRes] = await Promise.allSettled([
        fetchJson<{ ok: boolean; reports?: DailyListItem[] }>('/api/market-watch/report/daily?limit=30'),
        fetchJson<{ ok: boolean; reports?: WeeklyListItem[] }>('/api/market-watch/weekly/reports?limit=26'),
      ]);

      if (dailyRes.status === 'fulfilled') {
        const items = dailyRes.value.reports ?? [];
        setDailyList(items);
        const first = dailyDate ?? items[0]?.date ?? null;
        setDailyDate(first);
        if (first) setDaily(await fetchDaily(first));
      } else {
        setError('Daily report list unavailable.');
      }

      if (weeklyRes.status === 'fulfilled') {
        const items = weeklyRes.value.reports ?? [];
        setWeeklyList(items);
        const first = weeklyWeek ?? items[0]?.weekId ?? null;
        setWeeklyWeek(first);
        if (first) setWeekly(await fetchWeekly(first));
      } else {
        setError((prev) => prev ?? 'Weekly report list unavailable.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'reports unavailable');
    } finally {
      setLoading(false);
    }
    // The two selections are intentionally omitted: the first-load branch must
    // not re-run when a selection changes, or every click would refetch both
    // lists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchDaily, fetchWeekly]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSelectDaily = async (date: string) => {
    setDailyDate(date);
    setDaily(null);
    try {
      setDaily(await fetchDaily(date));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'report unavailable');
    }
  };

  const onSelectWeekly = async (weekId: string) => {
    setWeeklyWeek(weekId);
    setWeekly(null);
    try {
      setWeekly(await fetchWeekly(weekId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'weekly report unavailable');
    }
  };

  const dailyCount = dailyList?.length ?? 0;
  const weeklyCount = weeklyList?.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded border border-border">
          <TabButton
            active={view === 'daily'}
            onClick={() => setView('daily')}
            icon={<FileText className="h-3.5 w-3.5" aria-hidden />}
            label="Daily (end-of-day)"
            count={dailyCount}
          />
          <TabButton
            active={view === 'weekly'}
            onClick={() => setView('weekly')}
            icon={<CalendarClock className="h-3.5 w-3.5" aria-hidden />}
            label="Weekly review"
            count={weeklyCount}
          />
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
          title="Reload stored reports"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {error}
          </span>
        </div>
      ) : null}

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading stored reports…</p>
      ) : view === 'daily' ? (
        <DailyView
          list={dailyList}
          date={dailyDate}
          report={daily}
          onSelect={onSelectDaily}
        />
      ) : (
        <WeeklyView
          list={weeklyList}
          weekId={weeklyWeek}
          report={weekly}
          onSelect={onSelectWeekly}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium ${
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
      }`}
    >
      {icon}
      {label}
      <span className="font-mono text-[10px] text-muted-foreground">{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Daily — doc §26
// ---------------------------------------------------------------------------

function DailyView({
  list,
  date,
  report,
  onSelect,
}: {
  list: DailyListItem[] | null;
  date: string | null;
  report: DailyReport | null;
  onSelect: (date: string) => void;
}) {
  const items = useMemo(
    () => (list ?? []).filter((r): r is DailyListItem & { date: string } => Boolean(r.date)),
    [list],
  );

  if (!items.length) {
    return <EmptyReport kind="daily" />;
  }

  return (
    <>
      <section className="rounded-lg border border-border/60 bg-card/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4" aria-hidden /> End-of-day report
          </h3>
          <select
            value={date ?? ''}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Report date"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            {items.map((r) => (
              <option key={r.date} value={r.date}>
                {r.date}
              </option>
            ))}
          </select>
        </div>
        {report ? (
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4 lg:grid-cols-6">
            <Kv label="Date" value={report.date ?? DASH} />
            <Kv label="Generated" value={report.generatedAt ?? DASH} />
            <Kv
              label="Duration"
              value={report.generationDurationMs != null ? `${fmtNum(report.generationDurationMs, 0)}ms` : DASH}
            />
            <Kv label="Tracked" value={fmtInt(report.counts?.universeTracked ?? null)} />
            <Kv label="Eligible" value={fmtInt(report.counts?.eligible ?? null)} />
            <Kv label="Subscribed" value={fmtInt(report.counts?.subscribed ?? null)} />
            <Kv label="With price" value={fmtInt(report.counts?.withLivePrice ?? null)} />
            <Kv label="Validated ticks" value={fmtInt(report.counts?.totalValidatedTicks ?? null)} />
            <Kv label="Blocked" value={fmtInt(report.blocked?.length ?? null)} tone="warning" />
            <Kv label="Data quality classes" value={String(report.dataQuality?.vocabulary?.length ?? 0)} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No report stored for {date ?? 'the selected date'}.</p>
        )}
      </section>

      {report ? (
        <>
          <DailyBoard title="Top gainers" rows={report.movers?.topGainers ?? []} />
          <DailyBoard title="Top decliners by price change" rows={report.movers?.topDeclinersByPriceChange ?? []} />
          <DailyBoard title="Highest volume" rows={report.highestVolume ?? []} />
          <DailyBoard title="Most active" rows={report.mostActive ?? []} />
          <DailyBoard title="Circuit near" rows={report.circuitNear ?? []} />
          {report.blocked?.length ? <DailyBoard title="Blocked" rows={report.blocked} danger /> : null}
          {report.notes?.length ? (
            <ul className="space-y-0.5 px-1 text-[11px] text-muted-foreground">
              {report.notes.map((n) => (
                <li key={n}>• {n}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function DailyBoard({ title, rows, danger }: { title: string; rows: DailyReportRow[]; danger?: boolean }) {
  if (!rows.length) return null;
  return (
    <section className={`rounded-lg border ${danger ? 'border-red-500/40' : 'border-border/60'} bg-card/60`}>
      <header className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
        <span className="font-mono text-[11px] text-muted-foreground">{rows.length}</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">#</th>
              <th className="px-3 py-1.5 font-medium">Symbol</th>
              <th className="px-3 py-1.5 text-right font-medium">LTP</th>
              <th className="px-3 py-1.5 text-right font-medium">Change</th>
              <th className="px-3 py-1.5 text-right font-medium">Change %</th>
              <th className="px-3 py-1.5 text-right font-medium">Volume</th>
              <th className="px-3 py-1.5 text-right font-medium">1m %</th>
              <th className="px-3 py-1.5 text-right font-medium">5m %</th>
              <th className="px-3 py-1.5 text-right font-medium">10m %</th>
              <th className="px-3 py-1.5 text-right font-medium">30m %</th>
              <th className="px-3 py-1.5 text-right font-medium">Circ dist</th>
              <th className="px-3 py-1.5 font-medium">Quality</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.symbol ?? r.instrumentToken ?? i}`} className="border-t border-border/40">
                <td className="px-3 py-1 font-mono text-muted-foreground">{r.rank ?? i + 1}</td>
                <td className="px-3 py-1 font-mono font-medium">
                  {r.symbol ?? DASH}
                  {r.blocked ? <span className="ml-1 text-[10px] text-red-500">BLOCKED</span> : null}
                </td>
                <td className="px-3 py-1 text-right font-mono">{fmtNum(r.ltp)}</td>
                <td className="px-3 py-1 text-right font-mono">{fmtNum(r.change)}</td>
                <td
                  className={`px-3 py-1 text-right font-mono ${toneClass(
                    (r.changePct ?? 0) > 0 ? 'LIVE' : (r.changePct ?? 0) < 0 ? 'DANGER' : 'NORMAL',
                  )}`}
                >
                  {fmtPct(r.changePct)}
                </td>
                <td className="px-3 py-1 text-right font-mono">{fmtInt(r.volume)}</td>
                {(['1m', '5m', '10m', '30m'] as const).map((tf) => (
                  <td key={tf} className="px-3 py-1 text-right font-mono text-muted-foreground">
                    {fmtPct(r.timeframes?.[tf]?.changePct as number | null | undefined)}
                  </td>
                ))}
                <td className="px-3 py-1 text-right font-mono text-muted-foreground">
                  {r.circuitDistanceUpperPct != null ? `${fmtNum(r.circuitDistanceUpperPct)}%` : DASH}
                </td>
                <td className="px-3 py-1 text-[11px] text-muted-foreground">{r.dataQuality ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Weekly — doc §5
// ---------------------------------------------------------------------------

function WeeklyView({
  list,
  weekId,
  report,
  onSelect,
}: {
  list: WeeklyListItem[] | null;
  weekId: string | null;
  report: MwWeeklyReport | null;
  onSelect: (weekId: string) => void;
}) {
  const items = useMemo(
    () => (list ?? []).filter((r): r is WeeklyListItem & { weekId: string } => Boolean(r.weekId)),
    [list],
  );
  const rows = useMemo(() => report?.rows ?? [], [report]);
  const [filter, setFilter] = useState<MwRecommendation | 'ALL'>('ALL');

  const filtered = useMemo(
    () => (filter === 'ALL' ? rows : rows.filter((r) => r.recommendation === filter)),
    [rows, filter],
  );

  if (!items.length) {
    return <EmptyReport kind="weekly" />;
  }

  return (
    <>
      <section className="rounded-lg border border-border/60 bg-card/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="h-4 w-4" aria-hidden /> Weekly review report
          </h3>
          <select
            value={weekId ?? ''}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Review week"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            {items.map((r) => (
              <option key={r.weekId} value={r.weekId}>
                {r.weekId}
              </option>
            ))}
          </select>
        </div>

        {report ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4 lg:grid-cols-6">
              <Kv label="Week" value={report.weekId ?? DASH} />
              <Kv label="Generated" value={report.generatedAt ?? DASH} />
              <Kv label="Days reviewed" value={String(report.tradingDays?.length ?? 0)} />
              <Kv label="Universe" value={fmtInt(report.universeSize ?? null)} />
              <Kv label="₹ threshold" value={fmtNum(report.threshold ?? null)} />
              <Kv label="Margin threshold" value={`${fmtNum(report.marginThresholdMultiplier ?? null)}x`} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <RecCard label="Reviewed" value={report.counts?.reviewed} />
              <RecCard label="With data" value={report.counts?.withData} />
              <RecCard label="Recommend ADD" value={report.counts?.recommendAdd} tone="text-emerald-500" />
              <RecCard label="Recommend REMOVE" value={report.counts?.recommendRemove} tone="text-red-500" />
              <RecCard label="Recommend KEEP" value={report.counts?.recommendKeep} tone="text-sky-500" />
              <RecCard label="Recommend REVIEW" value={report.counts?.recommendReview} tone="text-amber-500" />
              <RecCard label="No data" value={report.counts?.withoutData} tone="text-muted-foreground" />
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Advisory only — this report never changes membership. Use{' '}
              <span className="font-mono">Weekly Review</span> to record ADD / REMOVE / KEEP and lock the week.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No weekly report stored for {weekId ?? 'the selected week'}.
          </p>
        )}
      </section>

      {rows.length ? (
        <section className="rounded-lg border border-border/60 bg-card/60">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Reviewed stocks ({filtered.length}/{rows.length})
            </h4>
            <div className="inline-flex overflow-hidden rounded border border-border">
              {(['ALL', 'ADD', 'REMOVE', 'KEEP', 'REVIEW'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  aria-pressed={filter === f}
                  className={`px-2 py-0.5 text-[10px] font-medium ${
                    filter === f ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Symbol</th>
                  <th className="px-3 py-1.5 font-medium">Company</th>
                  <th className="px-3 py-1.5 text-right font-medium">Latest</th>
                  <th className="px-3 py-1.5 text-right font-medium">Min</th>
                  <th className="px-3 py-1.5 text-right font-medium">Max</th>
                  <th className="px-3 py-1.5 text-right font-medium">&gt; ₹{fmtNum(report?.threshold ?? null, 0)}</th>
                  <th className="px-3 py-1.5 text-right font-medium">≤ ₹{fmtNum(report?.threshold ?? null, 0)}</th>
                  <th className="px-3 py-1.5 text-right font-medium">Week %</th>
                  <th className="px-3 py-1.5 text-right font-medium">Min circ dist</th>
                  <th className="px-3 py-1.5 font-medium">Margin</th>
                  <th className="px-3 py-1.5 text-right font-medium">Complete</th>
                  <th className="px-3 py-1.5 font-medium">Rec.</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <WeeklyRow key={`${r.token ?? r.symbol}-${r.recommendation ?? 'x'}`} row={r} />
                ))}
              </tbody>
            </table>
          </div>
          {!filtered.length ? (
            <p className="px-4 py-3 text-[11px] text-muted-foreground">
              No reviewed stock carries the {filter} recommendation.
            </p>
          ) : null}
        </section>
      ) : null}

      {report?.notes?.length ? (
        <ul className="space-y-0.5 px-1 text-[11px] text-muted-foreground">
          {report.notes.map((n) => (
            <li key={n}>• {n}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function WeeklyRow({ row }: { row: MwWeeklyReportRow }) {
  const rec = row.recommendation;
  return (
    <tr className="border-t border-border/40">
      <td className="px-3 py-1 font-mono font-medium">{row.symbol ?? DASH}</td>
      <td className="px-3 py-1 text-[11px] text-muted-foreground">{row.companyName ?? DASH}</td>
      <td className="px-3 py-1 text-right font-mono">{fmtNum(row.latestLtp)}</td>
      <td className="px-3 py-1 text-right font-mono text-muted-foreground">{fmtNum(row.weeklyMinLtp)}</td>
      <td className="px-3 py-1 text-right font-mono text-muted-foreground">{fmtNum(row.weeklyMaxLtp)}</td>
      <td className="px-3 py-1 text-right font-mono text-emerald-500/90">
        {fmtInt(row.observationsAboveThreshold ?? null)}
      </td>
      <td className="px-3 py-1 text-right font-mono text-red-500/90">
        {fmtInt(row.observationsAtOrBelowThreshold ?? null)}
      </td>
      <td
        className={`px-3 py-1 text-right font-mono ${toneClass(
          (row.weeklyChangePercent ?? 0) > 0 ? 'LIVE' : (row.weeklyChangePercent ?? 0) < 0 ? 'DANGER' : 'NORMAL',
        )}`}
      >
        {fmtPct(row.weeklyChangePercent)}
      </td>
      <td className="px-3 py-1 text-right font-mono text-muted-foreground">
        {row.minCircuitDistancePct != null ? `${fmtNum(row.minCircuitDistancePct)}%` : DASH}
      </td>
      <td className="px-3 py-1 text-[11px] text-muted-foreground">
        {row.marginMultiplier != null ? `${fmtNum(row.marginMultiplier)}x` : (row.marginStatus ?? DASH)}
      </td>
      <td className="px-3 py-1 text-right font-mono text-muted-foreground">
        {row.dataCompleteness != null ? `${Math.round(row.dataCompleteness * 100)}%` : DASH}
      </td>
      <td className={`px-3 py-1 text-[11px] font-semibold ${rec ? (RECOVERY_TONE[rec] ?? '') : ''}`}>
        {rec ?? DASH}
      </td>
    </tr>
  );
}

function RecCard({
  label,
  value,
  tone,
}: {
  label: string;
  value?: number | null;
  tone?: string;
}) {
  return (
    <div className="rounded border border-border/60 bg-background/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm ${tone ?? ''}`}>{fmtInt(value ?? null)}</div>
    </div>
  );
}

function Kv({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${tone === 'warning' ? 'text-amber-500' : ''}`}>{value}</span>
    </div>
  );
}

function EmptyReport({ kind }: { kind: 'daily' | 'weekly' }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-6">
      <h3 className="flex items-center gap-2 font-semibold text-amber-300">
        <AlertTriangle className="h-4 w-4" aria-hidden /> No {kind === 'daily' ? 'end-of-day' : 'weekly'} report stored
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        {kind === 'daily'
          ? 'A report is generated near the close of each trading day.'
          : 'The weekly report is generated by the Saturday review from the saved Monday-Friday data.'}{' '}
        Nothing is shown here rather than showing a value that was never computed.
      </p>
    </div>
  );
}
