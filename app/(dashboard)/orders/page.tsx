'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Search, ShoppingCart, Plus, Trash2, Send, RefreshCw, TrendingUp, TrendingDown,
  AlertCircle, CheckCircle2, XCircle, Wallet, Package, History, Download,
} from 'lucide-react';
import {
  searchScrip, getQuote, placeOrder, getFunds,
  getBaskets, createBasket, deleteBasket, pushBasket,
  getOrderHistory, getSystemStatus,
  type Basket, type BasketOrder,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

type SearchResult = {
  symbol: string;
  token: string;
  exchange: string;
  tradingSymbol?: string;
  companyName?: string;
};

type QuoteData = {
  ltp: number;
  upperCircuit: number;
  lowerCircuit: number;
  marginRequired: number;
  misAvailable: boolean;
};

function OrderHistoryTab() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchHistory = useCallback(async () => {
    try {
      const data = await getOrderHistory('orders', '');
      const list = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
      setOrders(list);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 10000);
    return () => clearInterval(interval);
  }, [fetchHistory]);

  const filtered = orders.filter((o) => statusFilter === 'all' || o?.status === statusFilter);

  const handleDownload = () => {
    const headers = ['Order ID', 'Symbol', 'Type', 'Product', 'Qty', 'Price', 'Status', 'Date'];
    const rows = filtered.map((o) => [
      o?.n_ord_no ?? o?.order_id ?? '', o?.trading_symbol ?? o?.symbol ?? '',
      o?.transaction_type ?? '', o?.product ?? '', o?.quantity ?? '',
      o?.price ?? '', o?.status ?? '', o?.order_date ?? o?.ts ?? '',
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `order_history_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="complete">Complete</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={handleDownload}>
          <Download className="h-4 w-4 mr-2" /> Export CSV
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  <th className="p-3 text-left font-medium">Order ID</th>
                  <th className="p-3 text-left font-medium">Symbol</th>
                  <th className="p-3 text-left font-medium">Type</th>
                  <th className="p-3 text-left font-medium">Product</th>
                  <th className="p-3 text-right font-medium">Qty</th>
                  <th className="p-3 text-right font-medium">Price</th>
                  <th className="p-3 text-left font-medium">Status</th>
                  <th className="p-3 text-left font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">Loading...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">No orders found</td></tr>
                ) : (
                  filtered.map((o, i) => (
                    <tr key={i} className="border-b hover:bg-muted/50 transition-colors text-sm">
                      <td className="p-3 text-muted-foreground">{o?.n_ord_no ?? o?.order_id ?? '—'}</td>
                      <td className="p-3 font-medium">{o?.trading_symbol ?? o?.symbol ?? '—'}</td>
                      <td className="p-3">
                        <Badge variant={o?.transaction_type === 'BUY' ? 'default' : 'destructive'} className={o?.transaction_type === 'BUY' ? 'bg-success text-success-foreground' : ''}>
                          {o?.transaction_type ?? '—'}
                        </Badge>
                      </td>
                      <td className="p-3 text-muted-foreground">{o?.product ?? '—'}</td>
                      <td className="p-3 text-right">{o?.quantity ?? '—'}</td>
                      <td className="p-3 text-right">{o?.price ?? '—'}</td>
                      <td className="p-3">
                        <Badge variant={o?.status === 'complete' ? 'default' : o?.status === 'rejected' ? 'destructive' : 'secondary'} className={o?.status === 'complete' ? 'bg-success text-success-foreground' : ''}>
                          {o?.status ?? '—'}
                        </Badge>
                      </td>
                      <td className="p-3 text-muted-foreground text-xs">{o?.order_date ?? o?.ts ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OrdersPage() {
  const [tab, setTab] = useState('view');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedStock, setSelectedStock] = useState<SearchResult | null>(null);
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [funds, setFunds] = useState<any>(null);
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [orderForm, setOrderForm] = useState({
  transactionType: 'BUY',
  product: 'MIS',
  orderType: 'MKT',
  quantity: '1',
  price: '0',
  triggerPrice: '0',

  // Target-profit auto exit
  targetEnabled: false,
  targetMode: 'FIXED' as 'FIXED' | 'PERCENT',
  targetProfit: '',
});
  const [placing, setPlacing] = useState(false);
  const { toast } = useToast();

  const fetchFunds = useCallback(async () => {
    try {
      const f = await getFunds();
      setFunds(f);
    } catch { /* not logged in */ }
  }, []);

  const fetchBaskets = useCallback(async () => {
    try {
      const data = await getBaskets();
      setBaskets(data.baskets || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchFunds();
    fetchBaskets();
  }, [fetchFunds, fetchBaskets]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try {
      const data = await searchScrip('nse_cm', searchQuery);
      const results = Array.isArray(data?.data) ? data.data : [];

const mappedResults: SearchResult[] = results.map((r: any) => ({
  symbol: r.pSymbolName ?? '',
  token: String(r.pSymbol ?? ''),
  exchange: r.pExchSeg ?? 'nse_cm',
  tradingSymbol: r.pTrdSymbol ?? '',
  companyName: r.pDesc ?? '',
}));

setSearchResults(mappedResults.slice(0, 10));
    } catch {
      toast({ title: 'Search failed', description: 'Kotak API may be unavailable', variant: 'destructive' });
    }
  };

  const handleSelectStock = async (stock: SearchResult) => {
    setSelectedStock(stock);
    setQuoteLoading(true);
    try {
      const data = await getQuote([{ instrument_token: stock.token, exchange_segment: stock.exchange }], 'ltp');
      const q = data?.data || {};
      console.log("QUOTE RAW:", data);
      console.log("QUOTE DATA:", q);
      setQuote({
        ltp: q.ltp || q.last_price || 0,
        upperCircuit: q.upper_circuit || 0,
        lowerCircuit: q.lower_circuit || 0,
        marginRequired: q.margin_required || 0,
        misAvailable: q.mis_available !== false,
      });
    } catch {
      setQuote({ ltp: 0, upperCircuit: 0, lowerCircuit: 0, marginRequired: 0, misAvailable: false });
    } finally {
      setQuoteLoading(false);
    }
  };

  const handlePlaceOrder = async () => {
    if (!selectedStock) return;
    setPlacing(true);
    try {
      await placeOrder({
        exchange: selectedStock.exchange,
        symbol: selectedStock.symbol,
        token: selectedStock.token,
        transaction_type: orderForm.transactionType,
        product: orderForm.product,
        order_type: orderForm.orderType,
        quantity: orderForm.quantity,
        price: orderForm.price,
        trigger_price: orderForm.triggerPrice,
      });
      toast({ title: 'Order placed', description: `${orderForm.transactionType} ${orderForm.quantity} ${selectedStock.symbol}` });
    } catch (err) {
      toast({ title: 'Order failed', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    } finally {
      setPlacing(false);
    }
  };

  const handleCreateBasket = async () => {
    try {
      await createBasket({ name: `Basket ${baskets.length + 1}`, orders: [], cancelOnFill: true });
      fetchBaskets();
      toast({ title: 'Basket created' });
    } catch {
      toast({ title: 'Failed to create basket', variant: 'destructive' });
    }
  };

  const handlePushBasket = async (id: string) => {
    try {
      await pushBasket(id);
      fetchBaskets();
      toast({ title: 'Basket pushed', description: 'Orders executed' });
    } catch {
      toast({ title: 'Basket push failed', variant: 'destructive' });
    }
  };

  const handleDeleteBasket = async (id: string) => {
    try {
      await deleteBasket(id);
      fetchBaskets();
      toast({ title: 'Basket deleted' });
    } catch { /* ignore */ }
  };

  const availableMargin = funds?.data?.limitObject?.RMS?.available_margin ?? funds?.available_margin ?? 0;
  const usedMargin = funds?.data?.limitObject?.RMS?.utilised_debit ?? funds?.utilised_debit ?? 0;
  const remainingBalance = availableMargin - usedMargin;
  const misDisabled = quote && !quote.misAvailable;
  const isDark = misDisabled;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
        <p className="text-sm text-muted-foreground">Place orders and manage baskets</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="view" className="gap-2"><Search className="h-4 w-4" /> View Order</TabsTrigger>
          <TabsTrigger value="basket" className="gap-2"><Package className="h-4 w-4" /> Basket Order</TabsTrigger>
          <TabsTrigger value="history" className="gap-2"><History className="h-4 w-4" /> Order History</TabsTrigger>
        </TabsList>

        {/* ---- View Order Tab ---- */}
        <TabsContent value="view" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Search Stock</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  placeholder="Search stock from Kotak API..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <Button onClick={handleSearch}><Search className="h-4 w-4 mr-2" /> Search</Button>
              </div>
              {searchResults.length > 0 && (
                <div className="mt-3 space-y-1">
                  {searchResults.map((r) => (
                    <div
                      key={r.token}
                      className="flex items-center justify-between rounded-lg border p-2 hover:bg-muted cursor-pointer"
                      onClick={() => handleSelectStock(r)}
                    >
                      <span className="font-medium text-sm">{r.tradingSymbol || r.symbol}</span>
                      <span className="text-xs text-muted-foreground">{r.companyName || r.exchange}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {selectedStock && (
            <Card className={isDark ? 'opacity-50 brightness-50' : ''}>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span>{selectedStock.tradingSymbol || selectedStock.symbol}</span>
                  {misDisabled && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertCircle className="h-3 w-3" /> MIS Intraday Unavailable
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {quoteLoading ? (
                  <div className="flex items-center justify-center py-4"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                ) : quote ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Current Price</Label>
                      <p className="text-lg font-bold font-mono">₹{quote.ltp.toFixed(2)}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Upper Circuit</Label>
                      <p className="text-lg font-bold font-mono text-success">₹{quote.upperCircuit.toFixed(2)}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Lower Circuit</Label>
                      <p className="text-lg font-bold font-mono text-destructive">₹{quote.lowerCircuit.toFixed(2)}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Margin Required</Label>
                      <p className="text-lg font-bold font-mono">₹{quote.marginRequired.toFixed(2)}</p>
                    </div>
                  </div>
                ) : null}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Select value={orderForm.transactionType} onValueChange={(v) => setOrderForm({ ...orderForm, transactionType: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BUY">BUY</SelectItem>
                      <SelectItem value="SELL">SELL</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={orderForm.product} onValueChange={(v) => setOrderForm({ ...orderForm, product: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MIS">MIS (Intraday)</SelectItem>
                      <SelectItem value="CNC">CNC (Delivery)</SelectItem>
                      <SelectItem value="NRML">NRML</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={orderForm.orderType} onValueChange={(v) => setOrderForm({ ...orderForm, orderType: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MKT">Market</SelectItem>
                      <SelectItem value="L">Limit</SelectItem>
                      <SelectItem value="SL">SL</SelectItem>
                      <SelectItem value="SL-M">SL-M</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    placeholder="Qty"
                    value={orderForm.quantity}
                    onChange={(e) => setOrderForm({ ...orderForm, quantity: e.target.value })}
                  />
                </div>

                <div className="flex gap-3">
                  <Button
                    className="flex-1 bg-success hover:bg-success/90 text-success-foreground"
                    disabled={misDisabled || placing}
                    onClick={handlePlaceOrder}
                  >
                    <TrendingUp className="h-4 w-4 mr-2" /> BUY
                  </Button>
                  <Button
                    className="flex-1 bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                    disabled={misDisabled || placing}
                    onClick={() => { setOrderForm({ ...orderForm, transactionType: 'SELL' }); handlePlaceOrder(); }}
                  >
                    <TrendingDown className="h-4 w-4 mr-2" /> SELL
                  </Button>
                </div>
                {misDisabled && (
                  <p className="text-sm text-destructive text-center">
                    Intraday trading is unavailable for this stock. The card is darkened to indicate this.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ---- Basket Order Tab ---- */}
        <TabsContent value="basket" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Baskets</CardTitle>
              <div className="flex items-center gap-3">
                <div className="text-sm text-muted-foreground">
                  Balance: <span className="font-bold text-foreground">₹{remainingBalance.toFixed(2)}</span>
                </div>
                <Button size="sm" onClick={handleCreateBasket}><Plus className="h-4 w-4 mr-2" /> New Basket</Button>
              </div>
            </CardHeader>
            <CardContent>
              {baskets.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <Package className="h-12 w-12 mb-3" />
                  <p className="text-sm">No baskets yet. Create one to add orders.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {baskets.map((basket) => (
                    <Card key={basket._id} className="border-2">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                        <div>
                          <CardTitle className="text-sm">{basket.name}</CardTitle>
                          <p className="text-xs text-muted-foreground">
                            {basket.orders?.length || 0} orders · {basket.cancelOnFill ? 'Cancel on fill' : 'No cancel'} · {basket.status}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="default" onClick={() => handlePushBasket(basket._id)}>
                            <Send className="h-4 w-4 mr-1" /> Push
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleDeleteBasket(basket._id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </CardHeader>
                      {basket.orders && basket.orders.length > 0 && (
                        <CardContent>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Symbol</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead>Product</TableHead>
                                <TableHead className="text-right">Qty</TableHead>
                                <TableHead>Status</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {basket.orders.map((order, i) => (
                                <TableRow key={i}>
                                  <TableCell className="font-medium text-sm">{order.symbol}</TableCell>
                                  <TableCell>
                                    <Badge variant={order.transactionType === 'BUY' ? 'default' : 'destructive'}>
                                      {order.transactionType}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-sm">{order.product}</TableCell>
                                  <TableCell className="text-right font-mono">{order.quantity}</TableCell>
                                  <TableCell>
                                    <Badge variant={
                                      order.status === 'executed' ? 'default' :
                                      order.status === 'cancelled' ? 'secondary' :
                                      order.status === 'failed' ? 'destructive' : 'outline'
                                    }>
                                      {order.status}
                                    </Badge>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </CardContent>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Order History Tab */}
        <TabsContent value="history" className="space-y-4">
          <OrderHistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
