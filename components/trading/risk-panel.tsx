'use client';

import { memo } from 'react';
import { CheckCircle2, Loader2, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PrecheckSummary } from '@/components/orders/trade/types';

export interface RiskPanelProps {
  precheck: PrecheckSummary;
  checking: boolean;
  /** True when the terminal exposes a real broker margin API. */
  supportsMargin: boolean;
  marginMessage: string | null;
  sessionActive: boolean;
}

/**
 * The risk verdict, as the Risk Engine returned it.
 *
 * The UI never decides whether an order may pass — it renders the server's
 * verdict and the reasons behind it. An unknown state is shown as unknown.
 */
export const RiskPanel = memo(function RiskPanel({
  precheck,
  checking,
  supportsMargin,
  marginMessage,
  sessionActive,
}: RiskPanelProps) {
  const kind = checking ? 'UNKNOWN' : precheck.kind;
  const tone =
    kind === 'PASS'
      ? 'success'
      : kind === 'WARNING'
        ? 'warning'
        : kind === 'BLOCK' || kind === 'EMERGENCY_BLOCK'
          ? 'danger'
          : 'neutral';

  const Icon =
    kind === 'PASS'
      ? ShieldCheck
      : kind === 'WARNING'
        ? ShieldAlert
        : kind === 'BLOCK' || kind === 'EMERGENCY_BLOCK'
          ? ShieldX
          : Loader2;

  const label =
    kind === 'PASS'
      ? 'PASS'
      : kind === 'WARNING'
        ? 'WARN'
        : kind === 'BLOCK'
          ? 'BLOCK'
          : kind === 'EMERGENCY_BLOCK'
            ? 'LOCKED'
            : 'UNKNOWN';

  const checks = Object.entries(precheck.checks ?? {});

  return (
    <section className="rounded-xl border border-border/70 bg-card p-3">
      <header className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider',
            tone === 'success' && 'border-success/40 bg-success/10 text-success',
            tone === 'warning' && 'border-warning/40 bg-warning/10 text-warning',
            tone === 'danger' && 'border-destructive/40 bg-destructive/10 text-destructive',
            tone === 'neutral' && 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          <Icon className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
          {checking ? 'checking' : label}
        </span>
        {precheck.checkedAt && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {new Date(precheck.checkedAt).toLocaleTimeString('en-IN', { hour12: false })}
          </span>
        )}
      </header>

      <p className="mt-2 text-[13px] leading-relaxed text-foreground">{precheck.label}</p>

      {!sessionActive && (
        <p className="mt-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-[12px] text-muted-foreground">
          No broker session — the Risk Engine evaluates the policy, the broker session decides the
          rest.
        </p>
      )}

      {precheck.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {precheck.reasons.map((r) => (
            <li key={r} className="flex items-start gap-1.5 text-[12px] text-destructive">
              <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              {r}
            </li>
          ))}
        </ul>
      )}

      {checks.length > 0 && (
        <ul className="mt-2 space-y-1">
          {checks.map(([name, ok]) => (
            <li key={name} className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <ShieldX className="h-3.5 w-3.5 shrink-0 text-destructive" />
              )}
              <span className="capitalize">{name.replace(/_/g, ' ')}</span>
              <span className={cn('font-semibold', ok ? 'text-success' : 'text-destructive')}>
                {ok ? 'pass' : 'fail'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {marginMessage && (
        <p className="mt-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-[12px] text-muted-foreground">
          {marginMessage}
        </p>
      )}

      {!supportsMargin && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
          This terminal has no broker margin API — the margin shown is a locally derived estimate.
        </p>
      )}
    </section>
  );
});
