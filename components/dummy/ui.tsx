'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Clock, Landmark, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatISTTime, formatIST } from '@/lib/ist';
import { useCountdown as useServerCountdown, countdownParts } from '@/lib/time-engine';
import {
  LiveIndicator,
  SectionCard,
  StatusBadge,
} from '@/components/design-system';
import { useRealtime } from '@/components/realtime-provider';
import {
  useDummyTheme,
  accentHex,
  ACCENT_TONE,
  activeAccentHex,
  DENSITY_GAP,
  FONT_SIZE,
} from '@/lib/dummy-theme';
import { sessionLabel, type DummySession, type MarketSnapshot } from '@/lib/dummy';

export function DummyThemedPage({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const theme = useDummyTheme();
  return (
    <div
      className={cn(DENSITY_GAP[theme.density], className)}
      data-dummy-appearance={theme.appearance}
      style={{
        ['--dummy-accent' as string]: activeAccentHex(theme),
        ['--dummy-accent-full' as string]: accentHex(theme.accent),
        colorScheme: theme.appearance === 'auto' ? 'light dark' : theme.appearance,
        fontSize: FONT_SIZE[theme.fontScale],
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live pulse — a subtle, calm highlight when a real-time value changes.
// No fabricated values: it only flashes on genuinely changed backend values.
// ---------------------------------------------------------------------------

function useFlashed(value: unknown): boolean {
  const prev = useRef<unknown>(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (value !== prev.current) {
      prev.current = value;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 800);
      return () => clearTimeout(t);
    }
  }, [value]);
  return flash;
}

export function LivePulse({
  value,
  children,
  className,
  pulseClass,
}: {
  value: unknown;
  children: React.ReactNode;
  className?: string;
  pulseClass?: string;
}) {
  const flash = useFlashed(value);
  return (
    <span
      data-live-pulse={flash ? 'true' : 'false'}
      className={cn(
        'transition-colors duration-700 ease-out',
        flash ? (pulseClass ?? 'bg-primary/10') : undefined,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function useCountdownTo(target: string | null | undefined): string | null {
  // Server-anchored countdown (lib/time-engine): the shared clock offsets to the
  // backend /api/system/time once, so the interval is never a fake client clock.
  const { ms } = useServerCountdown(target);
  if (ms == null) return null;
  if (ms <= 0) return 'now';
  const { h, m, s } = countdownParts(ms);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

// ---------------------------------------------------------------------------
// Premium Market Session card — the first, full-width dashboard section.
// Every value comes from the real backend MarketSnapshot; nothing is assumed.
// ---------------------------------------------------------------------------

export function MarketSessionCard({
  market,
  session,
  connected,
  lastUpdate,
}: {
  market?: MarketSnapshot | null;
  session?: DummySession | null;
  /** live websocket state from the single market-data pipeline */
  connected?: boolean | null;
  lastUpdate?: string | null;
}) {
  const theme = useDummyTheme();
  const accent = activeAccentHex(theme);
  const { brokerWsState } = useRealtime();
  const countdownOpen = useCountdownTo(market?.next_market_open);
  const countdownClose = useCountdownTo(market?.next_market_close);
  if (!market && !session) {
    return (
      <SectionCard title="Market Session" icon={CalendarClock}>
        <div className="text-sm text-muted-foreground">Session state unavailable.</div>
      </SectionCard>
    );
  }
  const open = market?.market_status === 'OPEN';
  const sessionOpen = session?.status === 'OPEN';
  const nowIst = market?.now_ist ? formatISTTime(market.now_ist) : null;

  return (
    <div
      className="relative overflow-hidden rounded-xl border border-border bg-card"
      data-verify="Market Session"
      style={{
        ['--pulse-accent' as string]: accent,
      }}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: `linear-gradient(90deg, ${accent}, transparent 70%)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: `linear-gradient(150deg, color-mix(in srgb, ${accent} 7%, transparent), transparent 55%)` }}
      />
      <div className="relative flex flex-col gap-4 p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)`, color: accent }}
            >
              <CalendarClock className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Market Session
              </p>
              <div className="flex items-center gap-2">
                <StatusBadge
                  status={open ? 'success' : market?.market_session === 'PRE_OPEN' ? 'warning' : 'neutral'}
                  label={market?.market_session === 'OPEN' ? 'OPEN' : market?.market_session === 'PRE_OPEN' ? 'PRE-OPEN' : market?.market_session || 'CLOSED'}
                />
                <span className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-xs font-semibold text-sky-500 ring-1 ring-inset ring-sky-500/30">
                  {market?.day_class === 'NORMAL_MARKET_DAY' ? 'Normal day' : market?.day_class ? String(market.day_class).replace(/_/g, ' ') : '—'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Trading date (IST)</p>
            <p className="font-semibold tabular-nums">{market?.tradingDate || market?.market_date || '—'}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Next trading date</p>
            <p className="inline-flex items-center rounded-full bg-violet-500/10 px-2 py-0.5 text-sm font-semibold text-violet-500 ring-1 ring-inset ring-violet-500/30 tabular-nums">
              {market?.next_trading_day ?? (market?.next_market_open ? market.next_market_open.slice(0, 10) : '—')}
            </p>
          </div>
          {nowIst ? (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Now (IST)</p>
              <p className="font-semibold tabular-nums">{nowIst}</p>
            </div>
          ) : null}
          {session ? (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Dummy session</p>
              <p className="font-semibold tabular-nums">{session.sessionId}</p>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:min-w-[260px]">
          <div className="flex-1 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Clock className="h-3 w-3" /> Next open
            </p>
            <p className="text-sm font-semibold tabular-nums">
              {market?.next_market_open
                ? formatIST(market.next_market_open, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '—'}
            </p>
            {countdownOpen && <p className="text-[11px] tabular-nums text-muted-foreground">in {countdownOpen}</p>}
          </div>
          <div className="flex-1 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Clock className="h-3 w-3" /> Next close
            </p>
            <p className="text-sm font-semibold tabular-nums">
              {market?.next_market_close
                ? formatIST(market.next_market_close, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '—'}
            </p>
            {countdownClose && <p className="text-[11px] tabular-nums text-muted-foreground">in {countdownClose}</p>}
          </div>
        </div>
      </div>

      <div className="relative border-t border-border/50 px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: market?.market_session === 'OPEN' ? '58%' : market?.market_session === 'PRE_OPEN' ? '15%' : '100%',
                background: market?.market_session === 'OPEN' ? accent : 'hsl(var(--muted-foreground) / 0.3)',
              }}
            />
          </div>
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {market?.market_session === 'OPEN' ? 'Live Session' : market?.market_session === 'PRE_OPEN' ? 'Pre-Open' : 'Session Closed'}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Backwards-compatible alias — the Dummy dashboard now uses MarketSessionCard. */
export function SessionCard(props: Parameters<typeof MarketSessionCard>[0]) {
  return <MarketSessionCard {...props} />;
}

export function DummyBadge() {
  const theme = useDummyTheme();
  return (
    <div
      className="inline-flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1 text-xs font-semibold tracking-wide"
      style={{ color: `var(--dummy-accent, ${accentHex(theme.accent)})` }}
    >
      <ShieldCheck className="h-3.5 w-3.5" />
      SIMULATION ACTIVE
    </div>
  );
}

export function AccentToneBadge({ tone }: { tone: keyof typeof ACCENT_TONE | (typeof ACCENT_TONE)[keyof typeof ACCENT_TONE] }) {
  const label = typeof tone === 'string' && tone in ACCENT_TONE ? (ACCENT_TONE as Record<string, string>)[tone] : tone;
  const theme = useDummyTheme();
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ backgroundColor: `color-mix(in srgb, ${accentHex(theme.accent)} 18%, transparent)`, color: accentHex(theme.accent) }}
    >
      {String(label)}
    </span>
  );
}

export function VirtualFundsNote() {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Landmark className="h-3.5 w-3.5" />
      Virtual capital — no real funds are used by the Dummy terminal.
    </div>
  );
}