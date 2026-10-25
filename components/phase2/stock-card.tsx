'use client';

// Horizontal stock card for the Live Tick page.
//
// Creamy, theme-aware surface on the same `ds-*` system as the dashboard. The
// top rail is colour-coded by the REAL feed status, the LTP flashes green/red
// when the price moves, and the tick age ticks live from the `now` prop (one
// clock on the page, not one interval per card).
//
// All data is real — no placeholders, no "--", no invented zeros.

import { memo, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LiveStock, StockStatus, DepthRow } from '@/hooks/use-live-stocks';
import { fmtPrice, fmtNumber, fmtCompact, sign } from '@/components/design-system';
import { cn } from '@/lib/utils';

export interface StockCardProps {
  stock: LiveStock;
  connected: boolean;
  marketClosed: boolean;
  now: number;
  index?: number;
}

/** Rail + pill styling per real feed status. */
const STATUS_CONFIG: Record<StockStatus, {
  rail: string; pill: string; text: string; dot: string; label: string;
}> = {
  LIVE: { rail: 'from-emerald-400/70 to-teal-400/40', pill: 'border-success/25 bg-success/10 text-success', text: 'text-success', dot: 'bg-success', label: 'LIVE' },
  STALE: { rail: 'from-amber-400/70 to-orange-400/40', pill: 'border-warning/25 bg-warning/10 text-warning', text: 'text-warning', dot: 'bg-warning', label: 'STALE' },
  WAITING: { rail: 'from-amber-400/60 to-yellow-300/30', pill: 'border-warning/25 bg-warning/10 text-warning', text: 'text-warning', dot: 'bg-warning', label: 'WAITING' },
  DISCONNECTED: { rail: 'from-destructive/50 to-rose-300/30', pill: 'border-destructive/25 bg-destructive/10 text-destructive', text: 'text-destructive', dot: 'bg-destructive', label: 'OFFLINE' },
  ERROR: { rail: 'from-destructive/60 to-rose-300/30', pill: 'border-destructive/25 bg-destructive/10 text-destructive', text: 'text-destructive', dot: 'bg-destructive', label: 'ERROR' },
  MARKET_CLOSED: { rail: 'from-slate-400/50 to-slate-300/25', pill: 'border-border/60 bg-muted/40 text-muted-foreground', text: 'text-muted-foreground', dot: 'bg-muted-foreground/50', label: 'CLOSED' },
  UNSUBSCRIBED: { rail: 'from-slate-400/40 to-slate-300/20', pill: 'border-border/60 bg-muted/40 text-muted-foreground', text: 'text-muted-foreground', dot: 'bg-muted-foreground/30', label: 'NOT SUBSCRIBED' },
};

function statusReason(stock: LiveStock, connected: boolean, marketClosed: boolean, now: number): string {
  if (marketClosed && !connected) return 'Market closed — feed intentionally stopped by the scheduler';
  if (!connected && stock.tickCount === 0) return 'WebSocket disconnected — waiting for connection';
  if (!stock.subscribed && !stock.wsSubscribed) return 'Not subscribed — subscribe from the Stock Subscription page';
  if (stock.tickCount === 0) return 'Subscribed but no tick received yet';
  if (stock.lastTickAtMs && now - stock.lastTickAtMs > 15_000) {
    return `No tick for ${Math.floor((now - stock.lastTickAtMs) / 1000)}s — feed may be stale`;
  }
  if (stock.tickCount > 0) return `${fmtNumber(stock.tickCount)} ticks received this session — feed active`;
  return 'Awaiting data';
}

function toIst(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-IN', {
      hour12: false, timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return ''; }
}

function toIstFull(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }) + ' IST';
  } catch { return ''; }
}

function tickAge(ms: number | null, now: number): string {
  if (ms == null) return '';
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 1) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
}

