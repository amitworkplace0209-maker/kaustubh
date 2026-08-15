'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Database, Server, Wifi, Calendar, Activity, Cpu, MemoryStick,
  AlertCircle, Clock, LogIn, LogOut, TrendingUp, RefreshCw, Globe,
  Briefcase, Wallet, PieChart, Download, ShoppingCart,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getSystemStatus, triggerLogin, triggerLogout } from '@/lib/api';

type SystemData = {
  node?: {
    status?: string;
    uptimeSeconds?: number;
    memory?: { rssMb?: number; heapUsedMb?: number; heapTotalMb?: number };
    cpuLoad1m?: number;
    cpuLoad5m?: number;
    cpuLoad15m?: number;
    cpuPercent?: number;
    ramPercent?: number;
  };
  python?: { status?: string; sdk_loaded?: boolean; error?: string } | null;
  pythonStatus?: {
    logged_in?: boolean;
    session_active?: boolean;
    websocket_connected?: boolean;
    subscribed_symbols?: number;
    last_login_at?: string | null;
    last_logout_at?: string | null;
    reconnect_count?: number;
    sdk_version?: string | null;
  } | null;
  mongo?: { connected?: boolean };
  buffer?: {
    totalReceived?: number;
    totalWritten?: number;
    totalWriteErrors?: number;
    bufferLength?: number;
    lastFlushAt?: string | null;
  };
  activeStocks?: number;
  totalStocks?: number;
  todayRecords?: number;
  todayInserts?: number;
  todayDownloads?: number;
  errorCount?: number;
  lastTickTime?: string | null;
  lastLogin?: string | null;
  lastLogout?: string | null;
  websocketConnected?: boolean;
  schedulerRunning?: boolean;
  schedulerEnabled?: boolean;
  sdkLoaded?: boolean;
  internetConnected?: boolean;
  totalOrders?: number;
  totalPositions?: number;
  holdingsCount?: number;
  funds?: any | null;
};

type IndicatorState = 'online' | 'offline' | 'connecting' | 'disconnected' | 'error';

function getIndicatorState(connected: boolean | undefined, hasError?: boolean): IndicatorState {
  if (hasError) return 'error';
  if (connected === true) return 'online';
  if (connected === false) return 'offline';
  return 'connecting';
}

const STATE_COLORS: Record<IndicatorState, string> = {
  online: 'bg-success text-success-foreground',
  offline: 'bg-muted text-muted-foreground',
  connecting: 'bg-warning text-warning-foreground',
  disconnected: 'bg-destructive text-destructive-foreground',
  error: 'bg-destructive text-destructive-foreground',
};

const STATE_LABELS: Record<IndicatorState, string> = {
  online: 'Online',
  offline: 'Offline',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
  error: 'Error',
};

function IndicatorCard({ icon: Icon, label, state }: { icon: React.ElementType; label: string; state: IndicatorState }) {
  return (
    <Card className="flex items-center gap-3 px-4 py-3">
      <Icon className="h-5 w-5 text-primary shrink-0" />
      <div className="flex flex-col min-w-0 gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Badge className={STATE_COLORS[state]}>{STATE_LABELS[state]}</Badge>
      </div>
    </Card>
  );
}

function StatCard({
  icon: Icon, label, value, sub, color = 'text-primary',
}: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className={`h-4 w-4 ${color}`} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function safeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(11, 19);
}

function safeDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function safeNumber(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return '0';
  return n.toLocaleString('en-US');
}

function safeFunds(funds: any): string {
  if (!funds) return '—';

  const data = funds?.data ?? funds;

  if (typeof data === 'string') return data;

  const net = data?.Net;

  if (net != null) {
    const value = Number(net);

    if (!isNaN(value)) {
      return `₹${value.toLocaleString('en-IN', {
        maximumFractionDigits: 2,
      })}`;
    }

    return String(net);
  }

  return '—';
}

