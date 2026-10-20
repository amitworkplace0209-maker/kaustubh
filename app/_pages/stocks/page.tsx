'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Package, Plus, Trash2, Search, Power, X, RefreshCw, Info, Loader2,
  Wifi, WifiOff, ChevronDown, ChevronUp, TrendingUp, TrendingDown,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  getStocks, addStock, deleteStock, toggleStock, bulkDeleteStocks,
  getTickStreamUrl,
} from '@/lib/api';
import { searchInstruments } from '@/lib/instrument-search-client';
import {
  SEARCH_SUGGESTION_LIMIT, shouldSearch, type CanonicalInstrument,
} from '@/lib/instrument-search';
import { useToast } from '@/hooks/use-toast';

type Stock = {
  _id: string;
  symbol: string;
  instrumentToken: string;
  exchangeSegment: string;
  internalIndex?: number;
  isIndex: boolean;
  isDepth: boolean;
  active: boolean;
};

type Tick = {
  symbol: string;
  tradingSymbol?: string;
  instrumentToken: string;
  exchangeSegment?: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  ltq: number | null;
  bp: number | null;
  sp: number | null;
  bq: number | null;
  bs: number | null;
  change: number | null;
  changePercent: number | null;
  averagePrice: number | null;
  ts: string;
  receivedAt?: string;
};

const EQUITY_INSTRUMENT_TYPES = new Set(['EQ', 'STK', 'E', 'EQUITY', 'EQUITIES', 'CS']);

/**
 * The stocks subscription list only ever carried cash-market equities. The
 * canonical row says so through `series` / `instrumentType` / `tradingSymbol`,
 * so the same intent is expressed against those fields here.
 */
function isEquityInstrument(r: CanonicalInstrument): boolean {
  const series = (r.series ?? '').trim().toUpperCase();
  const tradingSymbol = r.tradingSymbol.trim().toUpperCase();
  const instrumentType = r.instrumentType.trim().toUpperCase();

  if (instrumentType && !EQUITY_INSTRUMENT_TYPES.has(instrumentType)) return false;

  return series === 'EQ' || tradingSymbol.endsWith('-EQ');
}

function safeVal(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return v.toLocaleString('en-IN');
  return String(v);
}

