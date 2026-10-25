'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  Server, Database, Wifi, Calendar, Cpu, MemoryStick, HardDrive,
  Activity, Globe, Download, ShoppingCart, Bell, TrendingUp,
  CheckCircle2, XCircle, AlertCircle, RefreshCw, Search, Filter,
  LogIn, LogOut, Clock, Zap,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getSystemStatus, getNotificationSummary } from '@/lib/api';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';
import { PageHeader } from '@/components/design-system';

type IndicatorState = 'online' | 'offline' | 'connecting' | 'disconnected' | 'error';

const STATE_COLORS: Record<IndicatorState, string> = {
  online: 'bg-success text-success-foreground',
  offline: 'bg-muted text-muted-foreground',
  connecting: 'bg-warning text-warning-foreground',
  disconnected: 'bg-destructive text-destructive-foreground',
  error: 'bg-destructive text-destructive-foreground',
};

const STATE_LABELS: Record<IndicatorState, string> = {
  online: 'Online', offline: 'Offline', connecting: 'Connecting',
  disconnected: 'Disconnected', error: 'Error',
};

function getState(connected: boolean | undefined | null): IndicatorState {
  if (connected === true) return 'online';
  if (connected === false) return 'offline';
  return 'connecting';
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
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function safeNum(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return '0';
  return n.toLocaleString('en-US');
}

type HealthCardProps = {
  icon: React.ElementType; title: string; state: IndicatorState;
  lastOnline?: string; lastOffline?: string; extra?: { label: string; value: string }[];
};

function HealthCard({ icon: Icon, title, state, lastOnline, lastOffline, extra }: HealthCardProps) {
  return (
    <Card className="shadow-soft">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </div>
        <Badge className={STATE_COLORS[state]}>{STATE_LABELS[state]}</Badge>
      </CardHeader>
      <CardContent className="space-y-1 text-xs">
        {lastOnline && <div className="flex justify-between"><span className="text-muted-foreground">Last Online</span><span className="font-mono">{safeTime(lastOnline)}</span></div>}
        {lastOffline && <div className="flex justify-between"><span className="text-muted-foreground">Last Offline</span><span className="font-mono">{safeTime(lastOffline)}</span></div>}
        {extra?.map((e, i) => (
          <div key={i} className="flex justify-between"><span className="text-muted-foreground">{e.label}</span><span className="font-mono">{e.value}</span></div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function SystemPage() {
  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState('');
  const [filterState, setFilterState] = useState('all');

  // Both documents arrive over the persistent WebSocket — no polling.
  // `system` carries GET /api/system, `notifications` carries the
  // notification summary the page shows on the Notification Service card.
  const { data: systemDoc, refresh: refreshSystem, live } = useRealtimeChannel<{
    status?: Record<string, any>;
  }>('system', {
    fallbackMs: 5000,
    fallbackKey: 'system:status',
    fallback: () => getSystemStatus().then((status) => ({ status })),
    select: (doc) => {
      const status = (doc as { status?: Record<string, any> })?.status ?? undefined;
      return status ? { status } : null;
    },
  });

  const { data: notifDoc } = useRealtimeChannel<{ summary?: Record<string, any> }>(
    'notifications',
    {
      fallbackMs: 5000,
      fallbackKey: 'notifications:summary',
      fallback: () => getNotificationSummary().then((summary) => ({ summary })),
      select: (doc) => {
        const summary = (doc as { summary?: Record<string, any> })?.summary ?? undefined;
        return summary ? { summary } : null;
      },
    },
  );

  const data = systemDoc?.status ?? null;
  const notifSummary = notifDoc?.summary ?? null;
  const loading = !data;

  useEffect(() => {
    setMounted(true);
  }, []);

  const allCards = useMemo(() => {
    if (!data) return [];
    const cards: { icon: React.ElementType; title: string; state: IndicatorState; lastOnline?: string; lastOffline?: string; extra?: { label: string; value: string }[] }[] = [
      { icon: Server, title: 'FastAPI', state: getState(data.python?.status === 'ok'), extra: [{ label: 'SDK', value: data.sdkLoaded ? 'Loaded' : 'Missing' }] },
      { icon: Activity, title: 'Python Service', state: getState(data.python?.status === 'ok'), extra: [{ label: 'Uptime', value: `${Math.floor((data.node?.uptimeSeconds ?? 0) / 60)}m` }] },
      { icon: Database, title: 'MongoDB', state: getState(data.mongo?.connected), extra: [{ label: 'Records', value: safeNum(data.todayRecords) }] },
      { icon: LogIn, title: 'Kotak Login', state: getState(data.pythonStatus?.logged_in), lastOnline: data.lastLogin, lastOffline: data.lastLogout, extra: [{ label: 'Session', value: data.pythonStatus?.session_active ? 'Active' : 'Inactive' }] },
      { icon: Calendar, title: 'Scheduler', state: getState(data.schedulerRunning), extra: [{ label: 'Enabled', value: data.schedulerEnabled ? 'Yes' : 'No' }] },
      { icon: Wifi, title: 'WebSocket', state: getState(data.websocketConnected), lastOnline: data.lastWebSocketConnection, extra: [{ label: 'Stocks', value: safeNum(data.pythonStatus?.subscribed_symbols) }] },
      { icon: Globe, title: 'Internet', state: getState(data.internetConnected) },
      { icon: HardDrive, title: 'Disk', state: 'online', extra: [{ label: 'Used', value: `${data.node?.diskPercent ?? 0}%` }, { label: 'Total', value: `${((data.node?.diskTotalBytes ?? 0) / 1073741824).toFixed(1)} GB` }] },
      { icon: MemoryStick, title: 'Memory', state: 'online', extra: [{ label: 'Used', value: `${data.node?.ramPercent ?? 0}%` }, { label: 'Heap', value: `${data.node?.memory?.heapUsedMb ?? 0} MB` }] },
      { icon: Cpu, title: 'CPU', state: 'online', extra: [{ label: 'Load', value: `${(data.node?.cpuLoad1m ?? 0).toFixed(2)}` }, { label: 'Usage', value: `${data.node?.cpuPercent ?? 0}%` }] },
      { icon: Database, title: 'Data Saver', state: getState(data.buffer?.totalWritten > 0), extra: [{ label: 'Written', value: safeNum(data.buffer?.totalWritten) }, { label: 'Buffer', value: safeNum(data.buffer?.bufferLength) }] },
      { icon: ShoppingCart, title: 'Trading Engine', state: getState(data.pythonStatus?.logged_in), extra: [{ label: 'Orders', value: safeNum(data.totalOrders) }, { label: 'Positions', value: safeNum(data.totalPositions) }] },
      { icon: Bell, title: 'Notification Service', state: notifSummary ? (notifSummary.live === false ? 'offline' : 'online') : 'connecting', extra: [
        { label: 'Status', value: notifSummary ? (notifSummary.live === false ? 'Unavailable (cached)' : 'Live') : 'Unknown' },
        { label: 'Unread', value: safeNum(notifSummary?.unread) },
        { label: 'Total', value: safeNum(notifSummary?.total) },
      ] },
      { icon: Download, title: 'Download Service', state: 'online', extra: [{ label: 'Today', value: safeNum(data.todayDownloads) }] },
      { icon: Zap, title: 'API Health', state: getState(data.python?.status === 'ok'), extra: [{ label: 'Status', value: '200 OK' }] },
    ];
    return cards;
  }, [data, notifSummary]);

  const filteredCards = useMemo(() => {
    let list = allCards;
    if (search) list = list.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));
    if (filterState !== 'all') list = list.filter((c) => c.state === filterState);
    return list;
  }, [allCards, search, filterState]);

  if (!mounted || loading) {
    return <div className="flex items-center justify-center h-full"><RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const d = data || {};
  const onlineCount = allCards.filter((c) => c.state === 'online').length;
  const offlineCount = allCards.filter((c) => c.state === 'offline').length;

  return (
    <div className="space-y-6">
      <PageHeader title="Project Health Dashboard" subtitle={<>{onlineCount} online · {offlineCount} offline · {allCards.length} total components</>}>
        <Badge variant={live ? 'default' : 'secondary'} className="gap-1">
          <span className={`h-2 w-2 rounded-full ${live ? 'bg-success' : 'bg-muted-foreground'}`} />
          {live ? 'Live' : 'Offline'}
        </Badge>
        <Button size="sm" variant="ghost" onClick={refreshSystem}><RefreshCw className="h-4 w-4" /></Button>
      </PageHeader>

      {/* System Health Summary */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="card-accent-green">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">System Health</span>
              <CheckCircle2 className="h-5 w-5 text-success" />
            </div>
            <div className="text-2xl font-bold mt-1">{onlineCount}/{allCards.length}</div>
            <p className="text-xs text-muted-foreground">components online</p>
          </CardContent>
        </Card>
        <Card className="card-accent-teal">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Today's Saved Records</span>
              <Database className="h-5 w-5 text-teal-500" />
            </div>
            <div className="text-2xl font-bold mt-1">{safeNum(d.todayInserts)}</div>
            <p className="text-xs text-muted-foreground">ticks written</p>
          </CardContent>
        </Card>
        <Card className="card-accent-amber">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Today's Orders</span>
              <ShoppingCart className="h-5 w-5 text-amber-500" />
            </div>
            <div className="text-2xl font-bold mt-1">{safeNum(d.totalOrders)}</div>
            <p className="text-xs text-muted-foreground">{safeNum(d.totalPositions)} open positions</p>
          </CardContent>
        </Card>
        <Card className="card-accent-purple">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Memory Usage</span>
              <MemoryStick className="h-5 w-5 text-purple-500" />
            </div>
            <div className="text-2xl font-bold mt-1">{d.node?.ramPercent ?? 0}%</div>
            <p className="text-xs text-muted-foreground">{d.node?.memory?.heapUsedMb ?? 0} MB heap</p>
          </CardContent>
        </Card>
      </div>

      {/* Search & Filter */}
      <div className="flex gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search components..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
        </div>
        <Select value={filterState} onValueChange={setFilterState}>
          <SelectTrigger className="w-40"><Filter className="h-4 w-4 mr-2" /><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            <SelectItem value="online">Online</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
            <SelectItem value="connecting">Connecting</SelectItem>
            <SelectItem value="disconnected">Disconnected</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Component Health Cards */}
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {filteredCards.map((card, i) => (
          <HealthCard key={i} {...card} />
        ))}
      </div>

      {/* Session Info */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Session Information</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Last Login</span><span className="font-mono">{safeDateTime(d.lastLogin)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Last Logout</span><span className="font-mono">{safeDateTime(d.lastLogout)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Last WS Connection</span><span className="font-mono">{safeDateTime(d.lastWebSocketConnection)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Current Session</span><span className="font-medium">{d.pythonStatus?.session_active ? 'Active' : 'Inactive'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total Connected Stocks</span><span className="font-medium">{safeNum(d.activeStocks)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Reconnect Count</span><span className="font-medium">{safeNum(d.pythonStatus?.reconnect_count)}</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">System Resources</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">CPU Usage</span><span className="font-medium">{d.node?.cpuPercent ?? 0}%</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">CPU Load (1m)</span><span className="font-medium">{(d.node?.cpuLoad1m ?? 0).toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Memory Usage</span><span className="font-medium">{d.node?.ramPercent ?? 0}%</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Disk Usage</span><span className="font-medium">{d.node?.diskPercent ?? 0}%</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Service Uptime</span><span className="font-medium">{Math.floor((d.node?.uptimeSeconds ?? 0) / 60)}m {Math.floor((d.node?.uptimeSeconds ?? 0) % 60)}s</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Error Count</span><span className="font-medium">{safeNum(d.errorCount)}</span></div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
