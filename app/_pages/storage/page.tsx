'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, CheckCircle2, Cloud, Copy, Database, Download,
  Eye, EyeOff, HardDrive, HeartPulse, Lock, MemoryStick, Network, RefreshCw, Save, Search,
  Server, Settings2, ShieldAlert, Trash2, Zap,
} from 'lucide-react';
import { backendFetch } from '@/lib/backend';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Storage & Database — redesigned from zero.
 *
 * Full database details from the REAL backend (never fabricated):
 *  - Identity: Atlas vs Local, db name, credential-free host, server version,
 *    connected-at, pool counters, ping.
 *  - Capacity: dbStats used vs configured cluster capacity (Atlas M0 = 512 MB
 *    default) + budget + auto-clean threshold, with markers.
 *  - Totals: data / storage / index bytes, objects, collections, indexes.
 *  - Collections: real collStats per collection (search + sort + CSV).
 *  - Growth trend: persisted snapshot points.
 *  - Storage Engine: host/runtime, config (save), force snapshot, events,
 *    history, manual cleanup-guard pass.
 */

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

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

/** Live "x ago" ticker — isolated so tables never re-render. */
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

/** doc §32 history ranges → ms window (null = all). */
const RANGE_MS: Record<'5m' | '15m' | '1h' | '6h' | '24h' | 'all', number | null> = {
  '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 36e5, '6h': 6 * 36e5, '24h': 24 * 36e5, all: null,
};

