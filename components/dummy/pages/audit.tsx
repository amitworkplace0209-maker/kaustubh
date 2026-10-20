'use client';

import { useCallback, useEffect, useState } from 'react';
import { ScrollText, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCard } from '@/components/design-system';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { getDummyAudit, type AuditEvent } from '@/lib/dummy';
import { cn } from '@/lib/utils';

const CATEGORY_TONE: Record<string, { badge: string; dot: string }> = {
  order: { badge: 'text-success', dot: 'bg-success' },
  basket: { badge: 'text-info', dot: 'bg-info' },
  alert: { badge: 'text-warning', dot: 'bg-warning' },
  target: { badge: 'text-warning', dot: 'bg-warning' },
  prefs: { badge: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  watchlist: { badge: 'text-info', dot: 'bg-info' },
  maintenance: { badge: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};

function metaSummary(meta: Record<string, any> | undefined): string {
  if (!meta || typeof meta !== 'object') return '';
  const entries = Object.entries(meta);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .slice(0, 4)
    .join(' · ');
}

export default function DummyAudit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getDummyAudit(category, 200)
      .then((res) => setEvents(Array.isArray(res?.data) ? res.data : []))
      .catch((err: any) => setError(err?.message ?? 'Failed to load audit events'))
      .finally(() => setLoading(false));
  }, [category]);

  useEffect(() => {
    load();
  }, [load]);

  const categories = Array.from(new Set(events.map((e) => e.category)));

  return (
    <DummyThemedPage className="mx-auto w-full max-w-5xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-bold">Audit Trail</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <DummyBadge />
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <SectionCard
        title="Operational log"
        headerRight={
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setCategory('')}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                category === '' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              ALL
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase',
                  category === c ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        }
      >
        {error ? <div className="text-sm text-destructive">{error}</div> : null}
        {!error && events.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {loading ? 'Loading…' : 'No audit events yet. Place an order, run a basket, or change settings to see events here.'}
          </div>
        ) : null}
        {events.length > 0 ? (
          <div className="max-h-[28rem] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time (IST)</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => {
                  const tone = CATEGORY_TONE[e.category] ?? { badge: 'text-muted-foreground', dot: 'bg-muted-foreground' };
                  return (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {new Date(e.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn('gap-1 text-[10px] font-medium uppercase', tone.badge)}>
                          <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />
                          {e.category}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{e.action}</TableCell>
                      <TableCell className="max-w-[22rem] truncate text-xs text-muted-foreground" title={metaSummary(e.meta)}>
                        {metaSummary(e.meta)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </SectionCard>
    </DummyThemedPage>
  );
}