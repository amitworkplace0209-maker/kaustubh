'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  Briefcase,
  ClipboardList,
  CheckCircle2,
  XCircle,
  Activity,
  Database,
  Server,
  Wifi,
  Calendar,
  RefreshCw,
  LogIn,
  LogOut,
  AlertCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getFunds, getPositions, getHoldings, getOrderBook, getSystemStatus, triggerLogin, triggerLogout } from '@/lib/api';

function StatCard({ icon: Icon, label, value, sub, accent }: { icon: React.ElementType; label: string; value: string | number; sub?: string; accent: string }) {
  return (
    <Card className={`shadow-soft animate-fade-in ${accent}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? 'default' : 'destructive'} className={ok ? 'bg-success text-success-foreground' : ''}>
      {label}
    </Badge>
  );
}

export default function TradingDashboardPage() {
  const [funds, setFunds] = useState<any>(null);
  const [positions, setPositions] = useState<any>(null);
  const [holdings, setHoldings] = useState<any>(null);
  const [orders, setOrders] = useState<any>(null);
  const [system, setSystem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    try {
      const [f, p, h, o, s] = await Promise.allSettled([
        getFunds(), getPositions(), getHoldings(), getOrderBook(), getSystemStatus(),
      ]);
      if (f.status === 'fulfilled') setFunds(f.value);
      if (p.status === 'fulfilled') setPositions(p.value);
      if (h.status === 'fulfilled') setHoldings(h.value);
      if (o.status === 'fulfilled') setOrders(o.value);
      if (s.status === 'fulfilled') setSystem(s.value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 5000);
    return () => clearInterval(interval);
  }, [fetch]);

  if (loading) {
    return <div className="flex items-center justify-center h-full"><RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const availableMargin = funds?.data?.limitObject?.RMS?.available_margin ?? funds?.available_margin ?? '—';
  const usedMargin = funds?.data?.limitObject?.RMS?.utilised_debit ?? funds?.utilised_debit ?? '—';
  const blockedMargin = funds?.data?.limitObject?.RMS?.blocked_margin ?? funds?.blocked_margin ?? '—';
  const cash = funds?.data?.limitObject?.RMS?.cash ?? funds?.cash ?? '—';

  const posData = positions?.data ?? [];
  const posList = Array.isArray(posData) ? posData : [];
  const openPositions = posList.length;
  const totalMTM = posList.reduce((sum: number, p: any) => sum + (Number(p?.realised ?? 0) + Number(p?.unrealised ?? 0)), 0);

  const holdData = holdings?.data ?? [];
  const holdList = Array.isArray(holdData) ? holdData : [];
  const holdingsCount = holdList.length;
  const holdingsValue = holdList.reduce((sum: number, h: any) => sum + (Number(h?.quantity ?? 0) * Number(h?.avg_price ?? h?.price ?? 0)), 0);

  const orderData = orders?.data ?? [];
  const orderList = Array.isArray(orderData) ? orderData : [];
  const completedOrders = orderList.filter((o: any) => o?.status === 'complete' || o?.status === 'filled').length;
  const rejectedOrders = orderList.filter((o: any) => o?.status === 'rejected' || o?.status === 'cancelled').length;
  const totalOrders = orderList.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Trading Dashboard</h1>
          <p className="text-sm text-muted-foreground">Portfolio overview and trading metrics</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={async () => { await triggerLogin(); fetch(); }}>
            <LogIn className="h-4 w-4 mr-2" /> Login
          </Button>
          <Button size="sm" variant="outline" onClick={async () => { await triggerLogout(); fetch(); }}>
            <LogOut className="h-4 w-4 mr-2" /> Logout
          </Button>
          <Button size="sm" variant="ghost" onClick={fetch}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Status pills */}
      <div className="flex flex-wrap gap-2">
        <Card className="flex items-center gap-2 px-3 py-2 shadow-soft">
          <Database className="h-4 w-4 text-teal-500" />
          <span className="text-xs text-muted-foreground">MongoDB</span>
          <StatusPill ok={system?.mongo?.connected ?? false} label={system?.mongo?.connected ? 'Connected' : 'Down'} />
        </Card>
        <Card className="flex items-center gap-2 px-3 py-2 shadow-soft">
          <Server className="h-4 w-4 text-orange-500" />
          <span className="text-xs text-muted-foreground">Python</span>
          <StatusPill ok={system?.python?.status === 'ok'} label={system?.python?.status === 'ok' ? 'Running' : 'Down'} />
        </Card>
        <Card className="flex items-center gap-2 px-3 py-2 shadow-soft">
          <Activity className="h-4 w-4 text-green-500" />
          <span className="text-xs text-muted-foreground">FastAPI</span>
          <StatusPill ok={system?.python?.status === 'ok'} label="Running" />
        </Card>
        <Card className="flex items-center gap-2 px-3 py-2 shadow-soft">
          <LogIn className="h-4 w-4 text-purple-500" />
          <span className="text-xs text-muted-foreground">Kotak Login</span>
          <StatusPill ok={system?.pythonStatus?.logged_in ?? false} label={system?.pythonStatus?.logged_in ? 'Logged In' : 'Out'} />
        </Card>
        <Card className="flex items-center gap-2 px-3 py-2 shadow-soft">
          <Wifi className="h-4 w-4 text-teal-500" />
          <span className="text-xs text-muted-foreground">WebSocket</span>
          <StatusPill ok={system?.websocketConnected ?? false} label={system?.websocketConnected ? 'Connected' : 'Off'} />
        </Card>
        <Card className="flex items-center gap-2 px-3 py-2 shadow-soft">
          <Calendar className="h-4 w-4 text-amber-500" />
          <span className="text-xs text-muted-foreground">Scheduler</span>
          <StatusPill ok={system?.schedulerRunning ?? false} label={system?.schedulerRunning ? 'Running' : 'Stopped'} />
        </Card>
      </div>

      {/* Key metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Wallet} label="Available Margin" value={typeof availableMargin === 'number' ? `₹${availableMargin.toLocaleString()}` : availableMargin} accent="card-accent-green" />
        <StatCard icon={TrendingUp} label="Used Margin" value={typeof usedMargin === 'number' ? `₹${usedMargin.toLocaleString()}` : usedMargin} accent="card-accent-orange" />
        <StatCard icon={Briefcase} label="Open Positions" value={openPositions} sub={`${holdingsCount} holdings`} accent="card-accent-purple" />
        <StatCard icon={ClipboardList} label="Total Orders" value={totalOrders} sub={`${completedOrders} completed · ${rejectedOrders} rejected`} accent="card-accent-teal" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={TrendingUp} label="Today's P&L (MTM)" value={`₹${totalMTM.toLocaleString()}`} sub={totalMTM >= 0 ? 'profit' : 'loss'} accent={totalMTM >= 0 ? 'card-accent-green' : 'card-accent-red'} />
        <StatCard icon={Wallet} label="Blocked Margin" value={typeof blockedMargin === 'number' ? `₹${blockedMargin.toLocaleString()}` : blockedMargin} accent="card-accent-amber" />
        <StatCard icon={Wallet} label="Cash" value={typeof cash === 'number' ? `₹${cash.toLocaleString()}` : cash} accent="card-accent-teal" />
        <StatCard icon={Briefcase} label="Holdings Value" value={`₹${holdingsValue.toLocaleString()}`} sub={`${holdingsCount} stocks`} accent="card-accent-green" />
      </div>

      {/* Positions + Orders preview */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle className="text-base">Open Positions</CardTitle>
          </CardHeader>
          <CardContent>
            {posList.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No open positions</p>
            ) : (
              <div className="space-y-2">
                {posList.slice(0, 5).map((p: any, i: number) => {
                  const mtm = Number(p?.realised ?? 0) + Number(p?.unrealised ?? 0);
                  return (
                    <div key={i} className="flex items-center justify-between rounded-lg border p-2 text-sm">
                      <span className="font-medium">{p?.trading_symbol ?? p?.symbol ?? '—'}</span>
                      <span className="text-muted-foreground">Qty: {p?.net_qty ?? p?.quantity ?? 0}</span>
                      <span className={mtm >= 0 ? 'text-success font-medium' : 'text-destructive font-medium'}>
                        ₹{mtm.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle className="text-base">Recent Orders</CardTitle>
          </CardHeader>
          <CardContent>
            {orderList.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No orders today</p>
            ) : (
              <div className="space-y-2">
                {orderList.slice(0, 5).map((o: any, i: number) => (
                  <div key={i} className="flex items-center justify-between rounded-lg border p-2 text-sm">
                    <span className="font-medium">{o?.trading_symbol ?? o?.symbol ?? '—'}</span>
                    <span className="text-muted-foreground">{o?.transaction_type ?? o?.side ?? '—'}</span>
                    <Badge variant={o?.status === 'complete' ? 'default' : 'secondary'} className={o?.status === 'complete' ? 'bg-success text-success-foreground' : o?.status === 'rejected' ? 'bg-destructive text-destructive-foreground' : ''}>
                      {o?.status ?? '—'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
