'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ListChecks,
  Plus,
  Trash2,
  Play,
  RefreshCw,
  ScrollText,
  AlarmClock,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { StatusBadge, EmptyState, ErrorState, SectionCard, SectionHeading } from '@/components/design-system';
import {
  getDummyBaskets,
  createDummyBasket,
  deleteDummyBasket,
  executeDummyBasket,
  type DummyBasket,
  type BasketLegModel,
} from '@/lib/dummy';
import { useTradingMode } from '@/lib/settings-store';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { DummyThemedPage, DummyBadge, LivePulse, useCountdownTo } from '@/components/dummy/ui';
import { OrdersTabs } from '@/components/orders/orders-tabs';
import { cn } from '@/lib/utils';
import { formatISTDateTime } from '@/lib/ist';

type LegDraft = {
  symbol: string;
  transactionType: 'BUY' | 'SELL';
  orderType: string;
  quantity: string;
  price: string;
  triggerPrice: string;
};

const EMPTY_LEG: LegDraft = { symbol: '', transactionType: 'BUY', orderType: 'MIS', quantity: '1', price: '', triggerPrice: '' };

function ExpiryCountdown({ expiresAt }: { expiresAt: string | null }) {
  const countdown = useCountdownTo(expiresAt);
  if (!expiresAt) return null;
  return (
    <span className="flex items-center gap-1 text-amber-500">
      <AlarmClock className="h-3 w-3" /> expires in {countdown ?? 'now'}
    </span>
  );
}

