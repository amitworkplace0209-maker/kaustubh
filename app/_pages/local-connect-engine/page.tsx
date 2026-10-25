'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShieldCheck,
  RefreshCw,
  Server,
  KeyRound,
  Database,
  Activity,
  Wifi,
  Cpu,
  Lock,
  Unlock,
  Zap,
  Globe,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Play,
  Pause,
  Copy,
  Settings as SettingsIcon,
  Terminal,
} from 'lucide-react';
import {
  getAiEndpoint,
  setAiEndpoint,
  getAiToken,
  setAiToken,
  normalizeAiEndpoint,
} from '@/lib/ai-endpoint';
import {
  localAiHealth,
  localAiStatus,
  localAiProvidersCached,
  localAiModels,
} from '@/lib/local-ai';
import type { LocalAiSnapshot, LocalAiHealth } from '@/lib/local-ai';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Local Connect Engine — glassmorphism redesign.
 *
 * Auto-detects the local app (backend port 8000 / AI bridge port 8001),
 * authenticates, and creates a safe permissioned bridge. Real data only:
 * backend reachability, probe results, and bridge state are all live checks.
 * Nothing is fabricated — unreachable targets render '—' honestly.
 */

const PERM_KEY = 'kaustubh.local-connect.permissions';
const BRIDGE_KEY = 'kaustubh.local-connect.bridge';

interface Permissions {
  readStatus: boolean;
  readModels: boolean;
  runChat: boolean;
  runAnalyze: boolean;
  brokerDummy: boolean;
  brokerKotak: boolean;
  brokerShoonya: boolean;
  orderPlace: boolean;
  orderCancel: boolean;
  orderModify: boolean;
  websocketFeed: boolean;
  websocketControl: boolean;
  connectionManagerRead: boolean;
  connectionManagerControl: boolean;
  databaseRead: boolean;
  dataDownload: boolean;
  dataExport: boolean;
  marketDataRead: boolean;
  suggestionsRead: boolean;
  suggestionsRun: boolean;
  schedulerRead: boolean;
  schedulerControl: boolean;
  systemConfig: boolean;
  backendHealth: boolean;
  backendSystem: boolean;
  backendEngines: boolean;
  backendMarketData: boolean;
}

const DEFAULT_PERMS: Permissions = {
  readStatus: true,
  readModels: true,
  runChat: false,
  runAnalyze: false,
  brokerDummy: true,
  brokerKotak: false,
  brokerShoonya: false,
  orderPlace: false,
  orderCancel: false,
  orderModify: false,
  websocketFeed: true,
  websocketControl: false,
  connectionManagerRead: true,
  connectionManagerControl: false,
  databaseRead: true,
  dataDownload: true,
  dataExport: false,
  marketDataRead: true,
  suggestionsRead: true,
  suggestionsRun: false,
  schedulerRead: true,
  schedulerControl: false,
  systemConfig: false,
  backendHealth: true,
  backendSystem: true,
  backendEngines: true,
  backendMarketData: true,
};

