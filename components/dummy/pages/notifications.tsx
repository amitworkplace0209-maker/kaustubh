'use client';

/**
 * Notifications — trading-app style feed (list only).
 *
 * Every order event lands here as a rich card (symbol, side, qty × price,
 * status, time) instead of a raw JSON dump: fills, rejects, cancels,
 * square-offs, targets and alerts all arrive through the dummy terminal feed
 * with real metadata. Non-order rows keep a clean one-line style with a
 * collapsible detail block.
 *
 * Display colors + mute live in Settings → Notifications; this page only
 * reads them. PWA push controls also live in Settings.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell, BellRing, CheckCheck, Trash2, RefreshCw, Inbox, Info,
  Target, Zap, ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState, EmptyState } from '@/components/design-system';
import {
  getDummyNotifications,
  readAllDummyNotifications,
  readDummyNotification,
  deleteDummyNotification,
  clearDummyNotifications,
  type DummyNotification,
} from '@/lib/dummy';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { cn } from '@/lib/utils';
import { fmtRs, fmtQty } from '@/lib/formatters';

/* ---------------- display colors (read from Settings) ---------------- */

const COLOR_KEYS = ['emerald', 'red', 'amber', 'sky', 'violet', 'slate'] as const;
type ColorKey = (typeof COLOR_KEYS)[number];

const COLOR_STYLE: Record<ColorKey, { text: string; border: string; bg: string; dot: string; rail: string }> = {
  emerald: { text: 'text-emerald-500', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', dot: 'bg-emerald-500', rail: 'border-l-emerald-500' },
  red: { text: 'text-red-500', border: 'border-red-500/40', bg: 'bg-red-500/10', dot: 'bg-red-500', rail: 'border-l-red-500' },
  amber: { text: 'text-amber-500', border: 'border-amber-500/40', bg: 'bg-amber-500/10', dot: 'bg-amber-500', rail: 'border-l-amber-500' },
  sky: { text: 'text-sky-500', border: 'border-sky-500/40', bg: 'bg-sky-500/10', dot: 'bg-sky-500', rail: 'border-l-sky-500' },
  violet: { text: 'text-violet-500', border: 'border-violet-500/40', bg: 'bg-violet-500/10', dot: 'bg-violet-500', rail: 'border-l-violet-500' },
  slate: { text: 'text-muted-foreground', border: 'border-border', bg: 'bg-muted/40', dot: 'bg-muted-foreground/50', rail: 'border-l-muted-foreground/40' },
};

const DEFAULT_COLORS: Record<string, ColorKey> = {
  ORDER: 'emerald',
  BASKET: 'sky',
  TARGET: 'amber',
  ALERT: 'red',
  SUGGESTION: 'violet',
  SYSTEM: 'slate',
};

const COLORS_KEY = 'notif.colors.v1';

function loadColors(): Record<string, ColorKey> {
  try {
    const raw = window.localStorage.getItem(COLORS_KEY);
    if (!raw) return { ...DEFAULT_COLORS };
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out = { ...DEFAULT_COLORS };
    for (const [k, v] of Object.entries(parsed)) {
      if ((COLOR_KEYS as readonly string[]).includes(v)) out[k] = v as ColorKey;
    }
    return out;
  } catch {
    return { ...DEFAULT_COLORS };
  }
}

/* ---------------- order-card parsing (real metadata only) ---------------- */

type OrderFacts = {
  symbol: string;
  side: string;
  qty: number | null;
  price: number | null;
  orderId: string;
  product: string;
  status: 'FILLED' | 'REJECTED' | 'CANCELLED' | 'INFO';
};

function orderFacts(n: DummyNotification): OrderFacts | null {
  const m = (n.meta ?? {}) as Record<string, any>;
  const symbol = String(m.symbol ?? '').trim();
  if (!symbol) return null;
  const hay = `${n.title} ${n.message}`.toLowerCase();
  const status: OrderFacts['status'] = /reject|fail/.test(hay)
    ? 'REJECTED'
    : /cancel/.test(hay)
      ? 'CANCELLED'
      : /fill|execut|complet|success/.test(hay)
        ? 'FILLED'
        : 'INFO';
  const num = (v: unknown): number | null => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    symbol,
    side: String(m.side ?? m.transactionType ?? '').toUpperCase(),
    qty: num(m.quantity ?? m.qty),
    price: num(m.price ?? m.executedPrice ?? m.avgPrice),
    orderId: String(m.order_id ?? m.orderId ?? ''),
    product: String(m.product ?? ''),
    status,
  };
}

