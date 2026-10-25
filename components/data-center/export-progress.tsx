'use client';

// ---- Data Center export progress ----
// Stage-based stepper driven by REAL backend job stages. The percentage is
// shown only when the backend reports one (>0) — never fabricated.

import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ExportStage =
  | 'idle'
  | 'queued'        // Preparing export
  | 'fetching'      // Fetching data
  | 'generating'    // Generating files (backend: generating/saving)
  | 'zipping'       // Creating ZIP
  | 'completed';    // Ready

const STAGES: { key: ExportStage; label: string }[] = [
  { key: 'queued', label: 'Preparing export' },
  { key: 'fetching', label: 'Fetching data' },
  { key: 'generating', label: 'Generating files' },
  { key: 'zipping', label: 'Creating ZIP' },
  { key: 'completed', label: 'Ready' },
];

const ORDER: ExportStage[] = ['idle', 'queued', 'fetching', 'generating', 'zipping', 'completed'];

/** Map a raw backend stage string onto the UI stepper. */
export function toUiStage(raw: string): ExportStage {
  switch (raw) {
    case 'fetching': return 'fetching';
    case 'generating':
    case 'saving': return 'generating';
    case 'zipping': return 'zipping';
    case 'completed': return 'completed';
    default: return 'queued';
  }
}

export function stageButtonLabel(stage: ExportStage): string {
  switch (stage) {
    case 'queued': return 'Preparing…';
    case 'fetching': return 'Fetching…';
    case 'generating': return 'Generating…';
    case 'zipping': return 'Packaging…';
    case 'completed': return 'Download Ready';
    default: return '';
  }
}

export default function ExportProgress({
  stage,
  progressPercent,
}: {
  stage: ExportStage;
  /** Real backend percentage; null/0 → no number shown. */
  progressPercent?: number | null;
}) {
  const activeIndex = Math.max(ORDER.indexOf(stage === 'idle' ? 'queued' : stage), 1);
  const showPct =
    typeof progressPercent === 'number' && progressPercent > 0 && stage !== 'completed';

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Export progress</span>
        {showPct ? (
          <span className="font-mono tabular-nums text-primary">{progressPercent}%</span>
        ) : stage !== 'completed' ? (
          <span className="flex items-center gap-1 text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> working…
          </span>
        ) : (
          <span className="text-success">done</span>
        )}
      </div>
      <ol className="grid grid-cols-5 items-start gap-1">
        {STAGES.map((s, i) => {
          const idx = i + 1; // 1..5 aligned with ORDER positions
          const done = idx < activeIndex || stage === 'completed';
          const active = idx === activeIndex && stage !== 'completed';
          return (
            <li key={s.key} className="flex min-w-0 flex-col items-center gap-1 text-center">
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold transition-colors',
                  done && 'border-success/60 bg-success/15 text-success',
                  active && 'border-primary bg-primary/15 text-primary',
                  !done && !active && 'border-border/60 bg-muted/40 text-muted-foreground/60',
                )}
              >
                {done ? <Check className="h-3 w-3" /> : active ? <Loader2 className="h-3 w-3 animate-spin" /> : idx}
              </span>
              <span
                className={cn(
                  'w-full truncate text-[9px] leading-tight',
                  done || active ? 'text-foreground' : 'text-muted-foreground/70',
                )}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
      {/* Determinate bar only when the backend reports real progress */}
      {showPct && (
        <span className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${Math.min(progressPercent ?? 0, 100)}%` }}
          />
        </span>
      )}
    </div>
  );
}
