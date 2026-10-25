'use client';

import { useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RefreshCw } from 'lucide-react';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { NotificationBell, PwaInstallButton } from '@/app/_pages/session-manager/pwa-notify';

/**
 * Shared layer for SERVICES → Session Manager (§8-§22).
 *
 * Real-data only (master spec §4): every panel reads live backend state from
 * GET /api/phase3/session-manager/* and the WS#2 `engines` channel. Nothing is
 * fabricated — missing / not-applicable values render as '—' or NO DATA.
 *
 * `useCadenceRefresh` follows the Connection Manager push cadence: every
 * `engine.status` frame nudges a refresh of the page's one-shot data. Pages
 * with an explicit reason not to auto-refresh (configuration while editing,
 * history, reconcile, manual add) do not install it.
 */
export const SM = '/api/phase3/session-manager';
export const WE = '/api/phase2/websocket-engine';

export const TONE: Record<string, string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-800 border-emerald-500/40 font-semibold',
  SUBSCRIBED: 'bg-emerald-500/12 text-emerald-800 border-emerald-500/35',
  SUBSCRIBED_AND_PINNED: 'bg-amber-500/15 text-amber-800 border-amber-500/40 font-semibold',
  PINNED_ONLY: 'bg-amber-500/12 text-amber-800 border-amber-500/35',
  SUBSCRIBE_REQUESTED: 'bg-sky-500/12 text-sky-800 border-sky-500/35',
  UNSUBSCRIBE_REQUESTED: 'bg-slate-500/12 text-slate-700 border-slate-500/35',
  UNSUBSCRIBED: 'bg-slate-500/12 text-slate-700 border-slate-400/40',
  NOT_SUBSCRIBED: 'bg-slate-500/10 text-slate-600 border-slate-400/40',
  EXPIRING: 'bg-yellow-500/15 text-yellow-800 border-yellow-500/40',
  EXPIRED: 'bg-rose-500/15 text-rose-800 border-rose-500/40',
  INACTIVE: 'bg-zinc-500/10 text-zinc-600 border-zinc-400/40',
  ERROR: 'bg-red-500/15 text-red-800 border-red-500/40',
};

const TIER_TONE: Record<string, string> = {
  'L4': 'bg-slate-500/10 text-slate-700 border-slate-400/40',
  'L8': 'bg-fuchsia-500/15 text-fuchsia-800 border-fuchsia-500/40',
  'L16': 'bg-purple-500/15 text-purple-800 border-purple-500/40',
  'UNSET': 'bg-zinc-500/10 text-zinc-600 border-zinc-400/40',
};

export function tierBadge(level?: number | string, marketData?: string) {
  const l = Number(level);
  const label = l === 4 ? 'L4' : l === 8 ? 'L8' : l === 16 ? 'L16' : l ? `L${l}` : marketData ? String(marketData) : 'UNSET';
  return <Badge variant="outline" className={TIER_TONE[label] ?? TIER_TONE.UNSET}>{label}</Badge>;
}

/** IST display clock — Asia/Kolkata, 23h clock (no '24:00' quirk). */
const IST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function formatIst(ms: number): string {
  try {
    const p = Object.fromEntries(IST_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} IST`;
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Format ANY backend timestamp as IST wall time:
 *  - epoch floats/ints (seconds or ms — the runtime + DB forms)
 *  - ISO strings with any offset / 'Z' (backend already normalizes DB times to +05:30)
 *  Unparsable input is returned as-is — nothing is ever fabricated here. */
export function fmtTs(v?: unknown): string {
  if (v == null || v === '') return '—';
  const raw = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return formatIst(n >= 1e12 ? n : n * 1000);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw;
  return formatIst(ms);
}

export function fmtNum(n?: number | string | null): string {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (Number.isNaN(v)) return String(n);
  return v.toLocaleString('en-IN');
}

export function fmtDuration(seconds?: number | string | null): string {
  if (seconds == null || seconds === '' || Number.isNaN(Number(seconds))) return '—';
  const s = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

export function LivePill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant="outline" className={ok ? 'bg-emerald-500/15 text-emerald-800 border-emerald-500/40 font-semibold' : 'bg-slate-500/12 text-slate-700 border-slate-400/40'}>
      <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
      {label}
    </Badge>
  );
}

export type PanelProps = { data: any; error: string | null; refresh?: () => void };

export function StatCard({ icon: Icon, label, value, sub, tone }: { icon: any; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft-lg hover:border-primary/25">
      <CardHeader className="pb-1">
        <CardTitle className="text-[11px] flex items-center gap-1.5 text-muted-foreground">
          <span className="rounded-md bg-primary/10 p-1"><Icon className="h-3 w-3 text-primary" /></span> {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className={`text-xl font-mono leading-tight tabular-nums ${tone ?? ''}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5 truncate" title={sub}>{sub}</div>}
      </CardContent>
    </Card>
  );
}

export const CONFIG_LABELS: Record<string, { label: string; short: string }> = {
  session_lifetime_seconds: { label: 'Session lifetime', short: 'lifetime' },
  expiry_warning_seconds: { label: 'Expiry-warning horizon', short: 'warning' },
  tick_active_window_seconds: { label: 'Tick-active window', short: 'tick window' },
};

/** Follow the Connection Manager push cadence (engine.status frames). */
export function useCadenceRefresh(refresh: () => void, enabled = true) {
  const { onFrame } = useFrontendRealtime();
  const cb = useCallback(() => refresh(), [refresh]);
  useEffect(() => {
    if (!enabled) return;
    return onFrame((frame) => {
      if (frame.type === 'engine.status') cb();
    });
  }, [onFrame, cb, enabled]);
}

export function SmPageHeader({ icon: Icon, title, caption, badges, onRefresh, busy }: {
  icon: any;
  title: string;
  caption: string;
  badges?: React.ReactNode;
  onRefresh?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold flex flex-wrap items-center gap-2">
          <span className="rounded-xl bg-primary/10 p-1.5"><Icon className="h-5 w-5 text-primary" /></span> {title}
          {badges}
        </h1>
        <p className="text-xs text-muted-foreground mt-1">{caption}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <NotificationBell />
        <PwaInstallButton compact />
        {onRefresh && (
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={busy}>
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        )}
      </div>
    </div>
  );
}