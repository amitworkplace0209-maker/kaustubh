'use client';

import { useMemo, useState } from 'react';
import { Database, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { SectionCard, StatusBadge } from '@/components/design-system';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { dataCenterActions } from '@/lib/data-center-store';
import {
  DASH,
  fmtAgo,
  fmtBytes,
  fmtClock,
  fmtDec,
  fmtInt,
} from '@/lib/data-center-snapshot';
import type { DcSnapshot } from '@/lib/data-center-snapshot';
import type {
  DcCleanupPayload,
  DcSystemInfo,
  DcTrendPayload,
} from '@/lib/data-center';

function Row({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  const missing = value === DASH;
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5 last:border-0">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right text-[11px] tabular-nums',
          missing ? 'text-muted-foreground/70' : 'text-foreground',
        )}
        title={hint ? `${value} — ${hint}` : value}
      >
        {value}
      </span>
    </div>
  );
}

function SpaceDonut({ pct }: { pct: number | null }) {
  const p = pct == null || !Number.isFinite(pct) ? 0 : Math.max(0, Math.min(100, pct));
  const r = 34;
  const c = 2 * Math.PI * r;
  const tone = pct == null ? 'text-muted-foreground/30' : pct >= 90 ? 'text-destructive' : pct >= 75 ? 'text-warning' : 'text-teal-500';
  return (
    <div className="relative h-[96px] w-[96px] shrink-0">
      <svg viewBox="0 0 96 96" className="h-full w-full -rotate-90">
        <circle cx="48" cy="48" r={r} fill="none" strokeWidth="10" className="stroke-muted/40" />
        <circle
          cx="48"
          cy="48"
          r={r}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(p / 100) * c} ${c}`}
          className={cn('stroke-current', tone)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold tabular-nums leading-none">
          {pct == null ? DASH : `${fmtDec(pct, 1)}%`}
        </span>
        <span className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">used</span>
      </div>
    </div>
  );
}

/** Lightweight SVG sparkline — no chart lib, instant paint. */
function StorageSparkline({ trend }: { trend: DcTrendPayload | null }) {
  const pts = useMemo(() => {
    const raw = (trend?.points ?? []).filter(
      (p) => typeof p.dbTotalStorageBytes === 'number' && Number.isFinite(p.dbTotalStorageBytes),
    );
    return raw.slice(-30);
  }, [trend]);
  if (pts.length < 2) {
    return (
      <p className="rounded-lg border border-border/40 bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
        Storage trend builds up as snapshots accumulate (10 min cadence).
      </p>
    );
  }
  const vals = pts.map((p) => p.dbTotalStorageBytes as number);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 560;
  const H = 64;
  const d = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * W;
      const y = H - 6 - ((p.dbTotalStorageBytes as number - min) / span) * (H - 14);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <div className="rounded-lg border border-border/40 bg-card/40 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Storage growth</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {fmtBytes(min)} → {fmtBytes(max)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-[64px] w-full" preserveAspectRatio="none">
        <path d={d} fill="none" strokeWidth="2" className="stroke-teal-500" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function DatabaseMainSection({
  snapshot,
  now,
  host,
  hostError,
  cleanup,
  cleanupError,
  trend,
}: {
  snapshot: DcSnapshot;
  now: number;
  host: DcSystemInfo | null;
  hostError?: string | null;
  cleanup: DcCleanupPayload | null;
  cleanupError: string | null;
  trend: DcTrendPayload | null;
}) {
  const [cleanBusy, setCleanBusy] = useState(false);
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const d = snapshot.database;
  const s = snapshot.storage;
  const connected = d.connected === true;

  const hostTotal = host?.diskTotalBytes ?? null;
  const hostUsed = host?.diskUsedBytes ?? null;
  const hostPct = host?.diskPercent ?? null;
  const hostFree = hostTotal != null && hostUsed != null ? Math.max(0, hostTotal - hostUsed) : null;
  const hostMissing = hostTotal == null;
  const hostNote = hostMissing
    ? (hostError ?? 'Host disk probe (overview section) abhi load ho raha hai — kuch second me numbers aa jayenge.')
    : null;

  const dbSize = s.available ? s.storageSizeBytes : null;
  const dataSize = s.available ? s.dataSizeBytes : null;
  const indexSize = s.available ? s.indexSizeBytes : null;
  const src = `${d.provider ?? ''} ${d.activeSource ?? ''} ${d.configuredSource ?? ''}`.toLowerCase();
  const isAtlas = src.includes('atlas');
  // Atlas driver dbStats se: data ka storage me hissa (donut isi ka).
  const dataSharePct = dbSize != null && dataSize != null && dbSize > 0 ? (dataSize / dbSize) * 100 : null;

  const collections = useMemo(() => {
    const list = s.available ? [...s.collections] : [];
    list.sort((a, b) => (b.storageBytes ?? b.sizeBytes ?? 0) - (a.storageBytes ?? a.sizeBytes ?? 0));
    return list;
  }, [s]);
  const visible = showAll ? collections : collections.slice(0, 8);

  const last = cleanup?.last ?? null;

  const [confirmFull, setConfirmFull] = useState(false);

  const handleCleanup = async (mode: 'safe' | 'full') => {
    if (cleanBusy) return;
    if (mode === 'full' && !confirmFull) {
      setConfirmFull(true);
      setCleanMsg('Pakka full clean? Dobara click karo — ticks, notifications, alerts, history sab delete hoga. Settings/stocks safe rahenge.');
      return;
    }
    setCleanBusy(true);
    setCleanMsg(null);
    try {
      const r = await dataCenterActions.runCleanup(mode);
      const n = (r as { deleted?: number | null }).deleted;
      const count = typeof n === 'number' ? `${fmtInt(n)} records` : 'records';
      setCleanMsg(
        r.ok
          ? mode === 'full'
            ? `Full clean finished — ${count} deleted (ticks, notifications, alerts, history). Settings/stocks safe.`
            : `Cleanup finished — ${count} temp data removed, main content kept.`
          : (r.message ?? 'Cleanup failed.'),
      );
    } catch (e) {
      setCleanMsg(e instanceof Error ? e.message : 'Cleanup failed.');
    } finally {
      setCleanBusy(false);
      setConfirmFull(false);
    }
  };

  if (!d.available && !s.available) {
    return (
      <SectionCard title="Database" icon={Database}>
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
          <StatusBadge status="warning" label="NOT AVAILABLE" />
          <p className="mt-1.5 text-[11px] text-warning">{d.error ?? s.error ?? 'The backend did not report database state.'}</p>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Database"
      icon={Database}
      headerRight={
        <div className="flex items-center gap-2">
          <StatusBadge status={connected ? 'success' : 'danger'} label={connected ? 'CONNECTED' : 'DISCONNECTED'} />
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11px]" onClick={() => void dataCenterActions.refresh()}>
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
          <Button size="sm" className="h-7 gap-1.5 text-[11px]" onClick={() => void handleCleanup('safe')} disabled={cleanBusy}>
            <Trash2 className="h-3 w-3" /> {cleanBusy ? 'Cleaning…' : 'Run cleanup now'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* identity line */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {d.provider ? <StatusBadge status="info" label={d.provider.toUpperCase()} /> : null}
          <span className="truncate font-mono text-muted-foreground" title={d.database ?? ''}>{d.database ?? s.dbName ?? DASH}</span>
          {d.serverVersion ? <span className="text-muted-foreground">· v{d.serverVersion}</span> : null}
          {s.pingMs != null ? <span className="text-muted-foreground">· {fmtDec(s.pingMs, 1)} ms</span> : null}
        </div>

        {/* SPACE OVERVIEW — Atlas DB ka real usage (local device disk nahi) */}
        {isAtlas ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[auto_1fr]">
            <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
              <SpaceDonut pct={dataSharePct} />
              <div className="min-w-0 space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Atlas DB storage — used</div>
                <div className="text-xl font-bold tabular-nums leading-none">{fmtBytes(dbSize)}</div>
                <div className="text-[11px] tabular-nums text-muted-foreground">
                  <span className="text-foreground font-semibold">{fmtBytes(dataSize)}</span> data ·{' '}
                  <span className="text-teal-500 font-semibold">{fmtBytes(indexSize)}</span> index
                </div>
                <div className="text-[10px] text-muted-foreground">{fmtInt(s.documents)} documents · {fmtInt(s.collectionsCount)} collections</div>
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Atlas usage split</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {dataSharePct == null ? DASH : `data ${fmtDec(dataSharePct, 1)}% of storage`}
                </span>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted/50">
                <div
                  className="h-full rounded-full bg-teal-500 transition-all"
                  style={{ width: `${dataSharePct == null ? 0 : Math.max(0, Math.min(100, dataSharePct))}%` }}
                />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-background/60 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Used</div>
                  <div className="truncate text-[13px] font-semibold tabular-nums">{fmtBytes(dbSize)}</div>
                </div>
                <div className="rounded-lg bg-background/60 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Data</div>
                  <div className="truncate text-[13px] font-semibold tabular-nums">{fmtBytes(dataSize)}</div>
                </div>
                <div className="rounded-lg bg-background/60 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Index</div>
                  <div className="truncate text-[13px] font-semibold tabular-nums">{fmtBytes(indexSize)}</div>
                </div>
              </div>
              {(() => {
                const st = cleanup?.storage ?? null;
                const pct = st?.usagePct ?? (dbSize != null && hostTotal != null && hostTotal > 0 ? (dbSize / hostTotal) * 100 : null);
                const threshold = st?.thresholdPct ?? 90;
                const autoOn = st?.autoArmed ?? cleanup?.enabled ?? null;
                const over = st?.overThreshold ?? (pct != null && pct >= threshold);
                return (
                  <div className="mt-3 rounded-lg bg-background/60 px-2.5 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                        DB full — {st?.capacityMb != null ? `${st.capacityMb} MB capacity` : 'capacity'} ka hissa
                      </span>
                      <span className={cn('text-[12px] font-bold tabular-nums', over ? 'text-destructive' : 'text-foreground')}>
                        {pct == null ? DASH : `${fmtDec(pct, 1)}%`}
                      </span>
                    </div>
                    <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-muted/50">
                      <div
                        className={cn('h-full rounded-full transition-all', over ? 'bg-destructive' : pct != null && pct >= threshold - 10 ? 'bg-warning' : 'bg-teal-500')}
                        style={{ width: `${pct == null ? 0 : Math.max(0, Math.min(100, pct))}%` }}
                      />
                      <div className="absolute inset-y-0 w-0.5 bg-foreground/70" style={{ left: `${Math.max(0, Math.min(100, threshold))}%` }} title={`${threshold}% auto-cleanup line`} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-[10px] text-muted-foreground">
                      <span>{st?.usedMb != null ? `${fmtDec(st.usedMb, 1)} MB used` : fmtBytes(dbSize)}</span>
                      <span>{threshold}% par auto safai</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                      {autoOn === true ? (
                        <span className="text-teal-500 font-medium">Auto-cleanup ON</span>
                      ) : autoOn === false ? (
                        <span className="text-warning font-medium">Auto-cleanup OFF</span>
                      ) : 'Auto-cleanup'} — {threshold}% full hote hi temp data apne aap saaf ho jayega (har 5 min check)
                      {st?.lastAutoCleanAt ? ` · last auto: ${fmtAgo(st.lastAutoCleanAt, now)}` : ''}.
                    </p>
                  </div>
                );
              })()}
              <p className="mt-2 text-[10px] text-muted-foreground">
                Capacity configured hai (Atlas M0 = 512 MB) — driver quota expose nahi karta. Used + Data/Index split 100% real (dbStats) hai.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[auto_1fr]">
            <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
              <SpaceDonut pct={hostPct} />
              <div className="min-w-0 space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Local disk space</div>
                <div className="text-xl font-bold tabular-nums leading-none">{fmtBytes(hostTotal)}</div>
                <div className="text-[11px] tabular-nums text-muted-foreground">
                  <span className="text-foreground font-semibold">{fmtBytes(hostUsed)}</span> full ·{' '}
                  <span className="text-teal-500 font-semibold">{fmtBytes(hostFree)}</span> free
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Usage</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {hostPct == null ? DASH : `${fmtDec(hostPct, 1)}% full`}
                </span>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted/50">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    hostPct == null ? 'bg-muted' : hostPct >= 90 ? 'bg-destructive' : hostPct >= 75 ? 'bg-warning' : 'bg-teal-500',
                  )}
                  style={{ width: `${hostPct == null ? 0 : Math.max(0, Math.min(100, hostPct))}%` }}
                />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-background/60 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Total</div>
                  <div className="truncate text-[13px] font-semibold tabular-nums">{fmtBytes(hostTotal)}</div>
                </div>
                <div className="rounded-lg bg-background/60 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Full</div>
                  <div className="truncate text-[13px] font-semibold tabular-nums">{fmtBytes(hostUsed)}</div>
                </div>
                <div className="rounded-lg bg-background/60 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Free</div>
                  <div className="truncate text-[13px] font-semibold tabular-nums text-teal-500">{fmtBytes(hostFree)}</div>
                </div>
              </div>
              {hostNote ? <p className="mt-1 text-[10px] text-warning">{hostNote}</p> : null}
            </div>
          </div>
        )}

        {/* DB STORAGE GRID */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {[
            { label: 'DB storage', value: fmtBytes(s.storageSizeBytes) },
            { label: 'Data size', value: fmtBytes(s.dataSizeBytes) },
            { label: 'Index size', value: fmtBytes(s.indexSizeBytes) },
            { label: 'Documents', value: fmtInt(s.documents) },
            { label: 'Collections', value: fmtInt(s.collectionsCount) },
            { label: 'Indexes', value: fmtInt(s.indexesCount) },
          ].map((k) => (
            <div key={k.label} className="min-w-0 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
              <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{k.label}</div>
              <div className="mt-0.5 truncate text-[15px] font-semibold tabular-nums" title={k.value}>{k.value}</div>
            </div>
          ))}
        </div>

        <StorageSparkline trend={trend} />

        {/* COLLECTIONS */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Storage detail — Collections · {fmtInt(collections.length)} · total {fmtBytes(s.storageSizeBytes)}
            </p>
            {collections.length > 8 ? (
              <button
                className="text-[10px] text-primary hover:underline"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? 'Show less' : `Show all ${collections.length}`}
              </button>
            ) : null}
          </div>
          {visible.length === 0 ? (
            <p className="rounded-lg border border-border/40 px-3 py-2 text-[11px] text-muted-foreground">No collection sizes reported.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border/60">
              <table className="w-full min-w-[620px] text-[11px]">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">Collection</th>
                    <th className="px-3 py-1.5 text-right font-medium">Docs</th>
                    <th className="px-3 py-1.5 text-right font-medium">Storage</th>
                    <th className="px-3 py-1.5 text-right font-medium">DB ka hissa</th>
                    <th className="px-3 py-1.5 text-right font-medium">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const bytes = c.storageBytes ?? c.sizeBytes ?? null;
                    const share = dbSize != null && bytes != null && dbSize > 0 ? (bytes / dbSize) * 100 : null;
                    return (
                      <tr key={c.name} className="border-b border-border/30 last:border-0">
                        <td className="max-w-[200px] truncate px-3 py-1.5 font-mono text-[10px]" title={c.name}>{c.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {fmtInt(c.count)}{c.countIsApproximate ? <span className="ml-0.5 text-muted-foreground">~</span> : null}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtBytes(bytes)}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted/50">
                              <div className="h-full rounded-full bg-teal-500" style={{ width: `${share == null ? 0 : Math.max(0, Math.min(100, share))}%` }} />
                            </div>
                            <span className="w-11 text-right tabular-nums text-muted-foreground">{share == null ? DASH : `${fmtDec(share, 1)}%`}</span>
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {c.health ? (
                            <StatusBadge
                              status={c.health.toUpperCase() === 'OK' ? 'success' : c.health.toUpperCase() === 'WARN' ? 'warning' : 'danger'}
                              label={c.health}
                            />
                          ) : <span className="text-muted-foreground">{DASH}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* CONNECTION DETAILS */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Connection</p>
            <Row label="Host" value={d.host ?? DASH} />
            <Row label="Configured source" value={d.configuredSource ?? 'NOT CONFIGURED'} />
            <Row label="Active source" value={d.activeSource ?? DASH} />
            <Row
              label="Pool"
              value={
                typeof d.pool === 'object' && d.pool !== null && 'maxPoolSize' in d.pool
                  ? `${fmtInt((d.pool as { checkedOut?: number | null }).checkedOut ?? null)} / ${fmtInt((d.pool as { maxPoolSize?: number | null }).maxPoolSize ?? null)} in use`
                  : DASH
              }
            />
            <Row label="Server ping" value={s.pingMs != null ? `${fmtDec(s.pingMs, 1)} ms` : DASH} />
          </div>
          <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Cleanup — 1 click</p>
            {cleanupError && !cleanup ? (
              <p className="text-[11px] text-warning">{cleanupError}</p>
            ) : (
              <>
                <Row label="Last cleanup" value={last?.finishedAt ? fmtAgo(last.finishedAt, now) : 'NEVER RAN'} hint={last?.finishedAt ? fmtClock(last.finishedAt) : undefined} />
                <Row label="Last mode" value={last?.mode ? last.mode.toUpperCase() : DASH} />
                <Row label="Deleted last run" value={last?.totalDeleted != null ? fmtInt(last.totalDeleted) : DASH} />
                <Row label="Next cleanup" value={cleanup?.nextCleanup ? fmtAgo(cleanup.nextCleanup, now) : DASH} hint={cleanup?.schedule ?? cleanup?.timezone ?? undefined} />
                <Row label="Status" value={last?.status ?? 'NEVER RUN'} />
              </>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={() => void handleCleanup('safe')} disabled={cleanBusy}>
                <Trash2 className="h-3.5 w-3.5" /> {cleanBusy ? 'Cleaning…' : 'Run cleanup now'}
              </Button>
              <Button
                size="sm"
                variant={confirmFull ? 'destructive' : 'outline'}
                className="h-8 gap-1.5 border-destructive/50 text-[12px]"
                onClick={() => void handleCleanup('full')}
                disabled={cleanBusy}
                onBlur={() => setConfirmFull(false)}
              >
                <Trash2 className="h-3.5 w-3.5" /> {cleanBusy ? 'Cleaning…' : confirmFull ? 'Pakka? Phir click karo' : 'Full clean (sab data)'}
              </Button>
              {cleanMsg ? <span className="text-[11px] text-muted-foreground">{cleanMsg}</span> : null}
            </div>
            <div className="mt-1.5 space-y-1 text-[10px] text-muted-foreground">
              <p className="flex items-start gap-1">
                <HardDrive className="mt-0.5 h-3 w-3 shrink-0" />
                Run cleanup: sirf temp market data + telemetry saaf — ticks history, notifications, settings safe.
              </p>
              <p className="flex items-start gap-1">
                <HardDrive className="mt-0.5 h-3 w-3 shrink-0" />
                Full clean: ticks, notifications, alerts, events, download history, reports sab delete — sirf settings/stocks/watchlist safe rehte hain.
              </p>
            </div>
          </div>
        </div>

        <p className="break-words text-[10px] text-muted-foreground">
          source: {d.source} · measured {fmtAgo(d.generatedAt, now)}{d.generatedAt ? ` (${fmtClock(d.generatedAt)})` : ''}
        </p>
      </div>
    </SectionCard>
  );
}
