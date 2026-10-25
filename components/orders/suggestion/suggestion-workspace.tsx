'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity, ArrowRight, FlaskConical, Loader2, Lock, Package, Play, RefreshCw, Send, Trash2, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, PageHeader, SectionCard, StatusBadge, fmtNumber } from '@/components/design-system';
import { isAuthenticated, toTerminalId } from '@/lib/terminal-service';
import { type TradingMode } from '@/lib/settings-store';
import { SIDE_CLASS, capsFor } from '@/components/orders/trade/capabilities';
import { SuggestionPipeline } from './suggestion-pipeline';
import {
  deleteDummySuggestion,
  getDummySuggestions,
  processDummySuggestion,
  receiveDummySuggestion,
  rejectDummySuggestion,
  type DummySuggestion,
} from '@/lib/dummy';
import { defaultReceiveDraft, type ReceiveDraft, type SuggestionActionMap, type SuggestionActionState } from './types';

const EMPTY_ACTION: SuggestionActionState = { kind: null, busy: false, error: null };

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/25';

function canProcess(status: string): boolean {
  return ['RECEIVED'].includes((status || '').toUpperCase());
}

function canReject(status: string): boolean {
  return ['RECEIVED', 'VALIDATING', 'VALIDATED', 'EXECUTING'].includes((status || '').toUpperCase());
}

function fmtClock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.getTime() ? d.toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : '—';
}

/**
 * DORMANT — the full Suggestion workspace implementation, preserved intact.
 *
 * `/trading/suggestion` currently renders the Coming Soon placeholder
 * (components/orders/suggestion/suggestion-page.tsx) because the page is
 * intentionally empty until the suggestion feature ships. When it ships,
 * route this component again instead of rewriting it: it is the working
 * receiver → duplicate → expiry → risk → order-engine → dummy-broker
 * pipeline, wired to /api/dummy/suggestions.
 */

export function SuggestionWorkspacePage({ mode }: { mode: TradingMode }) {
  const terminal = toTerminalId(mode);
  if (terminal === 'dummy') return <SuggestionWorkspace />;
  return <SuggestionDormant terminal={terminal} mode={mode} />;
}

/** Honest dormant state when the active terminal exposes no suggestion engine. */
function SuggestionDormant({ terminal, mode }: { terminal: string; mode: TradingMode }) {
  const router = useRouter();
  const label = mode === 'kotak-neo' ? 'Kotak Neo' : `${terminal} terminal`;
  return (
    <div className="space-y-4">
      <PageHeader title="Suggestion Pipeline" subtitle="AI suggestions → validated execution" />
      <SectionCard title="Suggestion Engine" icon={FlaskConical} headerRight={<StatusBadge status="neutral" label="Dummy only" />}>
        <p className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-foreground/90">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          The suggestion pipeline is a Dummy (paper) engine: a model never places an order directly — it enters a
          validated receiver → duplicate → expiry → risk → order-engine → dummy-broker pipeline. {label} exposes no
          suggestion endpoint, so the engine is intentionally dormant here. Switch to Dummy mode to receive, review,
          and execute suggestions.
        </p>
        <Button type="button" variant="outline" onClick={() => router.push('/trading')}>
          Open terminal switcher <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </SectionCard>
    </div>
  );
}

