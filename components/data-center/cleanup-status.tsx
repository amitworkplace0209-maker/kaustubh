'use client';

import { useState } from 'react';
import { CalendarClock, Database, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  EmptyState, ErrorState, StatCard, StatusBadge, fmtNumber,
} from '@/components/design-system';
import { dataCenterActions } from '@/lib/data-center-store';
import type { DcCleanupPayload } from '@/lib/data-center';
import { clockLabel, shortDate } from '@/lib/data-center';

function runTone(status: string | null | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  const s = (status ?? '').toUpperCase();
  if (s === 'SUCCESS') return 'success';
  if (s === 'PARTIAL') return 'warning';
  if (s === 'FAILED') return 'danger';
  return 'neutral';
}

function runLabel(status: string | null | undefined): string {
  const s = (status ?? '').toUpperCase();
  if (s === 'SUCCESS' || s === 'PARTIAL' || s === 'FAILED') return s;
  return 'NEVER RUN';
}

/** Atlas 06:00 IST cleanup — real status from /api/system/cleanup/status. */
export function CleanupStatusCard({ data, error }: { data: DcCleanupPayload | null; error: string | null }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (error && !data) {
    return <ErrorState message={error} onRetry={() => void dataCenterActions.refresh()} />;
  }
  if (!data) {
    return <EmptyState icon={Trash2} title="No cleanup status" description="The backend did not report cleanup state yet." />;
  }

  const last = data.last;
  const topCollections = (last?.collections ?? [])
    .filter((c) => (c.deleted ?? 0) > 0 || c.error)
    .slice(0, 6);

  const handleRun = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await dataCenterActions.runCleanup();
      if (r.ok) {
        const n = (r as { deleted?: number | null }).deleted;
        setMsg(
          typeof n === 'number'
            ? `Cleanup finished — ${fmtNumber(n)} non-important records removed, main content kept.`
            : 'Cleanup finished — non-important data removed, main content kept.',
        );
      } else {
        setMsg(r.message ?? 'Cleanup failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard
          icon={CalendarClock} title="Last cleanup" tone="neutral"
          value={last?.finishedAt ? shortDate(last.finishedAt) : '—'}
          sub={last?.finishedAt ? clockLabel(last.finishedAt) : 'never ran'}
        />
        <StatCard
          icon={Database} title="Records deleted" tone="teal"
          value={last?.totalDeleted != null ? fmtNumber(last.totalDeleted) : '—'}
          sub={last ? `${fmtNumber(last.collectionsCleaned)} collections` : undefined}
        />
        <StatCard
          icon={CalendarClock} title="Next cleanup" tone="blue"
          value={data.nextCleanup ? shortDate(data.nextCleanup) : '—'}
          sub={data.schedule ?? data.timezone ?? undefined}
        />
        <StatCard
          icon={ShieldCheck}
          title="Status"
          tone={runTone(last?.status) === 'success' ? 'success' : runTone(last?.status) === 'warning' ? 'warning' : runTone(last?.status) === 'danger' ? 'danger' : 'neutral'}
          value={runLabel(last?.status)}
          sub={last?.trigger ? `via ${last.trigger}` : data.enabled === false ? 'scheduler disabled' : undefined}
        />
      </div>

      {last?.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          {last.error}
        </p>
      )}

      {topCollections.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Collection</th>
                <th className="px-3 py-2 text-right font-semibold">Deleted</th>
                <th className="px-3 py-2 text-right font-semibold">State</th>
              </tr>
            </thead>
            <tbody>
              {topCollections.map((c) => (
                <tr key={c.name} className="border-b border-border/30 last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-1.5 font-mono">{c.name}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtNumber(c.deleted)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <StatusBadge status={c.error ? 'danger' : 'success'} label={c.error ? 'FAILED' : 'CLEANED'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={handleRun} disabled={busy}>
          <Trash2 className="h-3.5 w-3.5" /> {busy ? 'Cleaning…' : 'Run cleanup now'}
        </Button>
        {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
        <span className="text-[10px] text-muted-foreground">1 click — ticks & main content safe, sirf expired/logs clean hote hain.</span>
        <span className="ml-auto hidden text-[10px] text-muted-foreground sm:inline">
          Daily 06:00 {data.timezone ?? 'Asia/Kolkata'} · Atlas trigger covers backend-offline
        </span>
      </div>
    </div>
  );
}