export const StockCard = memo(function StockCard({
  stock, connected, marketClosed, now, index = 0,
}: StockCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Price flash: compare against the previously rendered LTP.
  const prevLtp = useRef<number | null>(stock.ltp);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const before = prevLtp.current;
    prevLtp.current = stock.ltp;
    if (before == null || stock.ltp == null || stock.ltp === before) return;
    setFlash(stock.ltp > before ? 'up' : 'down');
    const t = setTimeout(() => setFlash(null), 800);
    return () => clearTimeout(t);
  }, [stock.ltp]);

  const sc = STATUS_CONFIG[stock.status] ?? STATUS_CONFIG.UNSUBSCRIBED;
  const up = stock.changePct != null && stock.changePct > 0;
  const down = stock.changePct != null && stock.changePct < 0;
  const changeClass = up ? 'text-success' : down ? 'text-destructive' : 'text-muted-foreground';
  const reason = statusReason(stock, connected, marketClosed, now);
  const ageSec = stock.lastTickAtMs != null ? Math.max(0, Math.round((now - stock.lastTickAtMs) / 1000)) : null;
  const ageClass = ageSec == null ? 'text-muted-foreground'
    : ageSec <= 10 ? 'text-success' : ageSec <= 60 ? 'text-warning' : 'text-destructive';

  return (
    <div
      style={{ '--ds-i': index } as React.CSSProperties}
      data-symbol={stock.symbol}
      className={cn(
        'ds-card ds-rise ds-lift group relative overflow-hidden rounded-2xl border border-border/50 bg-card/75 shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] backdrop-blur-xl',
        stock.status === 'LIVE' && 'border-success/20',
        (stock.status === 'ERROR' || stock.status === 'DISCONNECTED') && 'border-destructive/20',
      )}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2.5px] bg-gradient-to-r', sc.rail)} />

      <div
        className="flex cursor-pointer select-none flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/20"
        onClick={() => setExpanded((p) => !p)}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((p) => !p); } }}
      >
        {/* Identity */}
        <div className="flex min-w-0 shrink-0 items-center gap-2.5 sm:w-[190px]">
          <span className="shrink-0 text-muted-foreground/60 transition-transform duration-300 group-hover:scale-110">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold tracking-tight">{stock.symbol || stock.tradingSymbol || 'Unknown'}</span>
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[8px] font-semibold uppercase leading-none text-muted-foreground">{stock.exchange}</span>
            </p>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{stock.companyName || stock.instrumentType}</p>
            <p className="mt-1 flex items-center gap-1.5">
              <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em]', sc.pill)}>
                <span className={cn('h-1 w-1 rounded-full', sc.dot, stock.status === 'LIVE' && 'animate-pulse')} />
                {sc.label}
              </span>
              <FeedBadge level={stock.feedLevel} type={stock.feedType} hasDepth={!!stock.depth} />
            </p>
          </div>
        </div>

        {/* Live price */}
        <div className="min-w-[130px] flex-1">
          <p className={cn('text-xl font-semibold leading-7 tracking-[-0.02em] tabular-nums transition-colors duration-500',
            flash === 'up' ? 'text-success' : flash === 'down' ? 'text-destructive' : 'text-foreground')}>
            {stock.ltp != null ? `₹${fmtPrice(stock.ltp)}` : (
              <span className="text-[12px] font-normal text-muted-foreground">
                {stock.tickCount === 0 ? 'Waiting for first tick' : 'LTP unavailable'}
              </span>
            )}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5">
            <span className={cn('text-[11px] font-semibold tabular-nums', changeClass)}>
              {stock.change == null ? '' : `${sign(stock.change)}₹${fmtPrice(stock.change)}`}
            </span>
            <span className={cn('text-[10px] font-semibold tabular-nums', changeClass)}>
              {stock.changePct == null ? '' : `${sign(stock.changePct)}${stock.changePct.toFixed(2)}%`}
            </span>
            {stock.ltp != null && stock.change != null && (
              <span className={cn('text-[10px]', changeClass)}>{up ? '▲' : down ? '▼' : '—'}</span>
            )}
          </p>
        </div>

        {/* Depth / volume / live age */}
        <div className="flex shrink-0 items-center gap-4">
          <Cell label="Bid" value={stock.bid != null ? `₹${fmtPrice(stock.bid)}` : '—'}
            sub={stock.bidQty != null ? `×${fmtCompact(stock.bidQty)}` : undefined} className="hidden sm:block" tone="text-success" />
          <Cell label="Ask" value={stock.ask != null ? `₹${fmtPrice(stock.ask)}` : '—'}
            sub={stock.askQty != null ? `×${fmtCompact(stock.askQty)}` : undefined} className="hidden sm:block" tone="text-destructive" />
          <Cell label="Vol" value={fmtCompact(stock.volume)} className="hidden md:block" />
          <Cell label="Rate" value={`${stock.ticksPerSec.toFixed(1)}/s`} className="hidden lg:block" tone="text-sky-500" />
          <div className="w-[74px]">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">Last</p>
            <p className="mt-0.5 font-mono text-[10px] leading-tight tabular-nums text-muted-foreground">{toIst(stock.ts) || '—'}</p>
            <p className={cn('text-[9px] leading-tight tabular-nums', ageClass)}>{ageSec == null ? '' : `${ageSec}s`}</p>
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="animate-in slide-in-from-top-1 border-t border-border/50 px-4 py-3.5 duration-200">
          <p className="mb-3 rounded-xl bg-muted/30 px-2.5 py-1.5 text-[10px] text-muted-foreground">{reason}</p>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <DetailGroup title="Instrument">
              <DetailField label="Symbol" value={stock.symbol} />
              <DetailField label="Exchange" value={stock.exchange} />
              <DetailField label="Token" value={stock.token} />
              <DetailField label="Type" value={stock.instrumentType} />
              {stock.companyName && <DetailField label="Company" value={stock.companyName} />}
            </DetailGroup>

            <DetailGroup title="Price">
              <DetailField label="LTP" value={stock.ltp != null ? `₹${fmtPrice(stock.ltp)}` : 'Waiting for first tick'} highlight />
              <DetailField label="Change" value={stock.change != null ? `${sign(stock.change)}₹${fmtPrice(stock.change)}` : '—'} color={changeClass} />
              <DetailField label="Change %" value={stock.changePct != null ? `${sign(stock.changePct)}${stock.changePct.toFixed(2)}%` : '—'} color={changeClass} />
              <DetailField label="Open" value={stock.open != null ? `₹${fmtPrice(stock.open)}` : 'Not provided by feed'} />
              <DetailField label="High" value={stock.high != null ? `₹${fmtPrice(stock.high)}` : 'Not provided by feed'} />
              <DetailField label="Low" value={stock.low != null ? `₹${fmtPrice(stock.low)}` : 'Not provided by feed'} />
              <DetailField label="Prev close" value={stock.prevClose != null ? `₹${fmtPrice(stock.prevClose)}` : 'Not provided by feed'} />
            </DetailGroup>

            <DetailGroup title="Market depth">
              <DetailField label="Bid" value={stock.bid != null ? `₹${fmtPrice(stock.bid)}` : 'Waiting for depth data'} />
              <DetailField label="Bid qty" value={stock.bidQty != null ? fmtNumber(stock.bidQty) : '—'} />
              <DetailField label="Ask" value={stock.ask != null ? `₹${fmtPrice(stock.ask)}` : 'Waiting for depth data'} />
              <DetailField label="Ask qty" value={stock.askQty != null ? fmtNumber(stock.askQty) : '—'} />
              <DetailField label="Total buy qty" value={stock.tbq != null ? fmtNumber(stock.tbq) : '—'} />
              <DetailField label="Total sell qty" value={stock.tsq != null ? fmtNumber(stock.tsq) : '—'} />
              {stock.depth && (stock.depth.buy.length > 0 || stock.depth.sell.length > 0) && (
                <DepthLadder buy={stock.depth.buy} sell={stock.depth.sell} />
              )}
            </DetailGroup>

            <DetailGroup title="Volume / activity">
              <DetailField label="Volume" value={stock.volume != null ? fmtNumber(stock.volume) : '—'} />
              <DetailField label="LTQ" value={stock.ltq != null ? fmtNumber(stock.ltq) : '—'} />
              <DetailField label="Avg price" value={stock.avgPrice != null ? `₹${fmtPrice(stock.avgPrice)}` : '—'} />
              <DetailField label="OI" value={stock.oi != null ? fmtNumber(stock.oi) : '—'} />
              <DetailField label="Ticks today" value={stock.tickCountToday > 0 ? fmtNumber(stock.tickCountToday) : 'No ticks today'} />
              <DetailField label="Session ticks" value={fmtNumber(stock.tickCount)} />
              <DetailField label="Tick rate" value={`${stock.ticksPerSec.toFixed(1)}/s`} />
            </DetailGroup>

            <DetailGroup title="Feed">
              <DetailField label="Feed status" value={stock.wsConnected ? 'Connected' : stock.wsSubscribed ? 'Subscribed but disconnected' : 'Not subscribed'} />
              <DetailField label="WS lifecycle" value={stock.wsLifecycleState ?? 'Unknown'} />
              <DetailField label="WS reason" value={stock.wsReason ?? (stock.wsConnected ? 'Active' : 'Not connected')} />
              <DetailField label="Subscription" value={stock.subscriptionState} />
              <DetailField label="Subscription reason" value={stock.subscriptionReason ?? 'No additional info'} />
              <DetailField label="Request status" value={stock.requestStatus ?? '—'} />
              <DetailField label="Last tick" value={stock.ts ? toIstFull(stock.ts) : 'No tick received'} />
              <DetailField label="Tick age" value={stock.lastTickAtMs ? tickAge(stock.lastTickAtMs, now) : 'No tick received'} />
              <DetailField label="Received at" value={stock.receivedAt ? toIstFull(stock.receivedAt) : '—'} />
              <DetailField label="First tick" value={stock.firstTickAt ? toIstFull(stock.firstTickAt) : '—'} />
            </DetailGroup>

            <DetailGroup title="System">
              <DetailField label="Backend source" value="Kotak NeoAPI → Python SSE" />
              <DetailField label="Data source" value="tick_buffer (in-memory + MongoDB)" />
              <DetailField label="Is index" value={stock.isIndex ? 'Yes' : 'No'} />
              <DetailField label="Active" value={stock.active ? 'Yes' : 'No'} />
            </DetailGroup>
          </div>
        </div>
      )}
    </div>
  );
});

