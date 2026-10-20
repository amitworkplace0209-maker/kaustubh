'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowLeft,
  Bell,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  History as HistoryIcon,
  KeyRound,
  Layers,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { SM, TONE, fmtDuration, fmtNum, fmtTs } from '@/app/_pages/session-manager/sm-shared';
import { useNotifyPermission, usePwaInstall } from '@/app/_pages/session-manager/pwa-notify';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → Session — redesigned from zero.
 *
 * Advance full-color + full PWA support. Real data only:
 *  GET /session (identity/lifecycle/websocket/routing/terminals/history/events)
 *  GET /session/history?limit=100 (completed-sessions ledger, deferred so first
 *  paint is instant). Missing = '—'/skeleton, never fake.
 */

const SM_SESSION = `${SM}/session`;
const SM_HISTORY = `${SM}/session/history?limit=100`;

/** Throttled WS#2 cadence — max 1 refresh per delayMs, hidden tab paused. */
function useThrottledCadence(refresh: () => void, active: boolean, delayMs: number) {
  const { onFrame } = useFrontendRealtime();
  const last = useRef(0);
  const fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    if (!active) return;
    return onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - last.current < delayMs) return;
      last.current = t;
      fn.current();
    });
  }, [onFrame, active, delayMs]);
}

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

/** Live countdown derived from the REAL remainingSeconds (ticks locally, resets on backend change). */
function RemainingCountdown({ remaining, duration }: { remaining: number | null; duration: number | null }) {
  const [left, setLeft] = useState<number | null>(remaining);
  useEffect(() => { setLeft(remaining); }, [remaining]);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => (v == null || v <= 0 ? v : v - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  if (left == null) return <span>—</span>;
  const pct = duration ? Math.max(0, Math.min(100, (left / Math.max(1, duration)) * 100)) : null;
  return (
    <span className="block">
      <span className={cn('font-mono text-lg font-bold tabular-nums', left < 300 ? 'text-rose-300' : left < 900 ? 'text-amber-300' : 'text-emerald-300')}>{fmtDuration(left)}</span>
      {pct != null && (
        <span className="mt-1 block h-2 overflow-hidden rounded-full bg-muted">
          <span className={cn('block h-full rounded-full bg-gradient-to-r transition-all', left < 300 ? 'from-rose-500 to-rose-400' : left < 900 ? 'from-amber-500 to-amber-400' : 'from-emerald-500 to-emerald-400')} style={{ width: `${pct}%` }} />
        </span>
      )}
    </span>
  );
}

/** Live "x ago" ticker for a real timestamp (isolated so page doesn't re-render). */
function AgeTicker({ ts, prefix }: { ts?: string | null; prefix?: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!ts) return <span>—</span>;
  const ms = Date.parse(ts);
  if (isNaN(ms)) return <span className="font-mono">{fmtTs(ts)}</span>;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const age = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  return <span className="font-mono tabular-nums">{prefix ? `${prefix} · ` : ''}{fmtTs(ts)} ({age})</span>;
}

function OnlineDot() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const swActive = typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline" className={online ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'}>
        <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', online ? 'animate-pulse bg-emerald-400' : 'bg-rose-400')} />
        {online ? 'ONLINE' : 'OFFLINE'}
      </Badge>
      <Badge variant="outline" className={swActive ? 'border-emerald-500/30 text-emerald-300' : ''}>SW {swActive ? 'active' : '—'}</Badge>
    </span>
  );
}

