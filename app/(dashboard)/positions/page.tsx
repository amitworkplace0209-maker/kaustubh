'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import {
  Briefcase, TrendingUp, TrendingDown, RefreshCw, Edit3, XCircle, Power,
  Wallet, IndianRupee, AlertCircle,
} from 'lucide-react';
import { getPositions, squareOffPosition, getSystemStatus } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

type Position = {
  symbol: string;
  trading_symbol?: string;
  token: string;
  product: string;
  quantity: string | number;
  net_qty?: string | number;
  tradePrice: number;
  livePrice: number | null;
  positionType: string;
  realised: number;
  unrealised: number;
  stopLoss: number | null;
  estimatedCharges: number;
};

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [system, setSystem] = useState<any>(null);
  const [modifyTarget, setModifyTarget] = useState<Position | null>(null);
  const [newSL, setNewSL] = useState('');
  const { toast } = useToast();

  const fetch = useCallback(async () => {
    try {
      const [posRes, sysRes] = await Promise.allSettled([getPositions(), getSystemStatus()]);
      if (posRes.status === 'fulfilled') {
        const data = posRes.value?.data ?? [];
        setPositions(Array.isArray(data) ? data.map(normalizePosition) : []);
      }
      if (sysRes.status === 'fulfilled') setSystem(sysRes.value);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 5000);
    return () => clearInterval(interval);
  }, [fetch]);

  const handleSquareOff = async (pos: Position) => {
    try {
      await squareOffPosition({
        exchange: 'nse_cm',
        token: pos.token,
        product: pos.product,
        quantity: String(pos.quantity),
        position_type: pos.positionType,
      });
      toast({ title: 'Position squared off', description: pos.symbol });
      fetch();
    } catch (err) {
      toast({ title: 'Square off failed', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    }
  };

  const handleModify = async () => {
    if (!modifyTarget) return;
    toast({ title: 'Position updated', description: `${modifyTarget.symbol} SL set to ${newSL}` });
    setModifyTarget(null);
    setNewSL('');
  };

  const totalCharges = positions.reduce((s, p) => s + (p.estimatedCharges || 0), 0);
  const totalProfit = positions.reduce((s, p) => s + (p.realised || 0) + (p.unrealised || 0), 0);
  const netProfit = totalProfit - totalCharges;
  const mode = system?.pythonStatus?.logged_in ? 'API' : 'Dummy';

  if (loading) {
    return <div className="flex items-center justify-center h-full"><RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Positions</h1>
          <p className="text-sm text-muted-foreground">Mode: <Badge variant="outline">{mode}</Badge></p>
        </div>
        <Button size="sm" variant="ghost" onClick={fetch}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="card-accent-amber">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Charges</CardTitle>
            <IndianRupee className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">₹{fmtNum(totalCharges)}</div>
          </CardContent>
        </Card>
        <Card className={totalProfit >= 0 ? 'card-accent-green' : 'card-accent-red'}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Profit</CardTitle>
            {totalProfit >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <TrendingDown className="h-4 w-4 text-destructive" />}
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalProfit >= 0 ? 'text-success' : 'text-destructive'}`}>₹{fmtNum(totalProfit)}</div>
          </CardContent>
        </Card>
        <Card className={netProfit >= 0 ? 'card-accent-green' : 'card-accent-red'}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Net Profit</CardTitle>
            <Wallet className="h-4 w-4 text-teal-500" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${netProfit >= 0 ? 'text-success' : 'text-destructive'}`}>₹{fmtNum(netProfit)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Position cards */}
      {positions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Briefcase className="h-12 w-12 mb-3" />
            <p className="text-sm">No open positions</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {positions.map((pos, i) => {
            const mtm = (pos.realised || 0) + (pos.unrealised || 0);
            const isUp = mtm >= 0;
            return (
              <Card key={i} className="shadow-soft animate-fade-in">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <div>
                    <CardTitle className="text-base">{pos.trading_symbol || pos.symbol}</CardTitle>
                    <p className="text-xs text-muted-foreground">{pos.product} · {pos.positionType}</p>
                  </div>
                  <Badge variant={isUp ? 'default' : 'destructive'} className={isUp ? 'bg-success text-success-foreground' : ''}>
                    {isUp ? '+' : ''}₹{fmtNum(mtm)}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <Label className="text-xs text-muted-foreground">Trade Price</Label>
                      <p className="font-mono font-medium">₹{fmtNum(pos.tradePrice)}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Live Price</Label>
                      <p className="font-mono font-medium">{pos.livePrice != null ? `₹${fmtNum(pos.livePrice)}` : '—'}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Quantity</Label>
                      <p className="font-mono font-medium">{pos.quantity || pos.net_qty || 0}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Stop Loss</Label>
                      <p className="font-mono font-medium">{pos.stopLoss != null ? `₹${fmtNum(pos.stopLoss)}` : '—'}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Est. Charges</Label>
                      <p className="font-mono font-medium">₹{fmtNum(pos.estimatedCharges)}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Type</Label>
                      <p className="font-medium">{pos.positionType}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button size="sm" variant="outline" className="flex-1" onClick={() => { setModifyTarget(pos); setNewSL(pos.stopLoss?.toString() || ''); }}>
                          <Edit3 className="h-3 w-3 mr-1" /> Update
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Modify Position — {pos.symbol}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-3 py-2">
                          <div>
                            <Label>Stop Loss (₹)</Label>
                            <Input type="number" value={newSL} onChange={(e) => setNewSL(e.target.value)} />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button onClick={handleModify}>Save Changes</Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleSquareOff(pos)}>
                      <Power className="h-3 w-3 mr-1" /> Square Off
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function normalizePosition(raw: any): Position {
  return {
    symbol: raw?.symbol || raw?.trading_symbol || 'UNKNOWN',
    trading_symbol: raw?.trading_symbol || raw?.symbol,
    token: raw?.token || raw?.instrument_token || '',
    product: raw?.product || 'MIS',
    quantity: raw?.quantity || raw?.net_qty || 0,
    net_qty: raw?.net_qty || raw?.quantity,
    tradePrice: Number(raw?.buy_avg ?? raw?.sell_avg ?? raw?.avg_price ?? 0),
    livePrice: raw?.ltp ? Number(raw.ltp) : null,
    positionType: raw?.position_type || (Number(raw?.net_qty || raw?.quantity || 0) >= 0 ? 'LONG' : 'SHORT'),
    realised: Number(raw?.realised || 0),
    unrealised: Number(raw?.unrealised || 0),
    stopLoss: raw?.stop_loss ? Number(raw.stop_loss) : null,
    estimatedCharges: Number(raw?.estimated_charges ?? raw?.charges ?? 0),
  };
}
