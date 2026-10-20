'use client';

// ---- Funds history ledger — production-grade per spec §8-10,14,30-32 ----
// Demo: full authoritative ledger (DEPOSIT/WITHDRAWAL/CHARGE/TRADE_REALIZED_PNL)
// API: honest "not available" (Kotak RMS has no ledger endpoint)

import { useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, History, Inbox, Search, Download, Eye,
  Receipt, TrendingUp,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { fmtRs } from '@/lib/formatters';
import type { AccountFundsSource, FundsTransaction, LedgerEntry } from '@/lib/account-service';
import { istDateKey } from '@/lib/ist';

type TypeFilter = 'ALL' | 'DEPOSIT' | 'WITHDRAWAL' | 'CHARGE' | 'TRADE' | 'CREDIT' | 'DEBIT';
type StatusTone = 'completed' | 'pending' | 'failed' | 'adjustment';

function txnRowType(t: FundsTransaction & Partial<LedgerEntry>): Exclude<TypeFilter, 'ALL'> {
  const raw = String((t as unknown as Record<string, unknown>).type ?? '').toUpperCase();
  if (raw === 'DEPOSIT') return 'DEPOSIT';
  if (raw === 'WITHDRAWAL') return 'WITHDRAWAL';
  if (raw === 'CHARGE') return 'CHARGE';
  if (raw === 'TRADE_REALIZED_PNL' || raw === 'TRADE') return 'TRADE';
  if ((t as LedgerEntry).direction === 'CREDIT' || (t as unknown as Record<string, unknown>).direction === 'CREDIT') return 'CREDIT';
  if ((t as LedgerEntry).direction === 'DEBIT') return 'DEBIT';
  return t.amount >= 0 ? 'CREDIT' : 'DEBIT';
}

const TYPE_META: Record<Exclude<TypeFilter, 'ALL'>, { label: string; cls: string; Icon: React.ElementType }> = {
  DEPOSIT: { label: 'DEPOSIT', cls: 'bg-success/15 text-success', Icon: ArrowDownToLine },
  WITHDRAWAL: { label: 'WITHDRAWAL', cls: 'bg-orange/15 text-orange', Icon: ArrowUpFromLine },
  CHARGE: { label: 'CHARGE', cls: 'bg-destructive/10 text-destructive', Icon: Receipt },
  TRADE: { label: 'TRADE P&L', cls: 'bg-teal/15 text-teal-600', Icon: TrendingUp },
  CREDIT: { label: 'CREDIT', cls: 'bg-teal/15 text-teal-600', Icon: ArrowDownToLine },
  DEBIT: { label: 'DEBIT', cls: 'bg-destructive/15 text-destructive', Icon: ArrowUpFromLine },
};

const STATUS_BADGE: Record<StatusTone, string> = {
  completed: 'border-success/25 bg-success/10 text-success',
  pending: 'border-warning/40 bg-warning/10 text-warning',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  adjustment: 'border-border/50 bg-muted/50 text-muted-foreground',
};

function statusBadge(t: FundsTransaction) {
  const tone: StatusTone = t.status === 'COMPLETED' ? 'completed' : t.status === 'PENDING' ? 'pending' : t.status === 'FAILED' ? 'failed' : 'adjustment';
  return <Badge variant="outline" className={cn('h-5 px-1.5 py-0 text-[9px] font-bold tracking-wider uppercase', STATUS_BADGE[tone])}>{t.status}</Badge>;
}

const FILTERS: Array<{ key: TypeFilter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'DEPOSIT', label: 'Deposits' },
  { key: 'WITHDRAWAL', label: 'Withdrawals' },
  { key: 'CHARGE', label: 'Charges' },
  { key: 'TRADE', label: 'Trades' },
  { key: 'CREDIT', label: 'Credits' },
  { key: 'DEBIT', label: 'Debits' },
];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : `${fmtDate(iso)} ${fmtTime(iso)} IST`;
}

