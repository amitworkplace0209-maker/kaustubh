'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Database, HardDrive, MemoryStick, Network, RefreshCw, Server, 
  Cpu, ChevronDown, ChevronUp, Search, Filter, Download, Copy, CheckCircle2,
  AlertCircle, Info, Wifi, WifiOff, Zap, Settings, Trash2, Link, Unlink,
  Cloud, Save
} from 'lucide-react';
import { backendFetch } from '@/lib/backend';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

function unwrap(res: { data: any }): any {
  const d = res?.data;
  if (d && typeof d === 'object' && 'data' in d && (d as any).data !== undefined) return (d as any).data;
  return d;
}

function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN');
}

function fmtBytes(b?: number | null): string {
  if (b == null || Number.isNaN(Number(b))) return '—';
  const v = Number(b);
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} TB`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
  return `${v} B`;
}

function fmtTs(iso?: string | number | null): string {
  if (iso == null || iso === '') return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

function AgeTicker({ ts }: { ts?: string | number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 10000);
    return () => clearInterval(t);
  }, []);
  if (ts == null || ts === '') return <span>—</span>;
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (isNaN(ms)) return <span className="font-mono">{fmtTs(ts)}</span>;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const age = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  return <span className="font-mono tabular-nums" title={new Date(ms).toLocaleString('en-IN')}>{age}</span>;
}

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

function CollapsibleSection({ title, children, defaultOpen = true, icon, badge }: { 
  title: string; 
  children: React.ReactNode; 
  defaultOpen?: boolean; 
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border/50 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 p-3 bg-muted/40 hover:bg-muted/60 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          {icon && <span className="h-4 w-4 text-primary">{icon}</span>}
          <span className="font-semibold text-sm">{title}</span>
          {badge && <Badge variant="outline" className="ml-auto">{badge}</Badge>}
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="p-3 border-t border-border/50">{children}</div>}
    </div>
  );
}

export default function DatabasePage() {
  const [info, setInfo] = useState<any>(null);
  const [resources, setResources] = useState<any>(null);
  const [collections, setCollections] = useState<any[]>([]);
  const [config, setConfig] = useState<any>(null);
  const [clusterInfo, setClusterInfo] = useState<any>(null);
  const [pingResult, setPingResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'resources' | 'collections' | 'cluster' | 'config'>('overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [filterQ, setFilterQ] = useState('');

  const say = useCallback((kind: 'ok' | 'err', text: string) => setNotice({ kind, text }), []);

  const loadAll = useCallback(async (quiet = false) => {
    if (!quiet) { setLoading(true); setError(null); }
    try {
      const [infoRes, resourcesRes, collectionsRes, configRes, clusterRes, pingRes] = await Promise.all([
        backendFetch('/api/database/info', { timeoutMs: 15000 }),
        backendFetch('/api/database/resources', { timeoutMs: 15000 }),
        backendFetch('/api/database/collections?limit=200', { timeoutMs: 15000 }),
        backendFetch('/api/database/config', { timeoutMs: 15000 }),
        backendFetch('/api/database/cluster', { timeoutMs: 15000 }),
        backendFetch('/api/database/ping?timeout=5', { timeoutMs: 10000 }),
      ]);
      
      if (infoRes.ok && infoRes.data) { setInfo(unwrap(infoRes)); setError(null); }
      else if (!infoRes.ok) setError(infoRes.error ?? 'Database info unavailable');
      
      if (resourcesRes.ok && resourcesRes.data) setResources(unwrap(resourcesRes));
      if (collectionsRes.ok && collectionsRes.data) setCollections(unwrap(collectionsRes).collections ?? []);
      if (configRes.ok && configRes.data) setConfig(unwrap(configRes));
      if (clusterRes.ok && clusterRes.data) setClusterInfo(unwrap(clusterRes));
      if (pingRes.ok && pingRes.data) setPingResult(unwrap(pingRes));
      
      setLastRefresh(new Date());
    } catch (e: unknown) {
      if (!quiet) setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void loadAll(false); }, [loadAll]);

  const autoRef = useRef(autoRefresh);
  autoRef.current = autoRefresh;
  const loadRef = useRef(loadAll);
  loadRef.current = loadAll;
  useEffect(() => {
    const t = setInterval(() => {
      if (!autoRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void loadRef.current(true);
    }, 20000);
    return () => clearInterval(t);
  }, []);

  const handleReconnect = async () => {
    setBusy('reconnect');
    setNotice(null);
    const res = await backendFetch('/api/database/reconnect', { method: 'POST', timeoutMs: 60000 });
    setBusy(null);
    if (res.ok) { say('ok', 'Reconnected successfully'); void loadAll(false); }
    else say('err', res.error ?? 'Reconnection failed');
  };

  const handleSaveConfig = async (updates: any) => {
    setBusy('save-config');
    const res = await backendFetch('/api/services/storage/config', {
      method: 'POST',
      body: JSON.stringify(updates),
      timeoutMs: 20000,
    });
    setBusy(null);
    if (res.ok) { say('ok', 'Configuration saved'); void loadAll(false); }
    else say('err', res.error ?? 'Save failed');
  };

  const copyToClipboard = async (data: any, label: string) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      say('ok', `${label} copied to clipboard`);
    } catch { say('err', 'Clipboard unavailable'); }
  };

  if (loading && !info) {
    return (
      <div className="space-y-4">
        <div className="h-28 animate-pulse rounded-2xl bg-muted/60" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted/60" />)}</div>
        <p className="py-1 text-center text-xs text-muted-foreground">Loading Database Monitoring…</p>
      </div>
    );
  }

  const connected = info?.connected ?? false;
  const isAtlas = info?.source === 'atlas';
  const source = info?.source ?? 'unknown';
  const pool = info?.pool_stats ?? {};
  const connections = resources?.connections ?? {};
  const memory = resources?.memory ?? {};
  const storage = resources?.storage?.wired_tiger_cache ?? {};
  const ops = resources?.operations ?? {};
  const metrics = resources?.metrics ?? {};
  const network = resources?.network ?? {};

  const filteredCollections = useMemo(() => {
    const q = filterQ.trim().toLowerCase();
    if (!q) return collections;
    return collections.filter(c => String(c.name ?? '').toLowerCase().includes(q));
  }, [collections, filterQ]);

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/[0.12] via-indigo-500/[0.06] to-emerald-500/[0.12]" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 via-indigo-500 to-emerald-500 text-white shadow-xl">
            <Database className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Database Monitoring</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground sm:text-sm">
              {info?.database ?? '—'} · {info?.host ?? 'no host'} · {connected ? 'LIVE' : 'DOWN'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {connected ? (
              <Badge className="border border-emerald-500/40 bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 text-emerald-200">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                {isAtlas ? 'ATLAS CLOUD' : source.toUpperCase()}
              </Badge>
            ) : (
              <Badge className="border border-rose-500/40 bg-rose-500/10 text-rose-200">DISCONNECTED</Badge>
            )}
            <Badge variant="outline" className="tabular-nums">
              Pool: {pool.ready ?? 0}/{pool.created ?? 0}
            </Badge>
            {notice && <Badge variant="outline" className={notice.kind === 'ok' ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}>{notice.text}</Badge>}
            <button onClick={() => setAutoRefresh(v => !v)} title="Auto-refresh 20s" className={cn('rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors', autoRefresh ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-border text-muted-foreground')}>
              {autoRefresh ? '● AUTO' : '○ AUTO OFF'}
            </button>
            <IstClock />
            <Button size="sm" onClick={() => void loadAll(false)} className="gap-1.5 bg-gradient-to-r from-blue-500 to-emerald-500 shadow-md" disabled={busy !== null}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={handleReconnect} className="gap-1.5" disabled={busy !== null}>
              <Unlink className="h-3.5 w-3.5" /> {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0">{error}</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void loadAll(false)}>Retry</Button>
        </div>
      )}

      {/* TABS */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="w-full">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview"><Database className="h-3.5 w-3.5 mr-1" /> Overview</TabsTrigger>
          <TabsTrigger value="resources"><Activity className="h-3.5 w-3.5 mr-1" /> Resources</TabsTrigger>
          <TabsTrigger value="collections"><HardDrive className="h-3.5 w-3.5 mr-1" /> Collections</TabsTrigger>
          <TabsTrigger value="cluster">{isAtlas ? <Cloud className="h-3.5 w-3.5 mr-1" /> : <Server className="h-3.5 w-3.5 mr-1" />} Cluster</TabsTrigger>
          <TabsTrigger value="config"><Settings className="h-3.5 w-3.5 mr-1" /> Config</TabsTrigger>
        </TabsList>

        {/* OVERVIEW TAB */}
        <TabsContent value="overview" className="space-y-4 pt-4">
          {/* Connection Identity */}
          <CollapsibleSection title="Connection Identity" icon={<Database className="h-4 w-4" />} badge={connected ? 'Connected' : 'Down'}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <InfoRow label="Source" value={source.toUpperCase()} icon={isAtlas ? <Cloud className="h-3.5 w-3.5" /> : <Server className="h-3.5 w-3.5" />} />
              <InfoRow label="Database" value={info?.database ?? '—'} />
              <InfoRow label="Host (no creds)" value={info?.host ?? '—'} />
              <InfoRow label="Server Version" value={info?.server_version ?? '—'} />
              <InfoRow label="Connected Since" value={info?.connected_at ? new Date(info.connected_at * 1000).toLocaleString('en-IN') : '—'} icon={<Activity className="h-3.5 w-3.5" />} />
              <InfoRow label="Config Version" value={info?.config_version ?? 0} icon={<Settings className="h-3.5 w-3.5" />} />
              <InfoRow label="Pool Created" value={pool.created ?? 0} icon={<Zap className="h-3.5 w-3.5" />} />
              <InfoRow label="Pool Ready" value={pool.ready ?? 0} icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
            </div>
            {info?.error && (
              <div className="mt-3 p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-sm">
                <AlertCircle className="h-4 w-4 inline mr-1" /> Last Error: {info.error}
              </div>
            )}
          </CollapsibleSection>

          {/* Ping Status */}
          <CollapsibleSection title="Live Ping Test" icon={<Activity className="h-4 w-4" />} badge={pingResult?.ok ? 'OK' : 'Failed'}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <InfoRow label="Status" value={pingResult?.ok ? 'OK' : 'FAILED'} />
              <InfoRow label="Ping Latency" value={pingResult?.pingMs != null ? `${pingResult.pingMs} ms` : '—'} icon={<Activity className="h-3.5 w-3.5" />} />
              <InfoRow label="Query Test" value={pingResult?.queryOk ? 'PASSED' : 'FAILED'} icon={pingResult?.queryOk ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />} />
              <InfoRow label="Collections" value={pingResult?.collections != null ? String(pingResult.collections) : '—'} />
              <InfoRow label="Server Version" value={pingResult?.serverVersion ?? '—'} />
              <InfoRow label="Error" value={pingResult?.error ?? '—'} />
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={async () => { const r = await backendFetch('/api/database/ping?timeout=5', { timeoutMs: 10000 }); setPingResult(unwrap(r)); }} disabled={busy !== null}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" /> Re-ping
              </Button>
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(pingResult, 'Ping result')}>
                <Copy className="h-3.5 w-3.5 mr-1" /> Copy JSON
              </Button>
            </div>
          </CollapsibleSection>

          {/* Key Metrics Strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {(() => {
              const metrics = [
                { label: 'Connections', value: `${connections.current ?? 0} / ${(connections.available ?? 0) + (connections.current ?? 0)}`, Icon: Network, color: 'bg-blue-500' },
                { label: 'Memory (Resident)', value: `${memory.resident_mb ?? 0} MB`, Icon: MemoryStick, color: 'bg-violet-500' },
                { label: 'WiredTiger Cache', value: `${storage.usage_pct ?? 0}%`, Icon: HardDrive, color: 'bg-emerald-500' },
                { label: 'Ops/sec (Insert)', value: ops.insert ?? 0, Icon: Zap, color: 'bg-amber-500' },
                { label: 'Net In', value: `${fmtBytes(network.bytes_in)}/s`, Icon: Wifi, color: 'bg-cyan-500' },
                { label: 'Net Out', value: `${fmtBytes(network.bytes_out)}/s`, Icon: WifiOff, color: 'bg-rose-500' },
              ];
              return metrics.map((m) => (
                <Card key={m.label} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-0.5">
                  <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', m.color)} />
                  <CardContent className="p-3">
                    <div className="flex items-center gap-2">
                      <span className={cn('rounded-lg p-1.5 text-white shadow', m.color)}><m.Icon className="h-4 w-4" /></span>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{m.label}</span>
                    </div>
                    <p className="mt-1 truncate font-mono text-lg font-bold tabular-nums leading-7">{m.value}</p>
                  </CardContent>
                </Card>
              ));
            })()}
          </div>

          {/* Pool Stats */}
          <CollapsibleSection title="Connection Pool Stats" icon={<Link className="h-4 w-4" />} badge={`${pool.ready ?? 0} ready`}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Ready', pool.ready],
                ['Created', pool.created],
                ['Closed', pool.closed],
                ['Checkout Failed', pool.checkout_failed],
                ['Cleared', pool.cleared],
              ].map(([label, value]) => (
                <InfoRow key={label} label={label} value={value} />
              ))}
            </div>
          </CollapsibleSection>
        </TabsContent>

        {/* RESOURCES TAB */}
        <TabsContent value="resources" className="space-y-4 pt-4">
          {/* Connections */}
          <CollapsibleSection title="Connections" icon={<Network className="h-4 w-4" />} defaultOpen>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoRow label="Current" value={connections.current ?? 0} />
              <InfoRow label="Available" value={connections.available ?? 0} />
              <InfoRow label="Total Created" value={connections.total_created ?? 0} />
              <InfoRow label="Active" value={connections.active ?? 0} />
              <InfoRow label="Usage %" value={connections.usage_pct != null ? `${connections.usage_pct}%` : '—'} />
            </div>
            {connected && (
              <Progress value={connections.usage_pct ?? 0} className="mt-3 h-2" />
            )}
          </CollapsibleSection>

          {/* Memory */}
          <CollapsibleSection title="Memory" icon={<MemoryStick className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoRow label="Resident" value={`${memory.resident_mb ?? 0} MB`} />
              <InfoRow label="Virtual" value={`${memory.virtual_mb ?? 0} MB`} />
              <InfoRow label="Mapped" value={`${memory.mapped_mb ?? 0} MB`} />
              <InfoRow label="Mapped w/ Journal" value={`${memory.mapped_with_journal_mb ?? 0} MB`} />
            </div>
          </CollapsibleSection>

          {/* WiredTiger Cache */}
          <CollapsibleSection title="WiredTiger Cache" icon={<HardDrive className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoRow label="Used" value={`${storage.used_gb ?? 0} GB`} />
              <InfoRow label="Max" value={`${storage.max_gb ?? 0} GB`} />
              <InfoRow label="Usage %" value={`${storage.usage_pct ?? 0}%`} />
              <InfoRow label="Dirty Bytes" value={fmtBytes(storage.dirty_bytes)} />
              <InfoRow label="Read Into Cache" value={fmtBytes(storage.bytes_read_into_cache)} />
              <InfoRow label="Written From Cache" value={fmtBytes(storage.bytes_written_from_cache)} />
            </div>
            {connected && storage.usage_pct != null && (
              <Progress value={storage.usage_pct} className="mt-3 h-2" />
            )}
          </CollapsibleSection>

          {/* Operations */}
          <CollapsibleSection title="Operations (cumulative)" icon={<Zap className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Insert', ops.insert],
                ['Query', ops.query],
                ['Update', ops.update],
                ['Delete', ops.delete],
                ['GetMore', ops.getmore],
                ['Command', ops.command],
                ['Repl Insert', ops.repl_insert],
                ['Repl Update', ops.repl_update],
                ['Repl Delete', ops.repl_delete],
              ].map(([label, value]) => (
                <InfoRow key={label} label={label} value={fmtNum(value)} />
              ))}
            </div>
          </CollapsibleSection>

          {/* Metrics */}
          <CollapsibleSection title="Metrics (per-second rates)" icon={<Activity className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoRow label="Doc Inserted/s" value={fmtNum(metrics.document_inserted_per_sec)} />
              <InfoRow label="Doc Updated/s" value={fmtNum(metrics.document_updated_per_sec)} />
              <InfoRow label="Doc Deleted/s" value={fmtNum(metrics.document_deleted_per_sec)} />
              <InfoRow label="Cursors Open" value={fmtNum(metrics.cursor_open)} />
              <InfoRow label="Cursors Timed Out" value={fmtNum(metrics.cursor_timed_out)} />
            </div>
          </CollapsibleSection>

          {/* Network */}
          <CollapsibleSection title="Network I/O" icon={<Wifi className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoRow label="Bytes In" value={fmtBytes(network.bytes_in)} />
              <InfoRow label="Bytes Out" value={fmtBytes(network.bytes_out)} />
              <InfoRow label="Requests" value={fmtNum(network.num_requests)} />
            </div>
          </CollapsibleSection>

          {/* Server Info */}
          <CollapsibleSection title="Server Info" icon={<Info className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoRow label="Uptime" value={resources.server_uptime_seconds ? `${fmtNum(resources.server_uptime_seconds)}s` : '—'} />
              <InfoRow label="Local Time" value={resources.local_time ?? '—'} />
            </div>
          </CollapsibleSection>
        </TabsContent>

        {/* COLLECTIONS TAB */}
        <TabsContent value="collections" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={filterQ} onChange={e => setFilterQ(e.target.value)} placeholder="Filter collections…" className="h-9 pl-8 text-sm" />
            </div>
            <Button variant="outline" onClick={() => copyToClipboard(filteredCollections, 'Collections')}>
              <Copy className="h-3.5 w-3.5 mr-1" /> Copy JSON
            </Button>
            <Button variant="outline" onClick={() => {
              const head = 'name,count,size_mb,storage_mb,index_mb,indexes,avg_obj_size\n';
              const body = filteredCollections.map(c => [c.name, c.count, (c.size_mb ?? 0).toFixed(2), (c.storage_mb ?? 0).toFixed(2), (c.index_mb ?? 0).toFixed(2), c.index_count, c.avg_obj_size].join(',')).join('\n');
              const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
              const a = document.createElement('a'); a.href = url; a.download = 'collections.csv'; a.click(); URL.revokeObjectURL(url);
            }} disabled={!filteredCollections.length}>
              <Download className="h-3.5 w-3.5 mr-1" /> CSV
            </Button>
          </div>

          <Card className="overflow-hidden">
            <CardContent className="p-0">
              {!filteredCollections.length ? (
                <div className="p-8 text-center text-muted-foreground">No collections found</div>
              ) : (
                <div className="max-h-[600px] overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                      <tr className="border-b border-border">
                        <th className="px-3 py-2 font-semibold">Collection</th>
                        <th className="px-3 py-2 font-semibold text-right">Documents</th>
                        <th className="px-3 py-2 font-semibold text-right">Data Size</th>
                        <th className="px-3 py-2 font-semibold text-right">Storage Size</th>
                        <th className="px-3 py-2 font-semibold text-right">Index Size</th>
                        <th className="px-3 py-2 font-semibold text-right">Indexes</th>
                        <th className="px-3 py-2 font-semibold text-right">Avg Obj Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCollections.slice(0, 200).map((c: any) => (
                        <tr key={c.name} className="border-b border-border/50 hover:bg-muted/30">
                          <td className="px-3 py-2 font-mono font-medium truncate max-w-[200px]">{c.name}{c.capped && <Badge variant="secondary" className="ml-1 text-xs">CAPPED</Badge>}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtNum(c.count)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtBytes(c.size_bytes)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtBytes(c.storage_bytes)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtBytes(c.index_bytes)}</td>
                          <td className="px-3 py-2 text-right font-mono">{c.index_count}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtBytes(c.avg_obj_size)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* CLUSTER TAB */}
        <TabsContent value="cluster" className="space-y-4 pt-4">
          {isAtlas ? (
            <>
              <CollapsibleSection title="Atlas Cluster Details" icon={<Cloud className="h-4 w-4" />} defaultOpen badge={clusterInfo?.available ? 'Available' : 'Unavailable'}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <InfoRow label="Cluster Type" value={clusterInfo?.cluster_type ?? '—'} />
                  <InfoRow label="Version" value={clusterInfo?.version ?? '—'} />
                  <InfoRow label="Git Version" value={clusterInfo?.git_version ?? '—'} />
                  <InfoRow label="Allocator" value={clusterInfo?.allocator ?? '—'} />
                  <InfoRow label="JS Engine" value={clusterInfo?.javascript_engine ?? '—'} />
                  <InfoRow label="Sharding" value={clusterInfo?.sharding_enabled ? 'Enabled' : 'Disabled'} />
                  <InfoRow label="Modules" value={clusterInfo?.modules?.join(', ') ?? '—'} />
                </div>
                {clusterInfo?.error && <p className="mt-3 text-sm text-rose-300">Error: {clusterInfo.error}</p>}
              </CollapsibleSection>
            </>
          ) : (
            <div className="text-center py-8">
              <Server className="h-12 w-12 mx-auto text-muted-foreground/30" />
              <h3 className="mt-4 text-lg font-semibold">Not an Atlas Cluster</h3>
              <p className="mt-1 text-muted-foreground">This endpoint only shows details for MongoDB Atlas (mongodb+srv://) connections.<br />Current source: <code className="font-mono">{source}</code></p>
            </div>
          )}
        </TabsContent>

        {/* CONFIG TAB */}
        <TabsContent value="config" className="space-y-4 pt-4">
          <CollapsibleSection title="MongoDB Configuration" icon={<Settings className="h-4 w-4" />} defaultOpen badge={config?.configured ? 'Configured' : 'Not Configured'}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <InfoRow label="Source" value={config?.source ?? '—'} />
              <InfoRow label="Host" value={config?.host ?? '—'} />
              <InfoRow label="Database" value={config?.database ?? '—'} />
              <InfoRow label="DB from URI" value={config?.database_from_uri ?? '—'} />
            </div>
            <Separator className="my-4" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <InfoRow label="Max Pool Size" value={config?.pool?.max_pool_size ?? '—'} />
              <InfoRow label="Min Pool Size" value={config?.pool?.min_pool_size ?? '—'} />
              <InfoRow label="Max Idle Time" value={`${config?.pool?.max_idle_time_ms ?? 0} ms`} />
              <InfoRow label="Wait Queue Timeout" value={`${config?.pool?.wait_queue_timeout_ms ?? 0} ms`} />
              <InfoRow label="Server Selection Timeout" value={`${config?.timeouts?.server_selection_ms ?? 0} ms`} />
              <InfoRow label="Connect Timeout" value={`${config?.timeouts?.connect_ms ?? 0} ms`} />
              <InfoRow label="Socket Timeout" value={`${config?.timeouts?.socket_ms ?? 0} ms`} />
              <InfoRow label="Retry Attempts" value={config?.retry?.attempts ?? '—'} />
              <InfoRow label="Retry Delay" value={`${config?.retry?.retry_delay_s ?? 0} s`} />
            </div>
            <Separator className="my-4" />
            <h4 className="font-semibold text-sm">Test Database</h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <InfoRow label="Configured" value={config?.test_database?.configured ? 'Yes' : 'No'} />
              <InfoRow label="Database" value={config?.test_database?.database ?? '—'} />
            </div>
          </CollapsibleSection>

          {/* Storage Engine Config (from storage_engine) */}
          <CollapsibleSection title="Storage Engine Config (Runtime)" icon={<Settings className="h-4 w-4" />} defaultOpen>
            <form onSubmit={e => { e.preventDefault(); const fd = new FormData(e.target as HTMLFormElement); const updates: any = {}; for (const [key, val] of fd.entries()) { if (key === 'sampleIntervalSeconds') updates.sampleIntervalSeconds = parseInt(val as string); else if (key === 'cpuWarnPct') updates.cpuWarnPct = parseFloat(val as string); else if (key === 'cpuCritPct') updates.cpuCritPct = parseFloat(val as string); else if (key === 'monitoringEnabled') updates.monitoringEnabled = val === 'true'; } handleSaveConfig(updates); }} className="grid grid-cols-2 gap-3">
              <label className="text-sm text-muted-foreground">Sample Interval (s)
                <input type="number" name="sampleIntervalSeconds" defaultValue={config?.sampleIntervalSeconds ?? 10} min={1} step={1} className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs" />
              </label>
              <label className="text-sm text-muted-foreground">CPU Warn %
                <input type="number" name="cpuWarnPct" defaultValue={config?.cpuWarnPct ?? 70} min={0} max={100} step={1} className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs" />
              </label>
              <label className="text-sm text-muted-foreground">CPU Crit %
                <input type="number" name="cpuCritPct" defaultValue={config?.cpuCritPct ?? 90} min={0} max={100} step={1} className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs" />
              </label>
              <label className="text-sm text-muted-foreground">Monitoring
                <select name="monitoringEnabled" defaultValue={String(config?.monitoringEnabled !== false)} className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs">
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <div className="col-span-2 flex items-center gap-2">
                <Button type="submit" disabled={busy === 'save-config'} className="gap-1.5 bg-gradient-to-r from-amber-500 to-orange-600">
                  <Save className="h-3.5 w-3.5" /> {busy === 'save-config' ? 'Saving…' : 'Save Configuration'}
                </Button>
              </div>
            </form>
          </CollapsibleSection>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function InfoRow({ label, value, icon }: { label: string; value: string | number; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-1.5">
        {icon && <span className="h-3.5 w-3.5 text-primary">{icon}</span>}
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <p className="mt-0.5 truncate font-mono text-sm font-semibold tabular-nums" title={String(value)}>{value}</p>
    </div>
  );
}