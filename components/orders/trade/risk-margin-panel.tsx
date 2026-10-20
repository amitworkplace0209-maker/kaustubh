'use client';

import { Loader2, ShieldAlert, ShieldCheck, ShieldX, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard } from '@/components/design-system';
import type { DecisionKind, PrecheckSummary } from '@/components/orders/trade/types';

const KIND_META: Record<DecisionKind, { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string; Icon: typeof ShieldCheck }> = {
  PASS: { tone: 'success', label: 'Risk gate: PASS', Icon: ShieldCheck },
  WARNING: { tone: 'warning', label: 'Risk gate: WARNING', Icon: TriangleAlert },
  BLOCK: { tone: 'danger', label: 'Risk gate: BLOCK', Icon: ShieldX },
  EMERGENCY_BLOCK: { tone: 'danger', label: 'Trading suspended — terminal not connected', Icon: ShieldAlert },
  UNKNOWN: { tone: 'neutral', label: 'Risk gate: UNKNOWN', Icon: ShieldAlert },
};

// Themed tokens only — the hard-coded hex this used to carry ignored the active
// palette entirely and was one of the places the page stopped matching theme.
const TONE_TEXT = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  neutral: 'text-muted-foreground',
} as const;

const TONE_PILL = {
  success: 'border-success/40 bg-success/10',
  warning: 'border-warning/40 bg-warning/10',
  danger: 'border-destructive/40 bg-destructive/10',
  neutral: 'border-border bg-muted',
} as const;

export function RiskMarginPanel({
  precheck,
  supporting,
  checking,
  loggedIn,
}: {
  precheck: PrecheckSummary;
  supporting: boolean;
  checking: boolean;
  loggedIn: boolean;
}) {
  const { kind, label, reasons, checks, marginAvailable, marginMessage, marginRequired, checkedAt } = precheck;
  const meta = KIND_META[kind];
  const checksList = Object.entries(checks);

  return (
    <SectionCard title="Risk & margin gate">
      <div
        className={cn(
          'flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5',
          TONE_PILL[meta.tone],
        )}
      >
        <div className="min-w-0">
          <p className={cn('flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide', TONE_TEXT[meta.tone])}>
            <meta.Icon className="h-4 w-4 shrink-0" />
            {meta.label}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {label}
            {kind === 'EMERGENCY_BLOCK' && (
              <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                The terminal is not logged in, so the Risk Engine blocks trading outright (no bypass, no fake credit).
                Connect on the terminal page to resume.
              </span>
            )}
            {kind === 'UNKNOWN' && (
              <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                The risk service could not render a verdict — shown in full transparency instead of an invented pass.
              </span>
            )}
          </p>
        </div>
        {checking && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <span className="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-current opacity-60" />
              {r}
            </li>
          ))}
        </ul>
      )}

      {checksList.length > 0 && (
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {checksList.map(([name, ok]) => (
            <div
              key={name}
              className={cn(
                'flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-[11px]',
                ok ? 'border-success/30 bg-success/5 text-foreground/90' : 'border-destructive/30 bg-destructive/5 text-foreground/90',
              )}
            >
              <span className="font-medium capitalize">{name.replace(/_/g, ' ')}</span>
              <span className={ok ? 'font-bold text-success' : 'font-bold text-destructive'}>{ok ? 'PASS' : 'FAIL'}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Margin preview</p>
          <p className="mt-0.5 text-xs font-semibold">
            {supporting
              ? marginAvailable === true
                ? marginRequired != null
                  ? `₹${marginRequired.toLocaleString('en-IN', { maximumFractionDigits: 2 })} required`
                  : 'available'
                : marginAvailable === false
                  ? marginMessage || 'margin info unavailable'
                  : 'awaiting quote…'
              : marginMessage || 'not offered by this terminal'}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Risk verdict</p>
          <p className="mt-0.5 text-xs font-semibold">
            {checkedAt ? new Date(checkedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' · server-derived' : (loggedIn ? 'pending quote' : 'terminal offline')}
          </p>
        </div>
      </div>

      {!supporting && (
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/70">
          This terminal does not expose a margin API, so the account funds gate runs server-side inside the Risk
          Engine and returns the real verdict here.
        </p>
      )}
    </SectionCard>
  );
}