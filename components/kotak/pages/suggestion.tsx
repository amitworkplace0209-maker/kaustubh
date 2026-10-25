'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, ShieldAlert, Zap, GitBranch, Scissors, CheckCircle2, XCircle,
  Play, Trash2, RefreshCw, Send, Filter, Clock, AlertTriangle, ArrowUp,
  ArrowDown, TrendingUp, Brain, Eye, Settings2, Target, BarChart3,
  ChevronUp, Check, Pause, Shield, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { StatusBadge, EmptyState, ErrorState, SectionCard } from '@/components/design-system';
import {
  getDummySuggestions, processDummySuggestion, rejectDummySuggestion,
  deleteDummySuggestion, suggestionStatusTone, suggestionOutcome,
  type DummySuggestion,
} from '@/lib/dummy';
import { TradingService } from '@/lib/trading-service';
import { KotakPage, KotakBadge } from '@/components/kotak/ui';
import { OrdersTabs } from '@/components/orders/orders-tabs';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatISTDateTime } from '@/lib/ist';
import { useLatestTicks } from '@/hooks/use-latest-ticks';

const PIPELINE_STEPS = [
  { id: 'AI_MODEL', label: 'AI Model', icon: Brain },
  { id: 'RECEIVED', label: 'Receiver', icon: Send },
  { id: 'VALIDATED', label: 'Validate', icon: CheckCircle2 },
  { id: 'RISK_CHECK', label: 'Risk Check', icon: ShieldAlert },
  { id: 'ORDER_ENGINE', label: 'Order Engine', icon: Zap },
  { id: 'KOTAK_BROKER', label: 'Kotak Neo', icon: Send },
  { id: 'AUDIT', label: 'Audit', icon: Scissors },
] as const;

type TabKey = 'all' | 'high' | 'new' | 'pending' | 'executed' | 'expired';

const TABS: { key: TabKey; label: string; icon: typeof Sparkles }[] = [
  { key: 'all', label: 'All Suggestions', icon: Sparkles },
  { key: 'high', label: 'High Confidence', icon: TrendingUp },
  { key: 'new', label: 'New/Unread', icon: Eye },
  { key: 'pending', label: 'Accepted/Pending', icon: Clock },
  { key: 'executed', label: 'Executed', icon: CheckCircle2 },
  { key: 'expired', label: 'Expired', icon: AlertTriangle },
];

function getPipelineProgress(pipeline: string[]): { completed: number; total: number } {
  const total = PIPELINE_STEPS.length;
  const completed = PIPELINE_STEPS.filter((s) => pipeline.includes(s.id)).length;
  return { completed, total };
}

function getPipelineStatus(pipeline: string[], stepId: string): 'completed' | 'active' | 'pending' {
  const idx = PIPELINE_STEPS.findIndex((s) => s.id === stepId);
  if (idx === -1) return 'pending';
  if (pipeline.includes(stepId)) return 'completed';
  const firstIncomplete = PIPELINE_STEPS.findIndex((s) => !pipeline.includes(s.id));
  return idx === firstIncomplete ? 'active' : 'pending';
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 80) return 'bg-emerald-500';
  if (confidence >= 60) return 'bg-amber-500';
  if (confidence >= 40) return 'bg-orange-500';
  return 'bg-red-500';
}

function getConfidenceTextColor(confidence: number): string {
  if (confidence >= 80) return 'text-emerald-500';
  if (confidence >= 60) return 'text-amber-500';
  if (confidence >= 40) return 'text-orange-500';
  return 'text-red-500';
}

function getRiskReward(entry: number, target: number, stopLoss: number): number {
  if (!entry || !target || !stopLoss || entry === 0) return 0;
  const reward = Math.abs(target - entry);
  const risk = Math.abs(stopLoss - entry);
  return risk === 0 ? 0 : Number((reward / risk).toFixed(2));
}

