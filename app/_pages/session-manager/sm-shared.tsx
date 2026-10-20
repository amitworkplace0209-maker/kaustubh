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
  ACTIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  SUBSCRIBED: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  SUBSCRIBED_AND_PINNED: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  PINNED_ONLY: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  SUBSCRIBE_REQUESTED: 'bg-sky-500/10 text-sky-300 border-sky-500/25',
  UNSUBSCRIBE_REQUESTED: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  UNSUBSCRIBED: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  NOT_SUBSCRIBED: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  EXPIRING: 'bg-yellow-500/10 text-yellow-300 border-yellow-500/25',
  EXPIRED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  INACTIVE: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/25',
  ERROR: 'bg-red-500/15 text-red-300 border-red-500/30',
};

const TIER_TONE: Record<string, string> = {
  'L4': 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  'L8': 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  'L16': 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  'UNSET': 'bg-zinc-500/10 text-zinc-300 border-zinc-500/25',
};

export function tierBadge(level?: number | string, marketData?: string) {
  const l = Number(level);
  const label = l === 4 ? 'L4' : l === 8 ? 'L8' : l === 16 ? 'L16' : l ? `L${l}` : marketData ? String(marketData) : 'UNSET';
  return <Badge variant="outline" className={TIER_TONE[label] ?? TIER_TONE.UNSET}>{label}</Badge>;
}

export function fmtTs(iso?: string | number | null) {
  if (iso == null || iso === '') return '—';
  const s = String(iso).replace('Z', '').replace('+00:00', '');
  try {
    if (!s.includes('T') && !isNaN(Number(iso))) return new Date(Number(iso) * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const d = new Date(s.endsWith('Z') || s.includes('T') ? s : Number(s) * 1000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return String(iso);
  }
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
    <Badge variant="outline" className={ok ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-500/10 text-slate-300 border-slate-500/25'}>
      <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400'}`} />
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