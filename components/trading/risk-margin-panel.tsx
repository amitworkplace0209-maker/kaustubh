'use client';

import { Shield, AlertCircle, CheckCircle, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PrecheckSummary } from '@/components/orders/trade/types';

interface RiskMarginPanelProps {
  precheck: PrecheckSummary;
  supporting: boolean;
  checking: boolean;
  loggedIn: boolean;
}

const kindConfig = {
  PASS: { icon: CheckCircle, tone: 'success', label: 'PASS' },
  WARNING: { icon: AlertCircle, tone: 'warning', label: 'WARNING' },
  BLOCK: { icon: Shield, tone: 'danger', label: 'BLOCKED' },
  EMERGENCY_BLOCK: { icon: Shield, tone: 'danger', label: 'LOCKED' },
  UNKNOWN: { icon: Info, tone: 'neutral', label: 'UNKNOWN' },
};

export function RiskMarginPanel({ precheck, supporting, checking, loggedIn }: RiskMarginPanelProps) {
  const config = kindConfig[precheck.kind] || kindConfig.UNKNOWN;
  const Icon = config.icon;

  if (checking) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-xl border border-info/30 bg-info/5 px-2.5 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-info" />
          <span className="text-sm font-medium text-info">Checking risk policy…</span>
        </div>
        {!supporting && <p className="text-[10px] text-muted-foreground">Margin preview unavailable for this terminal.</p>}
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-2.5 py-2">
          <AlertCircle className="h-4 w-4 text-warning" />
          <span className="text-sm font-medium text-warning">Sign in to unlock risk checks</span>
        </div>
        <p className="text-[10px] text-muted-foreground">Risk precheck and margin preview require an active broker session.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className={cn('flex items-center gap-2 rounded-xl border px-2.5 py-2',
        config.tone === 'success' ? 'border-success/30 bg-success/5' :
        config.tone === 'warning' ? 'border-warning/30 bg-warning/5' :
        config.tone === 'danger' ? 'border-destructive/30 bg-destructive/5' :
        'border-border/50 bg-muted/20'
      )}>
        <Icon className={cn('h-4 w-4 shrink-0', config.tone === 'success' ? 'text-success' : config.tone === 'warning' ? 'text-warning' : config.tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')} />
        <span className={cn('text-sm font-bold uppercase tracking-wider', config.tone === 'success' ? 'text-success' : config.tone === 'warning' ? 'text-warning' : config.tone === 'danger' ? 'text-destructive' : 'text-foreground')}>
          {config.label}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{precheck.label}</span>
      </div>

      {precheck.marginRequired != null && (
        <div className="rounded-lg border border-border/50 bg-muted/20 p-2">
          <div className="flex items-center justify-between text-[10px]">
            <span className="font-bold uppercase tracking-wider text-muted-foreground">Margin Required</span>
            <span className="font-mono text-[12px] font-bold tabular-nums text-warning">₹{precheck.marginRequired.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
          </div>
          {precheck.marginAvailable !== null && (
            <div className="mt-1 flex items-center justify-between text-[10px]">
              <span className="font-bold uppercase tracking-wider text-muted-foreground">Available</span>
              <span className={cn('font-mono text-[12px] font-bold tabular-nums', precheck.marginAvailable ? 'text-success' : 'text-destructive')}>
                {precheck.marginAvailable ? 'Sufficient' : 'Insufficient'}
              </span>
            </div>
          )}
          {precheck.marginMessage && (
            <p className="mt-1 text-[10px] text-muted-foreground">{precheck.marginMessage}</p>
          )}
        </div>
      )}

      {precheck.reasons.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Checks</p>
          {precheck.reasons.map((reason, i) => (
            <div key={i} className="flex items-start gap-1.5 rounded-lg border border-border/50 bg-muted/20 px-2 py-1.5 text-[10px]">
              <Info className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground" />
              <span className="truncate">{reason}</span>
            </div>
          ))}
        </div>
      )}

      {Object.keys(precheck.checks).length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Details</p>
          {Object.entries(precheck.checks).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-2 py-1.5 text-[10px]">
              <span className="font-medium text-muted-foreground">{key}</span>
              <span className={cn('font-mono font-bold', value ? 'text-success' : 'text-destructive')}>
                {value ? 'PASS' : 'FAIL'}
              </span>
            </div>
          ))}
        </div>
      )}

      {!supporting && precheck.kind !== 'EMERGENCY_BLOCK' && (
        <p className="text-[10px] text-muted-foreground">Margin preview unavailable for this terminal.</p>
      )}
    </div>
  );
}