type Accent = 'sky' | 'emerald' | 'amber' | 'violet' | 'rose' | 'cyan';
const ACCENT: Record<Accent, { bar: string; chip: string; value: string }> = {
  sky: { bar: 'bg-sky-400', chip: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-lg shadow-sky-500/25', value: 'text-sky-300' },
  emerald: { bar: 'bg-emerald-400', chip: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25', value: 'text-emerald-300' },
  amber: { bar: 'bg-amber-400', chip: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/25', value: 'text-amber-300' },
  violet: { bar: 'bg-violet-400', chip: 'bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/25', value: 'text-violet-300' },
  rose: { bar: 'bg-rose-400', chip: 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-lg shadow-rose-500/25', value: 'text-rose-300' },
  cyan: { bar: 'bg-cyan-400', chip: 'bg-gradient-to-br from-cyan-500 to-sky-600 text-white shadow-lg shadow-cyan-500/25', value: 'text-cyan-300' },
};

function Kpi({ icon: Icon, label, value, sub, accent, loading }: {
  icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; accent: Accent; loading?: boolean;
}) {
  const a = ACCENT[accent];
  return (
    <Card className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', a.bar)} />
      <CardContent className="flex items-center gap-3 p-3.5">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', a.chip)}><Icon className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
          {loading ? <div className="mt-1 h-7 w-24 animate-pulse rounded bg-muted/70" /> : <div className={cn('truncate font-mono text-base font-bold tabular-nums leading-7', a.value)}>{value}</div>}
          <p className="truncate text-[11px] text-muted-foreground">{sub ?? ' '}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SessionManagerSessionPage() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 500);
    return () => clearTimeout(t);
  }, []);

  const sess = useOneShot<Record<string, any>>(SM_SESSION);
  const hist = useOneShot<any[]>(SM_HISTORY, late);
  useThrottledCadence(sess.refresh, true, 20000);
  useThrottledCadence(hist.refresh, late, 60000);

  const [q, setQ] = useState('');
  const [copied, setCopied] = useState(false);
  const { canInstall, installed, promptInstall } = usePwaInstall();
  const { permission, request } = useNotifyPermission();
  const seenCritical = useRef<Set<string>>(new Set());

  const data = (sess.data ?? {}) as Record<string, any>;
  const id = (data.identity ?? {}) as Record<string, any>;
  const life = (data.lifecycle ?? {}) as Record<string, any>;
  const ws = (data.websocket ?? {}) as Record<string, any>;
  const routing = (data.routing ?? {}) as Record<string, any>;
  const terminals = Object.entries((data.terminalSessions ?? {}) as Record<string, any>);
  const events = (Array.isArray(data.events) ? data.events : []) as any[];
  const historyRows = useMemo(() => {
    const h = (Array.isArray(hist.data) ? hist.data : (Array.isArray(data.sessionHistory) ? data.sessionHistory : [])) as any[];
    const qq = q.trim().toLowerCase();
    if (!qq) return h;
    return h.filter((r: any) => String(r.mode ?? '').toLowerCase().includes(qq) || String(r.broker ?? '').toLowerCase().includes(qq) || String(r.logout_reason ?? '').toLowerCase().includes(qq));
  }, [hist.data, data.sessionHistory, q]);

  const active = Boolean(life.active);
  const remaining = id.remainingSeconds != null ? Math.max(0, Math.round(Number(id.remainingSeconds))) : null;
  const duration = id.sessionDurationSeconds != null ? Math.max(1, Math.round(Number(id.sessionDurationSeconds))) : null;
  const wsLive = ws.state === 'CONNECTED';

  // ---- real session alerts (no extra fetch — derived from /session) ----
  const alerts = useMemo(() => {
    const out: { id: string; severity: 'critical' | 'warn' | 'info'; title: string; detail: string }[] = [];
    if (sess.data && !active) out.push({ id: 'inactive', severity: 'warn', title: 'No active session', detail: 'Owner session inactive hai.' });
    if (ws.state && ws.state !== 'CONNECTED') out.push({ id: 'ws', severity: 'warn', title: `WebSocket ${ws.state}`, detail: `Reconnects ${fmtNum(ws.reconnectCount)} · ${ws.disconnectReason ?? 'no reason'}` });
    if (data.lastAuthError) out.push({ id: 'auth', severity: 'critical', title: 'Auth error', detail: String(data.lastAuthError) });
    if (data.lastRestError) out.push({ id: 'rest', severity: 'warn', title: 'REST error', detail: String(data.lastRestError) });
    if (remaining != null && remaining < 900 && active) out.push({ id: 'expiry', severity: 'warn', title: `Session expiring in ${fmtDuration(remaining)}`, detail: 'Scheduler relogin karega — countdown live hai.' });
    for (const [term, r] of terminals) {
      const st = String(r.session_status ?? r.status ?? '');
      if (st === 'ERROR' || st === 'EXPIRED' || r.connection_status === 'DISCONNECTED') {
        out.push({ id: `term-${term}`, severity: 'critical', title: `${term}: ${st || r.connection_status}`, detail: String(r.state_message ?? r.broker_id ?? '') });
      }
    }
    return out;
  }, [sess.data, active, ws.state, ws.reconnectCount, ws.disconnectReason, data.lastAuthError, data.lastRestError, remaining, terminals]);

  // browser fan-out for NEW critical alerts only (permission-gated)
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    for (const a of alerts) {
      if (a.severity !== 'critical' || seenCritical.current.has(a.id)) continue;
      seenCritical.current.add(a.id);
      try { new Notification(`Session · ${a.title}`, { body: a.detail, tag: a.id }); } catch { /* in-app list still shows */ }
    }
  }, [alerts]);

  const copyId = async () => {
    const v = String(id.sessionId ?? '');
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const loading = !sess.data && !sess.error;
  const filteredTerms = terminals.filter(([term, r]: [string, any]) => {
    const qq = q.trim().toLowerCase();
    if (!qq) return true;
    return term.toLowerCase().includes(qq) || String(r.broker_id ?? '').toLowerCase().includes(qq) || String(r.session_status ?? '').toLowerCase().includes(qq);
  });

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-sky-500/[0.12] via-primary/[0.06] to-violet-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-sky-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Link href="/services/session-manager" aria-label="Back to overview" className="rounded-xl border border-border bg-muted/50 p-2 text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 via-primary to-violet-500 text-white shadow-xl">
            <KeyRound className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Session</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground sm:text-sm">
              {id.sessionId ? `${id.sessionId} · ${id.broker ?? '—'} · ${id.mode ?? '—'}` : 'Owner session identity, lifecycle, terminals · live backend state'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={active ? 'border border-emerald-500/40 bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 text-emerald-200' : 'border border-rose-500/40 bg-rose-500/10 text-rose-200'}>
              <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', active ? 'animate-pulse bg-emerald-400' : 'bg-rose-400')} />
              {String(life.lifecycleState ?? life.state ?? (sess.data ? 'NO SESSION' : '…'))}
            </Badge>
            <Badge variant="outline" className={wsLive ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : ''}>
              {wsLive ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />} {String(ws.state ?? '—')}
            </Badge>
            <OnlineDot />
            <IstClock />
            <Button size="sm" onClick={() => { sess.refresh(); if (late) hist.refresh(); }} className="gap-1.5 bg-gradient-to-r from-sky-500 to-violet-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
        <div className="relative h-2 w-full overflow-hidden bg-muted/60">
          {duration && remaining != null ? (
            <span className={cn('block h-full bg-gradient-to-r transition-all', remaining < 300 ? 'from-rose-500 to-rose-400' : remaining < 900 ? 'from-amber-500 to-amber-400' : 'from-emerald-500 via-cyan-500 to-sky-500')} style={{ width: `${Math.max(0, Math.min(100, (remaining / duration) * 100))}%` }} />
          ) : null}
        </div>
      </div>

      {sess.error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <span className="min-w-0">Session load failed: {sess.error} — retry karo, koi fake data nahi dikhayenge.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => sess.refresh()}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi accent="sky" icon={KeyRound} label="Session" value={loading ? '…' : String(id.sessionId ?? '—').slice(0, 18)} sub={id.sessionReference ? `ref ${id.sessionReference}` : String(id.userId ?? '')} loading={loading} />
        <Kpi accent="emerald" icon={ShieldCheck} label="Lifecycle" value={loading ? '…' : String(life.lifecycleState ?? life.state ?? '—')} sub={life.stateMessage ?? (active ? 'active owner session' : undefined)} loading={loading} />
        <Kpi accent="amber" icon={Clock} label="Remaining" value={loading ? '…' : <RemainingCountdown remaining={remaining} duration={duration} />} sub={id.loginSource ? `owner ${id.loginSource}` : undefined} loading={loading} />
        <Kpi accent="violet" icon={Layers} label="Terminals" value={loading ? '…' : fmtNum(terminals.length)} sub="independent per terminal" loading={loading} />
        <Kpi accent="cyan" icon={HistoryIcon} label="History" value={loading ? '…' : fmtNum(historyRows.length)} sub={hist.error ? 'ledger unavailable' : 'completed sessions'} loading={loading} />
        <Kpi accent="rose" icon={Activity} label="Events" value={loading ? '…' : fmtNum(events.length)} sub={wsLive ? 'ws live' : `ws ${String(ws.state ?? 'down')}`} loading={loading} />
      </div>

      {/* IDENTITY + WS */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-sky-500/10 to-blue-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 p-1.5 text-white shadow"><KeyRound className="h-3.5 w-3.5" /></span>
              Session identity · real
              <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 px-2 text-[11px]" onClick={() => void copyId()}>
                {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-300" /> : <Copy className="h-3 w-3" />} {copied ? 'Copied' : 'Copy ID'}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-3 text-xs">
            {loading ? (
              <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-8 animate-pulse rounded-lg bg-muted/60" />)}</div>
            ) : (
              ([
                ['Session ID', id.sessionId], ['Reference', id.sessionReference], ['Mode', id.mode], ['Broker', id.broker],
                ['User ID', id.userId], ['Login source', id.loginSource], ['Login at', fmtTs(id.loginTime)],
                ['Expires at', fmtTs(id.expiresAt)], ['Validated at', fmtTs(id.validatedAt)],
                ['Duration', fmtDuration(id.sessionDurationSeconds)], ['Last activity', fmtTs(data.lastActivityAt)],
                ['Last auth error', data.lastAuthError ? `${data.lastAuthError} (${fmtTs(data.lastAuthErrorAt)})` : null],
                ['Last REST error', data.lastRestError ?? null],
              ] as [string, unknown][]).filter(([, v]) => v != null && v !== '').map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3 rounded-lg border-b border-border/40 px-2 py-1.5 transition-colors hover:bg-white/[0.03]">
                  <span className="shrink-0 text-muted-foreground">{k}</span>
                  <span className="min-w-0 truncate text-right font-mono" title={String(v)}>{String(v)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="overflow-hidden shadow-soft">
            <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-cyan-500/5 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 p-1.5 text-white shadow"><Wifi className="h-3.5 w-3.5" /></span>
                WebSocket · routing
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-3">
              {loading ? <div className="h-16 animate-pulse rounded-lg bg-muted/60" /> : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className={wsLive ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}>
                      <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', wsLive && 'animate-pulse bg-emerald-400')} />{String(ws.state ?? 'DISCONNECTED')}
                    </Badge>
                    <Badge variant="outline" className="tabular-nums">reconnects {fmtNum(ws.reconnectCount)}</Badge>
                    <Badge variant="outline">routing {String(routing.state ?? '—')} · {String(routing.owner ?? '')}</Badge>
                  </div>
                  <div className="space-y-1 rounded-xl border border-border/50 bg-white/[0.02] p-2.5 text-[11px] text-muted-foreground">
                    <p>connected <AgeTicker ts={ws.connectedAt} /></p>
                    <p>disconnected <AgeTicker ts={ws.disconnectedAt} prefix={ws.disconnectReason ?? undefined} /></p>
                    <p>last message <AgeTicker ts={ws.lastMessageAt} /></p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* PWA + notifications — full support */}
          <Card className="overflow-hidden border-violet-500/25 shadow-soft">
            <CardHeader className="bg-gradient-to-r from-violet-500/15 to-fuchsia-500/10 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <span className="rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 p-1.5 text-white shadow"><MonitorSmartphone className="h-3.5 w-3.5" /></span>
                PWA · App & alerts
                {alerts.filter((a) => a.severity !== 'info').length > 0 && (
                  <Badge className="ml-auto border border-amber-500/40 bg-amber-500/15 text-amber-200 tabular-nums">{alerts.filter((a) => a.severity !== 'info').length} alerts</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 pt-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                {installed ? (
                  <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300"><Download className="mr-1 h-3 w-3" /> Installed · standalone</Badge>
                ) : canInstall ? (
                  <Button size="sm" onClick={() => void promptInstall()} className="bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md"><Download className="mr-1.5 h-3.5 w-3.5" /> Install app now</Button>
                ) : (
                  <span className="text-[11px] text-muted-foreground">Browser menu → Install / Add to Home Screen se install karo.</span>
                )}
                <span className="ml-auto"><OnlineDot /></span>
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/50 bg-white/[0.02] p-2.5">
                <Bell className="h-3.5 w-3.5 text-muted-foreground" />
                {permission === 'granted'
                  ? <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">Browser alerts ON — critical popup ayega</Badge>
                  : permission === 'denied'
                    ? <span className="text-[11px] text-muted-foreground">Notifications blocked — site settings se allow karo.</span>
                    : permission === 'unsupported'
                      ? <span className="text-[11px] text-muted-foreground">Is browser me Notification API nahi.</span>
                      : <Button size="sm" variant="outline" onClick={() => void request()}><Bell className="mr-1.5 h-3.5 w-3.5" /> Enable browser alerts</Button>}
              </div>
              <div className="space-y-1">
                {alerts.slice(0, 5).map((a) => (
                  <div key={a.id} className={cn('flex items-center gap-2 rounded-lg border px-2 py-1.5', a.severity === 'critical' ? 'border-rose-500/30 bg-rose-500/[0.06]' : a.severity === 'warn' ? 'border-amber-500/25 bg-amber-500/[0.05]' : 'border-sky-500/25 bg-sky-500/[0.05]')}>
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', a.severity === 'critical' ? 'animate-pulse bg-rose-400' : a.severity === 'warn' ? 'bg-amber-400' : 'bg-sky-400')} />
                    <span className="min-w-0 flex-1 truncate font-medium">{a.title} <span className="font-normal text-muted-foreground">· {a.detail}</span></span>
                  </div>
                ))}
                {!alerts.length && !loading && <p className="flex items-center gap-1.5 text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> All clear — koi session alert nahi.</p>}
                {loading && <div className="h-8 animate-pulse rounded-lg bg-muted/60" />}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* TERMINALS */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-purple-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
            Terminal sessions · independent
            <Badge variant="outline" className="tabular-nums">{fmtNum(terminals.length)}</Badge>
            <span className="relative ml-auto w-48 max-w-full sm:w-56">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter terminals…" className="h-7 pl-2 pr-2 text-[11px]" />
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Terminal</th><th className="px-3 py-2">Broker</th><th className="px-3 py-2">Session</th>
                  <th className="px-3 py-2">Status</th><th className="px-3 py-2">Login</th><th className="px-3 py-2">Expires</th>
                  <th className="px-3 py-2">Connection</th><th className="px-3 py-2">Message</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [0, 1, 2].map((i) => <tr key={i} className="border-b border-border/40"><td colSpan={8} className="px-3 py-2"><div className="h-8 animate-pulse rounded bg-muted/60" /></td></tr>)
                ) : filteredTerms.map(([term, r]: [string, any]) => (
                  <tr key={term} className="border-b border-border/40 transition-colors hover:bg-white/[0.03]">
                    <td className="px-3 py-2 font-semibold">{term}</td>
                    <td className="px-3 py-2">{r.broker_id ?? '—'}</td>
                    <td className="max-w-[180px] truncate px-3 py-2 font-mono" title={r.session_id ?? r.session_ref}>{r.session_id ?? r.session_ref ?? '—'}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className={TONE[String(r.session_status ?? '').toUpperCase()] ?? ''}>{r.session_status ?? '—'}</Badge></td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{fmtTs(r.created_at)}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{fmtTs(r.expires_at)}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className={r.connection_status === 'CONNECTED' ? 'border-emerald-500/30 text-emerald-300' : ''}>{String(r.connection_status ?? '—')}</Badge></td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-muted-foreground" title={r.state_message}>{r.state_message ?? '—'}</td>
                  </tr>
                ))}
                {!loading && !filteredTerms.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No terminal sessions yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* HISTORY + EVENTS */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-sky-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-cyan-500 to-sky-600 p-1.5 text-white shadow"><HistoryIcon className="h-3.5 w-3.5" /></span>
              Session history · ledger
              <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(historyRows.length)}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 text-left text-muted-foreground backdrop-blur">
                  <tr>
                    <th className="px-3 py-2">Login</th><th className="px-3 py-2">Logout</th><th className="px-3 py-2">Duration</th>
                    <th className="px-3 py-2">Reason</th><th className="px-3 py-2">Mode</th><th className="px-3 py-2">Broker</th>
                  </tr>
                </thead>
                <tbody>
                  {!late || (!hist.data && !hist.error && !data.sessionHistory) ? (
                    [0, 1, 2, 3].map((i) => <tr key={i} className="border-b border-border/40"><td colSpan={6} className="px-3 py-2"><div className="h-7 animate-pulse rounded bg-muted/60" /></td></tr>)
                  ) : historyRows.map((h: any, i: number) => (
                    <tr key={i} className="border-b border-border/40 transition-colors hover:bg-white/[0.03]">
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono">{fmtTs(h.login_time ?? h.ts)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono">{fmtTs(h.logout_time)}</td>
                      <td className="px-3 py-1.5 font-mono tabular-nums">{fmtDuration(h.session_duration)}</td>
                      <td className="max-w-[160px] truncate px-3 py-1.5" title={h.logout_reason ?? h.message}>{h.logout_reason ?? h.message ?? '—'}</td>
                      <td className="px-3 py-1.5"><Badge variant="outline" className="font-mono text-[10px]">{h.mode ?? '—'}</Badge></td>
                      <td className="px-3 py-1.5">{h.broker ?? '—'}</td>
                    </tr>
                  ))}
                  {late && (hist.error && !data.sessionHistory) ? (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-rose-300">History unavailable: {hist.error}</td></tr>
                  ) : late && !historyRows.length && (hist.data || data.sessionHistory) ? (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No completed sessions yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-fuchsia-500/10 to-pink-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
              Recent session events · live
              <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(events.length)}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            {loading ? (
              <div className="space-y-1.5">{[0, 1, 2, 3].map((i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/60" />)}</div>
            ) : (
              <div className="max-h-72 space-y-1 overflow-auto">
                {events.slice(0, 10).map((e: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-border/40 bg-white/[0.02] px-2 py-1.5 text-[11px]">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', String(e.event ?? '').includes('FAIL') || String(e.event ?? '').includes('ERROR') ? 'bg-rose-400' : String(e.event ?? '').includes('SUCCESS') || String(e.event ?? '').includes('READY') ? 'bg-emerald-400' : 'bg-sky-400')} />
                    <span className="shrink-0 font-mono font-semibold text-emerald-300">{String(e.event ?? 'event').slice(0, 24)}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.message ?? '—'}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtTs(e.at ?? e.ts)}</span>
                  </div>
                ))}
                {!events.length && <p className="py-4 text-center text-[11px] text-muted-foreground">No session events yet.</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Sources: <span className="font-mono">GET /session · GET /session/history</span> — sab real backend state. Session turant, history 500ms baad; auto-refresh throttled (20s/60s, hidden tab paused). PWA install + browser alerts + offline badge built-in. Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