const STATUS_STYLE: Record<OrderFacts['status'], { label: string; cls: string }> = {
  FILLED: { label: 'COMPLETE', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' },
  REJECTED: { label: 'REJECTED', cls: 'border-red-500/40 bg-red-500/10 text-red-500' },
  CANCELLED: { label: 'CANCELLED', cls: 'border-border bg-muted/50 text-muted-foreground' },
  INFO: { label: 'INFO', cls: 'border-sky-500/40 bg-sky-500/10 text-sky-500' },
};

function istTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return '—';
  }
}

function istDate(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  } catch {
    return '';
  }
}

const TAB_GROUPS: { id: string; label: string; match: (c: string) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'orders', label: 'Orders', match: (c) => c === 'ORDER' || c === 'BASKET' },
  { id: 'alerts', label: 'Alerts', match: (c) => c === 'TARGET' || c === 'ALERT' || c === 'SUGGESTION' },
  { id: 'system', label: 'System', match: (c) => c === 'SYSTEM' },
];

const CATEGORY_ICON: Record<string, typeof Bell> = {
  ORDER: Zap,
  BASKET: Zap,
  TARGET: Target,
  ALERT: BellRing,
  SUGGESTION: Bell,
  SYSTEM: Info,
};

export default function DummyNotifications() {
  const [list, setList] = useState<DummyNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [tradingDate, setTradingDate] = useState('');
  const [category, setCategory] = useState('');
  const [tab, setTab] = useState('all');
  const [error, setError] = useState<string | null>(null);
  // Display prefs (colors + mute) are controlled in Settings → Notifications;
  // this feed only reads them.
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [colors, setColors] = useState<Record<string, ColorKey>>(DEFAULT_COLORS);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('dummy.notif.muted');
      if (raw) setMuted(JSON.parse(raw));
    } catch { /* ignore */ }
    setColors(loadColors());
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getDummyNotifications(category, 100);
      setList(res.data || []);
      setUnread(res.unread ?? 0);
      if ((res as { tradingDate?: string }).tradingDate) {
        setTradingDate((res as { tradingDate?: string }).tradingDate ?? '');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    }
  }, [category]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(id);
  }, [load]);

  const colorOf = (cat: string) => COLOR_STYLE[colors[cat] ?? 'slate'];

  const visible = useMemo(() => {
    const group = TAB_GROUPS.find((g) => g.id === tab) ?? TAB_GROUPS[0];
    return list.filter((n) => !muted[n.category] && group.match(n.category));
  }, [list, muted, tab]);
  const visibleUnread = useMemo(() => visible.filter((n) => !n.read).length, [visible]);
  const categories = useMemo(() => ['', ...Array.from(new Set(list.map((n) => n.category)))], [list]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (error && list.length === 0) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void load()} /></DummyThemedPage>;
  }

  return (
    <DummyThemedPage>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
          <DummyBadge />
          {unread > 0 && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold tabular-nums text-primary-foreground">
              {unread} new
            </span>
          )}
          {tradingDate && (
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-sky-500">
              Today · {tradingDate} IST
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={async () => { await readAllDummyNotifications(); void load(); }} disabled={unread === 0}>
            <CheckCheck className="h-4 w-4" /> Read all
          </Button>
          <Button variant="outline" size="sm" onClick={async () => { await clearDummyNotifications(); void load(); }}>
            <Trash2 className="h-4 w-4" /> Clear
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        {TAB_GROUPS.map((g) => {
          const count = g.id === 'all' ? list.length : list.filter((n) => g.match(n.category)).length;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => setTab(g.id)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
                tab === g.id
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {g.label}
              <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
            </button>
          );
        })}
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="ml-auto h-9 w-44"><SelectValue placeholder="All categories" /></SelectTrigger>
          <SelectContent>
            {categories.map((c) => (
              <SelectItem key={c || 'ALL'} value={c}>{c || 'All categories'}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {visibleUnread > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/[0.06] px-3 py-2 text-sm">
          <Bell className="h-4 w-4 text-primary" /> {visibleUnread} unread in this view
        </div>
      )}

      {/* Feed */}
      {visible.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No notifications"
          description="Order fills, square-offs, targets and alerts land here the moment they happen — in the app and on your device."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              style={colorOf(n.category)}
              expanded={expanded.has(n.id)}
              onToggle={() => toggleExpand(n.id)}
              onRead={async () => { await readDummyNotification(n.id); void load(); }}
              onDelete={async () => { await deleteDummyNotification(n.id); void load(); }}
            />
          ))}
        </div>
      )}

    </DummyThemedPage>
  );
}

