'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Shared chrome for the per-broker Order Engine service pages.
 *
 * Layout + navigation only — every page keeps its own data connection:
 *   overview  · active-terminal book via useOrderEngineLive (WS `orders`)
 *   dummy     · GET /api/order-engine/engine/dummy (paper engine + verification)
 *   kotak     · GET /api/order-engine/engine/kotak (session + WS#2 order feed)
 *   shoonya   · GET /api/order-engine/engine/shoonya (session + OAuth)
 *   orders    · placement/cancel/modify through /api/order-engine/*
 *   history   · GET /api/order-engine/history
 *   basket    · /api/baskets + push
 *   settings  · GET/POST /api/order-engine/settings (+ engines-plane config)
 */

const TABS = [
  { key: 'overview', href: '/services/order-engine', label: 'Overview' },
  { key: 'dummy', href: '/services/order-engine/dummy', label: 'Dummy Engine' },
  { key: 'kotak', href: '/services/order-engine/kotak', label: 'Kotak Engine' },
  { key: 'shoonya', href: '/services/order-engine/shoonya', label: 'Shoonya Engine' },
  { key: 'orders', href: '/services/order-engine/orders', label: 'Orders' },
  { key: 'history', href: '/services/order-engine/history', label: 'History' },
  { key: 'basket', href: '/services/order-engine/basket', label: 'Basket' },
  { key: 'settings', href: '/services/order-engine/settings', label: 'Settings' },
] as const;

export type OengTabKey = (typeof TABS)[number]['key'];

const TAB_ACTIVE: Record<OengTabKey, string> = {
  overview: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700',
  dummy: 'border-amber-500/50 bg-amber-500/10 text-amber-700',
  kotak: 'border-sky-500/50 bg-sky-500/10 text-sky-700',
  shoonya: 'border-violet-500/50 bg-violet-500/10 text-violet-700',
  orders: 'border-indigo-500/50 bg-indigo-500/10 text-indigo-700',
  history: 'border-slate-500/50 bg-slate-500/10 text-slate-700',
  basket: 'border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-700',
  settings: 'border-rose-500/50 bg-rose-500/10 text-rose-700',
};

export function OengPageTabs({ active }: { active: OengTabKey }) {
  return (
    <nav aria-label="Order Engine pages" className="flex flex-wrap items-center gap-1.5">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            'rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors',
            t.key === active ? TAB_ACTIVE[t.key] : 'border-border/60 text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** IST wall-clock badge (formatting only; the timezone owner is the backend). */
export function OengIstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Badge variant="outline" className="tabular-nums">
      IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}
    </Badge>
  );
}

/** Backend number → en-IN digits, missing → '—' (honest). */
export function fmtN(n?: number | string | null, digits: number = 2): string {
  const v = Number(n);
  if (n == null || n === '' || Number.isNaN(v)) return '—';
  return v.toLocaleString('en-IN', { maximumFractionDigits: digits });
}

/** Connection-state badge in the light palette. */
export function ConnBadge({
  connected,
  label,
}: {
  connected: boolean;
  label?: string;
}) {
  return (
    <Badge variant="outline" className={connected ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/40 bg-rose-500/10 text-rose-700'}>
      <span
        className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-rose-500')}
      />
      {label ?? (connected ? 'CONNECTED' : 'NOT CONNECTED')}
    </Badge>
  );
}

export const OENG_TONE: Record<string, string> = {
  emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
  sky: 'border-sky-500/40 bg-sky-500/10 text-sky-700',
  violet: 'border-violet-500/40 bg-violet-500/10 text-violet-700',
  rose: 'border-rose-500/40 bg-rose-500/10 text-rose-700',
  slate: 'border-slate-500/30 bg-slate-500/10 text-slate-700',
  fuchsia: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700',
  indigo: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700',
};
