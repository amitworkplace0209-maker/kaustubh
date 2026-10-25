'use client';

import { AlertTriangle } from 'lucide-react';

/**
 * Uniform inline error banner for a Data Center section.
 *
 * Lives in its own module so both the page and the lazily-loaded chart bundle
 * can render the same banner without either importing the other.
 */
export function SectionError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{error}</span>
    </div>
  );
}