/* -------------------------------------------------------------------------- */

function Cell({ label, value, sub, className, tone }: {
  label: string; value: string; sub?: string; className?: string; tone?: string;
}) {
  return (
    <div className={cn('text-right', className)}>
      <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">{label}</p>
      <p className={cn('mt-0.5 text-[11px] font-semibold leading-tight tabular-nums', tone ?? 'text-foreground')}>
        {value}{sub && <span className="ml-0.5 text-[9px] font-normal text-muted-foreground">{sub}</span>}
      </p>
    </div>
  );
}

function FeedBadge({ level, type, hasDepth }: { level: number | null; type: string | null; hasDepth: boolean }) {
  const label = level === 8 ? 'L8' : level === 16 ? 'L16' : level === 4 ? 'L4' : type ? String(type) : null;
  if (!label) return null;
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase leading-none tracking-[0.12em]',
      level === 8 ? 'bg-fuchsia-500/15 text-fuchsia-500 dark:text-fuchsia-300'
        : level === 16 ? 'bg-purple-500/15 text-purple-500 dark:text-purple-300'
          : 'bg-muted text-muted-foreground',
    )}>
      {label}{hasDepth ? ' · 5×5' : ''}
    </span>
  );
}

function DepthLadder({ buy, sell }: { buy: DepthRow[]; sell: DepthRow[] }) {
  const rows = Math.max(buy.length, sell.length);
  if (rows === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {Array.from({ length: rows }).map((_, i) => {
        const b = buy[i];
        const s = sell[i];
        return (
          <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg bg-background/50 px-1.5 py-0.5 text-[10px]">
            <span className="text-left font-mono tabular-nums text-success">
              {b ? `₹${fmtPrice(Number(b.price))} × ${fmtNumber(Number(b.quantity))}` : (s ? '' : '—')}
            </span>
            <span className="text-[9px] text-muted-foreground">{i + 1}</span>
            <span className="text-right font-mono tabular-nums text-destructive">
              {s ? `₹${fmtPrice(Number(s.price))} × ${fmtNumber(Number(s.quantity))}` : (b ? '' : '—')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DetailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/40 bg-background/40 p-2.5">
      <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DetailField({ label, value, color, highlight }: {
  label: string; value: string; color?: string; highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/25 py-[3px] last:border-0">
      <span className="shrink-0 text-[10px] text-muted-foreground/80">{label}</span>
      <span className={cn(
        'truncate text-right text-[10px] font-medium tabular-nums',
        highlight ? 'font-semibold text-foreground' : (color ?? 'text-foreground'),
      )}>
        {value}
      </span>
    </div>
  );
}