function Row({ t, onView }: { t: FundsTransaction & Partial<LedgerEntry>; onView: (t: LedgerEntry) => void }) {
  const meta = TYPE_META[txnRowType(t)] ?? TYPE_META.DEBIT;
  const ledger = t as LedgerEntry;
  const isCredit = ledger.direction ? ledger.direction === 'CREDIT' : txnRowType(t) === 'DEPOSIT' || txnRowType(t) === 'CREDIT' || (ledger as unknown as Record<string, unknown>).type === 'TRADE_REALIZED_PNL' && (ledger.amount > 0);
  const debit = !isCredit ? fmtRs(Math.abs(ledger.amount ?? t.amount)) : '—';
  const credit = isCredit ? fmtRs(Math.abs(ledger.amount ?? t.amount)) : '—';
  const ref = ledger.orderId || ledger.symbol || (ledger.referenceId as string) || t.reference || '—';
  const bal = (ledger as unknown as Record<string, unknown>).balanceAfter != null ? fmtRs(Number((ledger as unknown as Record<string, unknown>).balanceAfter)) : t.balanceAfter != null ? fmtRs(t.balanceAfter) : '—';
  return (
    <>
      <tr className="hidden border-b last:border-0 hover:bg-muted/30 md:table-row cursor-pointer" onClick={() => onView(ledger as LedgerEntry)}>
        <td className="p-2.5 font-mono text-xs tabular-nums text-muted-foreground whitespace-nowrap">{fmtDate(t.ts)} {fmtTime(t.ts)}</td>
        <td className="p-2.5"><span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold', meta.cls)}><meta.Icon className="h-3 w-3" />{meta.label}</span>{ledger.subtype && <div className="text-[9px] text-muted-foreground">{ledger.subtype}</div>}</td>
        <td className="max-w-[200px] truncate p-2.5 text-xs" title={t.description ?? undefined}>{t.description ?? ledger.symbol ?? '—'}</td>
        <td className="p-2.5 font-mono text-xs tabular-nums whitespace-nowrap">{ref}</td>
        <td className="p-2.5 text-right font-mono text-xs font-semibold tabular-nums text-destructive">{debit}</td>
        <td className="p-2.5 text-right font-mono text-xs font-semibold tabular-nums text-success">{credit}</td>
        <td className="p-2.5 text-right font-mono text-xs tabular-nums">{bal}</td>
        <td className="p-2.5 text-center">{statusBadge(t)}</td>
        <td className="p-2.5 text-center"><Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={(e) => { e.stopPropagation(); onView(ledger as LedgerEntry); }}><Eye className="h-3 w-3" /></Button></td>
      </tr>
      <tr className="border-b last:border-0 md:hidden">
        <td colSpan={9} className="p-0">
          <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer" onClick={() => onView(ledger as LedgerEntry)}>
            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', meta.cls)}><meta.Icon className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><span className="text-xs font-semibold">{meta.label}</span>{statusBadge(t)}<span className="ml-auto font-mono text-xs font-bold tabular-nums">{isCredit ? <span className="text-success">{credit}</span> : <span className="text-destructive">{debit}</span>}</span></div>
              <div className="truncate text-[10px] text-muted-foreground">{fmtDate(t.ts)} {fmtTime(t.ts)} · {ref} · Bal {bal}</div>
              {t.description && <div className="truncate text-[10px] text-muted-foreground">{t.description}</div>}
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

export function FundsHistory({ transactions, source, loading }: { transactions: FundsTransaction[]; source: AccountFundsSource; loading: boolean; }) {
  const [filter, setFilter] = useState<TypeFilter>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const [selected, setSelected] = useState<LedgerEntry | null>(null);

  const rows = useMemo(() => {
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    const s = search.trim().toLowerCase();
    return (transactions as Array<FundsTransaction & Partial<LedgerEntry>>).filter((t) => {
      if (filter !== 'ALL' && txnRowType(t) !== filter) {
        // CREDIT/DEBIT filter also matches direction
        const dir = (t as LedgerEntry).direction;
        if (filter === 'CREDIT' && dir !== 'CREDIT') return false;
        if (filter === 'DEBIT' && dir !== 'DEBIT') return false;
        if (!['CREDIT','DEBIT'].includes(filter) && txnRowType(t) !== filter) return false;
      }
      const ts = new Date(t.ts).getTime();
      if (fromTs != null && ts < fromTs) return false;
      if (toTs != null && ts > toTs) return false;
      if (s) {
        const hay = `${t.id} ${(t as LedgerEntry).orderId ?? ''} ${(t as LedgerEntry).symbol ?? ''} ${t.description ?? ''} ${(t as LedgerEntry).referenceId ?? ''}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [transactions, filter, from, to, search]);

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const paged = rows.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const isDemo = source === 'demo-engine';

  const exportCsv = () => {
    const header = ['timestamp','transaction_id','type','direction','amount','balance_before','balance_after','reference','symbol','order_id','description'].join(',');
    const lines = paged.map((t) => {
      const l = t as LedgerEntry;
      return [t.ts, t.id, t.type, (l.direction ?? ''), t.amount, (l.balanceBefore ?? ''), t.balanceAfter ?? '', l.orderId ?? l.referenceId ?? '', l.symbol ?? '', l.orderId ?? '', `"${(t.description ?? '').replace(/"/g,'""')}"`].join(',');
    });
    const blob = new Blob([header + '\n' + lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `transactions_${istDateKey()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="shadow-soft">
      <CardContent className="px-4 py-3.5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/25"><History className="h-3.5 w-3.5" /></span>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Transaction History</h3>
          <Badge variant="outline" className={cn('h-5 border-0 px-1.5 py-0 text-[9px] font-bold tracking-wider', isDemo ? 'bg-purple/15 text-purple' : 'bg-success/15 text-success')}>{isDemo ? 'DEMO ENGINE' : 'KOTAK NEO'}</Badge>
          <span className="text-[10px] text-muted-foreground">{rows.length} entries · pg {safePage+1}/{totalPages}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <div className="relative"><Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" /><Input placeholder="ID / Order / Symbol" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} className="h-6 w-[150px] pl-7 text-xs" /></div>
            <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={exportCsv} disabled={paged.length===0}><Download className="h-3 w-3" /> Export</Button>
          </div>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => { setFilter(f.key); setPage(0); }} aria-pressed={filter===f.key} className={cn('rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors', filter===f.key ? 'border-primary/40 bg-primary/10 text-primary' : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted')}>{f.label}</button>
          ))}
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} className="h-6 w-[120px] rounded-md border-border/40 px-1.5 text-[10px]" aria-label="From" />
          <span className="text-[10px] text-muted-foreground">to</span>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} className="h-6 w-[120px] rounded-md border-border/40 px-1.5 text-[10px]" aria-label="To" />
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { setFrom(''); setTo(''); setSearch(''); setFilter('ALL'); setPage(0); }}>Clear</Button>
        </div>

        {loading && transactions.length===0 ? (
          <div className="space-y-2 py-4">{[0,1,2].map(i=> <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/50" />)}</div>
        ) : !isDemo ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground/50" />
            <div className="text-sm font-semibold">Funds history is not available from the connected broker API.</div>
            <div className="max-w-sm text-xs text-muted-foreground">The Kotak Neo integration currently exposes live account balances only. Deposits and withdrawals must be verified with your broker statements.</div>
          </div>
        ) : rows.length===0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No transactions yet — add/withdraw funds or place trades to build history.</div>
        ) : (
          <>
            <div className="rounded-xl border border-border/40 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="hidden border-b bg-muted/30 text-left text-[11px] uppercase tracking-wider text-muted-foreground md:table-row">
                      <th className="p-2.5 font-semibold whitespace-nowrap">Date/Time</th>
                      <th className="p-2.5 font-semibold">Type</th>
                      <th className="p-2.5 font-semibold">Description</th>
                      <th className="p-2.5 font-semibold">Reference</th>
                      <th className="p-2.5 text-right font-semibold">Debit</th>
                      <th className="p-2.5 text-right font-semibold">Credit</th>
                      <th className="p-2.5 text-right font-semibold">Balance</th>
                      <th className="p-2.5 text-center font-semibold">Status</th>
                      <th className="p-2.5 text-center font-semibold"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((t) => <Row key={t.id} t={t as FundsTransaction & Partial<LedgerEntry>} onView={setSelected} />)}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Showing {safePage*pageSize+1}–{Math.min((safePage+1)*pageSize, rows.length)} of {rows.length}</div>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={() => setPage(p=> Math.max(0,p-1))} disabled={safePage===0}>Previous</Button>
                <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={() => setPage(p=> Math.min(totalPages-1,p+1))} disabled={safePage>=totalPages-1}>Next</Button>
              </div>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={!!selected} onOpenChange={(open) => { if(!open) setSelected(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Transaction Detail</DialogTitle><DialogDescription className="font-mono text-xs">{selected?.id}</DialogDescription></DialogHeader>
          {selected && (
            <div className="space-y-3 py-2 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Timestamp</div><div className="font-mono text-xs">{fmtDateTime(selected.ts)}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Trading Date</div><div className="font-mono text-xs">{(selected as LedgerEntry).tradingDate ?? '—'}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Type</div><div className="font-semibold">{selected.type}{selected.subtype ? ` · ${selected.subtype}` : ''}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Direction</div><div className={cn('font-semibold', (selected as LedgerEntry).direction==='CREDIT'?'text-success':'text-destructive')}>{(selected as LedgerEntry).direction}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Amount</div><div className="font-mono font-semibold tabular-nums">{fmtRs(selected.amount)}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Status</div><div>{statusBadge(selected)}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Balance Before</div><div className="font-mono tabular-nums">{(selected as LedgerEntry).balanceBefore != null ? fmtRs((selected as LedgerEntry).balanceBefore) : '—'}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Balance After</div><div className="font-mono font-semibold tabular-nums">{selected.balanceAfter != null ? fmtRs(selected.balanceAfter) : '—'}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Symbol</div><div>{(selected as LedgerEntry).symbol ?? '—'}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Order ID</div><div className="font-mono text-xs">{(selected as LedgerEntry).orderId ?? '—'}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Position ID</div><div className="font-mono text-xs">{(selected as LedgerEntry).positionId ?? '—'}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Reference</div><div className="font-mono text-xs">{(selected as LedgerEntry).referenceType ?? '—'} {(selected as LedgerEntry).referenceId ?? ''}</div></div>
              </div>
              <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Description</div><div className="text-xs">{selected.description ?? '—'}</div></div>
              {(selected as LedgerEntry).metadata && Object.keys((selected as LedgerEntry).metadata ?? {}).length>0 && (
                <details className="rounded border border-border/40 bg-muted/20 p-2"><summary className="cursor-pointer text-xs font-semibold">Metadata</summary><pre className="mt-1 max-h-32 overflow-auto text-[11px]">{JSON.stringify((selected as LedgerEntry).metadata, null, 2)}</pre></details>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
