'use client';

import { Building2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard, StatusBadge } from '@/components/design-system';
import { useTradingMode } from '@/lib/settings-store';
import { ShoonyaStatusPage } from '@/components/shoonya/status';
import { KOTAK_FULL_LABEL } from '@/lib/kotak';

/**
 * Kotak terminal layout wrapper. The Kotak terminal is the REAL-broker
 * surface — it reuses the Phase 2 theme tokens so its pages inherit the
 * user's terminal-wide appearance. It never fabricates data: any value that
 * the live broker cannot serve renders an honest empty/unavailable state.
 */
export function KotakPage({
  children,
  title,
  className,
}: {
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={cn('space-y-4', className)}
      data-kaustubh-app="trading"
      data-kaustubh-broker="kotak"
    >
      {title ? (
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <KotakBadge />
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function KotakBadge() {
  return (
    <div className="inline-flex items-center gap-2 rounded-md border bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold tracking-wide text-emerald-600 dark:text-emerald-400">
      <Zap className="h-3.5 w-3.5" />
      KOTAK NEO — LIVE BROKER
    </div>
  );
}

/** Connection gate: shoonya → status page, dummy → dummy terminal page,
 *  kotak-neo → real Kotak page. Mirrors the dashboard wrapper pattern so every
 *  trading route renders exactly one honest surface. */
export function KotakGate({
  dummy,
  kotak,
}: {
  dummy: React.ReactNode;
  kotak: React.ReactNode;
}) {
  const mode = useTradingMode();
  if (mode === 'shoonya') return <ShoonyaStatusPage />;
  if (mode === 'dummy') return dummy;
  return kotak;
}

export function KotakLiveCard({
  title,
  connected,
  children,
  className,
}: {
  title: string;
  connected?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <SectionCard
      title={title}
      icon={Building2}
      headerRight={
        <StatusBadge
          status={connected ? 'success' : 'neutral'}
          label={connected ? 'LIVE' : 'OFFLINE'}
        />
      }
      className={className}
    >
      {children}
    </SectionCard>
  );
}

export { KOTAK_FULL_LABEL };