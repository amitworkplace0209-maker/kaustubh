'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { ReactNode } from 'react';

export type InsightSectionTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface InsightSection {
  id: string;
  label: string;
  value: string;
  tone: InsightSectionTone;
  icon: React.ComponentType<{ className?: string }>;
  node: ReactNode;
}

interface InsightSheetProps {
  sections: InsightSection[];
}

export function InsightSheet({ sections }: InsightSheetProps) {
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (sections.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {sections.map(section => {
        const isOpen = openSections.has(section.id);
        return (
          <div key={section.id} className="rounded-xl border border-border/60 bg-card overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(section.id)}
              className="flex w-full items-center justify-between gap-2 p-2"
              aria-expanded={isOpen}
            >
              <div className="flex items-center gap-1.5">
                <section.icon className={cn('h-4 w-4 shrink-0', section.tone === 'success' ? 'text-success' : section.tone === 'warning' ? 'text-warning' : section.tone === 'danger' ? 'text-destructive' : section.tone === 'info' ? 'text-info' : 'text-muted-foreground')} />
                <span className="text-[12px] font-extrabold tracking-tight">{section.label}</span>
                <span className={cn('font-mono text-[11px] font-bold tabular-nums', section.tone === 'success' ? 'text-success' : section.tone === 'warning' ? 'text-warning' : section.tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')}>
                  {section.value}
                </span>
              </div>
              {isOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>

            {isOpen && (
              <div className="border-t border-border/50 p-2 animate-slide-up">
                {section.node}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}