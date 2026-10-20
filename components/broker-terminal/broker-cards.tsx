'use client';

// The four Broker Terminal cards — ONE shared source across every phase.
//
// Used on:
//   - Broker Terminal overview (/services/broker-terminal) — prop-driven
//   - Phase 1 trading dashboard (standard + Dummy Mode) — self-loading
//
// Data = GET /api/trading/brokers/overview (honest per-broker envelope from
// build_terminal_overview). "Total balance" falls back to available margin
// when the feed omits a balance field. Combined = Kotak + Shoonya ONLY —
// Dummy's virtual capital is excluded and labelled. View Details opens the
// full Broker Profile page, Trade goes to the trading terminal.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight, Gauge, Landmark, Layers, MoreVertical, PlugZap, RefreshCw, Settings2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  CARD_TONE, ErrorState, SectionHeading, StatusBadge, type AccentTone,
} from '@/components/design-system';
import {
  ACCENT_TEXT, ACTIVE_BADGE_CLS, MiniCard, TERMINAL_META, pnlToneValue,
  sessionBadge, type Tone,
} from './broker-shared';
import { getBrokerTerminalOverview, refreshBrokerOverview } from '@/lib/api';
import { useBackend } from '@/lib/use-backend';
import { ageLabel, useServerNow } from '@/lib/time-engine';
import { fmtPnl, fmtQty, fmtRs, toNum } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { useRealtime } from '@/components/realtime-provider';

const profileHref = (id?: string) => `/services/broker-terminal/profile/${id ?? 'kotak'}`;

