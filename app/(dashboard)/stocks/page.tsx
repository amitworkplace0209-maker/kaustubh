'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Package, Plus, Trash2, Search, Power, X, RefreshCw, Info, Loader2,
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
} from '@/lib/api';
import { searchInstruments } from '@/lib/instrument-search-client';
import {
  SEARCH_SUGGESTION_LIMIT, shouldSearch, type CanonicalInstrument,
} from '@/lib/instrument-search';
import { PageHeader } from '@/components/design-system';
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
  if (typeof v === 'number') return v.toLocaleString('en-US');
  return String(v);
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
  const { toast } = useToast();

  const fetchStocks = useCallback(async () => {
  try {
    console.log("FETCH STOCKS START:", {
      search,
      time: new Date().toISOString(),
    });

    const data = await getStocks(search);

    console.log("FRONTEND STOCK API RESPONSE:", data);

    const stockList: Stock[] =
      Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.stocks)
            ? data.stocks
            : [];

    console.log("FRONTEND STOCK LIST:", stockList);
    console.log("FRONTEND STOCK COUNT:", stockList.length);

    /*
     * IMPORTANT:
     * Never replace existing stocks with an empty response
     * when this is the normal stock list.
     */
    if (stockList.length > 0) {
      console.log(
        "SETTING STOCK STATE:",
        stockList.length
      );
      stocksRef.current = stockList;
      setStocks(stockList);
    } else if (search.trim()) {
      console.log(
        "SEARCH RESULT EMPTY:",
        search
      );

      setStocks([]);
    } else {
      console.warn(
        "EMPTY STOCK RESPONSE — keeping existing stocks:",
         stocksRef.current.length
      );
    }

  } catch (error) {
    console.error(
      "FETCH STOCKS FAILED:",
      error
    );

    /*
     * IMPORTANT:
     * Do NOT clear stocks when API temporarily fails.
     */
    toast({
      title: "Failed to load stocks",
      description:
        error instanceof Error
          ? error.message
          : "Stock API request failed",
      variant: "destructive",
    });

  } finally {
    setLoading(false);
  }
}, [search, toast, stocks.length]);
  useEffect(() => {
    console.log("STOCK PAGE MOUNTED");

    fetchStocks();

    // The subscription list is a Mongo config document — it only changes when
    // THIS page adds / removes a row, so re-fetching it every 10 s was pure
    // request churn. Reload on user action and on a window re-focus instead;
    // the tick data for the listed instruments continues to flow live.
    const onFocus = () => {
      if (!document.hidden) fetchStocks();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      console.log("STOCK PAGE UNMOUNTED");
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [fetchStocks]);

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

      // Only EQ instruments will be shown.
      setSearchResults(eqResults);

      // First EQ result is automatically selected.
      const auto = eqResults[0] ?? null;
      setSelectedResult(auto);

      if (auto) {
        console.log('AUTO SELECTED EQ STOCK:', {
          token: auto.token,
          tradingSymbol: auto.tradingSymbol,
          series: auto.series,
          exchange: auto.exchange,
          exchangeSegment: auto.exchangeSegment,
        });
      }
    } catch (err) {
      toast({
        title: 'Search failed',
        description:
          err instanceof Error
            ? err.message
            : 'Kotak API unavailable',
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
    toast({
      title: 'No stock selected',
      description: 'Search for a stock first.',
      variant: 'destructive',
    });
    return;
  }

  const token = String(selectedResult.token || '');

  if (!token) {
    toast({
      title: 'No instrument token',
      description: 'The selected EQ instrument has no token.',
      variant: 'destructive',
    });
    return;
  }

  const symbol = String(
    selectedResult.symbol || selectedResult.tradingSymbol || ''
  ).trim();

  if (!symbol) {
    toast({
      title: 'No symbol found',
      description: 'The selected EQ instrument has no symbol.',
      variant: 'destructive',
    });
    return;
  }

  const exchangeSegment = String(
    selectedResult.exchangeSegment || 'nse_cm'
  );

  setAdding(true);

  try {
    await addStock({
      symbol: symbol.toUpperCase(),
      instrumentToken: token,
      exchangeSegment,
    });

    toast({
      title: 'Stock added',
      description: `${symbol.toUpperCase()} subscribed successfully`,
    });

    setSelectedResult(null);
    setSearchResults([]);
    setKotakSearch('');
    setAddOpen(false);

    fetchStocks();
  } catch (err) {
    toast({
      title: 'Error',
      description:
        err instanceof Error
          ? err.message
          : 'Failed to subscribe stock',
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
  const todayActive = stocks.filter((s) => s.active).length;

  // Flatten the canonical instrument for the info panel. Anything the Search
  // Engine did not supply stays null and renders through safeVal as '—'.
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
    ];
    for (const f of fieldMap) {
      const v = r[f.key];
      if (v != null && v !== '') {
        infoFields.push({ label: f.label, value: safeVal(v) });
      }
    }
    // Live market state
    const quoteFields: { key: keyof CanonicalInstrument; label: string }[] = [
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
    for (const f of quoteFields) {
      const v = r[f.key];
      if (v != null && v !== '') {
        infoFields.push({ label: f.label, value: safeVal(v) });
      }
    }
    // Margin
    infoFields.push({ label: '1 Qty Margin', value: safeVal(r.oneQtyMargin) });
    infoFields.push({ label: 'Margin Status', value: safeVal(r.marginStatus) });
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Stock Subscription" subtitle="Search, subscribe, and manage NSE stocks">
          <Button size="sm" variant="ghost" onClick={fetchStocks}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> Add Stock
          </Button>
          {selected.size > 0 && (
            <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
              <Trash2 className="h-4 w-4 mr-2" /> Delete ({selected.size})
            </Button>
          )}
      </PageHeader>

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="card-accent-teal">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Stocks</CardTitle>
            <Package className="h-4 w-4 text-teal-500" />
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
        <Card className="card-accent-amber">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Today's Active</CardTitle>
            <RefreshCw className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{todayActive}</div></CardContent>
        </Card>
      </div>

      {/* Search bar */}
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

      {/* Subscribed stocks table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  <th className="p-3 text-left font-medium w-10">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border"
                      checked={selected.size === stocks.length && stocks.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(stocks.map((s) => s.symbol)) : new Set())}
                    />
                  </th>
                  <th className="p-3 text-left font-medium">Symbol</th>
                  <th className="p-3 text-left font-medium">Internal Index</th>
                  <th className="p-3 text-left font-medium">Exchange</th>
                  <th className="p-3 text-left font-medium">Status</th>
                  <th className="p-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Loading...</td></tr>
                ) : stocks.length === 0 ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No stocks subscribed. Click "Add Stock" to search and subscribe.</td></tr>
                ) : (
                  stocks.map((stock) => (
                    <tr key={stock._id} className="border-b hover:bg-muted/50 transition-colors">
                      <td className="p-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border"
                          checked={selected.has(stock.symbol)}
                          onChange={() => toggleSelect(stock.symbol)}
                        />
                      </td>
                      <td className="p-3 font-medium">{stock.symbol}</td>
                      <td className="p-3 text-muted-foreground font-mono">{stock.internalIndex ?? '—'}</td>
                      <td className="p-3"><Badge variant="secondary" className="text-xs">NSE</Badge></td>
                      <td className="p-3">
                        <Switch checked={stock.active} onCheckedChange={(c) => handleToggle(stock.symbol, c)} />
                      </td>
                      <td className="p-3 text-right">
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(stock.symbol)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Add Stock Dialog with Kotak search + full info panel */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Add Stock — Search via Kotak API</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 overflow-hidden">
            {/* Left: Search + results list */}
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
    className={`flex items-center justify-between rounded-lg border p-3 ${
      selectedResult === r
        ? 'border-primary bg-primary/5'
        : ''
    }`}
  >
                       <div>
  <p className="font-medium text-sm">
  {r.symbol || r.tradingSymbol}
</p>

<p className="text-xs text-muted-foreground">
  NSE • EQ
</p>
</div>

<Badge variant="default">
  EQ Selected
</Badge>  </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>

            {/* Right: Full stock info panel */}
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
