'use client';

import { useState } from 'react';
import { Wifi, Webhook, CalendarClock, UserRound, Activity, ArrowUpRight, Clock3 } from 'lucide-react';
import Link from 'next/link';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  fmtCountdown,
  fmtNextAt,
  fmtNextIn,
  levelTone,
  type NextActionInfo,
  type StatusEntry,
} from '@/lib/topbar-status';
import { useNowTick } from '@/components/layout/topbar/use-now-tick';
import {
  LogoutButton,
  ManualLoginButton,
  type SessionController,
} from '@/components/layout/topbar/session-action';

// The GlobalTopBar shows EXACTLY four indicators, always labeled by their dot:
// ● INTERNET  ● WEBSOCKET  ● SCHEDULER  ● SESSION. The state text lives in the
// tooltip/panel, never inline as a second word.
const PILL_LABELS: Record<string, string> = {
  net: 'INTERNET',
  ws: 'WEBSOCKET',
  sched: 'SCHEDULER',
  sess: 'SESSION',
};

const ICONS = {
  network: Wifi,
  webhook: Webhook,
  calendarClock: CalendarClock,
  user: UserRound,
} as const;

const GLOW: Record<string, string> = {
  healthy: 'shadow-[0_0_0_3px] shadow-success/15',
  warning: 'shadow-[0_0_0_3px] shadow-warning/15',
  error: 'shadow-[0_0_0_3px] shadow-destructive/15',
  offline: 'shadow-[0_0_0_3px] shadow-muted/20',
  neutral: 'shadow-[0_0_0_3px] shadow-muted/20',
  info: 'shadow-[0_0_0_3px] shadow-info/15',
  unknown: 'shadow-[0_0_0_3px] shadow-muted/20',
};

type Props = {
  entry: StatusEntry;
  className?: string;
  /**
   * Only supplied for the SESSION indicator, and only in a real-broker
   * terminal. It is what lets a market-closed Manual Login action appear
   * INSIDE the session indicator card, next to the live logout countdown.
   */
  session?: SessionController | null;
  /** Extra one-line context rendered under the "next action" row (e.g. the
   *  honest market-closed reason). */
  contextNote?: string | null;
};

/**
 * One status indicator.
 *
 *   • HOVER  → tooltip: current state, one-line detail, and the NEXT action
 *              with both its clock time and its live "in 4h 12m" countdown.
 *   • CLICK  → full diagnostics panel: the same next/after plan plus every real
 *              backend row, and (for SESSION) the login / logout action.
 *
 * The countdown interpolates locally from the backend's absolute instant using
 * `useNowTick`, but ONLY while the user is actually looking at this pill — the
 * topbar itself never re-renders on a timer.
 */
