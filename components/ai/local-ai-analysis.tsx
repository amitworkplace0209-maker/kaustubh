'use client';

/**
 * LocalAiAnalysisPanel — one reusable surface for "explain this engine data
 * with the model running on my device".
 *
 * Used by:
 *   - Market Watch symbol detail (`/trading/market-watch`, `/dashboard` ...)
 *   - AI Suggestions market tab (`/ai/suggestions`)
 *
 * The panel is deliberately manual: it never calls a model on mount. A local
 * model can be expensive, so the user must press the button. The panel also
 * refuses to run when the bridge is reachable but no provider/model server is,
 * instead of showing a fake result.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, BrainCircuit, Loader2, RefreshCw, Sparkles, Wifi, WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard, StatusBadge } from '@/components/design-system';
import { contextFields } from '@/lib/ai-context';
import {
  defaultModelLabel,
  localAiAnalyze,
  localAiProviders,
  type LocalAiAnalysis,
  type LocalAiSnapshot,
} from '@/lib/local-ai';
import { cn } from '@/lib/utils';

export function LocalAiAnalysisPanel({
  kind,
  context,
  title = 'Local AI read',
  question,
  className,
}: {
  kind: 'market_watch_symbol' | 'market_watch_board' | 'suggestion_series' | 'suggestion_row' | 'generic';
  context: Record<string, unknown>;
  title?: string;
  question?: string;
  className?: string;
}) {
  const [snapshot, setSnapshot] = useState<LocalAiSnapshot | null>(null);
  const [bridgeState, setBridgeState] = useState<'checking' | 'online' | 'offline'>('checking');
  const [bridgeError, setBridgeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LocalAiAnalysis | null>(null);
  const [runError, setRunError] = useState('');

  const loadProviders = useCallback(async () => {
    setBridgeState('checking');
    setBridgeError('');
    try {
      const next = await localAiProviders();
      setSnapshot(next);
      setBridgeState('online');
    } catch (error: any) {
      setSnapshot(null);
      setBridgeState('offline');
      setBridgeError(error?.message || String(error));
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const sentFields = useMemo(() => contextFields(context), [context]);

  /**
   * Prefer the configured default provider, but only if it is actually
   * reachable. Otherwise use another enabled, reachable provider and pass it
   * explicitly — otherwise the button would look ready while the bridge would
   * still call the unreachable default.
   */
  const defaultProvider = snapshot?.providers.find(
    (p) => p.id === snapshot.defaults.provider && p.enabled,
  ) ?? null;
  const reachableProvider = snapshot?.providers.find((p) => p.enabled && p.reachable) ?? null;
  const activeProvider = defaultProvider?.reachable ? defaultProvider : reachableProvider;
  const activeModel = useMemo(() => {
    if (!activeProvider || !snapshot) return '';
    if (activeProvider.id === snapshot.defaults.provider) {
      return (
        snapshot.defaults.model ||
        activeProvider.model ||
        (activeProvider.models.length === 1 ? activeProvider.models[0].id : '')
      );
    }
    return activeProvider.model || (activeProvider.models.length === 1 ? activeProvider.models[0].id : '');
  }, [activeProvider, snapshot]);
  const modelLabel = activeProvider
    ? `${activeProvider.label}${activeModel ? ` · ${activeModel}` : ''}`
    : defaultModelLabel(snapshot);

  const run = useCallback(async () => {
    setBusy(true);
    setRunError('');
    try {
      const response = await localAiAnalyze({
        kind,
        context,
        question,
        provider: activeProvider?.id || undefined,
        model: activeModel || undefined,
      });
      setResult(response.data);
    } catch (error: any) {
      setRunError(error?.message || String(error));
    } finally {
      setBusy(false);
    }
  }, [activeModel, activeProvider, context, kind, question]);

  return (
    <SectionCard
      title={title}
      icon={BrainCircuit}
      className={className}
      headerRight={
        bridgeState === 'online' ? (
          <StatusBadge status="success" label="Local bridge" />
        ) : bridgeState === 'offline' ? (
          <StatusBadge status="danger" label="Bridge offline" />
        ) : (
          <StatusBadge status="neutral" label="Checking bridge" />
        )
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {bridgeState === 'checking' && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking the local AI bridge on this device…
            </>
          )}
          {bridgeState === 'online' && (
            <>
              <Wifi className="h-3.5 w-3.5 text-success" />
              <span>
                {activeProvider
                  ? `Using ${modelLabel}`
                  : 'Bridge online — no reachable model server'}
              </span>
            </>
          )}
          {bridgeState === 'offline' && (
            <>
              <WifiOff className="h-3.5 w-3.5 text-destructive" />
              The local AI bridge is not running on this device.
            </>
          )}
          <span aria-hidden>·</span>
          <span>{sentFields.length} engine fields in context</span>
        </div>

        {bridgeState === 'offline' && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground/80">
            <p className="font-medium text-destructive">Local AI is unavailable</p>
            <p className="mt-1 break-words text-muted-foreground">{bridgeError}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1" onClick={() => void loadProviders()}>
                <RefreshCw className="h-3 w-3" /> Retry
              </Button>
              <Link
                href="/ai/settings"
                className="text-xs font-medium text-info underline-offset-4 hover:underline"
              >
                Open AI Settings
              </Link>
            </div>
          </div>
        )}

        {bridgeState === 'online' && !reachableProvider && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground/80">
            <p className="font-medium text-warning">Bridge online, but no model server answered</p>
            <p className="mt-1 text-muted-foreground">
              Start Ollama or LM Studio, or set the correct URL in AI Settings. Nothing was sent to a model.
            </p>
            <Link
              href="/ai/settings"
              className="mt-2 inline-block text-xs font-medium text-info underline-offset-4 hover:underline"
            >
              Configure providers
            </Link>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void run()}
            disabled={busy || bridgeState !== 'online' || !activeProvider}
            className="gap-2"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? 'Local model thinking…' : 'Analyze with local AI'}
          </Button>
          {bridgeState === 'online' && activeProvider && (
            <span className="text-[11px] text-muted-foreground">
              {activeProvider.label}
              {activeProvider.models.length > 0 ? ` · ${activeProvider.models.length} model(s)` : ''}
            </span>
          )}
        </div>

        {runError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span className="break-words text-foreground/80">{runError}</span>
          </div>
        )}

        {result && (
          <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status="info" label={`${result.providerLabel} · ${result.model}`} />
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {Math.round(result.latencyMs)} ms · {result.contextChars} context chars
              </span>
            </div>
            <div className={cn('whitespace-pre-wrap text-sm leading-relaxed text-foreground/90')}>
              {result.content}
            </div>
            {result.groundedFields.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {result.groundedFields.map((field) => (
                  <span
                    key={field}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {field}
                  </span>
                ))}
              </div>
            )}
            <p className="text-[10px] leading-relaxed text-muted-foreground">{result.disclaimer}</p>
          </div>
        )}

        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Only the fields listed above are sent, and only to the model server on this device. The VM never
          receives your prompts. Engine values stay authoritative; the model explains them.
        </p>
      </div>
    </SectionCard>
  );
}