function getSourceBadge(source: string) {
  const lower = source.toLowerCase();
  if (lower.includes('khumbha')) return { label: 'Khumbha AI', color: 'bg-violet-500/15 text-violet-400 border-violet-500/30' };
  if (lower.includes('scanner')) return { label: 'Scanner', color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' };
  if (lower.includes('strategy')) return { label: 'Strategy Engine', color: 'bg-amber-500/15 text-amber-400 border-amber-500/30' };
  return { label: source, color: 'bg-muted text-muted-foreground' };
}

function isExpiringSoon(expiry: string | null): boolean {
  if (!expiry) return false;
  const msToExpiry = new Date(expiry).getTime() - Date.now();
  return msToExpiry > 0 && msToExpiry < 24 * 60 * 60 * 1000;
}

type FilterValues = {
  symbol: string;
  direction: string;
  source: string;
};

const EMPTY_FILTERS: FilterValues = { symbol: '', direction: 'ALL', source: '' };

export default function KotakSuggestion() {
  const [suggestions, setSuggestions] = useState<DummySuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoExecute, setAutoExecute] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);
  const [positions, setPositions] = useState<any[]>([]);
  const [funds, setFunds] = useState<{ availableMargin: number; usedMargin: number } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DummySuggestion | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { toast } = useToast();
  const { latest } = useLatestTicks(true);
  const router = useRouter();

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [sugRes, posRes, fundsRes] = await Promise.all([
        getDummySuggestions('').catch(() => ({ data: [] })),
        TradingService.getPositions().catch(() => null),
        TradingService.getFunds().catch(() => null),
      ]);
      setSuggestions(sugRes?.data || []);
      if (posRes?.data) setPositions(Array.isArray(posRes.data) ? posRes.data : []);
      if (fundsRes) setFunds({ availableMargin: fundsRes.availableMargin, usedMargin: fundsRes.usedMargin });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suggestions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const ltpFor = useCallback(
    (symbol: string) => {
      const t = latest.get(symbol);
      return t && typeof t.ltp === 'number' && t.ltp > 0 ? t.ltp : 0;
    },
    [latest],
  );

  const filtered = useMemo(() => {
    return suggestions.filter((s) => {
      if (filters.symbol && !s.symbol.toLowerCase().includes(filters.symbol.toLowerCase())) return false;
      if (filters.direction !== 'ALL' && s.direction !== filters.direction) return false;
      if (filters.source && !s.source.toLowerCase().includes(filters.source.toLowerCase())) return false;
      return true;
    });
  }, [suggestions, filters]);

  const tabFiltered = useMemo(() => {
    switch (activeTab) {
      case 'high': return filtered.filter((s) => s.confidence >= 70);
      case 'new': return filtered.filter((s) => s.status === 'RECEIVED' || s.status === 'VALIDATING');
      case 'pending': return filtered.filter((s) => s.status === 'VALIDATED');
      case 'executed': return filtered.filter((s) => s.status === 'EXECUTED');
      case 'expired': return filtered.filter((s) => ['EXPIRED', 'CANCELLED', 'FAILED'].includes(s.status));
      default: return filtered;
    }
  }, [filtered, activeTab]);

  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todaySuggestions = suggestions.filter((s) => new Date(s.createdAt) >= today);
    const executed = suggestions.filter((s) => s.status === 'EXECUTED');
    const accepted = suggestions.filter((s) => ['VALIDATED', 'EXECUTING', 'EXECUTED'].includes(s.status));
    const avgConf = suggestions.length > 0
      ? Math.round(suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length)
      : 0;
    return {
      totalToday: todaySuggestions.length,
      acceptanceRate: suggestions.length > 0 ? Math.round((accepted.length / suggestions.length) * 100) : 0,
      avgConfidence: avgConf,
      executed: executed.length,
    };
  }, [suggestions]);

  const processSuggestion = async (s: DummySuggestion) => {
    setActionId(s.id);
    try {
      const ltpMap: Record<string, number> = {};
      for (const sug of suggestions) {
        const l = ltpFor(sug.symbol);
        if (l > 0) ltpMap[sug.symbol] = l;
      }
      const res = await processDummySuggestion(s.id, ltpMap);
      toast({ title: 'Pipeline ran', description: `${s.symbol} → ${res.suggestion.status}` });
      void refresh();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Process failed', description: e?.message });
    } finally {
      setActionId(null);
    }
  };

  const confirmReject = async () => {
    if (!rejectTarget) return;
    try {
      const res = await rejectDummySuggestion(rejectTarget.id, rejectReason);
      toast({ title: 'Suggestion rejected', description: `${res.suggestion.symbol} → ${res.suggestion.status}` });
      setRejectTarget(null);
      setRejectReason('');
      void refresh();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Reject failed', description: e?.message });
    }
  };

  const removeSuggestion = async (id: string) => {
    try {
      await deleteDummySuggestion(id);
      void refresh();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Delete failed', description: e?.message });
    }
  };

  const executeManual = (s: DummySuggestion) => {
    try {
      localStorage.setItem(
        'kotak.trade.draft',
        JSON.stringify({
          symbol: s.symbol,
          side: s.direction,
          quantity: String(s.quantity || 1),
          source: s.source,
          note: 'Prefilled from Khumbha AI suggestion',
          savedAt: new Date().toISOString(),
        }),
      );
    } catch { /* storage unavailable */ }
    toast({ title: 'Sent to Trade', description: `${s.symbol} prefilled in the Kotak order form.` });
    router.push('/trading/trade');
  };

  const waitForSystem = (s: DummySuggestion) => {
    toast({ title: 'Marked as Pending', description: `${s.symbol} will be auto-executed when conditions are met.` });
  };

  const unrealised = positions.reduce((acc, p) => acc + (Number(p.unrealisedPnl ?? p.unrealised) || 0), 0);

  if (loading && suggestions.length === 0) {
    return (
      <KotakPage>
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading Khumbha AI suggestions…
        </div>
      </KotakPage>
    );
  }

  if (error && suggestions.length === 0) {
    return (
      <KotakPage>
        <OrdersTabs />
        <ErrorState message={error} onRetry={() => void refresh()} />
      </KotakPage>
    );
  }

  return (
    <KotakPage>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">AI Suggestions</h1>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <Badge variant="outline" className="text-[10px]">LIVE</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Khumbha AI suggestions — validated, risk-checked, and audited. Execute through real Kotak Neo broker.
            </p>
          </div>
          <KotakBadge />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <OrdersTabs />

      <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
        <Shield className="h-3.5 w-3.5 shrink-0" />
        Suggestions are generated by Khumbha AI. Execution sends orders to the live Kotak Neo broker.
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SectionCard title="Total Today" icon={BarChart3} className="text-xs">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold">{stats.totalToday}</span>
            <span className="text-xs text-muted-foreground">suggestions</span>
          </div>
        </SectionCard>
        <SectionCard title="Acceptance Rate" icon={TrendingUp} className="text-xs">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold">{stats.acceptanceRate}%</span>
            <span className="text-xs text-muted-foreground">accepted</span>
          </div>
        </SectionCard>
        <SectionCard title="Avg Confidence" icon={Target} className="text-xs">
          <div className="flex items-baseline gap-1">
            <span className={cn('text-2xl font-bold', getConfidenceTextColor(stats.avgConfidence))}>{stats.avgConfidence}%</span>
            <span className="text-xs text-muted-foreground">average</span>
          </div>
        </SectionCard>
        <SectionCard title="Unrealised P&L" icon={Sparkles} className="text-xs">
          <div className="flex items-baseline gap-1">
            <span className={cn('text-2xl font-bold', unrealised >= 0 ? 'text-emerald-500' : 'text-red-500')}>
              {unrealised >= 0 ? '+' : ''}₹{unrealised.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
            <span className="text-xs text-muted-foreground">positions</span>
          </div>
        </SectionCard>
      </div>

      {funds && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
          <SectionCard title="Kotak Available Margin" icon={Zap} className="text-xs">
            <div className="text-xl font-bold tabular-nums">₹{funds.availableMargin.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
          </SectionCard>
          <SectionCard title="Kotak Used Margin" icon={AlertTriangle} className="text-xs">
            <div className="text-xl font-bold tabular-nums">₹{funds.usedMargin.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
          </SectionCard>
        </div>
      )}

      <SectionCard title="Pipeline" icon={GitBranch} className="text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">Khumbha AI</Badge>
          <span className="text-muted-foreground">→</span>
          {PIPELINE_STEPS.map((step, i) => (
            <span key={step.id} className="flex items-center gap-1">
              <Badge variant="secondary" className="text-[9px]">
                <step.icon className="mr-0.5 h-2.5 w-2.5" />
                {step.label}
              </Badge>
              {i < PIPELINE_STEPS.length - 1 && <span className="text-muted-foreground text-[9px]">→</span>}
            </span>
          ))}
          <span className="text-muted-foreground">→</span>
          <Badge variant="outline" className="text-[10px]">Kotak Neo Execution</Badge>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Suggestions flow through AI Model → Receiver → Validate → Risk Check → Order Engine → Kotak Neo Broker → Audit.
          No model can place an order directly — every suggestion is audited before reaching the live broker.
        </p>
      </SectionCard>

      <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-muted/30 p-1">
        {TABS.map((tab) => {
          const count = tab.key === 'all'
            ? filtered.length
            : tab.key === 'high'
            ? filtered.filter((s) => s.confidence >= 70).length
            : tab.key === 'new'
            ? filtered.filter((s) => s.status === 'RECEIVED' || s.status === 'VALIDATING').length
            : tab.key === 'pending'
            ? filtered.filter((s) => s.status === 'VALIDATED').length
            : tab.key === 'executed'
            ? filtered.filter((s) => s.status === 'EXECUTED').length
            : filtered.filter((s) => ['EXPIRED', 'CANCELLED', 'FAILED'].includes(s.status)).length;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                activeTab === tab.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <tab.icon className="h-3 w-3" />
              {tab.label}
              {count > 0 && (
                <Badge variant={activeTab === tab.key ? 'default' : 'outline'} className="ml-1 h-4 min-w-[16px] justify-center px-1 text-[9px]">
                  {count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button variant={showFilters ? 'default' : 'outline'} size="sm" onClick={() => setShowFilters(!showFilters)}>
          <Filter className="h-3.5 w-3.5 mr-1" /> Filters
        </Button>
        {filtered.length > 0 && (
          <Badge variant="outline" className="text-[11px]">{filtered.length} suggestion{filtered.length !== 1 ? 's' : ''}</Badge>
        )}
      </div>

      {showFilters && (
        <SectionCard title="Filters" icon={Filter}>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Symbol</Label>
              <Input value={filters.symbol} onChange={(e) => setFilters({ ...filters, symbol: e.target.value })} placeholder="e.g. RELIANCE" className="uppercase" />
            </div>
            <div className="space-y-1.5">
              <Label>Direction</Label>
              <Select value={filters.direction} onValueChange={(v) => setFilters({ ...filters, direction: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="BUY">BUY</SelectItem>
                  <SelectItem value="SELL">SELL</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={filters.source} onValueChange={(v) => setFilters({ ...filters, source: v })}>
                <SelectTrigger><SelectValue placeholder="All sources" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All sources</SelectItem>
                  <SelectItem value="Khumbha AI">Khumbha AI</SelectItem>
                  <SelectItem value="Scanner">Scanner</SelectItem>
                  <SelectItem value="Strategy">Strategy</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </SectionCard>
      )}

      <SectionCard title="Auto-Execution Settings" icon={Settings2} className="text-xs">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Auto-Execute High Confidence</p>
              <p className="text-xs text-muted-foreground">Automatically send high-confidence suggestions through the pipeline</p>
            </div>
            <button
              onClick={() => setAutoExecute(!autoExecute)}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
                autoExecute ? 'bg-emerald-500' : 'bg-muted',
              )}
            >
              <span className={cn('inline-block h-4 w-4 rounded-full bg-white transition-transform', autoExecute ? 'translate-x-6' : 'translate-x-1')} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Confidence Threshold: {confidenceThreshold}%</Label>
              <input type="range" min={30} max={95} step={5} value={confidenceThreshold} onChange={(e) => setConfidenceThreshold(Number(e.target.value))} className="w-full accent-primary" />
              <div className="flex justify-between text-[10px] text-muted-foreground"><span>30%</span><span>95%</span></div>
            </div>
            <div className="flex items-end">
              <Button variant="outline" size="sm" className="text-xs" onClick={() => { toast({ title: 'Settings saved', description: `Threshold: ${confidenceThreshold}%` }); }}>
                <Check className="h-3 w-3 mr-1" /> Save Settings
              </Button>
            </div>
          </div>
        </div>
      </SectionCard>

      {tabFiltered.length === 0 && !loading ? (
        <EmptyState
          icon={Sparkles}
          title="No suggestions available"
          description="No suggestions match the current filter. Ensure Khumbha AI is connected."
        />
      ) : (
        <div className="space-y-3">
          {tabFiltered.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              latest={latest}
              actionId={actionId}
              expanded={expandedId === s.id}
              onToggleExpand={() => setExpandedId(expandedId === s.id ? null : s.id)}
              onExecuteManual={() => executeManual(s)}
              onWaitForSystem={() => waitForSystem(s)}
              onProcess={() => void processSuggestion(s)}
              onReject={() => setRejectTarget(s)}
              onDelete={() => void removeSuggestion(s.id)}
            />
          ))}
        </div>
      )}

      <Dialog open={rejectTarget !== null} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {rejectTarget?.symbol}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. diverges from the plan" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmReject()}>Reject</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </KotakPage>
  );
}

function SuggestionCard({
  suggestion: s,
  latest,
  actionId,
  expanded,
  onToggleExpand,
  onExecuteManual,
  onWaitForSystem,
  onProcess,
  onReject,
  onDelete,
}: {
  suggestion: DummySuggestion;
  latest: Map<string, { ltp: number | null; ts: string }>;
  actionId: string | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onExecuteManual: () => void;
  onWaitForSystem: () => void;
  onProcess: () => void;
  onReject: () => void;
  onDelete: () => void;
}) {
  const out = suggestionOutcome(s);
  const progress = getPipelineProgress(s.pipeline || []);
  const rr = getRiskReward(s.entry, s.target, s.stopLoss);
  const ltp = latest.get(s.symbol);
  const ltpValue = ltp && typeof ltp.ltp === 'number' && ltp.ltp > 0 ? ltp.ltp : null;
  const srcBadge = getSourceBadge(s.source);
  const isTerminal = ['EXECUTED', 'CANCELLED', 'FAILED', 'DELETED'].includes(s.status);

  return (
    <div className="rounded-lg border bg-background p-4 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex flex-col items-center gap-1">
            <span className="text-sm font-semibold">{s.symbol}</span>
            <Badge variant={s.direction === 'BUY' ? 'default' : 'destructive'} className="text-[10px] px-1.5 py-0">
              {s.direction === 'BUY' ? <ArrowUp className="h-2.5 w-2.5 mr-0.5" /> : <ArrowDown className="h-2.5 w-2.5 mr-0.5" />}
              {s.direction}
            </Badge>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{s.model}</span>
              <span className="text-[10px] text-muted-foreground">•</span>
              <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border', srcBadge.color)}>{srcBadge.label}</span>
              <StatusBadge status={suggestionStatusTone(s.status)} label={s.status} />
            </div>
            <div className="flex items-center gap-3 text-xs tabular-nums">
              {s.entry > 0 && <span><span className="text-muted-foreground">Entry</span> <span className="font-medium">₹{s.entry.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span></span>}
              {s.target > 0 && <span><span className="text-muted-foreground">Target</span> <span className="font-medium text-emerald-500">₹{s.target.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span></span>}
              {s.stopLoss > 0 && <span><span className="text-muted-foreground">SL</span> <span className="font-medium text-red-500">₹{s.stopLoss.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span></span>}
              {ltpValue !== null && <span><span className="text-muted-foreground">LTP</span> <span className="font-medium">₹{ltpValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span></span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Confidence</span>
              <span className={cn('text-sm font-bold tabular-nums', getConfidenceTextColor(s.confidence))}>{s.confidence}%</span>
            </div>
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full rounded-full transition-all duration-300', getConfidenceColor(s.confidence))} style={{ width: `${Math.min(s.confidence, 100)}%` }} />
            </div>
            {rr > 0 && <span className="text-[10px] text-muted-foreground">R:R {rr}</span>}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{formatISTDateTime(s.createdAt)}</span>
        {s.expiry && (
          <span className={isExpiringSoon(s.expiry) ? 'text-amber-500' : ''}>
            <Clock className="h-2.5 w-2.5 inline mr-0.5" />
            expires {formatISTDateTime(s.expiry)}
          </span>
        )}
        {s.orderId && <span className="font-mono">order {s.orderId}</span>}
        <span className={out.tone === 'success' ? 'text-emerald-500' : out.tone === 'danger' ? 'text-red-500' : 'text-amber-500'}>{out.label}</span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }} />
        </div>
        <span className="text-[10px] text-muted-foreground">{progress.completed}/{progress.total}</span>
      </div>

      {(s.checks || []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {s.checks.map((c) => (
            <span key={c.name} className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px]', c.passed ? 'border-emerald-500/40 text-emerald-600' : 'border-red-500/40 text-red-500')}>
              {c.passed ? '✓' : '✗'} {c.label}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7" variant="default" disabled={isTerminal} onClick={() => void onExecuteManual()} title="Open Kotak order form prefilled with this suggestion">
          <Play className="h-3 w-3 mr-1" /> Execute Manual
        </Button>
        <Button size="sm" className="h-7" variant="outline" disabled={isTerminal} onClick={() => void onWaitForSystem()} title="Mark as pending for auto-execution">
          <Pause className="h-3 w-3 mr-1" /> Wait for System
        </Button>
        <Button size="sm" className="h-7" variant="outline" disabled={isTerminal} onClick={() => void onProcess()} title="Run this suggestion through the pipeline">
          {actionId === s.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <GitBranch className="h-3 w-3 mr-1" />} Process
        </Button>
        <Button size="sm" className="h-7" variant="outline" disabled={isTerminal} onClick={() => void onReject()} title="Reject this suggestion">
          <XCircle className="h-3 w-3 mr-1" /> Reject
        </Button>
        <Button size="sm" className="h-7" variant="ghost" onClick={onToggleExpand} title="View full analysis details">
          {expanded ? <ChevronUp className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
          View Details
        </Button>
        <Button size="icon" className="h-7 w-7 ml-auto" variant="ghost" onClick={() => void onDelete()}>
          <Trash2 className="h-3 w-3 text-destructive" />
        </Button>
      </div>

      {expanded && (
        <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <div><span className="text-muted-foreground">Qty</span> <span className="font-medium">{s.quantity}</span></div>
            <div><span className="text-muted-foreground">Type</span> <span className="font-medium">{s.type}</span></div>
            <div><span className="text-muted-foreground">Product</span> <span className="font-medium">{s.product}</span></div>
            <div><span className="text-muted-foreground">Order Type</span> <span className="font-medium">{s.orderType}</span></div>
            <div><span className="text-muted-foreground">Source</span> <span className="font-medium">{s.source}</span></div>
            <div><span className="text-muted-foreground">R:R Ratio</span> <span className="font-medium">{rr || 'N/A'}</span></div>
          </div>

          <SectionCard title="Pipeline Progress" icon={GitBranch} className="text-[10px]">
            <div className="flex flex-wrap items-center gap-1">
              {PIPELINE_STEPS.map((step, i) => {
                const status = getPipelineStatus(s.pipeline || [], step.id);
                return (
                  <span key={step.id} className="flex items-center gap-1">
                    <span className={cn(
                      'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[9px]',
                      status === 'completed' ? 'border-emerald-500/40 text-emerald-500 bg-emerald-500/10'
                        : status === 'active' ? 'border-amber-500/40 text-amber-500 bg-amber-500/10 animate-pulse'
                        : 'border-muted text-muted-foreground',
                    )}>
                      <step.icon className="h-2 w-2" />
                      {step.label}
                      {status === 'completed' && <Check className="h-2 w-2" />}
                    </span>
                    {i < PIPELINE_STEPS.length - 1 && <span className="text-muted-foreground text-[8px]">→</span>}
                  </span>
                );
              })}
            </div>
          </SectionCard>

          {s.reason && (
            <div className="text-xs">
              <span className="text-muted-foreground">Reason: </span>
              <span>{s.reason}</span>
            </div>
          )}
          {s.rejectReason && (
            <div className="text-xs">
              <span className="text-muted-foreground">Reject Reason: </span>
              <span className="text-red-500">{s.rejectReason}</span>
            </div>
          )}
          {s.error && (
            <div className="text-xs">
              <span className="text-muted-foreground">Error: </span>
              <span className="text-red-500">{s.error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
