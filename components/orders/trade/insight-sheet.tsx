'use client';

// ─────────────────────────────────────────────────────────────────────────────
// INSIGHT SHEET — live chips inline, detail on demand.
//
// WHY THIS EXISTS
// Charges / Risk / Target / Basket used to live behind one grey "Insights"
// toggle. On a phone that toggle was (a) an extra tap before you could even
// read the risk verdict, and (b) a full-width collapsible that pushed the order
// bar off-screen once opened.
//
// Now the SUMMARY is always on screen — four chips carrying the real, live
// values (risk verdict, charge estimate, armed brackets, basket legs) — and a
// tap on any chip opens the matching detail in a sheet. The order flow itself
// never needs the detail, so the page stays a single screen on a PWA.
//
// The chips read from the SAME state the panels read from; nothing here is
// recomputed, cached or invented.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useMediaQuery } from '@/hooks/use-media-query';

export type InsightSection = {
  id: string;
  label: string;
  /** Compact value shown on the chip — must be the real current value. */
  value: string;
  /** Chip colour family. */
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  icon: React.ElementType;
  node: React.ReactNode;
};

const CHIP_TONE: Record<InsightSection['tone'], string> = {
  success: 'border-success/30 bg-success/[0.08] text-success',
  warning: 'border-warning/30 bg-warning/[0.08] text-warning',
  danger: 'border-destructive/30 bg-destructive/[0.08] text-destructive',
  info: 'border-info/30 bg-info/[0.08] text-info',
  neutral: 'border-border/70 bg-card text-muted-foreground',
};

export function InsightSheet({ sections }: { sections: InsightSection[] }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Desktop gets a side drawer; the PWA gets the bottom sheet the user asked for.
  const isDesktop = useMediaQuery('(min-width: 768px)');

  const openAt = useCallback((id: string) => {
    setActiveId(id);
    setOpen(true);
    // The body only exists once the sheet has mounted — wait a frame, then bring
    // the requested section into view.
    window.setTimeout(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-insight="${id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }, []);

  if (sections.length === 0) return null;

  return (
    <>
      {/* ── Always-visible live summary ── */}
      <div className="-mx-1 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => openAt(s.id)}
            className={cn(
              'group flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left transition-colors active:scale-[0.99]',
              CHIP_TONE[s.tone],
            )}
          >
            <s.icon className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[9px] font-bold uppercase leading-tight tracking-wider opacity-80">
                {s.label}
              </span>
              <span className="block truncate font-mono text-[11px] font-bold leading-tight tabular-nums">{s.value}</span>
            </span>
            <ChevronRight className="h-3 w-3 shrink-0 opacity-40 transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side={isDesktop ? 'right' : 'bottom'}
          className={cn(
            'flex flex-col gap-0 border-border bg-background/98 p-0 backdrop-blur-xl',
            isDesktop ? 'sm:max-w-md' : 'max-h-[88vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]',
          )}
        >
          <SheetHeader className="shrink-0 border-b border-border/60 px-4 py-3">
            {/* Drag affordance — the classic bottom-sheet grabber. */}
            {isDesktop ? null : (
              <span aria-hidden className="mx-auto mb-1 h-1 w-10 rounded-full bg-border" />
            )}
            <SheetTitle className="flex items-center gap-2 text-[13px] font-bold tracking-tight">
              Order insights
              <span className="text-[10px] font-medium text-muted-foreground">
                charges · risk · targets · basket
              </span>
            </SheetTitle>
            <SheetDescription className="sr-only">
              Detailed order information. The order form above stays usable without opening this panel.
            </SheetDescription>
          </SheetHeader>

          <div ref={bodyRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {sections.map((s) => (
              <section
                key={s.id}
                data-insight={s.id}
                className={cn(
                  'scroll-mt-2 rounded-xl transition-shadow',
                  activeId === s.id ? 'ring-1 ring-primary/40' : '',
                )}
              >
                {s.node}
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}