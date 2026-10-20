'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Activity, Pause, Play, Search, Wifi, WifiOff } from 'lucide-react';
import { getTickStreamUrl, getRecentTicks } from '@/lib/api';
import { PageHeader } from '@/components/design-system';

type Tick = {
  symbol: string;
  instrumentToken: string;
  exchangeSegment: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  change: number | null;
  changePercent: number | null;
  ts: string;
};

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function safeTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Kolkata' });
}

export default function LiveTickTablePage() {
  const [ticks, setTicks] = useState<Map<string, Tick>>(new Map());
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [filter, setFilter] = useState('');
  const [tickCount, setTickCount] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    const es = new EventSource(getTickStreamUrl());
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      es.close();
      setTimeout(() => {
        if (!paused) connect();
      }, 3000);
    };
    es.onmessage = (event) => {
      try {
        const tick: Tick = JSON.parse(event.data);
        setTicks((prev) => {
          const next = new Map(prev);
          next.set(tick.symbol, tick);
          if (next.size > 200) {
            const firstKey = next.keys().next().value;
            if (firstKey) next.delete(firstKey);
          }
          return next;
        });
        setTickCount((c) => c + 1);
      } catch { /* ignore parse errors */ }
    };
  }, [paused]);

  useEffect(() => {
    setMounted(true);
    getRecentTicks(50).then((data) => {
      if (data?.ticks) {
        const map = new Map<string, Tick>();
        for (const t of data.ticks) {
          map.set(t.symbol, t);
        }
        setTicks(map);
      }
    }).catch(() => {});
    connect();
    return () => {
      eventSourceRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    if (!paused && !connected) {
      connect();
    }
    if (paused && eventSourceRef.current) {
      eventSourceRef.current.close();
      setConnected(false);
    }
  }, [paused, connected, connect]);

  const tickList = Array.from(ticks.values()).filter((t) =>
    !filter || t.symbol.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Live Tick Table" subtitle="Real-time WebSocket tick data — no dummy rows">
        <div className="flex items-center gap-3">
          <Badge variant={connected ? 'default' : 'destructive'} className={connected ? 'bg-success text-success-foreground' : ''}>
            {connected ? <Wifi className="h-3 w-3 mr-1" /> : <WifiOff className="h-3 w-3 mr-1" />}
            {connected ? 'Live' : 'Disconnected'}
          </Badge>
          <span className="text-sm text-muted-foreground">{tickCount} ticks received</span>
          <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
            {paused ? <Play className="h-4 w-4 mr-2" /> : <Pause className="h-4 w-4 mr-2" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </PageHeader>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-green-500" />
            Live Ticks ({tickList.length} symbols)
          </CardTitle>
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter symbol..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 w-48"
            />
          </div>
        </CardHeader>
        <CardContent>
          {!connected && tickList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Activity className="h-12 w-12 mb-3 animate-pulse" />
              <p className="text-sm font-medium">Waiting for Live Data</p>
              <p className="text-xs mt-1">WebSocket is disconnected. Ticks will appear here when the connection is restored.</p>
            </div>
          ) : tickList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Activity className="h-12 w-12 mb-3 animate-pulse" />
              <p className="text-sm">Waiting for live ticks...</p>
              <p className="text-xs mt-1">Connect the Python service and subscribe to stocks to see data here.</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-320px)]">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">LTP</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                    <TableHead className="text-right">High</TableHead>
                    <TableHead className="text-right">Low</TableHead>
                    <TableHead className="text-right">Close</TableHead>
                    <TableHead className="text-right">Volume</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead className="text-right">Change %</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tickList.map((tick) => {
                    const isUp = (tick.change ?? 0) >= 0;
                    return (
                      <TableRow key={tick.symbol} className="animate-fade-in">
                        <TableCell className="font-medium">{tick.symbol}</TableCell>
                        <TableCell className="text-right font-mono">{fmtNum(tick.ltp)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{fmtNum(tick.open)}</TableCell>
                        <TableCell className="text-right font-mono text-success">{fmtNum(tick.high)}</TableCell>
                        <TableCell className="text-right font-mono text-destructive">{fmtNum(tick.low)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{fmtNum(tick.close)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{tick.volume != null ? tick.volume.toLocaleString('en-US') : '—'}</TableCell>
                        <TableCell className={`text-right font-mono font-medium ${isUp ? 'text-success' : 'text-destructive'}`}>
                          {isUp ? '+' : ''}{fmtNum(tick.change)}
                        </TableCell>
                        <TableCell className={`text-right font-mono ${isUp ? 'text-success' : 'text-destructive'}`}>
                          {isUp ? '+' : ''}{fmtNum(tick.changePercent)}%
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{safeTime(tick.ts)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
