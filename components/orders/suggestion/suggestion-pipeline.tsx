'use client';

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/design-system';
import { SUGGESTION_PIPELINE, suggestionOutcome, suggestionStatusTone, type DummySuggestion } from '@/lib/dummy';
import { suggestionStageState, TERMINAL_STAGES, type SuggestionCheck } from './types';

function stageState(stage: string, s: DummySuggestion) {
  return suggestionStageState(stage, s.status, s.pipeline);
}

export function SuggestionPipeline({ suggestion, compact }: { suggestion: DummySuggestion; compact?: boolean }) {
  const outcome = suggestionOutcome(suggestion);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={suggestionStatusTone(suggestion.status)} label={suggestion.status} />
        <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold', {
          'border-success/30 bg-success/10 text-success': outcome.tone === 'success',
          'border-destructive/30 bg-destructive/10 text-destructive': outcome.tone === 'danger',
          'border-warning/30 bg-warning/10 text-warning': outcome.tone === 'warning',
        })}>
          {outcome.label}
        </span>
      </div>

      {!compact && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
          {SUGGESTION_PIPELINE.map((stage, i) => {
            const st = stageState(stage, suggestion);
            return (
              <div key={stage} className="flex items-center gap-1">
                {i > 0 && <span className="h-px w-2 bg-border" />}
                <span
                  className={cn('rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider', {
                    'bg-success/15 text-success': st === 'visited',
                    'bg-info/20 text-info': st === 'active',
                    'bg-muted text-muted-foreground/40': st === 'pending',
                    'bg-border/50 text-muted-foreground/30 line-through': st === 'skipped',
                  })}
                >
                  {stage.replace(/_/g, ' ')}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {suggestion.checks && suggestion.checks.length > 0 && (
        <div className="space-y-1">
          {suggestion.checks.map((check: SuggestionCheck) => (
            <div
              key={check.name}
              className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5"
            >
              {check.passed ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-foreground/90">
                  {check.label || check.name}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {check.passed ? 'passed' : 'failed'}
                  </span>
                </p>
                {check.message && <p className="text-[10px] leading-relaxed text-muted-foreground">{check.message}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {!checkMap(suggestion).allDone && !TERMINAL_STAGES.has((suggestion.status || '').toUpperCase()) && (
        <p className="flex items-center gap-1.5 rounded-lg border border-info/30 bg-info/10 px-2.5 py-1.5 text-[10px] text-foreground/80">
          <AlertTriangle className="h-3 w-3 text-info" />
          Pipeline gates run server-side on process — this row shows the engine's live state, not a client simulation.
        </p>
      )}
    </div>
  );
}

function checkMap(s: DummySuggestion): { allDone: boolean; failed: number } {
  const checks = s.checks || [];
  return {
    allDone: checks.length > 0 && checks.every((c) => c.passed),
    failed: checks.filter((c) => !c.passed).length,
  };
}