function SuggestionWorkspace() {
  const loggedIn = isAuthenticated();
  const [, setAuthTick] = useState(0);
  const router = useRouter();

  const [items, setItems] = useState<DummySuggestion[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>('ALL');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actions, setActions] = useState<SuggestionActionMap>({});
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [draft, setDraft] = useState<ReceiveDraft>(defaultReceiveDraft);
  const [autoProcess, setAutoProcess] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DummySuggestion | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DummySuggestion | null>(null);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    busyRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getDummySuggestions(filter === 'ALL' ? '' : filter, 100);
      setItems(res.data || []);
      if (Array.isArray(res.statuses) && res.statuses.length) setStatuses(['ALL', ...res.statuses]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => {
      if (!busyRef.current) void load();
    }, 6000);
    return () => window.clearInterval(t);
  }, [load]);

  const patchAction = (id: string, patch: Partial<SuggestionActionState>) =>
    setActions((prev) => ({ ...prev, [id]: { ...(prev[id] || EMPTY_ACTION), ...patch } }));

  const runAction = useCallback(
    async (id: string, kind: 'process' | 'reject', reason = '') => {
      if (!loggedIn) return;
      patchAction(id, { kind, busy: true, error: null });
      busyRef.current = true;
      try {
        const res =
          kind === 'process'
            ? await processDummySuggestion(id)
            : await rejectDummySuggestion(id, reason);
        setItems((prev) => prev.map((s) => (s.id === id ? { ...s, ...res.suggestion } : s)));
      } catch (e) {
        patchAction(id, { error: e instanceof Error ? e.message : String(e) });
      } finally {
        patchAction(id, { busy: false, kind: null });
        busyRef.current = false;
      }
    },
    [loggedIn],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !loggedIn) return;
    const id = deleteTarget.id;
    patchAction(id, { kind: 'delete', busy: true, error: null });
    busyRef.current = true;
    try {
      await deleteDummySuggestion(id);
      setItems((prev) => prev.filter((s) => s.id !== id));
      setDeleteTarget(null);
    } catch (e) {
      patchAction(id, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      patchAction(id, { busy: false, kind: null });
      busyRef.current = false;
    }
  }, [deleteTarget, loggedIn]);

  const confirmReject = useCallback(async () => {
    if (!rejectTarget) return;
    await runAction(rejectTarget.id, 'reject', rejectReason.trim());
    setRejectTarget(null);
    setRejectReason('');
  }, [rejectTarget, rejectReason, runAction]);

  const sendSuggestion = useCallback(async () => {
    const symbol = draft.symbol.trim().toUpperCase();
    const quantity = parseInt(draft.quantity, 10) || 0;
    const entry = parseFloat(draft.entry) || 0;
    const confidence = Math.min(100, Math.max(0, parseFloat(draft.confidence) || 0));
    if (!symbol) {
      setSendError('Symbol is required.');
      return;
    }
    if (quantity <= 0) {
      setSendError('Quantity must be positive.');
      return;
    }
    if (entry <= 0) {
      setSendError('Entry price is required and must be positive (the engine ships no fantasy fills).');
      return;
    }
    setSending(true);
    setSendError(null);
    busyRef.current = true;
    try {
      const body = {
        symbol,
        direction: draft.direction,
        quantity,
        entry,
        target: parseFloat(draft.target) || 0,
        stopLoss: parseFloat(draft.stopLoss) || 0,
        confidence,
        model: draft.model.trim() || 'MANUAL',
        source: draft.source.trim() || 'KHUMBHA_AI',
        reason: draft.reason.trim(),
        product: draft.product,
        orderType: draft.orderType,
        type: 'NORMAL',
        autoProcess,
      };
      const res = await receiveDummySuggestion(body);
      setItems((prev) => [res.suggestion, ...prev]);
      setReceiveOpen(false);
      setDraft(defaultReceiveDraft());
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setSending(false);
    }
  }, [draft, autoProcess]);

  const anyBusy = useMemo(() => Object.values(actions).some((a) => a.busy) || loading, [actions, loading]);

  const visible = useMemo(
    () => (filter === 'ALL' ? items : items.filter((s) => (s.status || '').toUpperCase() === filter)),
    [items, filter],
  );

  const itemErr = (id: string) => actions[id]?.error || null;

  return (
    <div className="space-y-4">
      <PageHeader title="Suggestion Pipeline" subtitle="Dummy paper engine — validated queue, signed-in executions into the demo book">
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
        </Button>
        <Button type="button" size="sm" onClick={() => setReceiveOpen(true)}>
          <Send className="h-3.5 w-3.5" /> Receive suggestion
        </Button>
      </PageHeader>

      {/* Dummy Mode — replaces Session required card */}
      <div className="rounded-xl border border-purple/30 bg-gradient-to-br from-purple/10 via-purple/[0.04] to-transparent px-4 py-3.5 flex items-center gap-3 shadow-sm">
        <div className="h-9 w-9 rounded-xl bg-purple/15 border border-purple/20 flex items-center justify-center shrink-0">
          <Activity className="h-4 w-4 text-purple" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold tracking-tight text-purple flex items-center gap-2">● Dummy Mode — Paper Suggestions <span className="rounded border border-purple/30 bg-purple/15 px-1.5 py-0.5 text-[9px] font-bold text-purple">VIRTUAL</span></p>
          <p className="text-xs font-medium text-muted-foreground">Validated pipeline: receive → duplicate → expiry → risk → order-engine → dummy broker · No real funds</p>
        </div>
        <div className="hidden sm:flex items-center gap-2 shrink-0">
          <span className="h-2 w-2 rounded-full bg-purple animate-pulse" />
          <span className="text-[11px] font-bold text-purple tracking-wider">PAPER</span>
        </div>
      </div>

      {/* Suggestion / Pipeline Details */}
      <section className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5 bg-muted/10">
          <h3 className="text-xs font-bold uppercase tracking-widest text-foreground flex items-center gap-2"><Package className="h-3.5 w-3.5 text-primary" /> Suggestion Details</h3>
          <span className="text-[10px] font-semibold text-muted-foreground tabular-nums">{items.length} total · {visible.length} visible · {statuses.length - 1} statuses</span>
        </div>
        <div className="p-4 grid gap-4 md:grid-cols-3 text-xs leading-relaxed">
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Pipeline</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Engine</span><span className="font-bold text-foreground">Dummy Paper</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Queue</span><span className="font-bold text-foreground">{visible.length} visible</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Filter</span><span className="font-bold">{filter}</span></div>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Execution</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Process</span><span className="font-bold">RECEIVED → EXECUTED</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Risk</span><span className="font-bold text-success">Validated</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Broker</span><span className="font-bold text-purple">Dummy</span></div>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Action</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Receive</span><span className="font-bold">Manual / AI</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Auto-process</span><span className={cn('font-bold', autoProcess ? 'text-success' : 'text-muted-foreground')}>{autoProcess ? 'Enabled' : 'Paused'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Book</span><span className="font-mono font-bold">Demo (Coins)</span></div>
            </div>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-1.5">
        {statuses.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
              filter === s
                ? 'border-primary/60 bg-primary/15 text-primary'
                : 'border-border bg-card text-muted-foreground hover:text-foreground',
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {loadError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {loadError}
        </p>
      )}

      {!loading && visible.length === 0 && (
        <EmptyState
          icon={FlaskConical}
          title="No suggestions"
          description="The validated queue is empty for this filter. Receive one from the pipeline or switch filters."
        />
      )}

      <div className="space-y-3">
        {visible.map((s) => (
          <SectionCard
            key={s.id}
            className="space-y-3"
            headerRight={
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {s.id}
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-foreground">{s.symbol}</span>
              <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', SIDE_CLASS[s.direction])}>
                {s.direction}
              </span>
              <span className="text-xs text-muted-foreground">x {fmtNumber(s.quantity)}</span>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {s.product} · {s.orderType}
              </span>
              {s.type !== 'NORMAL' && (
                <span className="rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[10px] font-semibold text-info">
                  {s.type} · {Array.isArray(s.legs) ? s.legs.length : 0} legs
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
              {[
                ['Model', s.model || s.source || '—'],
                ['Confidence', s.confidence ? `${s.confidence}%` : '—'],
                ['Entry', fmtNumber(s.entry)],
                ['Target', fmtNumber(s.target)],
                ['Stop-loss', fmtNumber(s.stopLoss)],
                ['Expected value', fmtNumber(s.expectedValue)],
                ['Risk', fmtNumber(s.risk)],
                ['Received', fmtClock(s.createdAt)],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{k}</p>
                  <p className="truncate font-medium text-foreground/90">{v}</p>
                </div>
              ))}
            </div>

            {s.reason && <p className="text-[11px] leading-relaxed text-muted-foreground">“{s.reason}”</p>}

            <SuggestionPipeline suggestion={s} />

            {(s.error || s.rejectReason) && (
              <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-[10px] text-foreground/80">
                {s.rejectReason || s.error}
              </p>
            )}

            {itemErr(s.id) && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[10px] text-destructive">
                {itemErr(s.id)}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!loggedIn || !canProcess(s.status) || anyBusy}
                onClick={() => void runAction(s.id, 'process')}
              >
                {actions[s.id]?.busy && actions[s.id]?.kind === 'process' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Process
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!loggedIn || !canReject(s.status) || anyBusy}
                onClick={() => {
                  setRejectTarget(s);
                  setRejectReason('');
                }}
              >
                <X className="h-3.5 w-3.5" /> Reject
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!loggedIn || anyBusy}
                onClick={() => setDeleteTarget(s)}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => router.push('/trading/trade')}>
                Trade in terminal <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </SectionCard>
        ))}
      </div>

      <Dialog open={receiveOpen} onOpenChange={setReceiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Receive suggestion</DialogTitle>
            <DialogDescription>
              Sends a real suggestion into the validated pipeline (receiver → validate → duplicate → expiry → risk →
              order engine → dummy broker). The model never places an order directly.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Symbol *
              </label>
              <input
                className={inputCls}
                value={draft.symbol}
                onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
                placeholder="RELIANCE"
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Direction
              </label>
              <select
                className={inputCls}
                value={draft.direction}
                onChange={(e) => setDraft({ ...draft, direction: e.target.value as 'BUY' | 'SELL' })}
              >
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Quantity *
              </label>
              <input
                className={inputCls}
                inputMode="numeric"
                value={draft.quantity}
                onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Entry *
              </label>
              <input
                className={inputCls}
                inputMode="decimal"
                value={draft.entry}
                onChange={(e) => setDraft({ ...draft, entry: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Target
              </label>
              <input
                className={inputCls}
                inputMode="decimal"
                value={draft.target}
                onChange={(e) => setDraft({ ...draft, target: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Stop-loss
              </label>
              <input
                className={inputCls}
                inputMode="decimal"
                value={draft.stopLoss}
                onChange={(e) => setDraft({ ...draft, stopLoss: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Confidence (%)
              </label>
              <input
                className={inputCls}
                inputMode="decimal"
                value={draft.confidence}
                onChange={(e) => setDraft({ ...draft, confidence: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Model
              </label>
              <input
                className={inputCls}
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder="MANUAL"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Source
              </label>
              <input
                className={inputCls}
                value={draft.source}
                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                placeholder="KHUMBHA_AI"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Product
              </label>
              <select
                className={inputCls}
                value={draft.product}
                onChange={(e) => setDraft({ ...draft, product: e.target.value })}
              >
                <option value="MIS">MIS</option>
                <option value="CNC">CNC</option>
                <option value="NRML">NRML</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Order type
              </label>
              <select
                className={inputCls}
                value={draft.orderType}
                onChange={(e) => setDraft({ ...draft, orderType: e.target.value })}
              >
                <option value="MKT">MKT</option>
                <option value="L">LIMIT</option>
                <option value="SL">STOP-LOSS</option>
                <option value="SL-M">SL-MARKET</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Reason
              </label>
              <textarea
                className={cn(inputCls, 'h-16 resize-none py-2')}
                value={draft.reason}
                onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                placeholder="Optional basis — stored verbatim on the suggestion"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={autoProcess}
              onChange={(e) => setAutoProcess(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Process immediately after receive (runs the full validated pipeline now)
          </label>

          {sendError && <p className="text-[11px] text-destructive">{sendError}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReceiveOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void sendSuggestion()} disabled={sending}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Receive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectTarget !== null} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject suggestion {rejectTarget?.id}</DialogTitle>
            <DialogDescription>
              Marks the suggestion <span className="font-semibold text-foreground">{rejectTarget?.symbol}</span> as
              rejected in the scheduled state. No order is placed.
            </DialogDescription>
          </DialogHeader>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Reject reason
          </label>
          <input
            className={inputCls}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Optional reason stored on the suggestion"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={actions[rejectTarget?.id || '']?.busy}
              onClick={() => void confirmReject()}
            >
              <X className="h-3.5 w-3.5" /> Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete suggestion {deleteTarget?.id}</DialogTitle>
            <DialogDescription>
              Permanently removes {deleteTarget?.symbol} from the pipeline. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={actions[deleteTarget?.id || '']?.busy}
              onClick={() => void confirmDelete()}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        Pipeline is server-authoritative: every status/check comes from the engine via <code>GET /api/dummy/suggestions</code>.
        Executions write to the same demo book used by Trade/Basket (virtual coins, not real currency).
      </p>
    </div>
  );
}