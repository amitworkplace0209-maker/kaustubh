'use client';

/**
 * The skeleton for the trade page — the shape the page has while it loads.
 *
 * It mirrors the new layout (rail, search, quote header, ticket, money strip,
 * inspector) so the page does not jump when the real content arrives.
 */
export function TradePageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 pb-28 md:pb-4" aria-busy="true">
      <div className="flex items-center gap-2">
        <Bar className="h-4 w-24" />
        <Bar className="h-4 w-16" />
        <div className="ml-auto flex gap-1.5">
          <Bar className="h-5 w-20 rounded-full" />
          <Bar className="h-5 w-20 rounded-full" />
          <Bar className="h-5 w-16 rounded-full" />
        </div>
      </div>

      <Bar className="h-11 w-full rounded-xl" />

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-border/60 bg-card p-3">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Bar className="h-5 w-36" />
                <Bar className="h-3 w-52" />
              </div>
              <div className="space-y-2 text-right">
                <Bar className="h-7 w-28" />
                <Bar className="h-3 w-20" />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Bar className="h-2.5 w-12" />
                  <Bar className="h-3.5 w-16" />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-border/60 bg-card p-3">
            <Bar className="h-10 w-full rounded-lg" />
            <Bar className="h-10 w-full rounded-lg" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Bar className="h-11 w-full rounded-lg" />
              <Bar className="h-11 w-full rounded-lg" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-card p-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Bar className="h-2.5 w-16" />
                <Bar className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-xl border border-border/60 bg-card p-3">
          <Bar className="h-9 w-full rounded-lg" />
          <Bar className="h-4 w-2/3" />
          <Bar className="h-3 w-full" />
          <Bar className="h-3 w-4/5" />
        </div>
      </div>

      <div className="h-14 w-full rounded-xl border border-border/60 bg-card/60" />
    </div>
  );
}

function Bar({ className }: { className: string }) {
  return <div className={`animate-pulse bg-muted/70 ${className}`} />;
}