function NotificationRow({ n, style, expanded, onToggle, onRead, onDelete }: {
  n: DummyNotification;
  style: { text: string; border: string; bg: string; dot: string; rail: string };
  expanded: boolean;
  onToggle: () => void;
  onRead: () => void;
  onDelete: () => void;
}) {
  const facts = orderFacts(n);
  const Icon = CATEGORY_ICON[n.category] ?? Bell;
  const metaKeys = Object.keys(n.meta ?? {});
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border/60 border-l-4 bg-card shadow-sm', style.rail, !n.read && 'ring-1 ring-primary/20')}>
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', style.bg, style.text)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          {facts ? (
            <OrderCardBody facts={facts} n={n} />
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="font-semibold">{n.title}</span>
                {!n.read && <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{n.message}</p>
            </>
          )}
          <p className="mt-1 text-[10px] tabular-nums text-muted-foreground/70">
            {istDate(n.ts)} · {istTime(n.ts)} IST
          </p>
        </div>
        <span className={cn('shrink-0 rounded-full border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider', style.border, style.text, style.bg)}>
          {n.category}
        </span>
      </div>
      {(metaKeys.length > 0 || !facts) && (
        <div className="flex items-center justify-end gap-1 border-t border-border/40 px-3 py-1.5">
          {metaKeys.length > 0 && (
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Details
              <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
            </button>
          )}
          {!n.read && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => void onRead()}>
              Mark read
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-destructive" onClick={() => void onDelete()}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
      {expanded && metaKeys.length > 0 && (
        <pre className="mx-3 mb-2 overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[10px]">{JSON.stringify(n.meta, null, 2)}</pre>
      )}
    </div>
  );
}

function OrderCardBody({ facts, n }: { facts: NonNullable<ReturnType<typeof orderFacts>>; n: DummyNotification }) {
  const st = STATUS_STYLE[facts.status];
  const buy = facts.side === 'BUY';
  return (
    <>
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className={cn(
          'rounded px-1.5 py-px text-[10px] font-extrabold',
          buy ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
        )}>
          {facts.side || 'ORDER'}
        </span>
        <span className="font-bold tracking-tight">{facts.symbol}</span>
        {facts.qty != null && (
          <span className="tabular-nums text-muted-foreground">× {fmtQty(facts.qty)}</span>
        )}
        {facts.price != null && facts.price > 0 && (
          <span className="font-mono font-semibold tabular-nums">₹{Number(facts.price).toFixed(2)}</span>
        )}
        <span className={cn('rounded-full border px-1.5 py-px text-[9px] font-bold', st.cls)}>{st.label}</span>
        {!n.read && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {n.message}
        {facts.product && ` · ${facts.product}`}
        {facts.orderId && ` · ${facts.orderId}`}
      </p>
      {facts.price != null && facts.qty != null && facts.price > 0 && (
        <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
          Value <span className="font-semibold text-foreground">{fmtRs(facts.price * facts.qty)}</span>
          {(() => {
            const c = (n.meta as Record<string, any>)?.charges;
            const t = typeof c === 'number' ? c : c?.total;
            return t != null && Number(t) > 0 ? <> · Charges <span className="font-semibold text-destructive">{fmtRs(Number(t))}</span></> : null;
          })()}
        </p>
      )}
    </>
  );
}
