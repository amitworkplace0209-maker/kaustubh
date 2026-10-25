'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Database, Download, HardDrive, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DbwIstClock, DbwPageTabs, fmtNum } from './dbw-shared';

/**
 * SERVICES → DB Writer → Storage — din-wise + all-time MongoDB storage view.
 *
 * OWN connection (baaki pages se jaan-boojh ke alag):
 *   GET /api/services/engines/db_writer_engine/storage?days=&date=
 *     · allTime — har DB-Writer data collection ka LIVE collStats
 *     · days    — IST daily ledger (daily_summaries; _write_batch upsert karta hai)
 *     · day     — ek din ka detail (ledger row + REAL ticks count by receivedAt)
 *
 * Koi WS#2 nahi, koi engine control nahi, koi permission toggle nahi —
 * wo sab apne pages par hain. Missing = '—', fake value kabhi nahi.
 */

const STORAGE = '/api/services/engines/db_writer_engine/storage';

type DayRow = {
  date?: string | null;
  totalTicks?: number;
  totalWrites?: number;
  subscribedStocks?: number | null;
  updatedAt?: string | null;
};

type CollRow = {
  name: string;
  ok?: boolean;
  error?: string;
  documents?: number;
  sizeBytes?: number;
  sizeMB?: number;
  indexes?: number;
};

type StorageReport = {
  ok?: boolean;
  error?: string;
  generatedAt?: string | null;
  allTime?: {
    collections?: CollRow[];
    summary?: {
      collections?: number;
      documents?: number;
      sizeBytes?: number;
      sizeMB?: number;
    };
  };
  days?: DayRow[];
  daysRequested?: number;
  day?: {
    date?: string;
    startedAtUtc?: string;
    endedAtUtc?: string;
    timestampField?: string;
    ledger?: DayRow | null;
    ticksDocuments?: number | null;
    countsAvailable?: boolean;
  } | null;
};

