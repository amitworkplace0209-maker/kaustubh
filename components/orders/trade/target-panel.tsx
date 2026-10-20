'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard, EmptyState } from '@/components/design-system';
import {
  getTerminalTargets,
  removeTerminalTarget,
  setTerminalTarget,
  toTerminalId,
  type TargetEntry,
} from '@/lib/terminal-service';
import type { TradingMode } from '@/lib/settings-store';
import { fmtMoney, type TradeCapabilities } from '@/components/orders/trade/capabilities';

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm tabular-nums outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/25 disabled:opacity-60';

export function TargetPanel({
  mode,
  caps,
  symbol,
  loggedIn,
}: {
  mode: TradingMode;
  caps: TradeCapabilities;
  symbol?: string;
  loggedIn: boolean;
}) {
  const terminal = toTerminalId(mode);
  const [targets, setTargets] = useState<TargetEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await getTerminalTargets(terminal);
      setTargets(res?.data ?? []);
      setError('');
    } catch (err: any) {
      setError(err?.message ?? 'targets unavailable');
    } finally {
      setLoaded(true);
    }
  }, [terminal]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const currency = caps.virtualCurrency ? 'Coin' : caps.accountCurrency;

  const add = async () => {
    const value = Number(amount);
    if (!symbol || !Number.isFinite(value) || value <= 0) return;
    setLoading(true);
    setError('');
    try {
      const res = await setTerminalTarget(terminal, symbol, value);
      if (res?.ok) {
        setAmount('');
        setTargets((prev) => [
          ...prev.filter((t) => !(t.symbol === symbol && t.terminal === terminal)),
          res.data as TargetEntry,
        ]);
      } else {
        setError('target engine rejected the value');
      }
    } catch (err: any) {
      setError(err?.message ?? 'failed to set target');
    } finally {
      setLoading(false);
    }
  };

  const remove = async (sym: string) => {
    setError('');
    try {
      await removeTerminalTarget(terminal, sym);
      setTargets((prev) => prev.filter((t) => t.symbol !== sym));
    } catch (err: any) {
      setError(err?.message ?? 'failed to remove target');
    }
  };

  const isDummyOnly = !caps.virtualCurrency;

  return (
    <SectionCard title="Portfolio target" icon={Target}>
      {isDummyOnly ? (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The Target Engine is backed by the <strong>Dummy projection</strong> (per-engine scope). Fed terminals
            do not project paper targets, so this panel is intentionally dormant here instead of faking a number.
          </p>
          <EmptyState
            icon={Target}
            title="Target engine: Dummy-only"
            description="Switch to Dummy Mode on the terminal page to manage conversation targets."
            action={<span className="text-[10px] text-muted-foreground/60">read-only</span>}
          />
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={!symbol || !loggedIn || loading}
              className={inputCls}
              placeholder={symbol ? `Target (${currency})` : 'select an instrument first'}
              aria-label="Target amount"
            />
            <button
              type="button"
              onClick={add}
              disabled={!symbol || !loggedIn || loading}
              className="h-9 shrink-0 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Set'}
            </button>
          </div>

          {!loggedIn && (
            <p className="mt-2 text-[10px] text-destructive">Target changes require a logged-in terminal.</p>
          )}

          {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}

          {!loaded ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading targets&hellip;
            </div>
          ) : targets.length === 0 ? (
            <EmptyState
              icon={Target}
              className="mt-3"
              title="No targets set"
              description="Set a projected target for the selected instrument to track it."
            />
          ) : (
            <div className="mt-3 space-y-1.5">
              {targets.map((t) => (
                <div
                  key={t.symbol}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold">{t.symbol}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      target {fmtMoney(t.targetValue, currency)} · prod {t.product ?? 'MIS'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(t.symbol)}
                    className={cn(
                      'shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground',
                      'hover:border-destructive/40 hover:text-destructive',
                    )}
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}