function fmtNum(n: number | null | undefined, decimals = 2): string {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const prefix = n >= 0 ? '+' : '';
  return `${prefix}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Kolkata' });
}

export default function StocksPage() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const stocksRef = useRef<Stock[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [kotakSearch, setKotakSearch] = useState('');
  const [searchResults, setSearchResults] = useState<CanonicalInstrument[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedResult, setSelectedResult] = useState<CanonicalInstrument | null>(null);
  const [adding, setAdding] = useState(false);
  const [tickMap, setTickMap] = useState<Map<string, Tick>>(new Map());
  const [wsConnected, setWsConnected] = useState(false);
  const [expandedStock, setExpandedStock] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<Stock | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const { toast } = useToast();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchStocks = useCallback(async () => {
    try {
      const data = await getStocks(search);
      const stockList: Stock[] =
        Array.isArray(data) ? data
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.stocks) ? data.stocks
        : [];

      if (stockList.length > 0) {
        stocksRef.current = stockList;
        setStocks(stockList);
      } else if (search.trim()) {
        setStocks([]);
      } else {
        setStocks(stocksRef.current);
      }
    } catch (error) {
      toast({
        title: 'Failed to load stocks',
        description: error instanceof Error ? error.message : 'Stock API request failed',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [search, toast]);

  useEffect(() => {
    fetchStocks();
    const interval = setInterval(fetchStocks, 10000);
    return () => clearInterval(interval);
  }, [fetchStocks]);

  useEffect(() => {
    let es: EventSource | null = null;

    function connect() {
      if (!mountedRef.current) return;
      try {
        es = new EventSource(getTickStreamUrl());
        eventSourceRef.current = es;

        es.onopen = () => {
          if (mountedRef.current) setWsConnected(true);
        };

        es.onmessage = (event) => {
          try {
            const tick: Tick = JSON.parse(event.data);
            if (tick.ltp == null || tick.ltp === 0) return;

            if (mountedRef.current) {
              setTickMap((prev) => {
                const next = new Map(prev);
                if (tick.instrumentToken) next.set(tick.instrumentToken, tick);
                if (tick.symbol) next.set(tick.symbol, tick);
                if (tick.tradingSymbol) next.set(tick.tradingSymbol, tick);
                return next;
              });
            }
          } catch { /* ignore */ }
        };

        es.onerror = () => {
          if (mountedRef.current) setWsConnected(false);
          es?.close();
          eventSourceRef.current = null;
          if (mountedRef.current) {
            reconnectRef.current = setTimeout(connect, 3000);
          }
        };
      } catch {
        if (mountedRef.current) {
          reconnectRef.current = setTimeout(connect, 3000);
        }
      }
    }

    connect();
    return () => {
      es?.close();
      eventSourceRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, []);

  const getStockTick = useCallback((stock: Stock): Tick | null => {
    const token = stock.instrumentToken;
    const sym = stock.symbol;
    if (token) {
      const byToken = tickMap.get(token);
      if (byToken) return byToken;
    }
    if (sym) {
      const bySym = tickMap.get(sym);
      if (bySym) return bySym;
    }
    return null;
  }, [tickMap]);

  const handleKotakSearch = async () => {
    const query = kotakSearch.trim();
    if (!shouldSearch(query)) return;
    setSearching(true);
    setSelectedResult(null);
    setSearchResults([]);

    try {
      const response = await searchInstruments(query, { limit: SEARCH_SUGGESTION_LIMIT * 2 });
      if (response.errorCode) {
        toast({
          title: 'Search failed',
          description:
            response.errorCode === 'SEARCH_INDEX_UNAVAILABLE'
              ? 'Instrument search is unavailable. Try again shortly.'
              : response.errorCode,
          variant: 'destructive',
        });
        return;
      }
      const eqResults = response.results
        .filter(isEquityInstrument)
        .filter((r) => Boolean(r.token));

      setSearchResults(eqResults);
      const first = eqResults[0] ?? null;
      setSelectedResult(first);
    } catch (err) {
      toast({
        title: 'Search failed',
        description: err instanceof Error ? err.message : 'Kotak API unavailable',
        variant: 'destructive',
      });
      setSearchResults([]);
      setSelectedResult(null);
    } finally {
      setSearching(false);
    }
  };

  const handleAdd = async () => {
    if (!selectedResult) {
      toast({ title: 'No stock selected', description: 'Search for a stock first.', variant: 'destructive' });
      return;
    }

    const token = String(selectedResult.token || '');
    if (!token) {
      toast({ title: 'No instrument token', description: 'The selected EQ instrument has no token.', variant: 'destructive' });
      return;
    }

    const symbol = String(selectedResult.symbol || selectedResult.tradingSymbol || '').trim();
    if (!symbol) {
      toast({ title: 'No symbol found', description: 'The selected EQ instrument has no symbol.', variant: 'destructive' });
      return;
    }

    const exchangeSegment = String(selectedResult.exchangeSegment || 'nse_cm');

    setAdding(true);
    try {
      await addStock({
        symbol: symbol.toUpperCase(),
        instrumentToken: token,
        exchangeSegment,
      });
      toast({ title: 'Stock added', description: `${symbol.toUpperCase()} subscribed successfully` });
      setSelectedResult(null);
      setSearchResults([]);
      setKotakSearch('');
      setAddOpen(false);
      fetchStocks();
    } catch (err) {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to subscribe stock',
        variant: 'destructive',
      });
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (symbol: string) => {
    try {
      await deleteStock(symbol);
      toast({ title: 'Stock deleted', description: symbol });
      fetchStocks();
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    }
  };

  const handleToggle = async (symbol: string, active: boolean) => {
    try {
      await toggleStock(symbol, active);
      toast({ title: active ? 'Stock enabled' : 'Stock disabled', description: symbol });
      fetchStocks();
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    }
  };

  const handleBulkDelete = async () => {
    try {
      const result = await bulkDeleteStocks(Array.from(selected));
      toast({ title: 'Bulk delete complete', description: `${result.deleted} deleted` });
      setSelected(new Set());
      fetchStocks();
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    }
  };

  const toggleSelect = (symbol: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  const activeCount = stocks.filter((s) => s.active).length;
  const inactiveCount = stocks.length - activeCount;

  const filteredStocks = stocks.filter((s) => {
    if (!search.trim()) return true;
    return s.symbol.toLowerCase().includes(search.toLowerCase());
  });

  const infoFields: { label: string; value: string }[] = [];
  if (selectedResult) {
    const r = selectedResult;
    const fieldMap: { key: keyof CanonicalInstrument; label: string }[] = [
      { key: 'symbol', label: 'Symbol' },
      { key: 'tradingSymbol', label: 'Trading Symbol' },
      { key: 'name', label: 'Company Name' },
      { key: 'exchange', label: 'Exchange' },
      { key: 'exchangeSegment', label: 'Segment' },
      { key: 'series', label: 'Series' },
      { key: 'token', label: 'Token' },
      { key: 'isin', label: 'ISIN' },
      { key: 'lotSize', label: 'Lot Size' },
      { key: 'tickSize', label: 'Tick Size' },
      { key: 'instrumentType', label: 'Instrument Type' },
      { key: 'liveStatus', label: 'Live Status' },
      { key: 'ltp', label: 'Current Price' },
      { key: 'change', label: 'Change' },
      { key: 'changePct', label: 'Change %' },
      { key: 'prevClose', label: 'Prev Close' },
      { key: 'volume', label: 'Volume' },
      { key: 'bid', label: 'Bid' },
      { key: 'ask', label: 'Ask' },
      { key: 'spread', label: 'Spread' },
      { key: 'upperCircuit', label: 'Upper Circuit' },
      { key: 'lowerCircuit', label: 'Lower Circuit' },
      { key: 'timestamp', label: 'Tick Time' },
      { key: 'tickAgeSeconds', label: 'Tick Age (s)' },
    ];
    for (const f of fieldMap) {
      const v = r[f.key];
      if (v != null && v !== '') {
        infoFields.push({ label: f.label, value: safeVal(v) });
      }
    }
    infoFields.push({ label: '1 Qty Margin', value: safeVal(r.oneQtyMargin) });
    infoFields.push({ label: 'Margin Status', value: safeVal(r.marginStatus) });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Stocks</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={wsConnected ? 'default' : 'secondary'} className={wsConnected ? 'bg-success text-success-foreground' : ''}>
              {wsConnected ? <Wifi className="h-3 w-3 mr-1" /> : <WifiOff className="h-3 w-3 mr-1" />}
              {wsConnected ? 'LIVE' : 'DISCONNECTED'}
            </Badge>
            <span className="text-xs text-muted-foreground">{activeCount} active · {stocks.length} total</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={fetchStocks}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> Add Stock
          </Button>
          {selected.size > 0 && (
            <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
              <Trash2 className="h-4 w-4 mr-2" /> Delete ({selected.size})
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="card-accent-teal">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Stocks</CardTitle>
            <Package className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{stocks.length}</div></CardContent>
        </Card>
        <Card className="card-accent-green">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Subscribed</CardTitle>
            <Power className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold text-success">{activeCount}</div></CardContent>
        </Card>
        <Card className="card-accent-red">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Inactive</CardTitle>
            <X className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold text-destructive">{inactiveCount}</div></CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search subscribed stocks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
          {search && (
            <X className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 cursor-pointer text-muted-foreground" onClick={() => setSearch('')} />
          )}
        </div>
      </div>

      <div className="space-y-3">
        {loading ? (
          <Card className="shadow-soft">
            <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <RefreshCw className="h-8 w-8 animate-spin mb-3" />
              <p className="text-sm">Loading stocks...</p>
            </CardContent>
          </Card>
        ) : filteredStocks.length === 0 ? (
          <Card className="shadow-soft">
            <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Package className="h-12 w-12 mb-3" />
              <p className="text-sm font-medium">{search ? 'No stocks match your search' : 'No stocks subscribed'}</p>
              <p className="text-xs mt-1">Click &quot;Add Stock&quot; to search and subscribe.</p>
            </CardContent>
          </Card>
        ) : (
          filteredStocks.map((stock) => {
            const tick = getStockTick(stock);
            const isExpanded = expandedStock === stock.symbol;
            const hasLtp = tick?.ltp != null && tick.ltp !== 0;
            const change = tick?.change;
            const changePct = tick?.changePercent;
            const changeCls = change == null || change === 0
              ? 'text-muted-foreground'
              : change > 0 ? 'text-success' : 'text-destructive';

            return (
              <Card key={stock._id} className={`shadow-soft animate-fade-in overflow-hidden ${!stock.active ? 'opacity-50' : ''}`}>
                <div
                  className="cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedStock(isExpanded ? null : stock.symbol)}
                >
                  <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-sm">{stock.symbol}</span>
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              {stock.exchangeSegment === 'nse_cm' ? 'NSE' : stock.exchangeSegment}
                            </Badge>
                            {stock.active && hasLtp && (
                              <Badge variant="default" className="bg-success text-success-foreground text-[10px] px-1.5 py-0">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-white mr-1 animate-pulse" />
                                LIVE
                              </Badge>
                            )}
                            {!stock.active && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">INACTIVE</Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {hasLtp ? (
                          <div className="text-right">
                            <p className="font-mono text-sm font-semibold">{fmtNum(tick!.ltp)}</p>
                            {change != null && change !== 0 && (
                              <p className={`text-xs font-mono ${changeCls}`}>
                                {fmtCurrency(change)} ({fmtNum(changePct)}%)
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="font-mono text-sm text-muted-foreground">LTP —</p>
                        )}
                        <Switch
                          checked={stock.active}
                          onCheckedChange={(c) => handleToggle(stock.symbol, c)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={(e) => { e.stopPropagation(); handleDelete(stock.symbol); }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>

                    {hasLtp && (
                      <div className="grid grid-cols-5 gap-3 text-xs">
                        <div>
                          <span className="text-muted-foreground">Open</span>
                          <p className="font-mono font-medium">{fmtNum(tick!.open)}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">High</span>
                          <p className="font-mono font-medium">{fmtNum(tick!.high)}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Low</span>
                          <p className="font-mono font-medium">{fmtNum(tick!.low)}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Prev Close</span>
                          <p className="font-mono font-medium">{fmtNum(tick!.close)}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Volume</span>
                          <p className="font-mono font-medium">{tick!.volume != null ? tick!.volume.toLocaleString('en-IN') : '—'}</p>
                        </div>
                      </div>
                    )}

                    {hasLtp && (
                      <div className="grid grid-cols-5 gap-3 text-xs">
                        <div>
                          <span className="text-muted-foreground">Bid</span>
                          <p className="font-mono font-medium">{fmtNum(tick!.bp)}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Bid Qty</span>
                          <p className="font-mono font-medium">{tick!.bq != null ? Math.round(tick!.bq).toLocaleString('en-IN') : '—'}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Ask</span>
                          <p className="font-mono font-medium">{fmtNum(tick!.sp)}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Ask Qty</span>
                          <p className="font-mono font-medium">{tick!.bs != null ? Math.round(tick!.bs).toLocaleString('en-IN') : '—'}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">LTQ</span>
                          <p className="font-mono font-medium">{tick!.ltq != null ? Math.round(tick!.ltq).toLocaleString('en-IN') : '—'}</p>
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/50">
                      <span>Token: {stock.instrumentToken}</span>
                      <span>Segment: {stock.exchangeSegment}</span>
                      {tick?.ts && <span>Updated: {fmtTime(tick.ts)}</span>}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border bg-muted/20 p-4 space-y-3 animate-fade-in">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <Label className="text-xs text-muted-foreground">Instrument Token</Label>
                        <p className="font-mono mt-0.5">{stock.instrumentToken}</p>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Exchange Segment</Label>
                        <p className="mt-0.5">{stock.exchangeSegment}</p>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Internal Index</Label>
                        <p className="font-mono mt-0.5">{stock.internalIndex ?? '—'}</p>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Status</Label>
                        <p className="mt-0.5">{stock.active ? 'Active' : 'Inactive'}</p>
                      </div>
                    </div>
                    {hasLtp && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <Label className="text-xs text-muted-foreground">Average Price</Label>
                          <p className="font-mono mt-0.5">{fmtNum(tick!.averagePrice)}</p>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Total Buy Qty</Label>
                          <p className="font-mono mt-0.5">{tick!.volume != null ? tick!.volume.toLocaleString('en-IN') : '—'}</p>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Received At</Label>
                          <p className="font-mono mt-0.5">{fmtTime(tick!.receivedAt)}</p>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Exchange Segment</Label>
                          <p className="font-mono mt-0.5">{tick!.exchangeSegment || '—'}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Add Stock — Search via Kotak API</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 overflow-hidden">
            <div className="space-y-3 flex flex-col overflow-hidden">
              <div className="flex gap-2">
                <Input
                  placeholder="Search stock (e.g. RELIANCE)..."
                  value={kotakSearch}
                  onChange={(e) => setKotakSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleKotakSearch()}
                />
                <Button onClick={handleKotakSearch} disabled={searching}>
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </div>
              <ScrollArea className="flex-1 max-h-[50vh]">
                {searchResults.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Search for a stock to see results from Kotak API.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {searchResults.map((r, i) => (
                      <div
                        key={i}
                        className={`flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors ${
                          selectedResult === r ? 'border-primary bg-primary/5' : ''
                        }`}
                        onClick={() => setSelectedResult(r)}
                      >
                        <div>
                          <p className="font-medium text-sm">{r.symbol || r.tradingSymbol}</p>
                          <p className="text-xs text-muted-foreground">
                            {r.tradingSymbol || '—'} · {r.exchangeSegment || 'nse_cm'}
                          </p>
                        </div>
                        {selectedResult === r && (
                          <Badge variant="default">Selected</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>

            <div className="space-y-3 flex flex-col overflow-hidden">
              {selectedResult ? (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <Info className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">Stock Information</span>
                  </div>
                  <ScrollArea className="flex-1 max-h-[50vh]">
                    <div className="space-y-1.5">
                      {infoFields.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No additional information available.</p>
                      ) : (
                        infoFields.map((f, i) => (
                          <div key={i} className="flex justify-between border-b pb-1">
                            <span className="text-xs text-muted-foreground">{f.label}</span>
                            <span className="text-xs font-medium font-mono">{f.value}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Info className="h-10 w-10 mb-2" />
                  <p className="text-sm">Select a stock from search results to see full information.</p>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleAdd} disabled={adding || !selectedResult}>
              {adding ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
              Subscribe
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
