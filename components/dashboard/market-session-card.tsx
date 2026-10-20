'use client';

// Market Session — advanced compact card, no dummy/last-update noise

import { CalendarClock, Clock, Hourglass, TrendingUp, Sun, Moon } from 'lucide-react';
import { useSystem } from '@/components/system-provider';
import { useServerNow, useCountdown } from '@/lib/time-engine';
import { StatusBadge } from '@/components/design-system';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

function phaseLabel(status: string | null | undefined): string {
  const u = String(status ?? '').toUpperCase();
  if (u === 'OPEN') return 'OPEN';
  if (u === 'PRE_OPEN') return 'PRE-OPEN';
  if (u === 'POST_CLOSE') return 'CLOSED';
  if (u === 'CLOSED') return 'CLOSED';
  if (u === 'HOLIDAY') return 'HOLIDAY';
  return u.replace(/_/g, ' ') || 'UNKNOWN';
}

function phaseTone(status: string | null | undefined): 'success' | 'warning' | 'neutral' {
  const u = String(status ?? '').toUpperCase();
  if (u === 'OPEN') return 'success';
  if (u === 'PRE_OPEN') return 'warning';
  return 'neutral';
}

function dayClassLabel(dayClass: string | null | undefined, closureReason: string | null | undefined): string | null {
  const d = String(dayClass ?? '');
  if (d === 'NORMAL_MARKET_DAY') return 'Normal day';
  if (d === 'WEEKEND') return 'Weekend';
  if (d === 'EXCHANGE_HOLIDAY') return closureReason ? `Holiday — ${closureReason}` : 'Holiday';
  if (d === 'SPECIAL_CLOSURE') return closureReason ? `Special — ${closureReason}` : 'Special closure';
  return d ? d.replace(/_/g, ' ') : null;
}