export default function StoragePage() {
  const [db, setDb] = useState<any>(null);
  const [guard, setGuard] = useState<any>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [state, setState] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [auto, setAuto] = useState(true);
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<'storage' | 'count' | 'name'>('storage');
  const [copied, setCopied] = useState(false);
  // doc §32/33: history time-range + events search/filter (client-side, real rows)
  const [range, setRange] = useState<'5m' | '15m' | '1h' | '6h' | '24h' | 'all'>('6h');
  const [evQ, setEvQ] = useState('');
  const [evSev, setEvSev] = useState<'all' | 'high' | 'warn' | 'info'>('all');
  // REAL data-cleanup state (atlas_cleanup authority — works on whichever DB is connected)
  const [plan, setPlan] = useState<any>(null); // /api/system/cleanup/plan — protected classification
  const [cleanupStatus, setCleanupStatus] = useState<any>(null); // /api/system/cleanup/status
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [docMode, setDocMode] = useState<'clear' | 'drop'>('clear');
  const [fullPhrase, setFullPhrase] = useState('');
  const [cleanBusy, setCleanBusy] = useState(false);
  const [armed, setArmed] = useState<null | 'safe' | 'bulk'>(null);
  const [armedRow, setArmedRow] = useState<string | null>(null);
  const [cleanResult, setCleanResult] = useState<any>(null);
  // real document preview (read-only sample viewer)
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewData, setPreviewData] = useState<any[] | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const say = useCallback((kind: 'ok' | 'err', text: string) => setNotice({ kind, text }), []);

  const loadAll = useCallback(async (quiet = false) => {
    if (!quiet) { setLoading(true); setError(null); }
    try {
      const [dbRes, guardRes, trendRes, stRes] = await Promise.all([
        backendFetch('/api/system/data-center/database', { timeoutMs: 15000 }),
        backendFetch('/api/system/cleanup/storage', { timeoutMs: 15000 }),
        backendFetch('/api/system/data-center/storage-trend?days=14', { timeoutMs: 15000 }),
        backendFetch('/api/services/storage', { timeoutMs: 15000 }),
      ]);
      if (dbRes.ok && dbRes.data) {
        setDb(unwrap(dbRes));
        setDbError(null);
      } else if (!dbRes.ok) {
        setDbError(dbRes.error ?? 'Database plane unavailable');
      }
      if (guardRes.ok && guardRes.data) setGuard(unwrap(guardRes));
      if (trendRes.ok && trendRes.data) {
        const t = unwrap(trendRes);
        setTrend(Array.isArray(t?.points) ? t.points : Array.isArray(t) ? t : []);
      }
      if (stRes.ok && stRes.data) {
        setState((stRes.data as any).state ?? stRes.data);
        setConfig((stRes.data as any).config ?? {});
      } else if (!stRes.ok && !quiet) {
        setError(stRes.error ?? 'Failed to load Storage Engine');
      }
      const [evRes, hiRes] = await Promise.all([
        backendFetch('/api/services/storage/events?limit=50', { timeoutMs: 15000 }),
        backendFetch('/api/services/storage/history?limit=50', { timeoutMs: 15000 }),
      ]);
      if (evRes.ok && evRes.data) setEvents((evRes.data as any).events ?? []);
      if (hiRes.ok && hiRes.data) setHistory((hiRes.data as any).snapshots ?? []);
      // cleanup plane: protected classification + last/next run (real, from atlas_cleanup_log)
      const [planRes, csRes] = await Promise.all([
        backendFetch('/api/system/cleanup/plan', { timeoutMs: 30000 }),
        backendFetch('/api/system/cleanup/status', { timeoutMs: 15000 }),
      ]);
      if (planRes.ok && planRes.data) setPlan(unwrap(planRes));
      if (csRes.ok && csRes.data) setCleanupStatus(unwrap(csRes));
    } catch (e: unknown) {
      if (!quiet) setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void loadAll(false); }, [loadAll]);

  // auto-refresh 20s, hidden tab paused, quiet (no skeleton flicker)
  const autoRef = useRef(auto);
  autoRef.current = auto;
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

  const handleSave = async (updates: any) => {
    setSaving(true);
    const res = await backendFetch('/api/services/storage/config', {
      method: 'POST',
      body: JSON.stringify(updates),
      timeoutMs: 20000,
    });
    setSaving(false);
    if (res.ok) {
      setConfig((unwrap(res) as any)?.config ?? updates);
      say('ok', 'Configuration saved + applied.');
    } else say('err', res.error ?? 'Save failed');
  };

  const forceSnapshot = async () => {
    setBusy('snapshot');
    setNotice(null);
    const res = await backendFetch('/api/services/storage/snapshot', { method: 'POST', timeoutMs: 20000 });
    setBusy(null);
    if (res.ok) { say('ok', 'Snapshot sampled now.'); void loadAll(true); }
    else say('err', res.error ?? 'Snapshot failed');
  };

  const runCleanup = async () => {
    setBusy('cleanup');
    setNotice(null);
    const res = await backendFetch('/api/system/cleanup/storage', { method: 'POST', timeoutMs: 60000 });
    setBusy(null);
    if (res.ok) {
      const d = unwrap(res) as any;
      say('ok', `Cleanup pass: ${fmtNum(d?.deleted ?? d?.cleaned ?? 0)} docs trimmed (${d?.reason ?? 'done'}).`);
      void loadAll(true);
    } else say('err', res.error ?? 'Cleanup failed');
  };

  // ---- REAL data cleanup (backend atlas_cleanup authority) -----------------
  const toggleSel = (name: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const selectAllCleanable = () =>
    setSel(new Set(collections.filter((c) => !protectedSet.has(String(c.name))).map((c) => String(c.name))));

  /** One cleanup POST → real per-collection results + live post-state verification. */
  const runClean = async (body: Record<string, unknown>) => {
    setCleanBusy(true);
    setNotice(null);
    const res = await backendFetch('/api/system/cleanup/run', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 300000,
    });
    setCleanBusy(false);
    setArmed(null);
    setArmedRow(null);
    if (res.ok) {
      const d = unwrap(res) as any;
      if (d?.ok === false) {
        setCleanResult(d);
        say('err', String(d?.error ?? 'Clean pass failed — verification live counts se aayi.'));
        return;
      }
      setCleanResult(d);
      say('ok', `Clean pass ${d?.status ?? 'SUCCESS'} · ${fmtNum(d?.totalDeleted ?? 0)} docs deleted · verified on live counts.`);
      void loadAll(true);
    } else {
      say('err', res.error ?? 'Cleanup failed');
      setCleanResult(null);
    }
  };

  /** Read-only real-document preview of one collection (latest 5, sanitized). */
  const togglePreview = async (name: string) => {
    if (previewName === name) {
      setPreviewName(null);
      return;
    }
    setPreviewName(name);
    setPreviewBusy(true);
    setPreviewErr(null);
    setPreviewData(null);
    const res = await backendFetch(`/api/database/sample?collection=${encodeURIComponent(name)}&limit=5`, { timeoutMs: 20000 });
    setPreviewBusy(false);
    if (!res.ok) {
      setPreviewErr(res.error ?? 'Preview failed');
      return;
    }
    const d = unwrap(res) as any;
    setPreviewData(Array.isArray(d?.samples) ? d.samples : []);
  };

  const copySnapshot = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ database: db, guard, storage: state }, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const identity = db?.identity ?? {};
  const storage = db?.storage ?? {};
  const collections = useMemo(() => {
    const all = (Array.isArray(db?.collections) ? db.collections : []) as any[];
    const qq = q.trim().toLowerCase();
    const f = qq ? all.filter((c: any) => String(c.name ?? '').toLowerCase().includes(qq)) : [...all];
    f.sort((a: any, b: any) => {
      if (sortBy === 'name') return String(a.name).localeCompare(String(b.name));
      if (sortBy === 'count') return Number(b.count ?? 0) - Number(a.count ?? 0);
      return Number(b.storageBytes ?? 0) - Number(a.storageBytes ?? 0);
    });
    return f;
  }, [db?.collections, q, sortBy]);
  const maxColl = Math.max(1, ...collections.map((c: any) => Number(c.storageBytes ?? 0)));

  const exportCollections = () => {
    if (!collections.length) return;
    const head = 'name,documents,dataBytes,storageBytes,indexBytes,indexes,avgObjBytes,firstRecord,lastRecord\n';
    const body = collections.map((c: any) => [`"${c.name}"`, c.count ?? '', c.dataSizeBytes ?? '', c.storageBytes ?? '', c.indexSizeBytes ?? '', c.indexes ?? '', c.avgObjSizeBytes ?? '', c.firstRecord ?? '', c.lastRecord ?? ''].join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mongodb-collections.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const trendPts = useMemo(() => {
    return trend.map((p: any) => {
      const bytes = Number(p.totalStorageBytes ?? p.storageBytes ?? p.bytes ?? p.size ?? NaN);
      return { label: String(p.date ?? p.day ?? p.istDay ?? p.at ?? ''), bytes: Number.isFinite(bytes) ? bytes : null };
    }).filter((p) => p.label);
  }, [trend]);
  const maxTrend = Math.max(1, ...trendPts.map((p) => p.bytes ?? 0));

  const source = String(identity.source ?? db?.source ?? 'unknown').toLowerCase();
  const isAtlas = source.includes('atlas');
  const connected = identity.connected ?? db?.available ?? false;
  // cleanup classification (needs `connected`) — protected set from live plan fetch
  const protectedSet = useMemo(() => {
    const rows = (Array.isArray(plan?.collections) ? plan.collections : []) as any[];
    return new Set(rows.filter((r) => r.protected).map((r) => String(r.name)));
  }, [plan]);
  const lastClean = cleanupStatus?.last ?? null;
  const canClean = Boolean(connected && plan?.ok);
  const usedMb = Number(guard?.usedMb ?? NaN);
  const capMb = Number(guard?.capacityMb ?? NaN);
  const usePct = Number(guard?.usagePct ?? NaN);
  const budgetPct = Number.isFinite(usedMb) && Number.isFinite(capMb) && capMb > 0 ? 100 : NaN;
  void budgetPct;
  const budgetMb = Number(guard?.budgetMb ?? NaN);
  const budgetLine = Number.isFinite(budgetMb) && Number.isFinite(capMb) && capMb > 0 ? (budgetMb / capMb) * 100 : null;
  const threshLine = Number(guard?.thresholdPct ?? NaN);

  const hostname = state?.host || {};
  const runtime = state?.runtime || {};
  const database = state?.database || {};
  // doc §4: deployment-agnostic environment — show where the backend runs (defensive: only present fields)
  const env = state?.environment || {};
  const envRows = (
    [
      ['Type', env.environment_type ?? env.type],
      ['Hostname', env.hostname ?? hostname.hostname],
      ['Instance', env.instance_id ?? env.instanceId],
      ['Container', env.container_id ?? env.containerId],
      ['PID', env.process_id ?? runtime.pid],
      ['Runtime', env.runtime ?? runtime.runtime ?? runtime.name],
      ['Version', env.runtime_version ?? runtime.version],
      ['OS', env.os],
      ['Arch', env.architecture ?? env.arch],
      ['Timezone', env.timezone],
    ] as [string, unknown][]
  ).filter(([, v]) => v != null && v !== '');
  // doc §11/28: engine health table (defensive key variants, unavailable ≠ fake)
  const engineRows = Array.isArray(state?.engines) ? state.engines : [];
  // doc §13/30: storage pipeline fields (defensive variants)
  const dbLat = (k: string[]) => {
    for (const key of k) {
      const v = database[key];
      if (v != null && v !== '') return v;
    }
    return null;
  };
  const readLat = dbLat(['read_latency_ms', 'readLatencyMs', 'readLatency']);
  const writeLat = dbLat(['write_latency_ms', 'writeLatencyMs', 'writeLatency']);
  const backlog = dbLat(['backlog', 'queue_backlog', 'pendingWrites', 'pending_writes']);
  const pending = dbLat(['pending', 'pending_writes', 'pendingWrites']);
  const failed = dbLat(['failed', 'failedWrites', 'failed_writes', 'writeErrors', 'write_errors']);
  const lastOk = dbLat(['last_success', 'lastSuccess', 'lastSuccessfulWrite', 'lastWriteAt']);
  const lastFail = dbLat(['last_failure', 'lastFailure', 'lastError', 'lastFailedWrite']);
  // doc §36: composite health must expose underlying reasons
  const healthReasons = (
    Array.isArray(state?.engine?.health?.reasons) ? state.engine.health.reasons
    : Array.isArray(state?.healthReasons) ? state.healthReasons
    : []
  ) as unknown[];
  // doc §32: time-range filter over real snapshots
  const rangedHistory = useMemo(() => {
    const ms = RANGE_MS[range];
    if (ms == null) return history;
    const cut = Date.now() - ms;
    return history.filter((h: any) => {
      const t = Date.parse(h.updatedAt ?? h.ts ?? '');
      return Number.isFinite(t) && t >= cut;
    });
  }, [history, range]);
  const evFiltered = events.filter((ev: any) => {
    if (evSev !== 'all' && String(ev.severity ?? 'info').toLowerCase() !== evSev) return false;
    const qq = evQ.trim().toLowerCase();
    if (!qq) return true;
    return String(ev.message ?? '').toLowerCase().includes(qq) || String(ev.type ?? ev.event ?? '').toLowerCase().includes(qq);
  });

  if (loading && !state && !db) {
    return (
      <div className="space-y-4">
        <div className="h-28 animate-pulse rounded-2xl bg-muted/60" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted/60" />)}</div>
        <p className="py-1 text-center text-xs text-muted-foreground">Loading Storage & Database…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.12] via-primary/[0.06] to-emerald-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-indigo-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-emerald-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-primary to-emerald-500 text-white shadow-xl">
            <Database className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Storage & Database</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground sm:text-sm">
              {identity.database ?? '—'} · {identity.host ?? 'no host'} · {fmtBytes(storage.totalStorageBytes)} stored
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
            <Badge variant="outline" className={cn('tabular-nums', Number.isFinite(usePct) && usePct >= 90 ? 'border-rose-500/40 text-rose-300' : 'border-amber-500/30 text-amber-200')}>
              {Number.isFinite(usePct) ? `${usePct}% full` : 'usage —'}
            </Badge>
            {notice && <Badge variant="outline" className={notice.kind === 'ok' ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}>{notice.text}</Badge>}
            <button onClick={() => setAuto((v) => !v)} title="Auto-refresh 20s" className={cn('rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors', auto ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-border text-muted-foreground')}>
              {auto ? '● AUTO' : '○ AUTO OFF'}
            </button>
            <IstClock />
            <Button size="sm" onClick={() => void loadAll(false)} className="gap-1.5 bg-gradient-to-r from-indigo-500 to-emerald-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
        {/* capacity breadth bar */}
        <div className="relative h-2 w-full overflow-hidden bg-muted/60">
          {Number.isFinite(usePct) && (
            <span className={cn('block h-full bg-gradient-to-r transition-all', usePct >= 90 ? 'from-rose-500 to-rose-400' : usePct >= 70 ? 'from-amber-500 to-amber-400' : 'from-emerald-500 to-teal-400')} style={{ width: `${Math.min(100, usePct)}%` }} />
          )}
          {Number.isFinite(threshLine) && (
            <span className="absolute inset-y-0 w-0.5 bg-amber-300" style={{ left: `${Math.min(100, threshLine)}%` }} title={`auto-clean ${threshLine}%`} />
          )}
          {budgetLine != null && (
            <span className="absolute inset-y-0 w-0.5 bg-sky-300" style={{ left: `${Math.min(100, budgetLine)}%` }} title={`budget ${budgetMb}MB`} />
          )}
        </div>
      </div>

      {(error || dbError) && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <span className="min-w-0">{[error, dbError].filter(Boolean).join(' · ')}</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void loadAll(false)}>Retry</Button>
        </div>
      )}

      {/* doc §4: deployment environment — where the backend actually runs */}
      {envRows.length > 0 && (
        <Card className="overflow-hidden border-indigo-500/25 shadow-soft">
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-[11px]">
            <span className="font-bold uppercase tracking-wider text-muted-foreground">Backend runs on</span>
            {envRows.map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className="text-muted-foreground">{k}</span>
                <span className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-foreground" title={String(v)}>{String(v)}</span>
              </span>
            ))}
          </CardContent>
        </Card>
      )}

      {/* doc §36: composite health must expose underlying reasons, not one label */}
      {healthReasons.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-300">
          <span className="font-semibold">Health reasons: </span>
          {healthReasons.map(String).join(' · ')}
        </div>
      )}

      {/* DB IDENTITY — Atlas vs Local */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className={cn('overflow-hidden border shadow-soft lg:col-span-2', isAtlas ? 'border-sky-500/30' : 'border-emerald-500/30')}>
          <CardHeader className={cn('pb-2', isAtlas ? 'bg-gradient-to-r from-sky-500/15 to-blue-500/5' : 'bg-gradient-to-r from-emerald-500/15 to-teal-500/5')}>
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className={cn('rounded-lg p-1.5 text-white shadow', isAtlas ? 'bg-gradient-to-br from-sky-500 to-blue-600' : 'bg-gradient-to-br from-emerald-500 to-teal-600')}>
                {isAtlas ? <Cloud className="h-3.5 w-3.5" /> : <Server className="h-3.5 w-3.5" />}
              </span>
              {isAtlas ? 'Atlas Cloud' : source === 'unknown' ? 'Database' : 'Local Database'}
              <Badge variant="outline" className={cn('ml-auto font-mono', connected ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300')}>
                {connected ? 'CONNECTED' : 'DOWN'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-3 text-xs">
            {([
              ['Source', identity.sourceLabel ?? (db?.provider ?? `mongodb-${source}`)],
              ['Database', identity.database ?? storage.dbName ?? '—'],
              ['Host (no credentials)', identity.host ?? db?.host ?? '—'],
              ['Server version', identity.serverVersion ?? db?.serverVersion ?? '—'],
              ['Configured', identity.configured == null ? '—' : String(identity.configured)],
              ['Ping', storage.pingMs != null ? `${storage.pingMs} ms` : '—'],
            ] as [string, string][]).map(([k, v]) => (
              <p key={k} className="flex items-center justify-between gap-3 rounded-lg border-b border-border/40 px-2 py-1.5">
                <span className="shrink-0 text-muted-foreground">{k}</span>
                <span className="min-w-0 truncate text-right font-mono" title={v}>{v}</span>
              </p>
            ))}
            <p className="flex items-center justify-between gap-3 px-2 py-1.5">
              <span className="text-muted-foreground">Connected since</span>
              <AgeTicker ts={identity.connectedAt} />
            </p>
            {identity.error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-rose-300">{identity.error}</p>}
          </CardContent>
        </Card>

        {/* CAPACITY */}
        <Card className="overflow-hidden border-amber-500/25 shadow-soft lg:col-span-3">
          <CardHeader className="bg-gradient-to-r from-amber-500/10 to-orange-500/5 pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><HardDrive className="h-3.5 w-3.5" /></span>
              Capacity · used vs total
              <span className="ml-auto flex items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7 gap-1" disabled={busy != null} onClick={runCleanup}>
                  <Trash2 className="h-3 w-3" /> {busy === 'cleanup' ? 'Cleaning…' : 'Run cleanup'}
                </Button>
                <Button size="sm" variant="outline" className="h-7 gap-1" onClick={copySnapshot}>
                  {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-300" /> : <Copy className="h-3 w-3" />} {copied ? 'Copied' : 'Copy'}
                </Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 pt-3">
            <div className="flex items-end justify-between">
              <p className="font-mono text-2xl font-bold tabular-nums">
                {Number.isFinite(usedMb) ? `${usedMb} MB` : '—'}
                <span className="text-sm font-normal text-muted-foreground"> / {Number.isFinite(capMb) ? `${capMb} MB` : '—'}</span>
              </p>
              <p className={cn('font-mono text-xl font-bold tabular-nums', Number.isFinite(usePct) && usePct >= 90 ? 'text-rose-300' : Number.isFinite(usePct) && usePct >= 70 ? 'text-amber-300' : 'text-emerald-300')}>
                {Number.isFinite(usePct) ? `${usePct}%` : '—'}
              </p>
            </div>
            <div className="relative h-3 overflow-hidden rounded-full bg-muted/70">
              {Number.isFinite(usePct) && (
                <div className={cn('h-full rounded-full transition-all', usePct >= 90 ? 'bg-gradient-to-r from-rose-500 to-rose-400' : usePct >= 70 ? 'bg-gradient-to-r from-amber-500 to-amber-400' : 'bg-gradient-to-r from-emerald-500 to-teal-400')} style={{ width: `${Math.min(100, usePct)}%` }} />
              )}
              {Number.isFinite(threshLine) && <span className="absolute inset-y-0 w-0.5 bg-amber-300" style={{ left: `${Math.min(100, threshLine)}%` }} />}
              {budgetLine != null && <span className="absolute inset-y-0 w-0.5 bg-sky-300" style={{ left: `${Math.min(100, budgetLine)}%` }} />}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-300" /> auto-clean ≥ {Number.isFinite(threshLine) ? `${threshLine}%` : '—'}</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-300" /> budget {Number.isFinite(budgetMb) ? `${budgetMb} MB` : '—'}</span>
              <span>guard <span className="font-mono text-foreground">{guard?.enabled ? 'ON' : 'OFF'}</span></span>
              <span>reason <span className={cn('font-mono', guard?.overThreshold || guard?.overBudget ? 'text-amber-300' : 'text-emerald-300')}>{guard?.reason ?? '—'}</span></span>
              <span className="ml-auto">last auto-clean <AgeTicker ts={guard?.lastAutoCleanAt} /></span>
            </div>
            {(guard?.overBudget || guard?.overThreshold) && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
                {guard?.overThreshold ? `Threshold crossed (${usePct}% ≥ ${threshLine}%) — oldest regenerable candles auto-trim honge.` : `Over budget (${usedMb} MB > ${budgetMb} MB).`} Run cleanup se oldest days trim karo.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* TOTALS STRIP */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {([
          { label: 'Data size', v: fmtBytes(storage.totalSizeBytes), bar: 'bg-cyan-400' },
          { label: 'Storage (disk)', v: fmtBytes(storage.totalStorageBytes), bar: 'bg-violet-400' },
          { label: 'Indexes', v: fmtBytes(storage.totalIndexSizeBytes), bar: 'bg-amber-400' },
          { label: 'Documents', v: fmtNum(storage.totalObjects), bar: 'bg-emerald-400' },
          { label: 'Collections', v: fmtNum(storage.collectionsCount), bar: 'bg-sky-400' },
          { label: 'Index count', v: fmtNum(storage.indexesCount), bar: 'bg-fuchsia-400' },
        ] as const).map((k) => (
          <Card key={k.label} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-0.5">
            <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', k.bar)} />
            <CardContent className="p-3">
              <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.label}</p>
              <p className="truncate font-mono text-lg font-bold tabular-nums leading-7" title={k.v}>{k.v}</p>
              <p className="truncate text-[10px] text-muted-foreground">{storage.dbName ?? ''} · {storage.lastUpdatedAt ? 'live dbStats' : ''}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* doc §11/28: engine health table — diagnostic, real registry rows */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-purple-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 p-1.5 text-white shadow"><Zap className="h-3.5 w-3.5" /></span>
            Engines · health & heartbeat
            <Badge variant="outline" className="ml-auto tabular-nums">{Array.isArray(engineRows) ? fmtNum(engineRows.length) : '—'}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {!Array.isArray(engineRows) || engineRows.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">Engine list unavailable — backend ne koi registry row nahi bheji (missing, not zero).</p>
          ) : (
            <div className="max-h-[260px] overflow-auto rounded-xl border border-border/60">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-muted/80 text-muted-foreground backdrop-blur">
                  <tr><th className="px-2.5 py-1.5">Engine</th><th className="px-2.5 py-1.5">Status</th><th className="px-2.5 py-1.5 text-right">Uptime</th><th className="px-2.5 py-1.5">Heartbeat</th><th className="px-2.5 py-1.5">Version</th></tr>
                </thead>
                <tbody>
                  {engineRows.slice(0, 60).map((e: any, i: number) => {
                    const st = String(e.status ?? e.state ?? e.health ?? 'UNKNOWN');
                    return (
                      <tr key={e.engine_id ?? e.engineId ?? e.name ?? i} className="border-t border-border/40">
                        <td className="px-2.5 py-1.5 font-mono font-semibold">{e.engine_id ?? e.engineId ?? e.name ?? '—'}</td>
                        <td className="px-2.5 py-1.5">
                          <Badge variant="outline" className={cn('font-mono text-[10px]', st === 'RUNNING' ? 'border-emerald-500/40 text-emerald-300' : st === 'DEGRADED' ? 'border-amber-500/40 text-amber-300' : st === 'ERROR' || st === 'STOPPED' ? 'border-rose-500/40 text-rose-300' : '')}>{st}</Badge>
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{e.uptimeSeconds != null ? `${fmtNum(e.uptimeSeconds)}s` : e.uptime ?? '—'}</td>
                        <td className="px-2.5 py-1.5"><AgeTicker ts={e.lastHeartbeat ?? e.last_heartbeat ?? e.heartbeatAt} /></td>
                        <td className="px-2.5 py-1.5 font-mono text-muted-foreground">{e.version ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* doc §13/30: storage pipeline — latency, queue, backlog, last success/failure */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-sky-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-cyan-500 to-sky-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
            Storage pipeline · latency & backlog
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 pt-3 sm:grid-cols-4">
          {([
            ['Read latency', readLat != null ? `${readLat} ms` : '—'],
            ['Write latency', writeLat != null ? `${writeLat} ms` : '—'],
            ['Queue depth', database.queueDepth ?? backlog ?? '—'],
            ['Backlog', backlog ?? '—'],
            ['Pending writes', pending ?? '—'],
            ['Failed writes', failed ?? '—'],
            ['Last success', lastOk != null ? fmtTs(lastOk as string) : '—'],
            ['Last failure', lastFail != null ? String(lastFail) : '—'],
          ] as [string, string][]).map(([l, v]) => (
            <div key={l} className="rounded-xl border border-border/50 bg-white/[0.02] px-2.5 py-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
              <p className="truncate font-mono text-sm font-semibold tabular-nums" title={v}>{v}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* GROWTH TREND */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-indigo-500/10 to-cyan-500/10 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
            Growth trend · 14 days
            <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(trendPts.length)} points</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {!trendPts.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Trend still collecting — snapshots persist hote hi chart banega.</p>
          ) : (
            <div className="flex h-28 items-end gap-1">
              {trendPts.map((p, i) => (
                <div key={i} className="group relative flex-1 self-stretch" title={`${p.label}: ${p.bytes != null ? fmtBytes(p.bytes) : '—'}`}>
                  <div className="flex h-full items-end">
                    <div className="w-full rounded-t bg-gradient-to-t from-indigo-500/70 to-cyan-400/90 transition-all group-hover:from-indigo-400 group-hover:to-cyan-300" style={{ height: `${p.bytes != null ? Math.max(4, (p.bytes / maxTrend) * 100) : 2}%`, opacity: p.bytes != null ? 1 : 0.25 }} />
                  </div>
                  {i % Math.ceil(trendPts.length / 7) === 0 && (
                    <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 font-mono text-[8px] text-muted-foreground">{p.label.slice(5)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {!!trendPts.length && <div className="h-4" />}
        </CardContent>
      </Card>

      {/* COLLECTIONS */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-teal-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 p-1.5 text-white shadow"><Database className="h-3.5 w-3.5" /></span>
            Collections · real collStats
            <Badge variant="outline" className="tabular-nums">{fmtNum(collections.length)}</Badge>
            <span className="ml-auto flex items-center gap-1.5">
              <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
                {(['storage', 'count', 'name'] as const).map((s) => (
                  <button key={s} onClick={() => setSortBy(s)} className={cn('rounded-md px-2 py-1 text-[10px] font-semibold capitalize', sortBy === s ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground')}>{s === 'storage' ? 'Size' : s}</button>
                ))}
              </div>
              <span className="relative">
                <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-7 w-36 pl-7 text-[11px]" />
              </span>
              <Button size="sm" variant="outline" className="h-7 gap-1" onClick={exportCollections} disabled={!collections.length}>
                <Download className="h-3 w-3" /> CSV
              </Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {!collections.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{db ? (q ? `No match for "${q}".` : 'No collections reported.') : 'Database plane se judte hi collections dikhenge.'}</p>
          ) : (
            <div className="max-h-[380px] space-y-1 overflow-auto">
              {collections.slice(0, 100).map((c: any) => {
                const name = String(c.name);
                const locked = protectedSet.has(name);
                return (
                <div key={c.name} className={cn('rounded-lg border px-2.5 py-2', locked ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-border/50 bg-muted/[0.04]')} title={`${c.count ?? 0} docs · avg ${fmtBytes(c.avgObjSizeBytes)} · idx ${c.indexes ?? 0}`}>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {!locked && (
                        <input type="checkbox" checked={sel.has(name)} onChange={() => toggleSel(name)} title="Cleanup ke liye select" className="h-3.5 w-3.5 shrink-0 accent-rose-600" />
                      )}
                      {locked && <Lock className="h-3 w-3 shrink-0 text-amber-700" />}
                      <span className="truncate font-mono font-semibold">{c.name}</span>
                      {c.capped && <span className="rounded bg-amber-500/15 px-1 text-[9px] text-amber-700">CAPPED</span>}
                      {locked && <span className="rounded bg-amber-500/15 px-1 text-[9px] font-semibold text-amber-700">PROTECTED</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="font-mono tabular-nums">{fmtBytes(c.storageBytes)} <span className="text-muted-foreground">· {fmtNum(c.count)} docs</span></span>
                      <button onClick={() => void togglePreview(name)} title="Real documents dekho (latest 5)" className={cn('rounded-md border px-1.5 py-0.5 transition-colors', previewName === name ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700' : 'border-border hover:bg-muted')}>
                        {previewName === name ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </button>
                      {!locked && (
                        <button
                          onClick={() => {
                            if (armedRow !== name) { setArmedRow(name); return; }
                            void runClean({ mode: 'collection', names: [name], drop: docMode === 'drop' });
                          }}
                          disabled={!canClean || cleanBusy}
                          title="Is collection ka data clean (2-click confirm) — mode: Data cleanup card me set hota hai"
                          className={cn('rounded-md border px-1.5 py-0.5 transition-colors', armedRow === name ? 'border-rose-600 bg-rose-600 text-white' : 'border-border text-rose-700 hover:bg-rose-500/10')}
                        >
                          {armedRow === name ? <span className="text-[9px] font-bold">Confirm?</span> : <Trash2 className="h-3 w-3" />}
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted/70">
                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400" style={{ width: `${(Number(c.storageBytes ?? 0) / maxColl) * 100}%` }} />
                  </div>
                  <p className="mt-0.5 flex justify-between font-mono text-[10px] text-muted-foreground">
                    <span>data {fmtBytes(c.dataSizeBytes)} · idx {fmtBytes(c.indexSizeBytes)} ({c.indexes ?? 0})</span>
                    <span>{c.firstRecord ? `${String(c.firstRecord).slice(0, 10)} → ${String(c.lastRecord ?? '').slice(0, 10)}` : ''}</span>
                  </p>
                  {previewName === name && (
                    <div className="mt-1.5 rounded-lg border border-border bg-muted/30 p-2">
                      <p className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Real documents · latest {fmtNum(previewData?.length ?? 0)}
                        {previewBusy && <RefreshCw className="h-3 w-3 animate-spin" />}
                        <button onClick={() => setPreviewName(null)} className="ml-auto rounded px-1 hover:bg-muted">✕ close</button>
                      </p>
                      {previewErr ? (
                        <p className="text-[10px] text-rose-700">{previewErr}</p>
                      ) : previewData && previewData.length === 0 ? (
                        <p className="py-1 text-center text-[10px] text-muted-foreground">Collection empty — 0 documents.</p>
                      ) : (
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-1.5 font-mono text-[10px] leading-relaxed text-foreground">{previewData ? JSON.stringify(previewData, null, 1) : 'loading…'}</pre>
                      )}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* REAL DATA CLEANUP — atlas_cleanup authority, chalta hai jis DB se backend juda ho */}
      <Card className="overflow-hidden border-rose-500/25 shadow-soft">
        <CardHeader className="bg-gradient-to-r from-rose-500/10 to-amber-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-rose-500 to-amber-600 p-1.5 text-white shadow"><ShieldAlert className="h-3.5 w-3.5" /></span>
            Data cleanup · REAL deletion (verified)
            <Badge variant="outline" className="ml-auto tabular-nums">
              last run <AgeTicker ts={lastClean?.finishedAt ?? lastClean?.ts} /> · <span className="font-mono">{String(lastClean?.status ?? '—')}</span>
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed">
            Jis database par chalega: <span className="font-mono font-semibold">{identity.source ?? '—'}{isAtlas ? ' (Atlas cloud)' : ''} · {identity.host ?? '—'} · db {identity.database ?? '—'}</span> — backend jis se abhi juda hai wahi clean hota hai (Atlas cloud, ya local/VM-local mongo). Har pass ka audit <span className="font-mono">atlas_cleanup_log</span> me likha jata hai. Protected config/operational collections (settings, stocks, watchlist, session_manager_*, dummy_*, _migrations…) delete kabhi nahi hote.
          </p>
          {!canClean && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700">
              {connected ? 'Cleanup plan abhi load nahi hua — thoda rukkab refresh karo.' : 'Database connected nahi — cleanup disabled jab tak wapas judi.'}
            </p>
          )}
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
            {/* SAFE */}
            <div className="rounded-xl border border-border/60 bg-background p-2.5">
              <p className="text-[11px] font-bold">Safe clean</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">Temporary market data + telemetry (roz 06:00 IST jise wipe hota hai). Indexes/config safe.</p>
              <Button size="sm" variant="outline" className="mt-2 h-7 w-full gap-1 border-amber-500/40 text-amber-700" disabled={!canClean || cleanBusy}
                onClick={() => (armed === 'safe' ? void runClean({ mode: 'safe' }) : setArmed('safe'))}>
                <Trash2 className="h-3 w-3" /> {armed === 'safe' ? 'Confirm Safe clean?' : 'Run Safe clean'}
              </Button>
            </div>
            {/* FULL */}
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/[0.05] p-2.5">
              <p className="text-[11px] font-bold text-rose-700">Full clean</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">Safe + ticks history, notifications, alerts, events, reports. Config/operational kabhi nahi.</p>
              <Input value={fullPhrase} onChange={(e) => setFullPhrase(e.target.value.toUpperCase())} placeholder="Type CLEAN" className="mt-2 h-7 border-rose-500/40 text-center font-mono text-[11px]" />
              <Button size="sm" variant="destructive" className="mt-1.5 h-7 w-full gap-1" disabled={!canClean || cleanBusy || fullPhrase !== 'CLEAN'}
                onClick={() => { void runClean({ mode: 'full' }); setFullPhrase(''); }}>
                <Trash2 className="h-3 w-3" /> {cleanBusy ? 'Cleaning…' : 'Execute Full clean'}
              </Button>
            </div>
            {/* SELECTED */}
            <div className={cn('rounded-xl border bg-background p-2.5', docMode === 'drop' ? 'border-rose-500/40' : 'border-border/60')}>
              <p className="text-[11px] font-bold">Selected collections</p>
              <div className="mt-1 flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 p-0.5">
                {([['clear', 'Clear docs'], ['drop', 'DROP whole']] as const).map(([m, l]) => (
                  <button key={m} onClick={() => { setDocMode(m); setArmed(null); }} disabled={cleanBusy}
                    className={cn('flex-1 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors', docMode === m ? (m === 'drop' ? 'bg-rose-600 text-white shadow-sm' : 'bg-background shadow-sm ring-1 ring-border') : 'text-muted-foreground')}>
                    {l}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                {sel.size ? <span className="font-semibold text-foreground">{fmtNum(sel.size)} selected</span> : 'Collections card me checkbox se select karo.'}{' '}
                {docMode === 'drop' && 'Drop = poora collection (docs+index+allocated storage wapas). 0-doc ticks/market_ticks jaisi space reclaim isi se hoti hai.'}
              </p>
              {!sel.size && canClean && (
                <Button size="sm" variant="outline" className="mt-1 h-6 gap-1 text-[10px]" onClick={selectAllCleanable}>
                  Select all cleanable ({fmtNum(collections.filter((c) => !protectedSet.has(String(c.name))).length)})
                </Button>
              )}
              <Button size="sm" variant="destructive" className="mt-1.5 h-7 w-full gap-1" disabled={!canClean || cleanBusy || !sel.size}
                onClick={() => { if (armed !== 'bulk') { setArmed('bulk'); return; } void runClean({ mode: 'collection', names: [...sel], drop: docMode === 'drop' }); }}>
                <Trash2 className="h-3 w-3" />
                {cleanBusy ? 'Cleaning…' : armed === 'bulk' ? `Confirm ${docMode === 'drop' ? 'DROP' : 'Clean'} of ${fmtNum(sel.size)}?` : `${docMode === 'drop' ? 'DROP' : 'Clean'} selected (${fmtNum(sel.size)})`}
              </Button>
            </div>
          </div>
          {/* result banner — REAL post-state verification (drop → gone, clear → remaining 0) */}
          {cleanResult && (
            <div className={cn('rounded-xl border px-3 py-2.5 text-[11px]', cleanResult.ok ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-rose-500/30 bg-rose-500/10')}>
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {cleanResult.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <ShieldAlert className="h-3.5 w-3.5 text-rose-600" />}
                <span>{cleanResult.ok ? `${String(cleanResult.status ?? 'SUCCESS')} · verified` : 'FAILED / refused'}</span>
                <span className="font-mono text-muted-foreground">{cleanResult.mode ?? '—'} · trigger {cleanResult.trigger ?? '—'} · {fmtNum(cleanResult.totalDeleted ?? 0)} docs · {fmtNum(cleanResult.collectionsCleaned ?? 0)} cols · {cleanResult.durationSec ?? '—'}s</span>
              </p>
              {cleanResult.error && <p className="mt-1 text-rose-700">{String(cleanResult.error)}</p>}
              {Array.isArray(cleanResult.refused) && cleanResult.refused.length > 0 && (
                <p className="mt-1 text-amber-700">Refused (protected): {cleanResult.refused.map(String).join(' · ')}</p>
              )}
              {Array.isArray(cleanResult.collections) && cleanResult.collections.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(cleanResult.collections as any[]).slice(0, 40).map((r: any) => {
                    const v = (Array.isArray(cleanResult.verified) ? cleanResult.verified : []).find((x: any) => x.name === r.name);
                    return (
                      <span key={r.name} className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px]', r.error ? 'border-rose-500/40 text-rose-700' : 'border-emerald-500/40 text-emerald-700')}>
                        {r.name} · {r.skipped ? 'skipped' : r.dropped ? 'dropped' : `deleted ${fmtNum(r.deleted ?? 0)}`}
                        {v && v.gone != null ? (v.gone ? ' · gone ✓' : ' · STILL THERE ✗') : v ? ` · remaining ${fmtNum(v.remaining)}` : ''}
                        {r.error ? ` · ${String(r.error).slice(0, 60)}` : ''}
                      </span>
                    );
                  })}
                </div>
              )}
              <p className="mt-1 text-[10px] text-muted-foreground">Verification live counts se aayi hai (drop → collection gone, clear → remaining 0) — list refresh ho chuki si. Audit atlas_cleanup_log me hai.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* HOST + ENGINE */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-sky-500/10 to-blue-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 p-1.5 text-white shadow"><Server className="h-3.5 w-3.5" /></span>
              Host · runtime
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3">
            {(['cpu', 'memory', 'disk'] as const).map((k) => {
              const u = Number(hostname[k]?.usagePct ?? 0);
              return (
                <div key={k}>
                  <div className="flex justify-between text-[11px]"><span className="font-semibold uppercase text-muted-foreground">{k}</span><span className="font-mono tabular-nums">{u.toFixed(1)}%</span></div>
                  <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-muted/70">
                    <div className={cn('h-full rounded-full', u > 90 ? 'bg-rose-400' : u > 70 ? 'bg-amber-400' : 'bg-emerald-400')} style={{ width: `${Math.min(100, u)}%` }} />
                  </div>
                </div>
              );
            })}
            <div className="grid grid-cols-2 gap-2 pt-1 text-[11px]">
              <p className="rounded-lg border border-border/50 px-2 py-1.5"><Network className="mr-1 inline h-3 w-3" /> rx {fmtBytes(hostname.network?.rxBytes)} · tx {fmtBytes(hostname.network?.txBytes)}</p>
              <p className="rounded-lg border border-border/50 px-2 py-1.5 font-mono">load {hostname.load?.avg1 ?? '—'} / {hostname.load?.avg5 ?? '—'} / {hostname.load?.avg15 ?? '—'}</p>
              <p className="rounded-lg border border-border/50 px-2 py-1.5">threads <span className="font-mono">{fmtNum(runtime.threads)}</span></p>
              <p className="rounded-lg border border-border/50 px-2 py-1.5">uptime <span className="font-mono">{fmtNum(runtime.uptimeSeconds)}s</span></p>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <Badge variant="outline">pool ready {fmtNum(db?.pool?.ready)}</Badge>
              <Badge variant="outline">created {fmtNum(db?.pool?.created)}</Badge>
              <Badge variant="outline">closed {fmtNum(db?.pool?.closed)}</Badge>
              <Badge variant="outline" className={cn(Number(db?.pool?.checkout_failed) > 0 && 'border-rose-500/40 text-rose-300')}>checkout-fail {fmtNum(db?.pool?.checkout_failed)}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-amber-500/10 to-orange-500/5 pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><Settings2 className="h-3.5 w-3.5" /></span>
              Engine config · save + snapshot
              <span className="ml-auto flex items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7 gap-1" disabled={busy != null} onClick={forceSnapshot}>
                  <Zap className="h-3 w-3" /> {busy === 'snapshot' ? 'Sampling…' : 'Sample now'}
                </Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.target as HTMLFormElement);
                const updates: any = {};
                for (const [key, val] of fd.entries()) {
                  if (key === 'sampleIntervalSeconds') updates.sampleIntervalSeconds = parseInt(val as string);
                  else if (key === 'cpuWarnPct') updates.cpuWarnPct = parseFloat(val as string);
                  else if (key === 'cpuCritPct') updates.cpuCritPct = parseFloat(val as string);
                  else if (key === 'monitoringEnabled') updates.monitoringEnabled = val === 'true';
                }
                void handleSave(updates);
              }}
              className="grid grid-cols-2 gap-2"
            >
              <label className="text-[11px] text-muted-foreground">Sample interval (s)
                <input type="number" name="sampleIntervalSeconds" defaultValue={config?.sampleIntervalSeconds ?? 10} min={1} step={1} className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs" />
              </label>
              <label className="text-[11px] text-muted-foreground">CPU warn %
                <input type="number" name="cpuWarnPct" defaultValue={config?.cpuWarnPct ?? 70} min={0} max={100} step={1} className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs" />
              </label>
              <label className="text-[11px] text-muted-foreground">CPU crit %
                <input type="number" name="cpuCritPct" defaultValue={config?.cpuCritPct ?? 90} min={0} max={100} step={1} className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs" />
              </label>
              <label className="text-[11px] text-muted-foreground">Monitoring
                <select name="monitoringEnabled" defaultValue={String(config?.monitoringEnabled !== false)} className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs">
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <div className="col-span-2 flex items-center gap-2">
                <Button type="submit" disabled={saving} size="sm" className="gap-1.5 bg-gradient-to-r from-amber-500 to-orange-600">
                  <Save className="h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Save Configuration'}
                </Button>
                <span className="text-[11px] text-muted-foreground">DB queue {fmtNum(database.queueDepth)} · {database.status ?? '—'}</span>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* doc §32: history with time ranges + charts (real snapshots only) */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <MemoryStick className="h-3.5 w-3.5" /> Snapshots · CPU/Mem/Disk
            <Badge variant="outline" className="tabular-nums">{fmtNum(rangedHistory.length)}</Badge>
            <span className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
              {(['5m', '15m', '1h', '6h', '24h', 'all'] as const).map((r) => (
                <button key={r} onClick={() => setRange(r)} className={cn('rounded-md px-2 py-1 font-mono text-[10px] font-semibold', range === r ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground')}>{r}</button>
              ))}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 pt-3">
          {!rangedHistory.length ? <p className="py-4 text-center text-xs text-muted-foreground">{history.length ? `Is range (${range}) me koi snapshot nahi.` : 'No snapshots yet — 10s sampling pe record honge.'}</p> : (
            <>
              {(['cpu', 'memory', 'disk'] as const).map((k, ki) => {
                const vals = rangedHistory.slice(-60).map((h: any) => Number(h.host?.[k]?.usagePct ?? 0));
                const colors = ['bg-sky-400', 'bg-violet-400', 'bg-amber-400'];
                return (
                  <div key={k}>
                    <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k}</p>
                    <div className="flex h-8 items-end gap-[2px]">
                      {vals.map((v, i) => (
                        <div key={i} className={cn('min-w-[2px] flex-1 rounded-t', colors[ki])} style={{ height: `${Math.max(4, Math.min(100, v))}%`, opacity: 0.55 + (v / 200) }} title={`${v.toFixed(1)}%`} />
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="max-h-56 overflow-auto rounded-xl border border-border/60">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-muted/80 text-muted-foreground backdrop-blur">
                    <tr><th className="px-2.5 py-1.5">Time</th><th className="px-2.5 py-1.5 text-right">CPU</th><th className="px-2.5 py-1.5 text-right">Mem</th><th className="px-2.5 py-1.5 text-right">Disk</th></tr>
                  </thead>
                  <tbody>
                    {rangedHistory.slice(0, 50).map((h: any, i: number) => (
                      <tr key={i} className="border-t border-border/40">
                        <td className="px-2.5 py-1 font-mono tabular-nums">{new Date(h.updatedAt ?? Date.now()).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</td>
                        <td className="px-2.5 py-1 text-right font-mono tabular-nums">{Number(h.host?.cpu?.usagePct ?? 0).toFixed(1)}%</td>
                        <td className="px-2.5 py-1 text-right font-mono tabular-nums">{Number(h.host?.memory?.usagePct ?? 0).toFixed(1)}%</td>
                        <td className="px-2.5 py-1 text-right font-mono tabular-nums">{Number(h.host?.disk?.usagePct ?? 0).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* doc §33: events searchable + filterable timeline */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <Activity className="h-3.5 w-3.5" /> Events · searchable timeline
            <Badge variant="outline" className="tabular-nums">{fmtNum(evFiltered.length)}/{fmtNum(events.length)}</Badge>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
                {(['all', 'high', 'warn', 'info'] as const).map((s) => (
                  <button key={s} onClick={() => setEvSev(s)} className={cn('rounded-md px-2 py-1 text-[10px] font-semibold capitalize', evSev === s ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground')}>{s}</button>
                ))}
              </span>
              <span className="relative">
                <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input value={evQ} onChange={(e) => setEvQ(e.target.value)} placeholder="Search events…" className="h-7 w-40 pl-7 text-[11px]" />
              </span>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {!evFiltered.length ? <p className="py-4 text-center text-xs text-muted-foreground">{events.length ? `No match for "${evQ}".` : 'No storage events recorded yet.'}</p> : (
            <ul className="max-h-64 space-y-1 overflow-auto">
              {evFiltered.slice(0, 50).map((ev: any, i: number) => (
                <li key={i} className="flex items-start gap-2 rounded-lg border border-border/50 px-2.5 py-1.5 text-xs">
                  <HeartPulse className={cn('mt-0.5 h-3 w-3 shrink-0', String(ev.severity ?? '').toLowerCase() === 'high' ? 'text-rose-400' : String(ev.severity ?? '').toLowerCase() === 'warn' ? 'text-amber-400' : 'text-emerald-400')} />
                  <span className="min-w-0 flex-1 text-muted-foreground">{ev.message ?? 'untitled'}</span>
                  {ev.ts && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtTs(ev.ts)}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Sources: <span className="font-mono">/data-center/database · /system/cleanup/plan · /system/cleanup/run · /system/cleanup/status · /database/sample · /cleanup/storage · /data-center/storage-trend · /services/storage</span> — sab real dbStats/collStats, cleanup verification live counts se, capacity configured quota se (driver quota report nahi karta). Auto-refresh 20s (hidden paused). Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
