'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, SectionCard, StatusBadge } from '@/components/design-system';
import { getKotakAudit, type AuditEntry } from '@/lib/kotak';
import { KotakPage } from '@/components/kotak/ui';

function fmtTs(ts?: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function actionTone(action?: string): 'success' | 'warning' | 'neutral' {
  const a = String(action || '').toLowerCase();
  if (/(place|execute|push|fill)/.test(a)) return 'success';
  if (/(reject|cancel|fail|error|logout)/.test(a)) return 'warning';
  return 'neutral';
}

export default function KotakAudit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState('kotak');

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getKotakAudit(150);
      setEntries(Array.isArray(res?.data) ? res.data : []);
      if (res?.terminal) setTerminal(res.terminal);
    } catch (e: any) {
      setError(e?.message ?? 'audit trail unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  if (error && !loading) {
    return (
      <KotakPage title="Audit Trail">
        <ErrorState message={error} onRetry={() => void reload()} />
      </KotakPage>
    );
  }

  return (
    <KotakPage title="Audit Trail">
      <SectionCard
        title={`Audit Trail — ${terminal}`}
        icon={ScrollText}
        headerRight={
          <div className="flex items-center gap-2">
            <StatusBadge status={loading ? 'neutral' : 'success'} label={loading ? 'LOADING' : 'SERVER'} />
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        }
      >
        <p className="mb-3 text-xs text-muted-foreground">
          Every order intent flows through Risk → Audit → Adapter; this page lists the persisted audit log entries for this terminal.
        </p>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No audit entries yet"
            description="Placing, modifying or cancelling an order through the terminal records the decision chain here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Time (IST)</TableHead>
                <TableHead className="w-[110px]">Action</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="w-[100px]">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e, i) => (
                <TableRow key={e._id ?? `${e.ts ?? ''}-${e.action ?? ''}-${i}`}>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                    {fmtTs(e.ts || e.timestamp)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={actionTone(e.action)} label={String(e.action ?? '—')} />
                  </TableCell>
                  <TableCell className="max-w-[420px] truncate text-xs">{e.detail ?? e.message ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{e.source ?? e.user ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </KotakPage>
  );
}