// Advanced timeline — gradient line, pulsing current dot, session progress
function SessionTimeline({ status, progress }: { status: string | null | undefined; progress: number | null }) {
  const u = String(status ?? '').toUpperCase();
  const active: 'pre' | 'open' | 'closed' = u === 'OPEN' ? 'open' : u === 'PRE_OPEN' ? 'pre' : 'closed';
  const stations = [
    { key: 'pre', label: 'PRE-OPEN', time: '08:45' },
    { key: 'open', label: 'OPEN', time: '09:15' },
    { key: 'closed', label: 'CLOSE', time: '15:30' },
  ] as const;
  const activeIdx = stations.findIndex((s) => s.key === active);

  // progress 0–1 across the trading day (09:15=0 to 15:30=1), null outside
  const showProgress = u === 'OPEN' && progress != null && progress >= 0 && progress <= 1;

  return (
    <div className="relative">
      {/* Background line */}
      <div className="absolute left-1 right-1 top-[7px] h-1 rounded-full bg-muted" />
      {/* Progress fill */}
      {showProgress && (
        <div className="absolute left-1 top-[7px] h-1 rounded-full bg-gradient-to-r from-emerald-500 to-sky-500 transition-all duration-1000" style={{ width: `${Math.max(0, Math.min(100, progress! * 100))}%` }} />
      )}
      {!showProgress && activeIdx >= 0 && (
        <div className="absolute left-1 top-[7px] h-1 rounded-full bg-gradient-to-r from-emerald-500/40 to-sky-500/20" style={{ width: `${(activeIdx / 2) * 100}%` }} />
      )}

      <div className="relative flex justify-between">
        {stations.map((s, idx) => {
          const isActive = s.key === active;
          const isPast = idx < activeIdx;
          const isFuture = idx > activeIdx;
          return (
            <div key={s.key} className="flex flex-col items-center gap-1">
              <span
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 bg-card text-[8px] font-bold shadow-sm transition-all',
                  isActive && u === 'OPEN' ? 'border-emerald-500 bg-emerald-500 text-white [box-shadow:0_0_8px_hsl(var(--success)/0.5)] animate-pulse' : isActive ? 'border-amber-500 bg-amber-500 text-white' : isPast ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' : 'border-border bg-muted text-muted-foreground/60',
                )}
              >
                {isActive ? '●' : isPast ? '✓' : ''}
              </span>
              <span className={cn('text-[9px] font-bold tracking-widest', isActive ? 'text-foreground' : isPast ? 'text-emerald-600/70' : 'text-muted-foreground/50')}>
                {s.label}
              </span>
              <span className="text-[10px] font-medium tabular-nums text-muted-foreground">{s.time}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const IST_DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  weekday: 'short',
});

function sessionProgress(serverNow: number, status: string | null | undefined): number | null {
  const u = String(status ?? '').toUpperCase();
  if (u !== 'OPEN') return null;
  // IST 09:15 to 15:30
  const ist = new Date(new Date(serverNow).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const start = new Date(ist);
  start.setHours(9, 15, 0, 0);
  const end = new Date(ist);
  end.setHours(15, 30, 0, 0);
  const now = ist.getTime();
  const s = start.getTime();
  const e = end.getTime();
  if (now < s) return 0;
  if (now > e) return 1;
  return (now - s) / (e - s);
}

export function MarketSessionCard() {
  const { market } = useSystem();
  const serverNow = useServerNow();

  const status: string | null = market?.market_status ?? market?.marketSession ?? null;
  const nextOpen = market?.next_market_open ?? market?.nextMarketOpen ?? null;
  const nextClose = market?.next_market_close ?? market?.nextMarketClose ?? null;
  const dayClass = market?.day_class ?? market?.dayClass ?? null;
  const closure = market?.closure_reason ?? null;
  const tradingDay = market?.market_date ?? market?.trading_day ?? null;
  const mode = market?.mode ?? market?.session_mode ?? null;
  const nextTradingDay: string | null = market?.next_trading_day ?? market?.nextTradingDay ?? (nextOpen ? String(nextOpen).slice(0, 10) : null);

  const tone = phaseTone(status);
  const badgeStatus = tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'neutral';
  const targetIso = String(status ?? '').toUpperCase() === 'OPEN' ? nextClose : nextOpen;
  const { text: countdownText } = useCountdown(targetIso);
  const isOpen = String(status ?? '').toUpperCase() === 'OPEN';
  const progress = sessionProgress(serverNow, status);

  // Subtle card tint by phase
  const cardTint =
    tone === 'success'
      ? 'from-emerald-500/[0.04] via-sky-500/[0.03] to-transparent'
      : tone === 'warning'
        ? 'from-amber-500/[0.05] to-transparent'
        : 'from-muted/30 to-transparent';

  return (
    <Card data-verify="market-session" className="group relative overflow-hidden border-border/60">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2.5px]', tone === 'success' ? 'bg-gradient-to-r from-emerald-500 to-sky-500' : tone === 'warning' ? 'bg-amber-500' : 'bg-border')} />
      <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br', cardTint)} />

      <CardContent className="relative px-3 py-2.5">
        {/* Row 1 — icon + status + IST + countdown (compact) */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm ring-1 ring-inset',
                tone === 'success'
                  ? 'bg-gradient-to-br from-emerald-500 to-emerald-600 text-white ring-emerald-500/20'
                  : tone === 'warning'
                    ? 'bg-gradient-to-br from-amber-500 to-orange-500 text-white ring-amber-500/20'
                    : 'bg-muted text-muted-foreground ring-border',
              )}
            >
              {isOpen ? <Sun className="h-4 w-4" /> : String(status).toUpperCase() === 'PRE_OPEN' ? <Hourglass className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Market Session</h2>
                <StatusBadge status={badgeStatus} label={phaseLabel(status)} />
              </div>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <Clock className="h-3 w-3 text-muted-foreground/60" /> {IST_FMT.format(serverNow)}
                </span>
                <span className="text-muted-foreground/30">·</span>
                <span>{tradingDay ? String(tradingDay).slice(0, 10) : IST_DATE_FMT.format(serverNow)}</span>
                {mode ? (
                  <>
                    <span className="text-muted-foreground/30">·</span>
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide">{String(mode)}</span>
                  </>
                ) : null}
              </p>
            </div>
          </div>

          {/* Countdown — prominent, colorful */}
          <div className="shrink-0 text-right">
            <p className="flex items-center justify-end gap-1 text-[10px] font-medium text-muted-foreground">
              {isOpen ? <TrendingUp className="h-3 w-3 text-emerald-500" /> : <Hourglass className="h-3 w-3 text-muted-foreground/60" />}
              {countdownText ? (isOpen ? 'Closes in' : 'Opens in') : isOpen ? 'Open' : 'Next'}
            </p>
            <p
              className={cn(
                'text-lg font-bold leading-none tracking-tight tabular-nums',
                isOpen ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground',
              )}
              title={targetIso ? String(targetIso) : undefined}
            >
              {countdownText ?? (market ? '—' : 'Loading…')}
            </p>
            <p className="text-[10px] tabular-nums text-muted-foreground">
              {isOpen && nextClose
                ? `Close ${new Date(nextClose).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })}`
                : !isOpen && nextOpen
                  ? `Open ${new Date(nextOpen).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })}`
                  : '\u00A0'}
            </p>
          </div>
        </div>

        {/* Row 2 — day class + timeline (no "Last update 5h ago") */}
        <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            {dayClassLabel(dayClass, closure) ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 text-sm font-semibold text-sky-500 ring-1 ring-inset ring-sky-500/30">
                <span className="text-[11px] font-bold uppercase tracking-wider text-sky-500/70">Day</span>
                {dayClassLabel(dayClass, closure)}
              </span>
            ) : (
              <span className="font-medium text-foreground">Trading calendar</span>
            )}
            {isOpen && progress != null && (
              <span className="text-[11px] tabular-nums">
                · <span className="font-bold text-emerald-600">{Math.round(progress * 100)}%</span> day complete
              </span>
            )}
            {nextTradingDay ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-1 text-sm font-semibold text-violet-500 ring-1 ring-inset ring-violet-500/30">
                <span className="text-[11px] font-bold uppercase tracking-wider text-violet-500/70">Next trading date</span>
                {nextTradingDay}
              </span>
            ) : null}
          </p>
          <div className="w-full sm:w-[300px]">
            <SessionTimeline status={status} progress={progress} />
          </div>
        </div>

        {/* Session progress bar when open */}
        {isOpen && progress != null && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-emerald-400 to-sky-500 transition-all duration-1000"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
