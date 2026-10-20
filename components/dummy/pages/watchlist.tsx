'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Star, Plus, Trash2, RefreshCw, Layers, ShoppingCart, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, ErrorState, SectionCard } from '@/components/design-system';
import {
  getDummyWatchlists,
  createDummyWatchlist,
  deleteDummyWatchlist,
  setActiveDummyWatchlist,
  addDummyWatchlistSymbol,
  removeDummyWatchlistSymbol,
  type Watchlist,
} from '@/lib/dummy';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { useToast } from '@/hooks/use-toast';
import { placeDemoOrder } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function DummyWatchlist() {
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [activeId, setActiveId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newListName, setNewListName] = useState('');
  const [newSymbol, setNewSymbol] = useState('');
  const [ordering, setOrdering] = useState<string | null>(null);

  const { toast } = useToast();

  const quickOrder = async (sym: string, side: string) => {
    if (ordering === sym) return;
    const row = (active?.symbols ?? []).find((x) => x.symbol === sym);
    const t = latest.get(sym);
    const ltp = t && typeof t.ltp === 'number' ? t.ltp : 0;
    setOrdering(sym);
    try {
      const res = await placeDemoOrder({
        symbol: sym,
        tradingSymbol: row?.tradingSymbol || sym,
        token: row?.token || '',
        exchange: row?.exchange || 'nse_cm',
        transactionType: side,
        product: 'MIS',
        orderType: 'MKT',
        quantity: 1,
        price: 0,
        triggerPrice: 0,
        ltp,
      });
      toast({ title: `${side} ${sym} (MKT · MIS · 1) placed`, description: `Order ${res?.demoOrder?.orderId ?? ''}` });
    } catch (e: any) {
      toast({ variant: 'destructive', title: `${side} failed`, description: e?.detail ?? e?.message });
    } finally {
      setOrdering(null);
    }
  };

  const reload = useCallback(async () => {
    try {
      const res = await getDummyWatchlists();
      setLists(res?.items ?? []);
      setActiveId(res?.activeId ?? '');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const active = useMemo(() => lists.find((l) => l.id === activeId) ?? lists[0] ?? null, [lists, activeId]);
  const symbols = useMemo(() => (active?.symbols ?? []).map((s) => s.symbol).filter(Boolean), [active]);

  const { latest } = useLatestTicks(true);
  useEffect(() => {
    for (const sym of symbols) {
      const t = latest.get(sym);
      if (t && typeof t.ltp === 'number' && t.ltp > 0) feedDummyLtp(sym, t.ltp);
    }
  }, [latest, symbols]);

  const createList = async () => {
    const name = newListName.trim();
    if (!name) return;
    try {
      await createDummyWatchlist(name);
      setNewListName('');
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    }
  };

  const removeList = async (id: string) => {
    if (!window.confirm('Delete this watchlist?')) return;
    try {
      await deleteDummyWatchlist(id);
      void reload();
    } catch {
      /* keep */
    }
  };

  const activate = async (id: string) => {
    try {
      await setActiveDummyWatchlist(id);
      void reload();
    } catch {
      /* keep */
    }
  };

  const addSymbol = async () => {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym || !active) return;
    try {
      await addDummyWatchlistSymbol(active.id, { symbol: sym });
      setNewSymbol('');
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add failed');
    }
  };

  const removeSymbol = async (symbol: string) => {
    if (!active) return;
    try {
      await removeDummyWatchlistSymbol(active.id, symbol);
      void reload();
    } catch {
      /* keep */
    }
  };

  const currentRow = (s: string) => (active?.symbols ?? []).find((x) => x.symbol === s) ?? { symbol: s };

  if (loading && lists.length === 0) {
    return <DummyThemedPage><div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading watchlists…</div></DummyThemedPage>;
  }
  if (error && lists.length === 0) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void reload()} /></DummyThemedPage>;
  }

  return (
    <DummyThemedPage>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Watchlist</h1>
          <DummyBadge />
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <SectionCard title="My Lists" icon={Layers} className="lg:col-span-1">
          <div className="space-y-1.5">
            {lists.length === 0 ? (
              <p className="py-2 text-center text-xs text-muted-foreground">No lists yet — create one below.</p>
            ) : (
              lists.map((l) => (
                <div
                  key={l.id}
                  className={cn(
                    'flex items-center justify-between rounded-md border px-2.5 py-1.5 text-sm',
                    l.id === activeId ? 'border-primary/50 bg-primary/10' : 'border-border hover:bg-muted/40',
                  )}
                >
                  <button type="button" className="flex min-w-0 cursor-pointer items-center gap-2" onClick={() => void activate(l.id)}>
                    <Star className={cn('h-3.5 w-3.5 shrink-0', l.id === activeId ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')} />
                    <span className={cn('truncate', l.id === activeId ? 'font-semibold' : 'text-muted-foreground')}>{l.name}</span>
                    <Badge variant="outline" className="ml-1 text-[10px]">{l.symbols.length}</Badge>
                  </button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => void removeList(l.id)}>
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
              ))
            )}
            <div className="flex items-center gap-2 pt-2">
              <Input
                className="h-8 text-xs"
                placeholder="New list name"
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createList(); }}
              />
              <Button size="sm" onClick={() => void createList()}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </SectionCard>

        <div className="space-y-4 lg:col-span-3">
          <SectionCard
            title={active ? `“${active.name}”` : 'Symbols'}
            icon={Star}
            headerRight={
              <div className="flex items-center gap-2">
                <Input
                  className="h-8 w-40 text-xs"
                  placeholder="Add SYMBOL"
                  value={newSymbol}
                  onChange={(e) => setNewSymbol(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addSymbol(); }}
                />
                <Button size="sm" onClick={() => void addSymbol()}>Add</Button>
              </div>
            }
          >
            {!active || symbols.length === 0 ? (
              <EmptyState
                icon={Star}
                title="No symbols in this list"
                description="Pick or create a list on the left, then add symbols to stream live LTP here."
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="hidden sm:table-cell">Exchange</TableHead>
                      <TableHead className="text-right">LTP</TableHead>
                      <TableHead className="w-36" />
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {symbols.map((sym) => {
                      const row = currentRow(sym);
                      const t = latest.get(sym);
                      const ltp = t && typeof t.ltp === 'number' ? t.ltp : null;
                      return (
                        <TableRow key={sym}>
                          <TableCell className="font-medium">{sym}</TableCell>
                          <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{row.exchange || 'nse_cm'}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {ltp ? ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="sm" disabled={!ltp || ltp <= 0 || ordering === sym}>
                                  <ShoppingCart className="mr-1.5 h-3.5 w-3.5" />
                                  {ordering === sym ? <Check className="h-3.5 w-3.5" /> : 'Order'}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => void quickOrder(sym, 'BUY')}>
                                  <span className="text-emerald-500">BUY</span> <span className="text-muted-foreground">1 · MKT · MIS</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => void quickOrder(sym, 'SELL')}>
                                  <span className="text-red-500">SELL</span> <span className="text-muted-foreground">1 · MKT · MIS</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" onClick={() => void removeSymbol(sym)}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </DummyThemedPage>
  );
}