/** Per-broker card (Kotak / Shoonya / Dummy) — mini metrics, honest "N/A". */
export function BrokerCard({ id, row, tone, sub, now, loading }: {
  id: string;
  row: Record<string, any> | undefined;
  tone: AccentTone;
  sub: string;
  now: number;
  loading: boolean;
}) {
  const t = CARD_TONE[tone];
  const meta = TERMINAL_META[id] ?? { name: id, sub, icon: Layers, tone };
  const Icon = meta?.icon ?? Layers;
  const connected = Boolean(row?.connected);
  const enabled = row?.enabled !== false;
  const isActive = Boolean(row?.active);
  // Balance falls back to the available margin (the real account money) when
  // the broker feed omits a separate balance field.
  const balance = toNum(row?.balance) ?? toNum(row?.availableMargin);
  const used = toNum(row?.usedMargin);
  const avail = toNum(row?.availableMargin);
  const exposure = toNum(row?.exposure);
  const invested = toNum(row?.invested);
  const pnl = toNum(row?.totalPnl);
  const realized = toNum(row?.realizedPnl);
  const unrealized = toNum(row?.unrealizedPnl);
  const orders = row?.orders ?? {};
  const age = ageLabel(row?.updatedAt, now);
  const badge: { status: Tone; label: string } = row?.connected
    ? sessionBadge(row?.sessionState, true)
    : { status: 'danger', label: 'NOT CONNECTED' };
  const message = row?.message ?? row?.lastError;

  return (
    <Card
      data-verify={`broker-card-${id}`}
      className={cn('group relative h-full overflow-hidden transition-all duration-200 hover:-translate-y-0.5', t.border, t.restShadow, t.hoverBorder, t.hoverShadow)}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2px]', t.bar)} />
      <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent', t.tint)} />
      <CardContent className="relative flex h-full flex-col gap-3 px-4 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset', t.icon)}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{row?.name ?? meta?.name ?? id}</p>
              <p className="truncate text-[10px] text-muted-foreground">{sub}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {isActive && <Badge className={ACTIVE_BADGE_CLS}>ACTIVE</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`${row?.name ?? id} actions`}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem asChild>
                  <Link href={profileHref(id)}><ArrowUpRight className="mr-2 h-3.5 w-3.5" /> View Broker Profile</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/trading/trade"><Gauge className="mr-2 h-3.5 w-3.5" /> Trade</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/services/broker-terminal/terminals"><Settings2 className="mr-2 h-3.5 w-3.5" /> Configure in Terminals</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={badge.status} label={badge.label} />
          {!enabled && <StatusBadge status="warning" label="NOT CONFIGURED" />}
        </div>

        {loading ? (
          <>
            <div className="flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total balance</p>
                <p className="tabular-nums text-2xl font-bold tracking-tight text-muted-foreground/60">…</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <MiniCard label="Used margin" value="\u2014" loading />
              <MiniCard label="Available margin" value="\u2014" loading />
              <MiniCard label="Exposure" value="\u2014" loading />
              <MiniCard label="Invested" value="\u2014" loading />
              <MiniCard label="Open positions" value="\u2014" loading />
              <MiniCard label="Open orders" value="\u2014" loading />
            </div>

            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total P&L</p>
                <p className="tabular-nums text-lg font-bold text-muted-foreground/60">…</p>
              </div>
              <div className="min-w-0 text-right text-[10px] leading-4 text-muted-foreground/60 tabular-nums">
                <p>R … · UR …</p>
                <p>sync …</p>
              </div>
            </div>
          </>
        ) : !connected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-6 text-center">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted/70 text-muted-foreground">
              <PlugZap className="h-5 w-5" />
            </span>
            <p className="text-xs font-semibold text-muted-foreground">Not connected</p>
            <p className="max-w-[240px] text-[10px] leading-4 text-muted-foreground/75">
              {message && !/^(not connected|disconnected)/i.test(message.trim().replace(/[.\s]+$/, ''))
                ? message
                : 'Connect this broker to stream live balances, positions and orders.'}
            </p>
            {row?.lastError && (
              <p className="max-w-[240px] truncate text-[10px] leading-4 text-destructive/80">{row.lastError}</p>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total balance</p>
                <p className={cn('truncate text-2xl font-bold tracking-tight tabular-nums', balance == null && 'font-medium text-muted-foreground')}>
                  {balance == null ? 'N/A' : fmtRs(balance)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <MiniCard label="Used margin" value={fmtRs(used)} />
              <MiniCard label="Available margin" value={fmtRs(avail)} />
              <MiniCard label="Exposure" value={fmtRs(exposure)} />
              <MiniCard label="Invested" value={fmtRs(invested)} />
              <MiniCard
                label="Open positions"
                value={row?.positionCount == null ? '\u2014' : `${row.positionCount} (${fmtQty(toNum(row.longQty) ?? 0)}/${fmtQty(toNum(row.shortQty) ?? 0)})`}
              />
              <MiniCard
                label="Open orders"
                value={orders?.open == null ? '\u2014' : `${orders.open} open \u00b7 ${orders.pending ?? 0} pending`}
              />
            </div>

            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total P&L</p>
                <p className={cn('truncate text-lg font-bold tabular-nums', ACCENT_TEXT[pnlToneValue(pnl)])}>{fmtPnl(pnl)}</p>
              </div>
              <div className="min-w-0 text-right text-[10px] leading-4 text-muted-foreground tabular-nums">
                <p className="truncate">R {fmtPnl(realized)} · UR {fmtPnl(unrealized)}</p>
                <p className="truncate">sync {age ?? '\u2014'}</p>
              </div>
            </div>
          </>
        )}

        {!loading && connected && message && (
          <p className={cn('truncate text-[11px]', row?.lastError ? 'text-destructive' : 'text-muted-foreground')}>{message}</p>
        )}

        <div className="mt-1 flex items-center gap-2">
          <Button size="sm" variant="ghost" asChild className="flex-1"><Link href={profileHref(id)}>View Details</Link></Button>
          {connected ? (
            <Button size="sm" variant="outline" asChild className="flex-1"><Link href="/trading/trade">Trade</Link></Button>
          ) : (
            <Button size="sm" variant="outline" asChild className="flex-1">
              <Link href="/services/broker-terminal/terminals"><PlugZap className="mr-1 h-3.5 w-3.5" />{enabled ? 'Connect' : 'Configure'}</Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Combined Kotak + Shoonya card (Dummy's virtual capital excluded). */
export function CombinedBrokerCard({ combined, generatedAt, now, loading }: {
  combined: Record<string, any> | undefined;
  generatedAt?: string;
  now: number;
  loading: boolean;
}) {
  const tone: AccentTone = 'purple';
  const t = CARD_TONE[tone];
  const connected = Boolean(combined?.connected);
  const balance = toNum(combined?.balance) ?? toNum(combined?.availableMargin);
  const used = toNum(combined?.usedMargin);
  const avail = toNum(combined?.availableMargin);
  const exposure = toNum(combined?.exposure);
  const invested = toNum(combined?.invested);
  const currentValue = toNum(combined?.currentValue);
  const pnl = toNum(combined?.totalPnl);
  const orders = combined?.orders ?? {};

  return (
    <Card
      data-verify="combined-card"
      className={cn('group relative h-full overflow-hidden transition-all duration-200 hover:-translate-y-0.5', t.border, t.restShadow, t.hoverBorder, t.hoverShadow)}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2px]', t.bar)} />
      <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent', t.tint)} />
      <CardContent className="relative flex h-full flex-col gap-3 px-4 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset', t.icon)}>
              <Layers className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold">Combined</p>
              <p className="text-[10px] text-muted-foreground">Kotak + Shoonya only</p>
            </div>
          </div>
          <StatusBadge status={connected ? 'success' : 'neutral'} label={connected ? 'AGGREGATE' : 'NONE'} />
        </div>

{loading ? (
            <>
              <div className="flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total balance</p>
                  <p className="tabular-nums text-2xl font-bold tracking-tight text-muted-foreground/60">…</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <MiniCard label="Used margin" value="\u2014" loading />
                <MiniCard label="Available margin" value="\u2014" loading />
                <MiniCard label="Exposure" value="\u2014" loading />
                <MiniCard label="Invested" value="\u2014" loading />
                <MiniCard label="Current value" value="\u2014" loading />
                <MiniCard label="Open positions" value="\u2014" loading />
              </div>

              <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total P&L</p>
                  <p className="tabular-nums text-lg font-bold text-muted-foreground/60">…</p>
                </div>
                <div className="min-w-0 text-right text-[10px] leading-4 text-muted-foreground/60 tabular-nums">
                  <p>sync …</p>
                </div>
              </div>
            </>
          ) : !connected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-6 text-center">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted/70 text-muted-foreground">
                <Landmark className="h-5 w-5" />
              </span>
              <p className="text-xs font-semibold text-muted-foreground">No real terminals yet</p>
              <p className="max-w-[240px] text-[10px] leading-4 text-muted-foreground/75">
                Combined balance appears once a real broker (Kotak or Shoonya) connects.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total balance</p>
                  <p className={cn('truncate text-2xl font-bold tracking-tight tabular-nums', balance == null && 'font-medium text-muted-foreground')}>
                    {balance == null ? 'N/A' : fmtRs(balance)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <MiniCard label="Used margin" value={fmtRs(used)} />
                <MiniCard label="Available margin" value={fmtRs(avail)} />
                <MiniCard label="Exposure" value={fmtRs(exposure)} />
                <MiniCard label="Invested" value={fmtRs(invested)} />
                <MiniCard label="Current value" value={fmtRs(currentValue)} />
                <MiniCard
                  label="Open positions"
                  value={combined?.positionCount == null ? '\u2014' : String(combined.positionCount)}
                />
              </div>

              <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total P&L</p>
                  <p className={cn('truncate text-lg font-bold tabular-nums', ACCENT_TEXT[pnlToneValue(pnl)])}>{fmtPnl(pnl)}</p>
                </div>
                <div className="min-w-0 text-right text-[10px] leading-4 text-muted-foreground tabular-nums">
                  <p className="truncate">{orders?.open ?? '\u2014'} open orders · sync {ageLabel(generatedAt, now) ?? '\u2014'}</p>
                </div>
              </div>
            </>
          )}

        <div className="mt-1 flex items-center gap-2">
          <Button size="sm" variant="outline" asChild className="w-full"><Link href="/services/broker-terminal/profile/combined">View Details</Link></Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The 4-card grid — presentational, prop-driven (used by the Broker Terminal overview). */
export function BrokerCards({ overview, loading, className }: {
  overview: Record<string, any> | null;
  loading?: boolean;
  className?: string;
}) {
  const now = useServerNow();
  const terminals = overview?.terminals ?? {};
  const combined = overview?.combined;
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', className)}>
      {(['kotak', 'shoonya', 'dummy'] as const).map((id) => (
        <div key={id} data-verify={`broker-terminal-${id}`} className="h-full">
          <BrokerCard
            id={id}
            row={terminals?.[id] as Record<string, any> | undefined}
            tone={id === 'shoonya' ? 'orange' : id === 'dummy' ? 'success' : 'blue'}
            sub={TERMINAL_META[id]?.sub ?? ''}
            now={now}
            loading={loading ?? false}
          />
        </div>
      ))}
      <div data-verify="combined-portfolio" className="h-full">
        <CombinedBrokerCard combined={combined} generatedAt={overview?.generatedAt} now={now} loading={loading ?? false} />
      </div>
    </div>
  );
}

/**
 * Self-loading "Broker Terminals" section for the Phase 1 trading dashboard —
 * replaces the old BrokerTerminals + BrokerDataLiveSection cards with the SAME
 * four cards as the Broker Terminal overview. Refresh = POST (invalidate cache
 * + real engine re-run) then a canonical GET.
 */
export function BrokerCardsSection({ heading = 'Broker Terminals', reloadKey = 0, sub }: {
  heading?: string;
  reloadKey?: number;
  sub?: string;
}) {
  const rt = useRealtime();
  const { data, error, loading, refresh } = useBackend(getBrokerTerminalOverview);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (reloadKey > 0) refresh();
    // reloadKey intentionally drives keyed re-fetch; refresh is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const prevConnRef = useRef(rt.appConnection);
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = rt.appConnection;
    if ((prev === 'RECONNECTING' || prev === 'DISCONNECTED' || prev === 'OFFLINE') && rt.appConnection === 'CONNECTED') {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt.appConnection]);

  const handleRefresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await refreshBrokerOverview();
      refresh();
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : '';
      if (/aborted/i.test(msg) || /timed out|timeout/i.test(msg)) return;
      console.error('broker refresh failed', e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refresh]);

  return (
    <section aria-label="Broker Terminals" data-verify="broker-terminals-section" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex-1">
          <SectionHeading>{heading}</SectionHeading>
          {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
        </div>
        <Button size="sm" variant="outline" onClick={handleRefresh} disabled={loading || busy}>
          <RefreshCw className={cn('mr-1 h-3.5 w-3.5', busy && 'animate-spin')} /> Refresh
        </Button>
      </div>
      {!data && error ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : (
        <BrokerCards overview={data} loading={loading} />
      )}
    </section>
  );
}