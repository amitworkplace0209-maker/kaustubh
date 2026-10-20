'use client';

/**
 * Feed freshness + connection quality — advanced, derived ONLY from real data.
 * Pure SVG (no chart lib): instant paint, zero bundle cost.
 */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

export interface FreshnessInput {
  secondsSinceTick: number | null;
  secondsSinceMessage: number | null;
  feedState: string | null;
  connected: boolean | null;
}

export interface QualityInput {
  availabilityPct: number | null;
  totalMessages: number | null;
  totalErrors: number | null;
  reconnectCount: number | null;
}

function freshnessTone(ageSec: number | null): { label: string; color: string; pct: number } {
  if (ageSec == null) return { label: 'NO DATA', color: '#64748b', pct: 0 };
  if (ageSec <= 5) return { label: 'LIVE', color: '#10b981', pct: 100 };
  if (ageSec <= 30) return { label: 'FRESH', color: '#38bdf8', pct: 72 };
  if (ageSec <= 120) return { label: 'STALE', color: '#f59e0b', pct: 42 };
  return { label: 'DEAD', color: '#f43f5e', pct: 16 };
}

/** Honest 0–100 score with a visible formula — a derivation, not a measurement. */
export function qualityScore(q: QualityInput): { score: number | null; parts: { label: string; value: number; max: number }[] } {
  if (q.availabilityPct == null && q.totalErrors == null && q.reconnectCount == null) {
    return { score: null, parts: [] };
  }
  const avail = q.availabilityPct ?? 0;
  const msgs = q.totalMessages ?? 0;
  const errs = q.totalErrors ?? 0;
  const errRate = msgs > 0 ? Math.min(1, errs / msgs) : errs > 0 ? 1 : 0;
  const recon = Math.min(1, (q.reconnectCount ?? 0) / 20);
  const availPart = Math.max(0, Math.min(100, avail)) * 0.5;
  const errPart = (1 - errRate) * 100 * 0.3;
  const reconPart = (1 - recon) * 100 * 0.2;
  return {
    score: Math.round((availPart + errPart + reconPart) * 10) / 10,
    parts: [
      { label: 'Availability × 50%', value: Math.round(availPart * 10) / 10, max: 50 },
      { label: 'Error-free × 30%', value: Math.round(errPart * 10) / 10, max: 30 },
      { label: 'Stability × 20%', value: Math.round(reconPart * 10) / 10, max: 20 },
    ],
  };
}

function Ring({ pct, color, children }: { pct: number; color: string; children: React.ReactNode }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-[84px] w-[84px] shrink-0">
      <svg viewBox="0 0 84 84" className="h-full w-full -rotate-90">
        <circle cx="42" cy="42" r={r} fill="none" strokeWidth="9" className="stroke-muted/40" />
        <circle
          cx="42" cy="42" r={r} fill="none" strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${(Math.max(0, Math.min(100, pct)) / 100) * c} ${c}`}
          stroke={color}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

function fmtAge(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h`;
}

export function TicksSparkline({ series }: { series: { ticksPerSecond?: number | null }[] }) {
  const pts = useMemo(() => {
    const vals = (series ?? [])
      .map((p) => (typeof p.ticksPerSecond === 'number' && Number.isFinite(p.ticksPerSecond) ? p.ticksPerSecond : null))
      .filter((v): v is number => v !== null)
      .slice(-90);
    return vals;
  }, [series]);
  if (pts.length < 2) {
    return <p className="rounded-lg border border-border/40 px-3 py-2 text-[11px] text-muted-foreground">Not enough buckets for a sparkline yet.</p>;
  }
  const max = Math.max(...pts, 1);
  const W = 300;
  const H = 44;
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (pts.length - 1)) * W).toFixed(1)},${(H - 4 - (v / max) * (H - 10)).toFixed(1)}`).join(' ');
  return (
    <div className="rounded-lg border border-border/40 bg-card/40 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Ticks/s — last {pts.length} buckets</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">peak {Math.max(...pts).toFixed(1)}/s</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-[44px] w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="ws-spark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#14b8a6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={`${d} L${W},${H} L0,${H} Z`} fill="url(#ws-spark)" />
        <path d={d} fill="none" stroke="#14b8a6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function FreshnessPanel({ live, quality, series }: {
  live: FreshnessInput;
  quality: QualityInput;
  series: { ticksPerSecond?: number | null }[];
}) {
  const tick = freshnessTone(live.secondsSinceTick);
  const msg = freshnessTone(live.secondsSinceMessage);
  const q = qualityScore(quality);
  const scoreColor = q.score == null ? '#64748b' : q.score >= 90 ? '#10b981' : q.score >= 70 ? '#38bdf8' : q.score >= 40 ? '#f59e0b' : '#f43f5e';

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
        <Ring pct={tick.pct} color={tick.color}>
          <span className="text-sm font-bold tabular-nums leading-none">{fmtAge(live.secondsSinceTick)}</span>
          <span className="mt-0.5 text-[8px] uppercase tracking-wide text-muted-foreground">tick age</span>
        </Ring>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Feed freshness</p>
          <p className="text-lg font-bold" style={{ color: tick.color }}>{tick.label}</p>
          <p className="truncate text-[10px] text-muted-foreground">feed: {live.feedState ?? '—'}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
        <Ring pct={msg.pct} color={msg.color}>
          <span className="text-sm font-bold tabular-nums leading-none">{fmtAge(live.secondsSinceMessage)}</span>
          <span className="mt-0.5 text-[8px] uppercase tracking-wide text-muted-foreground">msg age</span>
        </Ring>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Message freshness</p>
          <p className="text-lg font-bold" style={{ color: msg.color }}>{msg.label}</p>
          <p className="text-[10px] text-muted-foreground">{live.connected ? 'socket connected' : 'socket not connected'}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Connection quality (derived)</p>
          <p className="text-xl font-bold tabular-nums" style={{ color: scoreColor }}>{q.score == null ? '—' : q.score}</p>
        </div>
        {q.parts.length === 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground">Not enough history to score yet.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {q.parts.map((p) => (
              <div key={p.label}>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{p.label}</span><span className="tabular-nums">{p.value}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted/50">
                  <div className={cn('h-full rounded-full')} style={{ width: `${p.max > 0 ? Math.max(0, Math.min(100, (p.value / p.max) * 100)) : 0}%`, background: scoreColor }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="lg:col-span-3">
        <TicksSparkline series={series} />
      </div>
    </div>
  );
}