function BasketStatusBadge({ status }: { status: 'Draft' | 'Active' | 'Complete' | 'Expired' }) {
  const variant =
    status === 'Draft'
      ? 'secondary'
      : status === 'Active'
        ? 'default'
        : status === 'Complete'
          ? 'default'
          : 'destructive';
  const cls =
    status === 'Draft'
      ? 'bg-gray-500/10 text-gray-500 border-gray-500/20'
      : status === 'Active'
        ? 'bg-blue-500/10 text-blue-500 border-blue-500/20'
        : status === 'Complete'
          ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
          : 'bg-red-500/10 text-red-500 border-red-500/20';
  return (
    <Badge variant={variant} className={cn('text-[10px]', cls)}>
      {status}
    </Badge>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          'h-1.5 rounded-full transition-all',
          pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-blue-500' : 'bg-muted',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function formatCurrency(val: number): string {
  return `₹${val.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export default function DummyBaskets() {
  const tradingMode = useTradingMode();
  const [baskets, setBaskets] = useState<DummyBasket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftPolicy, setDraftPolicy] = useState<'ALL' | 'MIN' | 'EXACT'>('ALL');
  const [draftMinimum, setDraftMinimum] = useState('1');
  const [draftExpiry, setDraftExpiry] = useState('0');
  const [draftLegs, setDraftLegs] = useState<LegDraft[]>([{ ...EMPTY_LEG }]);
  const [draftProductType, setDraftProductType] = useState<'MIS' | 'NRM'>('MIS');
  const [draftAmountToAllot, setDraftAmountToAllot] = useState('');
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<Record<string, any> | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [auditId, setAuditId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const { latest } = useLatestTicks(true);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await getDummyBaskets();
      setBaskets(res.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load baskets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setLeg = (idx: number, patch: Partial<LegDraft>) => {
    setDraftLegs((legs) => legs.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const addLeg = () => setDraftLegs((legs) => [...legs, { ...EMPTY_LEG }]);
  const removeLeg = (idx: number) => setDraftLegs((legs) => legs.filter((_, i) => i !== idx));

  const canCreate = useMemo(() => {
    return (
      draftName.trim().length > 0 &&
      draftLegs.length > 0 &&
      draftLegs.every((l) => l.symbol.trim() && parseInt(l.quantity, 10) > 0)
    );
  }, [draftName, draftLegs]);

  const draftTotalValue = useMemo(() => {
    return draftLegs.reduce((sum, l) => {
      const qty = parseInt(l.quantity, 10) || 0;
      const price = Number(l.price) || 0;
      return sum + qty * price;
    }, 0);
  }, [draftLegs]);

  const draftBudgetRemaining = useMemo(() => {
    const budget = Number(draftAmountToAllot) || 0;
    return budget > 0 ? budget - draftTotalValue : budget;
  }, [draftAmountToAllot, draftTotalValue]);

  const submitCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const legs = draftLegs
        .filter((l) => l.symbol.trim() && parseInt(l.quantity, 10) > 0)
        .map<BasketLegModel>((l) => ({
          symbol: l.symbol.trim().toUpperCase(),
          transactionType: l.transactionType,
          orderType: draftProductType,
          quantity: parseInt(l.quantity, 10),
          price: Number(l.price || 0),
          triggerPrice: Number(l.triggerPrice || 0),
        }));
      await createDummyBasket({
        name: draftName.trim(),
        legs,
        policy: { mode: draftPolicy, minimum: draftPolicy === 'ALL' ? 0 : parseInt(draftMinimum, 10) || 1 },
        expirySeconds: parseInt(draftExpiry, 10) || 0,
      });
      setDraftName('');
      setDraftLegs([{ ...EMPTY_LEG }]);
      setDraftAmountToAllot('');
      setCreateDialogOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    } finally {
      setCreating(false);
    }
  };

  const executeBasket = async (id: string) => {
    setExecutingId(id);
    setExecutionResult(null);
    setRunError(null);
    try {
      const result = await executeDummyBasket({ basketId: id, terminal: tradingMode });
      setExecutionResult(result);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'execution failed');
    } finally {
      setExecutingId(null);
      void refresh();
    }
  };

  const removeBasket = async (id: string) => {
    try {
      await deleteDummyBasket(id);
      void refresh();
      if (auditId === id) setAuditId(null);
    } catch {
      /* keep */
    }
  };

  const lastLegsSymbols = useMemo(() => {
    const s = new Set<string>();
    for (const b of baskets) for (const leg of b.legs) s.add(leg.symbol);
    return s;
  }, [baskets]);

  const basketMeta = useMemo(() => {
    const map: Record<string, { executed: number; totalValue: number; executedValue: number; remainingValue: number; status: 'Draft' | 'Active' | 'Complete' | 'Expired' }> = {};
    for (const b of baskets) {
      const executedLegs = b.legs.filter((l) => {
        const last = (b.audit || [])[0];
        const lr = (last?.legResults || []).find((r: any) => r.symbol === l.symbol);
        return lr && lr.ok;
      });
      const expiresAt = b.expirySeconds > 0 ? new Date(new Date(b.createdAt).getTime() + b.expirySeconds * 1000) : null;
      const expired = expiresAt !== null && expiresAt.getTime() <= Date.now();

      let totalValue = 0;
      for (const l of b.legs) {
        const tick = latest.get(l.symbol);
        const ltp = tick && typeof tick.ltp === 'number' ? tick.ltp : Number(l.price) || 0;
        totalValue += (l.quantity || 0) * ltp;
      }

      let executedValue = 0;
      for (const l of executedLegs) {
        const tick = latest.get(l.symbol);
        const ltp = tick && typeof tick.ltp === 'number' ? tick.ltp : Number(l.price) || 0;
        executedValue += (l.quantity || 0) * ltp;
      }

      let status: 'Draft' | 'Active' | 'Complete' | 'Expired' = 'Draft';
      if (expired) status = 'Expired';
      else if (b.audit.length > 0 && executedLegs.length === b.legs.length) status = 'Complete';
      else if (b.audit.length > 0) status = 'Active';

      map[b.id] = {
        executed: executedLegs.length,
        totalValue,
        executedValue,
        remainingValue: totalValue - executedValue,
        status,
      };
    }
    return map;
  }, [baskets, latest]);

  const toggleExpanded = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  useEffect(() => {
    for (const sym of lastLegsSymbols) {
      const t = latest.get(sym);
      if (t && typeof t.ltp === 'number' && t.ltp > 0) feedDummyLtp(sym, t.ltp);
    }
  }, [latest, lastLegsSymbols]);

  if (loading && baskets.length === 0) {
    return <DummyThemedPage><div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading baskets…</div></DummyThemedPage>;
  }
  if (error && baskets.length === 0) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void refresh()} /></DummyThemedPage>;
  }

  const auditBasket = baskets.find((b) => b.id === auditId);

  return (
    <DummyThemedPage>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Basket Orders</h1>
          <DummyBadge />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-4 w-4" /> Create Basket
          </Button>
        </div>
      </div>

      <OrdersTabs />

      {runError && <p className="text-sm text-red-500">{runError}</p>}
      {executionResult && (
        <div className="rounded-md border bg-muted/40 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{executionResult.basket?.name}</span>
            <StatusBadge
              status={executionResult.ok ? 'success' : 'danger'}
              label={executionResult.ok ? 'EXECUTED' : 'FAILED'}
            />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-xs text-muted-foreground">Filled</div>
              <div className="font-semibold">{executionResult.summary?.filled} / {executionResult.summary?.totalLegs}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Failed</div>
              <div className="font-semibold">{executionResult.summary?.failed}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Policy</div>
              <div className="font-semibold">{executionResult.summary?.policyMode}</div>
            </div>
          </div>
          <div className="mt-3 space-y-1">
            {(executionResult.summary?.legResults || []).map((r: any, i: number) => (
              <div key={i} className="flex items-center justify-between rounded bg-background px-2 py-1 text-xs">
                <span className={r.ok ? 'text-emerald-500' : 'text-red-500'}>
                  {r.ok ? '✓' : '✗'} {r.symbol}
                </span>
                <span className="text-muted-foreground">{r.status ?? r.message ?? ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <SectionHeading>Saved baskets</SectionHeading>
      {baskets.length === 0 ? (
        <EmptyState icon={ListChecks} title="No baskets yet" description="Create one to batch your orders." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {baskets.map((b) => {
            const isOpen = expanded[b.id] === true;
            const expiresAt = b.expirySeconds > 0 ? new Date(new Date(b.createdAt).getTime() + b.expirySeconds * 1000).toISOString() : null;
            const meta = basketMeta[b.id] ?? { executed: 0, totalValue: 0, executedValue: 0, remainingValue: 0, status: 'Draft' as const };
            const legAudit = Object.fromEntries(((b.audit || [])[0]?.legResults || []).map((r: any) => [r.symbol, r]));
            const lastAudit = b.audit?.[0];

            return (
              <Card key={b.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base">{b.name}</CardTitle>
                      <BasketStatusBadge status={meta.status} />
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggleExpanded(b.id)}>
                        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => void removeBasket(b.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{meta.executed}/{b.legs.length} orders executed</span>
                      <span className="tabular-nums">{meta.executed}/{b.legs.length}</span>
                    </div>
                    <ProgressBar value={meta.executed} max={b.legs.length} />
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div>
                      <div className="text-muted-foreground">Total Value</div>
                      <div className="font-semibold tabular-nums">{formatCurrency(meta.totalValue)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Executed</div>
                      <div className="font-semibold tabular-nums text-emerald-500">{formatCurrency(meta.executedValue)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Remaining</div>
                      <div className="font-semibold tabular-nums">{formatCurrency(meta.remainingValue)}</div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{b.legs.length} legs · created {formatISTDateTime(b.createdAt)}</span>
                    {expiresAt && meta.status !== 'Expired' && (
                      <ExpiryCountdown expiresAt={expiresAt} />
                    )}
                    {meta.status === 'Expired' && <span className="text-red-500">expired</span>}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      className="flex-1"
                      size="sm"
                      disabled={meta.status === 'Expired' || executingId === b.id}
                      onClick={() => void executeBasket(b.id)}
                    >
                      {executingId === b.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      Execute All
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setDraftLegs([{ ...EMPTY_LEG }]); setCreateDialogOpen(true); }}>
                      <Plus className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void removeBasket(b.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>

                  {isOpen && (
                    <div className="space-y-3 border-t pt-3">
                      <div className="space-y-1">
                        {b.legs.map((l, i) => {
                          const tick = latest.get(l.symbol);
                          const ltp = tick && typeof tick.ltp === 'number' && tick.ltp > 0 ? tick.ltp : null;
                          const res = legAudit[l.symbol];
                          const legValue = (l.quantity || 0) * (ltp || Number(l.price) || 0);
                          const executionStatus = res ? (res.ok ? 'Executed' : 'Cancelled') : 'Pending';
                          const pnl = ltp && l.transactionType === 'BUY' ? (ltp - Number(l.price || ltp)) * l.quantity : ltp && l.transactionType === 'SELL' ? (Number(l.price || ltp) - ltp) * l.quantity : null;

                          return (
                            <div key={i} className={cn(
                              'rounded-md border px-2.5 py-2 text-xs',
                              executionStatus === 'Executed' ? 'border-emerald-500/30 bg-emerald-500/5' : executionStatus === 'Cancelled' ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-background',
                            )}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold">{l.symbol}</span>
                                  <Badge variant={l.transactionType === 'BUY' ? 'default' : 'destructive'} className="text-[10px]">
                                    {l.transactionType}
                                  </Badge>
                                  <span className="text-muted-foreground">{l.quantity} × {formatCurrency(ltp || Number(l.price) || 0)} = {formatCurrency(legValue)}</span>
                                </div>
                                <Badge variant={executionStatus === 'Executed' ? 'default' : executionStatus === 'Cancelled' ? 'destructive' : 'secondary'} className="text-[10px]">
                                  {executionStatus}
                                </Badge>
                              </div>
                              <div className="mt-1 flex items-center justify-between text-[11px]">
                                <div className="flex items-center gap-2 text-muted-foreground">
                                  {ltp && (
                                    <span className="flex items-center gap-1">
                                      LTP ₹{ltp.toFixed(2)}
                                      <LivePulse value={ltp} className="inline-flex items-center"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /></LivePulse>
                                    </span>
                                  )}
                                  {res && <span className="font-mono">{formatISTDateTime(res.at)}</span>}
                                </div>
                                {pnl !== null && (
                                  <span className={cn('font-mono tabular-nums', pnl >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                                    P&L {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {b.audit.length > 0 && (
                        <div className="border-t pt-3">
                          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                            <ScrollText className="h-3 w-3" /> Audit Trail
                          </div>
                          <div className="space-y-0">
                            {b.audit.slice(0, 10).map((entry, i) => (
                              <div key={i} className="relative pb-3 pl-5 last:pb-0">
                                {i < Math.min(10, b.audit.length) - 1 && (
                                  <div className="absolute bottom-0 left-1 top-3 w-px bg-border" />
                                )}
                                <div className={cn(
                                  'absolute left-0 top-1.5 h-3 w-3 rounded-full border-2 border-background',
                                  entry.ok ? 'bg-emerald-500' : 'bg-red-500',
                                )} />
                                <div className="rounded-md border p-2">
                                  <div className="flex items-center justify-between">
                                    <StatusBadge status={entry.ok ? 'success' : 'danger'} label={entry.ok ? 'OK' : 'PARTIAL'} />
                                    <span className="font-mono text-[11px] text-muted-foreground">
                                      {formatISTDateTime(entry.at)}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                                    {entry.filled}/{entry.totalLegs} filled · policy {entry.policyMode}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Basket</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Basket Name</Label>
                <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="e.g. Morning momentum" />
              </div>
              <div className="space-y-2">
                <Label>Expiry Date &amp; Time</Label>
                <Input
                  type="datetime-local"
                  value={draftExpiry === '0' ? '' : new Date(Date.now() + parseInt(draftExpiry, 10) * 1000).toISOString().slice(0, 16)}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) { setDraftExpiry('0'); return; }
                    const diff = Math.max(0, Math.round((new Date(val).getTime() - Date.now()) / 1000));
                    setDraftExpiry(String(diff));
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>Amount to Allot (₹)</Label>
                <Input type="number" min={0} value={draftAmountToAllot} onChange={(e) => setDraftAmountToAllot(e.target.value)} placeholder="Total capital budget" />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Product Type</Label>
                <Select value={draftProductType} onValueChange={(v) => setDraftProductType(v as 'MIS' | 'NRM')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MIS">MIS — Intraday</SelectItem>
                    <SelectItem value="NRM">NRM — Delivery</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Policy</Label>
                <Select value={draftPolicy} onValueChange={(v) => setDraftPolicy(v as 'ALL' | 'MIN' | 'EXACT')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">ALL — execute every leg</SelectItem>
                    <SelectItem value="MIN">MIN — at least N legs</SelectItem>
                    <SelectItem value="EXACT">EXACT — every leg required</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Min legs</Label>
                <Input type="number" min={1} value={draftMinimum} onChange={(e) => setDraftMinimum(e.target.value)} disabled={draftPolicy === 'ALL'} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Orders</Label>
              {draftLegs.map((leg, idx) => (
                <div key={idx} className="grid grid-cols-12 items-center gap-2">
                  <Input className="col-span-3" placeholder="Symbol" value={leg.symbol} onChange={(e) => setLeg(idx, { symbol: e.target.value })} />
                  <Select value={leg.transactionType} onValueChange={(v) => setLeg(idx, { transactionType: v as 'BUY' | 'SELL' })}>
                    <SelectTrigger className="col-span-2"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BUY">BUY</SelectItem>
                      <SelectItem value="SELL">SELL</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input className="col-span-2" type="number" min={1} placeholder="Qty" value={leg.quantity} onChange={(e) => setLeg(idx, { quantity: e.target.value })} />
                  <Input className="col-span-2" type="number" min={0} step="0.05" placeholder="Price" value={leg.price} onChange={(e) => setLeg(idx, { price: e.target.value })} />
                  <Input className="col-span-2" type="number" min={0} step="0.05" placeholder="Trigger" value={leg.triggerPrice} onChange={(e) => setLeg(idx, { triggerPrice: e.target.value })} />
                  <div className="flex items-center justify-end gap-1 col-span-1">
                    {draftLegs.length > 1 && (
                      <Button variant="ghost" size="icon" onClick={() => removeLeg(idx)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addLeg}>
                <Plus className="h-4 w-4" /> Add leg
              </Button>
            </div>

            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-2 text-sm">
              <span className="text-muted-foreground">Orders: {draftLegs.length}</span>
              <span className="text-muted-foreground">Total Value: {formatCurrency(draftTotalValue)}</span>
              {Number(draftAmountToAllot) > 0 && (
                <span className={cn('font-medium', draftBudgetRemaining < 0 ? 'text-red-500' : 'text-emerald-500')}>
                  Budget Remaining: {formatCurrency(draftBudgetRemaining)}
                </span>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button disabled={!canCreate || creating} onClick={() => void submitCreate()}>
              {creating ? 'Creating…' : 'Create Basket'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={auditId !== null} onOpenChange={(o) => !o && setAuditId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Execution audit — {auditBasket?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {auditBasket && (auditBasket.audit || []).length === 0 && (
              <p className="text-muted-foreground">No executions recorded yet for this basket.</p>
            )}
            <div className="space-y-0">
              {(auditBasket?.audit || []).slice(0, 8).map((entry, i) => (
                <div key={i} className="relative pb-4 pl-5 last:pb-0">
                  {i < Math.min(8, (auditBasket?.audit?.length ?? 0)) - 1 && (
                    <div className="absolute bottom-0 left-1 top-3 w-px bg-border" />
                  )}
                  <div className={cn(
                    'absolute left-0 top-1.5 h-3 w-3 rounded-full border-2 border-background',
                    entry.ok ? 'bg-emerald-500' : 'bg-red-500',
                  )} />
                  <div className="rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <StatusBadge status={entry.ok ? 'success' : 'danger'} label={entry.ok ? 'OK' : 'PARTIAL'} />
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatISTDateTime(entry.at)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs">
                      {entry.filled}/{entry.totalLegs} filled · policy {entry.policyMode}
                    </div>
                    {entry.durationMs ? (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        ran in {entry.durationMs > 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs}ms`}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAuditId(null)}>Close</Button>
            <Button asChild><Link href="/trading/order-history">View order history</Link></Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DummyThemedPage>
  );
}
