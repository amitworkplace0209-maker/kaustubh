'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, Loader2, Target, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getTerminalTargets,
  removeTerminalTarget,
  setTerminalTarget,
  type TargetEntry,
} from '@/lib/terminal-service';
import type { ArmedTrigger } from '@/lib/trigger-store';

export interface TargetsPanelProps {
  terminal: string;
  symbol: string;
  sessionActive: boolean;
  armedTrigger: ArmedTrigger | null;
  currency: string;
}

/**
 * Target price for the selected instrument — the ENGINE-backed target.
 *
 * Targets live in the backend Target Engine (`/api/terminal/targets`), which
 * owns the square-off. The panel also surfaces an ARMED auto square-off from
 * the trigger registry so the operator can see that a bracket is live.
 */
export function TargetsPanel({
  terminal,
  symbol,
  sessionActive,
  armedTrigger,
  currency,
}: TargetsPanelProps) {
  const [targets, setTargets] = useState<TargetEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!symbol) return;
    setLoading(true);
    try {
      const res = await getTerminalTargets(terminal as any);
      const rows = Array.isArray(res?.data) ? res.data : [];
      setTargets(rows.filter((t) => String(t.symbol).toUpperCase() === symbol.toUpperCase()));
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Targets unavailable');
    } finally {
      setLoading(false);
    }
  }, [terminal, symbol]);

  useEffect(() => {
    if (!sessionActive) return;
    void load();
  }, [load, sessionActive]);

  const add = useCallback(async () => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setBusy(true);
    try {
      await setTerminalTarget(terminal as any, symbol, amount);
      setValue('');
      await load();
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not set the target');
    } finally {
      setBusy(false);
    }
  }, [terminal, symbol, value, load]);

  const remove = useCallback(
    async (sym: string) => {
      setBusy(true);
      try {
        await removeTerminalTarget(terminal as any, sym);
        await load();
      } catch (err: any) {
        setError(err?.message ?? 'Could not remove the target');
      } finally {
        setBusy(false);
      }
    },
    [terminal, load],
  );

  const mine = targets.filter((t) => String(t.symbol).toUpperCase() === symbol.toUpperCase());

  return (
    <section className="rounded-xl border border-border/70 bg-card p-3">
      <header className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">
        <Target className="h-3.5 w-3.5" />
        Targets
      </header>

      {armedTrigger && (
        <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-success/25 bg-success/[0.07] px-2.5 py-2 text-[12px] text-success">
          <Activity className="h-3.5 w-3.5 shrink-0" />
          Auto square-off armed · {armedTrigger.kind === 'TARGET' ? 'Target' : 'Stop loss'}{' '}
          {currency}
          {Number(armedTrigger.triggerPrice).toFixed(2)}
        </p>
      )}

      {mine.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {mine.map((t) => (
            <li
              key={t.id ?? t.symbol}
              className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-1.5"
            >
              <span className="min-w-0">
                <span className="block font-mono text-[13px] font-bold tabular-nums">
                  {currency}
                  {Number(t.targetValue).toFixed(2)}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  target value
                  {t.currentValue != null && (
                    <span className="font-mono">
                      {' '}
                      · now {currency}
                      {Number(t.currentValue).toFixed(2)}
                    </span>
                  )}
                </span>
              </span>
              <button
                type="button"
                aria-label="Remove target"
                disabled={busy}
                onClick={() => void remove(t.symbol)}
                className="shrink-0 rounded-md border border-border/60 p-1.5 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {loading ? 'Loading targets…' : 'No target set for this instrument.'}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        <Input
          aria-label="Target value"
          inputMode="decimal"
          placeholder="Target value"
          value={value}
          disabled={!sessionActive}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 font-mono text-[13px] font-semibold tabular-nums"
        />
        <Button
          type="button"
          size="sm"
          disabled={!sessionActive || busy || !(Number(value) > 0)}
          onClick={() => void add()}
          className={cn('h-9 shrink-0 rounded-lg px-3 text-[12px] font-bold')}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Set'}
        </Button>
      </div>

      {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
    </section>
  );
}