export function StatusPill({ entry, className, session, contextNote }: Props) {
  const [hovered, setHovered] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const tone = levelTone(entry.level);
  const Icon = ICONS[entry.icon as keyof typeof ICONS] ?? Activity;
  const label = PILL_LABELS[entry.id] ?? entry.label.toUpperCase();

  // Live only while this pill is being read.
  const nowMs = useNowTick(hovered || panelOpen);

  const next = entry.next ?? null;
  const after = entry.after ?? null;
  const showInlineLogin = entry.id === 'sess' && session?.needsLogin === true;

  const nextText = next ? `${next.label} · ${fmtNextIn(next, nowMs)}` : null;
  const aria = [
    `${label} · ${entry.state}`,
    entry.hint ? entry.hint : '',
    nextText ? `next ${nextText}` : '',
    'Hover for what happens next, click for live diagnostics.',
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <span
      className={cn(
        'group inline-flex shrink-0 select-none items-center gap-1.5 rounded-md border pr-1.5 text-[11px] font-medium tracking-wide transition-colors duration-200 lg:text-xs',
        tone.card,
        panelOpen && 'ring-1 ring-foreground/20',
        className,
      )}
      data-indicator={entry.id}
      data-level={entry.level}
    >
      <Tooltip open={hovered && !panelOpen} delayDuration={200}>
        <Popover open={panelOpen} onOpenChange={setPanelOpen}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild onMouseDown={(e) => e.preventDefault()}>
              <button
                type="button"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onFocus={() => setHovered(true)}
                onBlur={() => setHovered(false)}
                aria-label={aria}
                className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md pl-2 text-muted-foreground transition-colors hover:text-foreground lg:h-9 lg:pl-2.5"
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0 rounded-full transition-colors duration-300',
                    tone.dot,
                    GLOW[entry.level],
                  )}
                />
                <span className="whitespace-nowrap">{label}</span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>

          {/* ---- HOVER: the short answer — where it is + what happens next ---- */}
          <TooltipContent side="bottom" className="max-w-[19rem] p-0">
            <div className="space-y-1.5 px-2.5 py-2">
              <p className="text-xs font-semibold">
                {label} · <span className={tone.text}>{entry.state}</span>
                {entry.hint ? <span className="font-normal text-muted-foreground"> · {entry.hint}</span> : null}
              </p>
              <p className="text-[11px] leading-snug text-muted-foreground">{entry.detail}</p>
              <NextPlanLine next={next} nowMs={nowMs} tone={tone} />
              {after && <NextPlanLine next={after} nowMs={nowMs} tone={tone} muted />}
              {contextNote ? <p className="text-[11px] leading-snug text-warning/90">{contextNote}</p> : null}
              <p className="pt-0.5 text-[10px] text-muted-foreground/70">
                Click for full diagnostics{showInlineLogin ? ' · or log in now' : ''}
              </p>
            </div>
          </TooltipContent>

          {/* ---- CLICK: full diagnostics + real session actions ---- */}
          <PopoverContent side="bottom" align="start" className="w-[min(94vw,22rem)] p-0" sideOffset={6}>
            <div className="rounded-lg border bg-popover/95 p-3 backdrop-blur-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={cn('flex size-7 items-center justify-center rounded-md border', tone.bg, tone.ring)}>
                    <Icon className={cn('size-3.5', tone.text)} aria-hidden />
                  </span>
                  <p className="text-sm font-semibold tracking-tight">{label}</p>
                </div>
                <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', tone.bg, tone.text)}>
                  {entry.state}
                </span>
              </div>

              {/* Plan block — the headline the user actually came for. */}
              <div className="mb-2 space-y-1 rounded-md border border-border/60 bg-background/40 p-2">
                <NextPlanLine next={next} nowMs={nowMs} tone={tone} />
                {after && <NextPlanLine next={after} nowMs={nowMs} tone={tone} muted />}
                {contextNote ? <p className="text-[11px] leading-snug text-warning/90">{contextNote}</p> : null}
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border/60 pt-2">
                {entry.rows.slice(0, 12).map((row, i) => (
                  <div key={`${row.label}-${i}`} className="flex items-baseline gap-2">
                    <dt className="min-w-0 overflow-hidden text-[11px] text-muted-foreground">{row.label}</dt>
                    <dd className="ml-auto truncate text-[11px] font-semibold tabular-nums">{row.value}</dd>
                  </div>
                ))}
              </dl>

              {/* Real session actions. When a session is live this is the
                  countdown + logout; when the market is closed and no session
                  exists this is the Manual Login button. */}
              {session && (session.needsLogin || session.active) && (
                <div className="mt-3 space-y-1.5 border-t border-border/60 pt-2">
                  {session.active && (
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Auto-logs out in{' '}
                      <span className="font-semibold tabular-nums text-foreground">
                        {session.sync.remainingMs != null ? fmtCountdown(session.sync.remainingMs) : '—'}
                      </span>{' '}
                      ({session.sync.loginSource === 'SCHEDULER' ? 'scheduler-owned' : 'manual'} session).
                    </p>
                  )}
                  {session.needsLogin ? <ManualLoginButton controller={session} /> : <LogoutButton controller={session} />}
                  {session.failed && (
                    <p className="text-[11px] text-destructive" role="alert">
                      {session.failed}
                    </p>
                  )}
                </div>
              )}

              {entry.href && (
                <Link
                  href={entry.href}
                  className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-foreground/80 transition-colors hover:text-foreground"
                >
                  <ArrowUpRight className="size-3.5" aria-hidden />
                  Open details
                </Link>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </Tooltip>

      {/* The market-closed Manual Login affordance lives INSIDE the session
          indicator card, so the action the user needs is never one surface
          away from the state that requires it. */}
      {showInlineLogin && session && (
        <ManualLoginButton controller={session} variant="pill" className="mr-0.5" />
      )}
    </span>
  );
}

/** "▸ Next: WebSocket connect · 08:55 IST · in 4h 12m" — one honest line. */
function NextPlanLine({
  next,
  nowMs,
  tone,
  muted,
}: {
  next: NextActionInfo | null;
  nowMs: number | null;
  tone: ReturnType<typeof levelTone>;
  muted?: boolean;
}) {
  if (!next) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <Clock3 className="size-3 shrink-0" aria-hidden />
        Next action not published by the backend
      </p>
    );
  }
  return (
    <p className={cn('flex items-start gap-1.5 text-[11px] leading-snug', muted ? 'text-muted-foreground' : 'text-foreground')}>
      <Clock3 className={cn('mt-0.5 size-3 shrink-0', muted ? 'text-muted-foreground/60' : tone.text)} aria-hidden />
      <span className="min-w-0">
        <span className="text-muted-foreground">{muted ? 'Then' : 'Next'}:</span>{' '}
        <span className="font-semibold">{next.label}</span>
        <span className="text-muted-foreground"> · {fmtNextAt(next)} · </span>
        <span className={cn('font-semibold tabular-nums', next.passed ? 'text-muted-foreground' : tone.text)}>
          {fmtNextIn(next, nowMs)}
        </span>
      </span>
    </p>
  );
}

export type { Props as StatusPillProps };