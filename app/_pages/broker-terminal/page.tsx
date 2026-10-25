'use client';

/**
 * SERVICES -> Trading -> Broker Terminal (Overview)
 *
 * The Broker Terminal ENGINE: every broker (Kotak Neo / Shoonya / Dummy Mode)
 * reported in ONE pass from GET /api/trading/brokers/overview, plus the
 * Combined aggregate (Kotak + Shoonya ONLY — Dummy's virtual capital is
 * excluded by the engine). Every number is real adapter output (or the paper
 * engine for Dummy, only AFTER the mode has actually been started). Adapters
 * that cannot serve a value render "—"/"N/A", never a fabricated number.
 *
 * DESIGN: a "control desk" hero → capital allocation → per-broker matrix →
 * session/alerts/health/funds. Machine tokens (`SESSION_ACTIVE`, `WS_ACTIVE`,
 * `NOT_LOGGED_IN`) are resolved to proper names via `broker-shared` so an
 * operator reads "Session Active", not the enum.
 *
 * "Total balance" falls back to the available margin when the broker reports
 * no balance field — the margin IS the account money for those feeds. Refresh =
 * POST /api/trading/brokers/refresh (invalidates the shared broker cache and
 * re-runs the engine for REAL broker reads), then a canonical GET. The System
 * Status strip + LIVE indicator read the ONE centralized realtime state
 * (RealtimeProvider), never a second poll.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ArrowUpRight,
  Bell,
  Check,
  Copy,
  Gauge,
  KeyRound,
  Landmark,
  Layers,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Waypoints,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LiveIndicator, SectionHeading, StatusBadge } from '@/components/design-system';
import {
  ACCENT_TEXT,
  TERMINAL_IDS,
  TERMINAL_META,
  InfoRow,
  MiniCard,
  SectionCardHead,
  SectionShell,
  SystemStatusStrip,
  maskId,
  pnlToneValue,
  sessionBadge,
  sessionManagerTs,
  sessionStateName,
  severityBadge,
  terminalTone,
} from '@/components/broker-terminal/broker-shared';
import {
  AllocationBar,
  AllocationLegend,
  BrokerHero,
  LiveDot,
  OrderLifecycleBar,
  PositionBar,
  RingGauge,
  StatTile,
  heroAccent,
  marginTone,
} from '@/components/broker-terminal/broker-visual';
import { BrokerCards } from '@/components/broker-terminal/broker-cards';
import { getBrokerTerminalOverview, getBrokersStatus, getSessionManagerSession, refreshBrokerOverview } from '@/lib/api';
import { useBackend } from '@/lib/use-backend';
import { ageLabel, useCountdown, useServerNow } from '@/lib/time-engine';
import { fmtPnl, fmtRs, toNum } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { useRealtime } from '@/components/realtime-provider';

// ===========================================================================
// HERO
// ===========================================================================

function OverviewHero({
  live,
  liveLabel,
  activeName,
  activeId,
  marketPhase,
  notice,
  busy,
  onRefresh,
}: {
  live: boolean;
  liveLabel: string;
  activeName: string;
  activeId: string | null;
  marketPhase: string | null;
  notice: string | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <BrokerHero accent={heroAccent(live ? 'success' : 'warning')}>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/30">
              <Waypoints className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-display sm:text-2xl">Broker Terminal</h1>
              <p className="text-xs text-muted-foreground">
                Every broker in one live pass · active: <span className="text-foreground">{activeName}</span>
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
              <LiveDot live={live} />
              {liveLabel}
            </span>
            {marketPhase ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-info/40 bg-info/10 px-2 py-0.5 text-[10px] font-semibold text-info">
                Market {String(marketPhase).toLowerCase()}
              </span>
            ) : null}
            {activeId ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                Trading on {TERMINAL_META[activeId]?.name ?? activeId}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning">
                No active terminal
              </span>
            )}
            {notice ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                {notice}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <LiveIndicator live={live} label={liveLabel} className="hidden lg:inline-flex" />
          <Button onClick={onRefresh} size="sm" className="gap-1.5" disabled={busy}>
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
        </div>
      </div>
    </BrokerHero>
  );
}

// ===========================================================================
// CAPITAL ALLOCATION
// ===========================================================================

function CapitalAllocation({
  overview,
}: {
  overview: Record<string, any> | null;
}) {
  const terminals = overview?.terminals ?? {};
  const combined = overview?.combined;

  const slices = TERMINAL_IDS.map((id) => ({
    id,
    label: TERMINAL_META[id].name,
    value: toNum(terminals[id]?.balance) ?? toNum(terminals[id]?.availableMargin),
  }));

  const connected = TERMINAL_IDS.filter((id) => terminals[id]?.connected).length;
  const realConnected = TERMINAL_IDS.filter(
    (id) => id !== 'dummy' && terminals[id]?.connected,
  ).length;
  const totalPnl = toNum(combined?.totalPnl);
  const totalBalance = toNum(combined?.balance) ?? toNum(combined?.availableMargin);
  const exposure = toNum(combined?.exposure);
  const invested = toNum(combined?.invested);
  const marginUsed = toNum(combined?.usedMargin);
  const marginAvail = toNum(combined?.availableMargin);
  const utilPct =
    marginUsed != null && marginAvail != null && marginAvail > 0
      ? Math.round((marginUsed / marginAvail) * 1000) / 10
      : null;
  const utilTone = marginTone(utilPct);

  const longQty = toNum(combined?.longQty);
  const shortQty = toNum(combined?.shortQty);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <SectionShell className="lg:col-span-2">
        <SectionCardHead
          icon={Landmark}
          title="Capital allocation"
          tone="blue"
          right={
            <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              Kotak + Shoonya only · Dummy excluded
            </span>
          }
        />

        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Combined capital</p>
            <p
              className={cn(
                'truncate text-3xl font-bold tracking-display tabular-nums',
                totalBalance == null && 'text-lg font-medium text-muted-foreground',
              )}
            >
              {totalBalance == null ? 'N/A' : fmtRs(totalBalance)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Combined P&amp;L</p>
            <p className={cn('truncate text-xl font-bold tabular-nums', ACCENT_TEXT[pnlToneValue(totalPnl)])}>
              {fmtPnl(totalPnl)}
            </p>
          </div>
        </div>

        <AllocationBar slices={slices} total={totalBalance} height={12} />
        <div className="mt-2">
          <AllocationLegend slices={slices} total={totalBalance} />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MiniCard label="Invested" value={fmtRs(invested)} />
          <MiniCard label="Exposure" value={fmtRs(exposure)} />
          <MiniCard label="Used margin" value={fmtRs(marginUsed)} />
          <MiniCard label="Available" value={fmtRs(marginAvail)} tone="success" />
        </div>

        <div className="mt-4 grid gap-4 border-t border-border/50 pt-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Long / short exposure</span>
              <span className="font-mono tabular-nums">
                {longQty ?? '—'} / {shortQty ?? '—'}
              </span>
            </div>
            <PositionBar long={longQty} short={shortQty} />
            <div className="mt-1.5 flex gap-3 text-[9px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-success" /> Long
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-destructive" /> Short
              </span>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Order lifecycle</span>
              <span className="font-mono tabular-nums">{combined?.orders?.total ?? '—'} total</span>
            </div>
            <OrderLifecycleBar orders={combined?.orders} />
            <div className="mt-1.5 flex flex-wrap gap-2 text-[9px] text-muted-foreground">
              {(['open', 'pending', 'completed', 'rejected'] as const).map((k) => (
                <span key={k} className="flex items-center gap-1">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      k === 'open'
                        ? 'bg-info'
                        : k === 'pending'
                          ? 'bg-warning'
                          : k === 'completed'
                            ? 'bg-success'
                            : 'bg-destructive',
                    )}
                  />
                  {k} {combined?.orders?.[k] ?? 0}
                </span>
              ))}
            </div>
          </div>
        </div>
      </SectionShell>

      <div className="space-y-4">
        <SectionShell>
          <SectionCardHead icon={GaugeIcon} title="Margin utilisation" tone={utilTone} />
          <div className="flex flex-col items-center gap-3">
            <RingGauge
              value={utilPct}
              max={100}
              label="used vs available"
              tone={marginTone(utilPct)}
              live
            />
            {utilPct != null && utilPct > 100 ? (
              <p className="text-center text-[11px] font-medium text-destructive">
                Margin utilisation above 100% — the account is over the line.
              </p>
            ) : (
              <p className="text-center text-[10px] leading-snug text-muted-foreground">
                Used margin ÷ available margin, straight from the engine aggregate.
              </p>
            )}
          </div>
        </SectionShell>

        <SectionShell>
          <SectionCardHead icon={Activity} title="Broker reach" tone="teal" />
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-muted-foreground">Terminals online</span>
              <span className="font-mono text-sm font-semibold tabular-nums">
                {connected}
                <span className="text-muted-foreground">/{TERMINAL_IDS.length}</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-muted-foreground">Real-money brokers</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-success">
                {realConnected}
                <span className="text-muted-foreground">/2</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-muted-foreground">Aggregate engine</span>
              <StatusBadge
                status={combined?.connected ? 'success' : 'neutral'}
                label={combined?.connected ? 'LIVE' : 'NO SOURCE'}
              />
            </div>
          </div>
        </SectionShell>
      </div>
    </div>
  );
}

function GaugeIcon({ className }: { className?: string }) {
  return <Gauge className={cn('h-3 w-3', className)} aria-hidden />;
}

// ===========================================================================
// SESSION
// ===========================================================================

function SessionCard() {
  const rt = useRealtime();
  const { data: session } = useBackend(getSessionManagerSession);
  const sm = session?.data ?? session;
  const identity = sm?.identity ?? {};
  const lifecycle = sm?.lifecycle ?? {};
  const state = lifecycle?.state ?? rt.sessionStatus;
  const sessionStateBadge = sessionBadge(String(state ?? ''), rt.sessionActive === true ? true : undefined);
  const stateName = sessionStateName(String(state ?? ''));
  const cd = useCountdown(identity?.expiresAt);
  const remaining = cd?.text ?? (identity?.remainingSeconds ? `${identity.remainingSeconds}s` : null);

  const terminalLabel =
    identity?.broker ? `${identity.mode} · ${identity.broker}` : rt.state?.terminalBroker ?? rt.state?.terminal ?? '—';

  return (
    <SectionShell>
      <SectionCardHead
        icon={KeyRound}
        title="Session"
        tone="violet"
        right={
          <Button size="sm" variant="ghost" asChild className="h-6 px-2 text-[11px]">
            <Link href="/services/session-manager">Details <ArrowUpRight className="ml-1 h-3 w-3" /></Link>
          </Button>
        }
      />
      <div className="space-y-0.5">
        <InfoRow label="Active terminal" value={terminalLabel} />
        <InfoRow label="Session state" value={<StatusBadge status={sessionStateBadge.status} label={sessionStateBadge.label} />} />
        {stateName?.blurb ? (
          <p className="pb-1 text-[10px] italic leading-snug text-muted-foreground">{stateName.blurb}</p>
        ) : null}
        <InfoRow label="Session ID" value={<span className="font-mono">{maskId(identity?.sessionId)}</span>} mono />
        <InfoRow label="Lifecycle" value={lifecycle?.lifecycleState ?? lifecycle?.state ?? rt.sessionStatus} />
        <InfoRow label="WS state" value={rt.brokerWsState} />
        <InfoRow label="Struct" value={remaining ? `ttl ${remaining}` : 'not active'} />
        <InfoRow label="Last activity" value={sessionManagerTs(identity?.loginTime)} />
      </div>
    </SectionShell>
  );
}

// ===========================================================================
// ALERTS
// ===========================================================================

function AlertsCard() {
  const rt = useRealtime();
  const { unreadCount, activeAlerts, latestAlerts } = rt.notificationsState;
  const alerts = (latestAlerts ?? []).slice(0, 4);
  const now = useServerNow();

  return (
    <SectionShell>
      <SectionCardHead
        icon={Bell}
        title="Alerts"
        tone="warning"
        right={
          <div className="flex items-center gap-1.5">
            <Badge variant="outline">{activeAlerts} active</Badge>
            <Badge variant="outline">{unreadCount} unread</Badge>
          </div>
        }
      />
      {alerts.length === 0 ? (
        <EmptyState icon={Bell} title="No active alerts" description="Honest zero — nothing is being flagged right now." className="py-8" />
      ) : (
        <div className="divide-y divide-border/60">
          {alerts.map((a, i) => {
            const badge = severityBadge(a?.severity);
            const ago = ageLabel(a?.created_at ?? a?.triggered_at ?? a?.first_seen_at, now);
            return (
              <div key={i} className="flex items-start justify-between gap-2 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{a?.title ?? a?.message ?? a?.component ?? 'Alert'}</p>
                  <p className="truncate text-[10px] tabular-nums text-muted-foreground">
                    {a?.symbol ? `${a.symbol} · ` : ''}{ago ?? '—'}
                    {a?.occurrence_count && a.occurrence_count > 1 ? ` · ×${a.occurrence_count}` : ''}
                  </p>
                </div>
                <StatusBadge status={badge.status} label={badge.label} className="shrink-0" />
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2">
        <Button size="sm" variant="ghost" asChild className="h-6 px-2 text-[11px]">
          <Link href="/services/notifications">Open Notification Center <ArrowUpRight className="ml-1 h-3 w-3" /></Link>
        </Button>
      </div>
    </SectionShell>
  );
}

// ===========================================================================
// BROKER HEALTH MATRIX
// ===========================================================================

function BrokerHealthMatrix({ status, now }: { status: Record<string, any> | null; now: number }) {
  const rows = status?.terminals ?? [];

  return (
    <SectionShell>
      <SectionCardHead
        icon={Activity}
        title="Broker Health"
        tone="teal"
        right={
          <Button size="sm" variant="ghost" asChild className="h-6 px-2 text-[11px]">
            <Link href="/services/connection-manager">Connections <ArrowUpRight className="ml-1 h-3 w-3" /></Link>
          </Button>
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon={Activity} title="No terminal data" description="GET /api/trading/brokers/status returned nothing yet." className="py-8" />
      ) : (
        <div className="space-y-2">
          {rows.map((r: Record<string, any>) => {
            const enabled = r?.enabled !== false;
            const loggedIn = Boolean(r?.isLoggedIn);
            const age = ageLabel(r?.updatedAt, now);
            const proper = sessionStateName(r?.sessionState);
            const tone = terminalTone(r?.id);
            return (
              <Link
                key={r?.id}
                href={`/services/broker-terminal/profile/${r?.id}`}
                className={cn(
                  'group flex items-center justify-between gap-2 rounded-lg border border-border/50 px-2.5 py-2 transition-colors hover:border-border hover:bg-muted/30',
                  r?.isActive && 'border-primary/40 bg-primary/[0.06]',
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: terminalHueColor(r?.id, tone) }}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{r?.name ?? TERMINAL_META[r?.id]?.name ?? r?.id}</p>
                    <p className="truncate text-[10px] text-muted-foreground" title={proper?.blurb}>
                      {proper?.label ?? r?.sessionState ?? '—'} · {age ?? 'never synced'}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {r?.isActive ? <Badge className="border-primary/40 bg-primary/15 text-primary">ACTIVE</Badge> : null}
                  <StatusBadge
                    status={!enabled ? 'warning' : loggedIn ? 'success' : 'danger'}
                    label={!enabled ? 'Not configured' : loggedIn ? 'Connected' : 'Logged out'}
                  />
                  <ArrowUpRight className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {status?.terminals ? (
        <p className="mt-2 truncate text-[10px] tabular-nums text-muted-foreground">
          engine time · {sessionManagerTs(status?.generatedAt)}
        </p>
      ) : null}
    </SectionShell>
  );
}

function terminalHueColor(id: string, _tone: string): string {
  switch (id) {
    case 'kotak':
      return 'hsl(217 91% 60%)';
    case 'shoonya':
      return 'hsl(25 95% 53%)';
    case 'dummy':
      return 'hsl(142 70% 45%)';
    default:
      return 'hsl(var(--muted-foreground))';
  }
}

// ===========================================================================
// ACCOUNT & FUNDS
// ===========================================================================

function AccountFundsCard({ combined, generatedAt, now }: { combined: Record<string, any> | undefined; generatedAt?: string; now: number }) {
  const balance = toNum(combined?.balance) ?? toNum(combined?.availableMargin);
  const used = toNum(combined?.usedMargin);
  const avail = toNum(combined?.availableMargin);
  const cash = toNum(combined?.cash);
  const exposure = toNum(combined?.exposure);
  const invested = toNum(combined?.invested);
  const currentValue = toNum(combined?.currentValue);
  const pnl = toNum(combined?.totalPnl);
  const charges = toNum(combined?.totalCharges);

  const utilPct = used != null && avail != null && avail > 0 ? Math.round((used / avail) * 1000) / 10 : null;

  return (
    <SectionShell>
      <SectionCardHead
        icon={Landmark}
        title="Account & Funds"
        tone="blue"
        right={
          <Button size="sm" variant="ghost" asChild className="h-6 px-2 text-[11px]">
            <Link href="/services/broker-terminal/profile/combined">Details <ArrowUpRight className="ml-1 h-3 w-3" /></Link>
          </Button>
        }
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total balance</p>
          <p className={cn('truncate text-2xl font-bold tracking-display tabular-nums', balance == null && 'font-medium text-muted-foreground')}>
            {balance == null ? 'N/A' : fmtRs(balance)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total P&amp;L</p>
            <p className={cn('truncate text-base font-bold tabular-nums', ACCENT_TEXT[pnlToneValue(pnl)])}>{fmtPnl(pnl)}</p>
          </div>
          {pnl != null && pnl !== 0 ? (
            <span
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-lg',
                pnl > 0 ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
              )}
            >
              {pnl > 0 ? <TrendingUp className="h-4 w-4" aria-hidden /> : <TrendingDown className="h-4 w-4" aria-hidden />}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <MiniCard label="Available margin" value={fmtRs(avail)} tone="success" />
        <MiniCard label="Used margin" value={fmtRs(used)} tone={utilPct != null && utilPct > 100 ? 'danger' : 'neutral'} />
        <MiniCard label="Margin util." value={utilPct == null ? '—' : `${utilPct}%`} tone={utilPct == null ? 'neutral' : utilPct > 100 ? 'danger' : utilPct > 70 ? 'warning' : 'success'} />
        <MiniCard label="Cash" value={fmtRs(cash)} />
        <MiniCard label="Exposure" value={fmtRs(exposure)} />
        <MiniCard label="Invested" value={fmtRs(invested)} />
        <MiniCard label="Current value" value={fmtRs(currentValue)} />
        <MiniCard label="Charges" value={fmtRs(charges)} />
      </div>

      <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
        updated {ageLabel(generatedAt, now) ?? '—'}
      </p>
    </SectionShell>
  );
}

// ===========================================================================
// PAGE
// ===========================================================================

export default function BrokerTerminalPage() {
  const router = useRouter();
  const rt = useRealtime();
  const now = useServerNow();
  const { data, error, loading, refresh } = useBackend(getBrokerTerminalOverview);
  const { data: status, refresh: refreshStatus } = useBackend(getBrokersStatus);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const { copy, copied } = useCopyLocal();

  const combined = data?.combined;
  const activeId = data?.active ?? null;
  const activeName = activeId
    ? (TERMINAL_META[activeId]?.name ?? activeId)
    : (rt.state?.terminalBroker ?? '—');
  const marketPhase = rt.marketState?.phase ?? rt.marketState?.state ?? null;

  // Refresh = POST (invalidate cache + real engine re-run) then a canonical GET.
  const handleRefresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await refreshBrokerOverview();
      refresh();
      refreshStatus();
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : 'refresh failed';
      // An aborted/cancelled request is not a failure — stay quiet.
      setNotice(/aborted/i.test(msg) ? null : msg);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refresh, refreshStatus]);

  // Re-sync the overview when the ONE realtime stream re-establishes (reconnect).
  const prevConnRef = useRef(rt.appConnection);
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = rt.appConnection;
    if ((prev === 'RECONNECTING' || prev === 'DISCONNECTED' || prev === 'OFFLINE') && rt.appConnection === 'CONNECTED') {
      refresh();
    }
  }, [rt.appConnection, refresh]);

  const live = rt.appConnection === 'CONNECTED';
  const liveLabel = !rt.hydrated
    ? 'Connecting…'
    : live
      ? 'LIVE'
      : rt.appConnection === 'CONNECTING'
        ? 'Connecting'
        : rt.appConnection === 'RECONNECTING'
          ? 'Reconnecting'
          : rt.appConnection === 'OFFLINE'
            ? 'Offline'
            : 'Disconnected';

  const brokerRows = useMemo(
    () =>
      TERMINAL_IDS.map((id) => ({
        id,
        row: (data?.terminals ?? {})[id],
      })),
    [data],
  );

  const connectedCount = brokerRows.filter((b) => b.row?.connected).length;

  return (
    <div className="space-y-6">
      <OverviewHero
        live={live}
        liveLabel={liveLabel}
        activeName={activeName}
        activeId={activeId}
        marketPhase={marketPhase}
        notice={notice}
        busy={busy}
        onRefresh={handleRefresh}
      />

      {/* Quick stat strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatTile label="Brokers" value={TERMINAL_IDS.length} icon={Waypoints} />
        <StatTile label="Online" value={`${connectedCount}/${TERMINAL_IDS.length}`} tone={connectedCount > 0 ? 'text-success' : 'text-muted-foreground'} icon={ShieldCheck} />
        <StatTile label="Active" value={activeId ? TERMINAL_META[activeId]?.name ?? activeId : 'none'} tone={activeId ? 'text-primary' : 'text-warning'} icon={Zap} />
        <StatTile label="Positions" value={combined?.positionCount ?? '—'} icon={Layers} />
        <StatTile label="Open orders" value={combined?.orders?.open ?? '—'} tone={(combined?.orders?.open ?? 0) > 0 ? 'text-warning' : 'text-foreground'} icon={Activity} />
      </div>

      {!data && error ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <SectionHeading>Broker Connections</SectionHeading>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[11px]"
                  onClick={() => void copy(JSON.stringify(data, null, 2))}
                >
                  {copied ? <Check className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                  {copied ? 'Copied' : 'Copy JSON'}
                </Button>
                <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11px]" onClick={() => router.push('/services/broker-terminal/terminals')}>
                  <RotateCcw className="h-3 w-3" aria-hidden />
                  Configure
                </Button>
              </div>
            </div>
            <BrokerCards overview={data} loading={loading} />
          </section>

          <section className="space-y-3">
            <SectionHeading>Capital &amp; Risk</SectionHeading>
            <CapitalAllocation overview={data} />
          </section>

          <section className="space-y-3">
            <SectionHeading>Operations</SectionHeading>
            <div className="grid gap-4 lg:grid-cols-2">
              <SessionCard />
              <AlertsCard />
              <BrokerHealthMatrix status={status} now={now} />
              <AccountFundsCard combined={combined} generatedAt={data?.generatedAt} now={now} />
            </div>
          </section>

          <section className="space-y-3">
            <SectionHeading>System Status</SectionHeading>
            <SystemStatusStrip />
          </section>
        </>
      )}
    </div>
  );
}

/** Local clipboard helper (Copy JSON on the overview only). */
function useCopyLocal() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try {
      if (!navigator?.clipboard?.writeText) return;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard denied — stay silent, the page must not break */
    }
  }, []);
  return { copied, copy };
}