/** YYYY-MM-DD → "24 Oct" display title (pura string title attribute me). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]}`;
}

function fmtTimeIST(iso?: string | null): string {
  if (iso == null || iso === '') return '—';
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })
    : '—';
}

export default function DbWriterStoragePage() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(45);
  const daysRef = useRef(45);
  const [selected, setSelected] = useState('');
  const selectedRef = useRef('');
  const bootedRef = useRef(false);

  /** OWN connection: ek storage endpoint, days + optional date drill-down. */
  const fetch_ = useCallback(async (date: string): Promise<StorageReport | null> => {
    setBusy(true);
    setErr(null);
    try {
      const q = `days=${daysRef.current}${date ? `&date=${encodeURIComponent(date)}` : ''}`;
      const res = await fetch(`${STORAGE}?${q}`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!json?.ok) {
        setErr(json?.error ?? `HTTP ${res.status}`);
        return null;
      }
      const data = (json.data ?? {}) as StorageReport;
      if (data.ok === false) {
        setErr(data.error ?? 'Storage report unavailable');
        return null;
      }
      setReport(data);
      return data;
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  // Boot: report lo; pehli baar latest ledger day (backend-owned date) pe
  // drill-down karo — client clock se koi din invent nahi hota.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    let cancelled = false;
    void (async () => {
      const first = await fetch_('');
      if (cancelled || !first) return;
      const latest = (first.days ?? []).find((d) => d?.date)?.date as string | undefined;
      if (latest) {
        selectedRef.current = latest;
        setSelected(latest);
        await fetch_(latest);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetch_]);

  /** Honest day picker (input date + chips + table row click). */
  const pickDay = useCallback(async (date: string) => {
    if (!date || date === selectedRef.current) return;
    selectedRef.current = date;
    setSelected(date);
    await fetch_(date);
  }, [fetch_]);

  // 60s self-refresh — sirf khud ka storage endpoint, koi aur channel nahi.
  useEffect(() => {
    const t = setInterval(() => {
      void fetch_(selectedRef.current);
    }, 60000);
    return () => clearInterval(t);
  }, [fetch_]);

  const changeDays = (n: number) => {
    daysRef.current = n;
    setDays(n);
    void fetch_(selectedRef.current);
  };

  const exportCsv = () => {
    const rows = report?.days ?? [];
    if (!rows.length) return;
    const csv = `date,totalTicks,totalWrites,subscribedStocks,updatedAt\n${rows
      .map((r) => `${r.date ?? ''},${r.totalTicks ?? 0},${r.totalWrites ?? 0},${r.subscribedStocks ?? ''},"${r.updatedAt ?? ''}"`)
      .join('\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'db-writer-daily-ledger.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const allTime = report?.allTime;
  const colls = allTime?.collections ?? [];
  const summary = allTime?.summary;
  const maxCollMB = Math.max(0.001, ...colls.map((c) => Number(c.sizeMB ?? 0)));
  const ledger = report?.days ?? [];
  const maxLedgerWrites = Math.max(1, ...ledger.map((d) => Number(d.totalWrites ?? 0)));
  const day = report?.day ?? null;
  const dayLedger = day?.ledger ?? null;

  return (
    <div className="space-y-4 pb-6">
      {/* HERO — flat blue band, overview ke gradient hero se JAAN-BOOJH ke alag */}
      <div className="rounded-2xl border border-sky-500/30 bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-xl">
            <HardDrive className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">DB Writer · Storage</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              din-wise ledger + all-time MongoDB plane · apna storage connection
            </p>
          </div>
          <DbwPageTabs active="storage" />
          <DbwIstClock />
          <Button
            size="sm"
            onClick={() => void fetch_(selectedRef.current)}
            disabled={busy}
            className="gap-1.5 bg-gradient-to-r from-sky-500 to-blue-600 shadow-md"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} /> Refresh
          </Button>
        </div>
        {/* BIG band of the four headline numbers (storage page signature) */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ['Collections', fmtNum(summary?.collections), 'engine data plane'],
            ['All-time docs', fmtNum(summary?.documents), 'counted, not estimated'],
            ['All-time size', `${summary?.sizeMB != null ? fmtNum(summary.sizeMB) : '—'} MB`, 'live collStats'],
            ['Ledger days', fmtNum(ledger.length), `window ${report?.daysRequested ?? days}d`],
          ] as [string, string, string][]).map(([l, v, sub]) => (
            <div key={l} className="rounded-xl border border-sky-500/20 bg-sky-500/[0.06] px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-sky-700/80">{l}</p>
              <p className="font-mono text-lg font-bold tabular-nums text-foreground">{v}</p>
              <p className="truncate text-[10px] text-muted-foreground">{sub}</p>
            </div>
          ))}
        </div>
      </div>

      {err && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
          <span className="min-w-0">Storage plane: {err}</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void fetch_(selectedRef.current)}>Retry</Button>
        </div>
      )}
      {!report && !err && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-muted/60" />)}
          <p className="py-1 text-center text-xs text-muted-foreground">Loading storage report…</p>
        </div>
      )}

      {report && (
        <>
          {/* DAY-WISE PANEL */}
          <Card className="overflow-hidden border-sky-500/25 shadow-soft">
            <CardHeader className="bg-gradient-to-r from-sky-500/10 to-blue-500/5 pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 p-1.5 text-white shadow"><CalendarDays className="h-3.5 w-3.5" /></span>
                Din-wise storage (IST business days · daily_summaries ledger)
                <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 px-2 text-[11px]" onClick={exportCsv} disabled={!ledger.length}>
                  <Download className="h-3 w-3" /> Ledger CSV
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-3">
              {/* day picker: chips + free date input */}
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  value={selected}
                  onChange={(e) => void pickDay(e.target.value)}
                  className="h-8 w-40 text-xs"
                  aria-label="IST din chuno (YYYY-MM-DD)"
                />
                {([14, 45, 90, 180] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => changeDays(n)}
                    className={cn(
                      'rounded-lg border px-2 py-1 font-mono text-[10px] transition-colors',
                      days === n
                        ? 'border-blue-500/50 bg-blue-500/15 text-blue-700'
                        : 'border-border/60 text-muted-foreground hover:text-foreground',
                    )}
                    title={`Ledger window = ${n} din`}
                  >
                    {n}d
                  </button>
                ))}
                <span className="text-[10px] text-muted-foreground">window</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {ledger.slice(0, 8).map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() => void pickDay(d.date as string)}
                    className={cn(
                      'rounded-lg border px-2 py-1 font-mono text-[10px] tabular-nums transition-colors',
                      selected === d.date
                        ? 'border-sky-500/50 bg-sky-500/15 text-sky-700'
                        : 'border-border/60 text-muted-foreground hover:text-foreground',
                    )}
                    title={`${d.date} · ${fmtNum(d.totalWrites)} written`}
                  >
                    {fmtDate(d.date)}
                  </button>
                ))}
                {ledger.length > 8 && <span className="text-[10px] text-muted-foreground">+{ledger.length - 8} purane</span>}
              </div>

              {/* selected day detail */}
              <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.05] p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-bold">{selected ? fmtDate(selected) : '—'}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{selected || 'koi din nahi chuna'}</span>
                  {busy && <span className="text-[10px] text-sky-700">reading…</span>}
                </div>
                {day?.startedAtUtc && (
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    window (UTC): {day.startedAtUtc} → {day.endedAtUtc} · ts field: <code>{day.timestampField ?? '—'}</code>
                  </p>
                )}
                {selected ? (
                  dayLedger ? (
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {([
                        ['Ledger ticks', fmtNum(dayLedger.totalTicks), 'flush-time upsert'],
                        ['Ledger writes', fmtNum(dayLedger.totalWrites), 'real bulk inserts'],
                        ['Subscribed stocks', fmtNum(dayLedger.subscribedStocks), 'distinct day-set'],
                        ['Ticks docs (receivedAt)', day?.countsAvailable ? fmtNum(day?.ticksDocuments) : '—', 'exact IST-window count'],
                        ['Ledger updated', dayLedger.updatedAt ? fmtTimeIST(dayLedger.updatedAt) : '—', 'IST'],
                      ] as [string, string, string][]).map(([l, v, sub]) => (
                        <div key={l} className="rounded-lg border border-border/50 bg-card/80 px-2 py-2">
                          <p className="truncate text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                          <p className="font-mono text-base font-bold tabular-nums">{v}</p>
                          <p className="truncate text-[9px] text-muted-foreground">{sub}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Is din ka ledger row nahi — market closed ya pipeline OFF tha. Koi synthesized number nahi.
                    </p>
                  )
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">Din chuno — chips ya date picker se.</p>
                )}
                {day && day.countsAvailable === false && (
                  <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700">
                    receivedAt count fail hua — value '—' dikhti hai, fake substitute nahi.
                  </p>
                )}
                <p className="mt-2 text-[9px] text-muted-foreground">
                  Ledger row flush ke waqt upsert hoti hai; ticks-docs count receivedAt window ka hai — dono REAL,
                  front-midnight flush border par alag aa sakte hain (aur sahi hai).
                </p>
              </div>

              {/* trend bars — REAL ledger values only */}
              {ledger.length > 1 && (
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Total writes per din (ledger) · last {Math.min(14, ledger.length)}
                  </p>
                  <div className="flex h-24 items-end gap-1 overflow-x-auto">
                    {ledger.slice(0, 14).reverse().map((d) => {
                      const n = Number(d.totalWrites ?? 0);
                      const h = Math.max(2, (n / maxLedgerWrites) * 100);
                      return (
                        <div key={d.date} className="flex min-w-[14px] flex-1 flex-col items-center gap-1">
                          <div className="flex h-20 w-full items-end justify-center">
                            <div
                              className="w-full rounded-t bg-gradient-to-t from-sky-500/70 to-blue-400"
                              style={{ height: `${h}%` }}
                              title={`${d.date} · ${fmtNum(d.totalTicks)} ticks · ${fmtNum(d.totalWrites)} written`}
                            />
                          </div>
                          <span className="font-mono text-[8px] text-muted-foreground">{fmtDate(d.date)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ledger table */}
              <div className="max-h-56 overflow-auto rounded-xl border border-border/50">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="text-left text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                      <th className="px-2 py-1.5">Din (IST)</th>
                      <th className="px-2 py-1.5 text-right">Ticks</th>
                      <th className="px-2 py-1.5 text-right">Writes</th>
                      <th className="px-2 py-1.5 text-right">Stocks</th>
                      <th className="px-2 py-1.5 text-right">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((d, i) => (
                      <tr
                        key={`${d.date}-${i}`}
                        onClick={() => void pickDay(d.date as string)}
                        className={cn(
                          'cursor-pointer border-t border-border/40 tabular-nums hover:bg-sky-500/10',
                          selected === d.date && 'bg-sky-500/10',
                        )}
                      >
                        <td className="px-2 py-1.5 font-mono">{d.date ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.totalTicks)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.totalWrites)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.subscribedStocks)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{d.updatedAt ? fmtTimeIST(d.updatedAt) : '—'}</td>
                      </tr>
                    ))}
                    {!ledger.length && (
                      <tr><td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">Ledger khali — pehla flush ke baad din aayega.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ALL-TIME PANEL */}
          <Card className="overflow-hidden border-sky-500/25 shadow-soft">
            <CardHeader className="bg-gradient-to-r from-blue-500/10 to-indigo-500/5 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <span className="rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 p-1.5 text-white shadow"><Database className="h-3.5 w-3.5" /></span>
                All-time plane · har collection ka live collStats
                <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                  generatedAt {report.generatedAt ? fmtTimeIST(report.generatedAt) : '—'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
              {colls.length ? (
                <div className="space-y-1.5">
                  {colls.map((c) => (
                    <div key={c.name} className="rounded-lg border-b border-border/40 px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="min-w-0 truncate font-mono" title={c.error ?? c.name}>{c.name}</span>
                        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                          {c.ok === false ? <span className="text-rose-700">err</span> : (
                            <>
                              {fmtNum(c.documents)} docs · {c.sizeMB != null ? fmtNum(c.sizeMB) : '—'} MB
                              {c.indexes != null ? ` · ${fmtNum(c.indexes)} idx` : ''}
                            </>
                          )}
                        </span>
                      </div>
                      {c.ok !== false && (
                        <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted/70">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-sky-500 to-blue-500"
                            style={{ width: `${(Number(c.sizeMB ?? 0) / maxCollMB) * 100}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                  <p className="pt-1 text-[10px] text-muted-foreground">
                    Tick engine data plane: ticks + market_ticks + candles + market-watch collections + daily_summaries.
                    Baaki DB collections is page ke scope me nahi (Database page dekho).
                  </p>
                </div>
              ) : (
                <p className="py-4 text-center text-xs text-muted-foreground">Collection stats unavailable — MongoDB se.</p>
              )}
            </CardContent>
          </Card>

          <p className="text-[11px] text-muted-foreground">
            Sab numbers live MongoDB command (collStats / count_documents / find) se aaye. Ledger aur receivedAt-count
            dono asli measurements hain — missing jagah '—', fake kabhi nahi.
          </p>
        </>
      )}
    </div>
  );
}
