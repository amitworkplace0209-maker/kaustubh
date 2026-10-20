'use client';

/**
 * /trading/suggestion — intentionally EMPTY.
 *
 * The page shows a Coming Soon placeholder until the suggestion engine ships.
 * The complete (working) implementation is preserved — not routed — in
 * `./suggestion-workspace.tsx`; re-route it when the feature is ready.
 */

import { Sparkles } from 'lucide-react';

export function SuggestionPage(_props: { mode?: unknown }) {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-muted/40">
          <Sparkles className="h-5 w-5 text-muted-foreground" />
        </span>
        <h1 className="text-xl font-extrabold tracking-tight">Coming Soon</h1>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          The suggestion engine is on its way.
        </p>
      </div>
    </div>
  );
}