export default function DashboardPage() {
  const [data, setData] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const fetch = useCallback(async () => {
    try {
      const d = await getSystemStatus();
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    fetch();
    const interval = setInterval(fetch, 5000);
    return () => clearInterval(interval);
  }, [fetch]);

  if (!mounted || loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <p className="text-destructive font-medium">Failed to load dashboard</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button onClick={fetch} variant="outline">Retry</Button>
      </div>
    );
  }

  const d = data || {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Indicators</h1>
          <p className="text-sm text-muted-foreground">Real-time system overview</p>
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

      {/* System Indicators */}
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        <IndicatorCard icon={Server} label="FastAPI" state={getIndicatorState(d.python?.status === 'ok')} />
        <IndicatorCard icon={Activity} label="Python Service" state={getIndicatorState(d.python?.status === 'ok')} />
        <IndicatorCard icon={Database} label="MongoDB" state={getIndicatorState(d.mongo?.connected)} />
        <IndicatorCard icon={LogIn} label="Kotak Login" state={getIndicatorState(d.pythonStatus?.logged_in)} />
        <IndicatorCard icon={Wifi} label="WebSocket" state={getIndicatorState(d.websocketConnected)} />
        <IndicatorCard icon={Calendar} label="Scheduler" state={getIndicatorState(d.schedulerRunning)} />
        <IndicatorCard icon={Globe} label="Internet" state={getIndicatorState(d.internetConnected)} />
        <IndicatorCard icon={Server} label="API" state={getIndicatorState(d.python?.status === 'ok')} />
        <IndicatorCard icon={Database} label="Data Saving" state={getIndicatorState(d.buffer?.totalWritten ? d.buffer.totalWritten > 0 : false)} />
      </div>

      {/* Stats grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={TrendingUp} label="Active Stocks" value={safeNumber(d.activeStocks)} sub={`of ${safeNumber(d.totalStocks)} total`} />
        <StatCard icon={Database} label="Today's Records" value={safeNumber(d.todayRecords)} sub="ticks stored" color="text-success" />
        <StatCard icon={Download} label="Today's Downloads" value={safeNumber(d.todayDownloads)} sub="files generated" color="text-blue-500" />
        <StatCard icon={AlertCircle} label="Error Count" value={safeNumber(d.errorCount)} sub="today" color={(d.errorCount ?? 0) > 0 ? 'text-destructive' : 'text-success'} />
        <StatCard icon={Cpu} label="CPU Usage" value={`${d.node?.cpuPercent ?? 0}%`} sub={`Load: ${(d.node?.cpuLoad1m ?? 0).toFixed(2)}`} />
        <StatCard icon={MemoryStick} label="RAM Usage" value={`${d.node?.ramPercent ?? 0}%`} sub={`${d.node?.memory?.heapUsedMb ?? 0} MB / ${d.node?.memory?.heapTotalMb ?? 0} MB`} />
        <StatCard icon={Clock} label="Last Tick Time" value={safeTime(d.lastTickTime)} sub={d.lastTickTime ? 'latest tick' : 'no ticks yet'} />
        <StatCard icon={Activity} label="Buffer Length" value={safeNumber(d.buffer?.bufferLength)} sub={`Received: ${safeNumber(d.buffer?.totalReceived)}`} />
      </div>

      {/* Trading overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={ShoppingCart} label="Total Orders" value={safeNumber(d.totalOrders)} sub="order book" color="text-orange-500" />
        <StatCard icon={Briefcase} label="Total Positions" value={safeNumber(d.totalPositions)} sub="open positions" color="text-teal-500" />
        <StatCard icon={PieChart} label="Holdings Count" value={safeNumber(d.holdingsCount)} sub="holdings" color="text-green-500" />
        <StatCard icon={Wallet} label="Funds" value={safeFunds(d.funds)} sub="available margin" color="text-amber-500" />
      </div>

      {/* Session info + Buffer details */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Session Info</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Login Time</span>
              <span className="font-medium">{safeDateTime(d.lastLogin)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Logout Time</span>
              <span className="font-medium">{safeDateTime(d.lastLogout)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subscribed Symbols</span>
              <span className="font-medium">{safeNumber(d.pythonStatus?.subscribed_symbols)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reconnect Count</span>
              <span className="font-medium">{safeNumber(d.pythonStatus?.reconnect_count)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">SDK Version</span>
              <span className="font-medium">{d.pythonStatus?.sdk_version ?? '—'}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Buffer & Write Stats</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Received</span>
              <span className="font-medium">{safeNumber(d.buffer?.totalReceived)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Written</span>
              <span className="font-medium text-success">{safeNumber(d.buffer?.totalWritten)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Write Errors</span>
              <span className="font-medium">{safeNumber(d.buffer?.totalWriteErrors)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Flush</span>
              <span className="font-medium">{safeTime(d.buffer?.lastFlushAt)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Service Uptime</span>
              <span className="font-medium">
                {Math.floor((d.node?.uptimeSeconds ?? 0) / 60)}m {Math.floor((d.node?.uptimeSeconds ?? 0) % 60)}s
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
