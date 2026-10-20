'use client';

// ---- Professional refresh control ----
// Shows subtle loading state; duplicate clicks while a request is in flight
// are ignored by the caller's busy-guard (useAccountData).

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function RefreshButton({
  onClick, refreshing, disabled,
}: {
  onClick: () => void;
  refreshing: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 shrink-0 gap-1.5 rounded-lg px-3 text-xs font-semibold"
      onClick={onClick}
      disabled={disabled || refreshing}
      aria-label="Refresh account data"
    >
      <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
      Refresh
    </Button>
  );
}
