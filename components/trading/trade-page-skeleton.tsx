'use client';

import { cn } from '@/lib/utils';

const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn('animate-pulse bg-muted rounded', className)} />
);

const SkeletonRow = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <div className={cn('flex items-center gap-2', className)}>{children}</div>
);

export function TradePageSkeleton() {
  return (
    <div className="dense-ui mx-auto flex min-h-full w-full max-w-5xl flex-col gap-3 pb-24 md:pb-4 animate-fade-in">
      {/* Status bar skeleton */}
      <div className="flex items-center gap-2 overflow-x-auto px-0.5">
        <Skeleton className="h-5 w-24 shrink-0" />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-32" />
        </div>
      </div>

      {/* Search skeleton */}
      <div className="sticky top-0 z-20 -mx-3 border-b border-border/50 bg-background/95 px-3 py-2 backdrop-blur md:-mx-6 md:px-6">
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>

      {/* Order card skeleton */}
      <div className="space-y-3 overflow-hidden rounded-xl border bg-card shadow-soft p-3">
        {/* Selected stock card skeleton */}
        <div className="border-b border-border/40 pb-3">
          <SkeletonRow className="gap-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-5 w-16 rounded-md" />
            </div>
            <Skeleton className="h-8 w-48 shrink-0" />
          </SkeletonRow>
          <Skeleton className="mt-2 h-3 w-40" />
          
          <div className="mt-3 flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-muted/40" />
          <div className="mt-1 flex justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>

        {/* Ticket skeleton */}
        <div className="space-y-2 p-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Skeleton className="h-11 w-full rounded-xl" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
          <Skeleton className="h-12 w-full rounded-xl" />
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <Skeleton className="h-10 flex-1 rounded-xl" />
            <Skeleton className="h-10 w-10 rounded-xl" />
            <Skeleton className="h-10 flex-1 rounded-xl" />
          </div>
          <Skeleton className="h-3 w-full" />
          <div className="grid grid-cols-2 gap-1.5">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        </div>

        {/* Margin/Value/Avail row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>

        {/* Execution state skeleton */}
        <Skeleton className="h-12 w-full rounded-lg border" />

        {/* Insights skeleton */}
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-xl border" />
          <Skeleton className="h-10 w-full rounded-xl border" />
          <Skeleton className="h-10 w-full rounded-xl border" />
          <Skeleton className="h-10 w-full rounded-xl border" />
        </div>
      </div>

      {/* Order bar skeleton */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-border/50 bg-background/95 px-3 py-2 backdrop-blur-md md:sticky md:bottom-0 md:z-20 md:-mx-6 md:px-6 md:backdrop-blur-sm">
        <Skeleton className="h-14 w-full rounded-xl border" />
        <div className="mt-1.5 flex items-center justify-between">
          <Skeleton className="h-3 w-48" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-8 w-20 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}