const PERM_GROUPS: { title: string; icon: React.ElementType; items: [keyof Permissions, string][] }[] = [
  { title: 'Local AI bridge', icon: Activity, items: [['readStatus', 'Read status'], ['readModels', 'Read models'], ['runChat', 'Run chat'], ['runAnalyze', 'Run analyze']] },
  { title: 'Broker terminals', icon: Terminal, items: [['brokerDummy', 'Dummy terminal'], ['brokerKotak', 'Kotak Neo'], ['brokerShoonya', 'Shoonya']] },
  { title: 'Order engine', icon: Zap, items: [['orderPlace', 'Place orders'], ['orderCancel', 'Cancel orders'], ['orderModify', 'Modify orders']] },
  { title: 'Realtime / WebSocket', icon: Wifi, items: [['websocketFeed', 'Live feed read'], ['websocketControl', 'WebSocket control']] },
  { title: 'Connection manager', icon: Terminal, items: [['connectionManagerRead', 'Read connections'], ['connectionManagerControl', 'Control connections']] },
  { title: 'Data / database', icon: Database, items: [['databaseRead', 'Database read'], ['dataDownload', 'Data download'], ['dataExport', 'Data export']] },
  { title: 'Market data', icon: Activity, items: [['marketDataRead', 'Market data read']] },
  { title: 'Suggestions', icon: Zap, items: [['suggestionsRead', 'Read suggestions'], ['suggestionsRun', 'Run suggestions']] },
  { title: 'System / scheduler', icon: Cpu, items: [['schedulerRead', 'Scheduler read'], ['schedulerControl', 'Scheduler control'], ['systemConfig', 'System config']] },
  { title: 'Backend (local app)', icon: Server, items: [['backendHealth', 'Backend health'], ['backendSystem', 'System status'], ['backendEngines', 'Engine list'], ['backendMarketData', 'Market data']] },
];

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${checked ? 'bg-primary' : 'bg-muted'}`}
      aria-pressed={checked}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Badge variant="outline" className="tabular-nums">
      IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}
    </Badge>
  );
}

function StatPill({ icon: Icon, label, value, sub, tone = 'info' }: {
  icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}) {
  const tones: Record<string, string> = {
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    danger: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
    info: 'border-primary/40 bg-primary/10 text-primary',
    neutral: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <Card className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-1 ${tones[tone]}`} />
      <CardContent className="flex items-center gap-3 p-3.5">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className={cn('truncate font-mono text-lg font-bold tabular-nums leading-7', tones[tone])} title={String(value)}>
            {value}
          </p>
          {sub && <p className="truncate text-[11px] text-muted-foreground" title={String(sub)}>{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function LocalConnectEnginePage() {
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<LocalAiHealth | null>(null);
  const [snapshot, setSnapshot] = useState<LocalAiSnapshot | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [perms, setPerms] = useState<Permissions>(DEFAULT_PERMS);

  const [detectedBackend, setDetectedBackend] = useState<string | null>(null);
  const [detectedBridge, setDetectedBridge] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  const [backendHealth, setBackendHealth] = useState<any>(null);
  const [backendSystem, setBackendSystem] = useState<any>(null);
  const [backendEngines, setBackendEngines] = useState<any>(null);

  const [bridgeId, setBridgeId] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<string>('not created');

  const [backendToken, setBackendToken] = useState<string | null>(null);
  const [backendAuthMsg, setBackendAuthMsg] = useState<string | null>(null);
  const [backendDiscover, setBackendDiscover] = useState<any>(null);

  useEffect(() => {
    setEndpoint(getAiEndpoint());
    setToken(getAiToken());
    try {
      const raw = window.localStorage.getItem(PERM_KEY);
      if (raw) setPerms({ ...DEFAULT_PERMS, ...JSON.parse(raw) });
    } catch { /* ignore */ }
    try {
      const raw = window.localStorage.getItem(BRIDGE_KEY);
      if (raw) {
        const b = JSON.parse(raw);
        setBridgeId(b.id || null);
        setBridgeStatus(b.id ? 'active' : 'not created');
      }
    } catch { /* ignore */ }
    try {
      const t = window.localStorage.getItem('kaustubh.local-connect.backendToken');
      if (t) setBackendToken(t);
    } catch { /* ignore */ }
  }, []);

  const persistPerms = (next: Permissions) => {
    setPerms(next);
    try {
      window.localStorage.setItem(PERM_KEY, JSON.stringify(next));
    } catch { /* ignore */ }
  };

  const autoDetect = useCallback(async () => {
    setDetecting(true);
    setError(null);
    const backendCandidates = ['http://127.0.0.1:8000', 'http://localhost:8000'];
    let foundBackend: string | null = null;
    for (const c of backendCandidates) {
      try {
        const res = await fetch(`${c}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) });
        if (res.ok) { foundBackend = c; break; }
      } catch { /* try next */ }
    }
    setDetectedBackend(foundBackend);

    const bridgeCandidates = ['http://127.0.0.1:8001', 'http://localhost:8001'];
    let foundBridge: string | null = null;
    for (const c of bridgeCandidates) {
      try {
        const res = await fetch(`${c}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) });
        if (res.ok) { foundBridge = c; break; }
      } catch { /* try next */ }
    }
    setDetectedBridge(foundBridge);
    if (foundBridge && !endpoint) setEndpoint(foundBridge);
    setDetecting(false);
  }, [endpoint]);

  useEffect(() => { void autoDetect(); }, [autoDetect]);

  const saveConnection = () => {
    const normalized = normalizeAiEndpoint(endpoint);
    if (!normalized) { setError('Enter a valid http:// or https:// endpoint'); return; }
    setAiEndpoint(normalized);
    setAiToken(token);
    setEndpoint(normalized);
    setSavedMsg('Connection settings saved on this device.');
    setError(null);
  };

  const probe = async () => {
    setLoading(true); setError(null);
    try {
      const h = await localAiHealth();
      setHealth(h);
      const s = await localAiStatus();
      setSnapshot(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHealth(null); setSnapshot(null);
    } finally { setLoading(false); }
  };

  const fetchProviders = async () => {
    if (!perms.readStatus) { setError('Permission "Read status" is disabled.'); return; }
    setLoading(true); setError(null);
    try {
      const s = await localAiProvidersCached();
      setSnapshot(s);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const fetchModels = async () => {
    if (!perms.readModels) { setError('Permission "Read models" is disabled.'); return; }
    setLoading(true); setError(null);
    try {
      const r = await localAiModels();
      setModels((r.models || []).map((m) => `${m.providerLabel || m.provider || '?'} · ${m.id}`));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const fetchBackend = async () => {
    if (!perms.backendHealth && !perms.backendSystem && !perms.backendEngines) { setError('Backend permissions are disabled.'); return; }
    setLoading(true); setError(null);
    try {
      const headers: Record<string, string> = {};
      if (backendToken) headers['X-Local-Connect-Token'] = backendToken;
      const base = detectedBackend || '';
      if (perms.backendHealth) { const r = await fetch(base ? `${base}/health` : '/health', { headers }); if (r.ok) setBackendHealth(await r.json()); }
      if (perms.backendSystem) { const r = await fetch(base ? `${base}/api/system` : '/api/system', { headers }); if (r.ok) setBackendSystem(await r.json()); }
      if (perms.backendEngines) { const r = await fetch(base ? `${base}/api/services/engines` : '/api/services/engines', { headers }); if (r.ok) setBackendEngines(await r.json()); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const createBridge = () => {
    const id = `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const record = { id, secret, createdAt: new Date().toISOString(), backend: detectedBackend, bridge: detectedBridge || endpoint, permissions: perms };
    try { window.localStorage.setItem(BRIDGE_KEY, JSON.stringify(record)); } catch { /* ignore */ }
    setBridgeId(id);
    setBridgeStatus('active');
    setSavedMsg('Safe bridge created and stored on this device.');
  };

  const revokeBridge = () => {
    try { window.localStorage.removeItem(BRIDGE_KEY); } catch { /* ignore */ }
    setBridgeId(null);
    setBridgeStatus('revoked');
    setSavedMsg('Bridge revoked.');
  };

  const discoverBackend = async () => {
    if (!detectedBackend) { setBackendAuthMsg('Backend not detected.'); return; }
    try {
      const r = await fetch(`${detectedBackend}/api/local-connect/discover`);
      if (!r.ok) throw new Error(`discover failed (${r.status})`);
      setBackendDiscover(await r.json());
      setBackendAuthMsg('Backend discovered.');
    } catch (e) { setBackendAuthMsg(e instanceof Error ? e.message : String(e)); }
  };

  const handshakeBackend = async () => {
    if (!detectedBackend) { setBackendAuthMsg('Backend not detected.'); return; }
    try {
      const r = await fetch(`${detectedBackend}/api/local-connect/handshake`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: `device-${navigator.userAgent.slice(0, 40)}`, bridge_id: bridgeId, permissions: perms }),
      });
      if (!r.ok) throw new Error(`handshake failed (${r.status})`);
      const data = await r.json();
      const token = data?.data?.session_token;
      if (!token) throw new Error('no session token returned');
      try { window.localStorage.setItem('kaustubh.local-connect.backendToken', token); } catch { /* ignore */ }
      setBackendToken(token);
      setBackendAuthMsg('Authenticated with local backend. Safe bridge active.');
    } catch (e) { setBackendAuthMsg(e instanceof Error ? e.message : String(e)); }
  };

  const revokeBackend = async () => {
    setBackendToken(null);
    try { window.localStorage.removeItem('kaustubh.local-connect.backendToken'); } catch { /* ignore */ }
    if (!detectedBackend || !backendToken) { setBackendAuthMsg('Local backend session cleared.'); return; }
    try { await fetch(`${detectedBackend}/api/local-connect/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_token: backendToken }) }); } catch { /* ignore */ }
    setBackendAuthMsg('Local backend session revoked.');
  };

  return (
    <div className="space-y-4 pb-6 p-4 sm:p-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.12] via-primary/[0.07] to-emerald-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-violet-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-emerald-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-primary to-emerald-500 text-white shadow-xl">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Local Connect Engine</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground sm:text-sm">
              Auto-detects the local app, authenticates, and creates a safe permissioned bridge · live backend state
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="tabular-nums">backend {detectedBackend ?? '—'}</Badge>
            <Badge variant="outline" className="tabular-nums">bridge {detectedBridge ?? '—'}</Badge>
            <IstClock />
            <Button size="sm" onClick={autoDetect} disabled={detecting} className="gap-1.5 bg-gradient-to-r from-primary to-violet-500 shadow-md">
              <RefreshCw className={`h-3.5 w-3.5 ${detecting ? 'animate-spin' : ''}`} /> Auto-detect
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      )}
      {savedMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="min-w-0">{savedMsg}</span>
        </div>
      )}

      {/* DETECTION */}
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Server className="h-3.5 w-3.5" /> Local backend (port 8000)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="flex items-center gap-2 text-xs">
              {detectedBackend ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  <span className="text-success font-mono">{detectedBackend}</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-destructive" />
                  <span className="text-destructive">Not detected</span>
                </>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Globe className="h-3.5 w-3.5" /> Local AI bridge (port 8001)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="flex items-center gap-2 text-xs">
              {detectedBridge ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  <span className="text-success font-mono">{detectedBridge}</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-destructive" />
                  <span className="text-destructive">Not detected</span>
                </>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Lock className="h-3.5 w-3.5" /> Local backend authentication
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="text-xs space-y-1">
              <div>Discovered: {backendDiscover ? 'yes' : 'no'}</div>
              <div>Session: {backendToken ? 'authenticated' : 'not authenticated'}</div>
            </div>
            {backendAuthMsg && <p className="mt-1 text-xs text-muted-foreground">{backendAuthMsg}</p>}
            <div className="flex gap-2 flex-wrap mt-3">
              <button onClick={discoverBackend} className="rounded-lg border border-border px-3 py-2 text-xs">Discover</button>
              <button onClick={handshakeBackend} disabled={!detectedBackend} className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">Authenticate</button>
              <button onClick={revokeBackend} className="rounded-lg border border-border px-3 py-2 text-xs">Revoke session</button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* CONNECTION SETTINGS */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="overflow-hidden shadow-soft lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <KeyRound className="h-3.5 w-3.5" /> Bridge connection
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Endpoint</label>
                <input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  placeholder="http://127.0.0.1:8001"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Token (optional)</label>
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  type="password"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  placeholder="X-Khumbha-AI-Token"
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={saveConnection} className="flex-1 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">Save</button>
              <button onClick={probe} disabled={loading} className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs">
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Probe
              </button>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Lock className="h-3.5 w-3.5" /> Safe bridge
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            <div className="text-xs space-y-1">
              <div>Status: <span className={bridgeStatus === 'active' ? 'text-success' : 'text-muted-foreground'}>{bridgeStatus}</span></div>
              {bridgeId && <div className="font-mono break-all">ID: {bridgeId}</div>}
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={createBridge} className="flex-1 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">
                <Zap className="h-3 w-3" /> Create bridge
              </button>
              <button onClick={revokeBridge} className="rounded-lg border border-border px-3 py-2 text-xs">
                <Unlock className="h-3 w-3" /> Revoke
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground pt-1">
              Bridge secret is generated on this device and stored locally. Revoke anytime.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* PERMISSIONS */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <ShieldCheck className="h-3.5 w-3.5" /> Permissions (on/off)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {PERM_GROUPS.map((group) => (
              <div key={group.title} className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <group.icon className="h-4 w-4" /> {group.title}
                </div>
                {group.items.map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between text-sm">
                    <span>{label}</span>
                    <Toggle checked={perms[key]} onChange={(v) => persistPerms({ ...perms, [key]: v })} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* DATA FETCH */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="overflow-hidden shadow-soft lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Activity className="h-3.5 w-3.5" /> Bridge status
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            {health ? (
              <div className="text-xs space-y-1">
                <div>Service: {health.service}</div>
                <div>Version: {health.bridgeVersion}</div>
                <div>Uptime: {health.uptimeSec}s</div>
                <div>Providers: {health.localAi.providersReachable}/{health.localAi.providers}</div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Probe to load bridge status.</p>
            )}
            {snapshot && (
              <div className="text-xs text-muted-foreground pt-1">
                Defaults: {snapshot.defaults?.provider} · {snapshot.defaults?.model}
              </div>
            )}
            <div className="flex gap-2 pt-1 flex-wrap">
              <button onClick={probe} disabled={loading} className="rounded-lg border border-border px-3 py-2 text-xs">Probe</button>
              <button onClick={fetchProviders} disabled={loading} className="rounded-lg border border-border px-3 py-2 text-xs">Fetch providers</button>
              <button onClick={fetchModels} disabled={loading} className="rounded-lg border border-border px-3 py-2 text-xs">Fetch models</button>
            </div>
            {snapshot?.providers && (
              <ul className="text-xs space-y-1 max-h-32 overflow-auto pt-1">
                {snapshot.providers.map((p) => (
                  <li key={p.id}>{p.label} — {p.reachable ? 'reachable' : 'offline'} ({p.models.length} models)</li>
                ))}
              </ul>
            )}
            {models.length > 0 && (
              <ul className="text-xs space-y-1 max-h-32 overflow-auto pt-1">
                {models.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Cpu className="h-3.5 w-3.5" /> Backend (local app) data
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            <div className="flex gap-2 flex-wrap">
              <button onClick={fetchBackend} disabled={loading} className="rounded-lg border border-border px-3 py-2 text-xs">Fetch backend data</button>
            </div>
            {backendHealth && (
              <div className="text-xs space-y-1 pt-1">
                <div className="font-semibold">Health</div>
                <pre className="max-h-24 overflow-auto text-[10px] text-muted-foreground">{JSON.stringify(backendHealth, null, 2)}</pre>
              </div>
            )}
            {backendSystem && (
              <div className="text-xs space-y-1 pt-1">
                <div className="font-semibold">System</div>
                <pre className="max-h-24 overflow-auto text-[10px] text-muted-foreground">{JSON.stringify(backendSystem, null, 2)?.slice(0, 500)}</pre>
              </div>
            )}
            {backendEngines && (
              <div className="text-xs space-y-1 pt-1">
                <div className="font-semibold">Engines</div>
                <pre className="max-h-24 overflow-auto text-[10px] text-muted-foreground">{JSON.stringify(backendEngines, null, 2)?.slice(0, 500)}</pre>
              </div>
            )}
            {!backendHealth && !backendSystem && !backendEngines && (
              <p className="text-xs text-muted-foreground">Fetch to load backend health/system/engines.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Local Connect Engine controls local-app reachability only. Backend reads hit the detected local app directly (port 8000) — nothing is cached or fabricated.
      </p>
    </div>
  );
}
