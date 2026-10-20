'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowUpDown, Check, ChevronDown, Loader2, Monitor, Landmark, Radar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toTerminalId, type TradingMode } from '@/lib/settings-store';
import { getTerminalList, type TerminalInfo } from '@/lib/terminal-service';
import {
  TERMINAL_ACCENT,
  TERMINAL_ICON_TONE,
  TRADING_TERMINALS,
  useTerminal,
} from '@/components/terminal/terminal-provider';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

/**
 * Terminal icon mapping — each terminal gets a distinct, semantically
 * appropriate icon from the project's existing Lucide icon library.
 */
const TERMINAL_ICONS: Record<TradingMode, React.ElementType> = {
  dummy: Monitor,
  'kotak-neo': Landmark,
  shoonya: Radar,
};

/**
 * Single canonical terminal selector — lives in the Trading Terminal sidebar,
 * directly under the brand header. Clicking the trigger opens a premium
 * dropdown (mouse, touch, PWA, keyboard and collapsed-sidebar friendly).
 * Switching is a plain context switch: no reload, no confirm. Broker sign-in
 * stays in each terminal's own connection UI.
 *
 * Per-terminal status dots reflect the REAL backend /api/terminal/list state
 * only — never fabricated. When the list cannot be fetched no status is drawn.
 */
export function SidebarTerminalSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { mode, busy, error, switchTo, clearError } = useTerminal();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Real backend terminal statuses (fetched once + whenever the menu opens).
  const [statuses, setStatuses] = useState<Record<string, TerminalInfo> | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    getTerminalList()
      .then((res) => {
        if (!alive) return;
        const map: Record<string, TerminalInfo> = {};
        for (const t of res.terminals ?? []) map[t.id] = t;
        setStatuses(map);
      })
      .catch(() => {
        if (alive) setStatuses(null);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const activeIdx = Math.max(
    0,
    TRADING_TERMINALS.findIndex((t) => t.id === mode),
  );
  const active = TRADING_TERMINALS[activeIdx];
  const ActiveIcon = TERMINAL_ICONS[active.id];

  const select = useCallback((target: TradingMode) => {
    if (target === mode || busy) return;
    setOpen(false);
    clearError();
    void switchTo(target);
  }, [mode, busy, clearError, switchTo]);

  const terminalStatus = (id: TradingMode) => {
    if (!statuses) return null;
    const info = statuses[toTerminalId(id)];
    if (!info) return null;
    if (info.isLoggedIn) return { tone: 'text-success', dot: 'bg-success', label: 'Connected' };
    if (info.enabled === false) return { tone: 'text-warning', dot: 'bg-warning', label: 'Not enabled' };
    return { tone: 'text-muted-foreground', dot: 'bg-muted-foreground', label: 'Offline' };
  };

  if (collapsed) {
    return (
      <DropdownMenuPrimitive.Root open={open} onOpenChange={setOpen}>
        <DropdownMenuPrimitive.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className={cn(
              'group flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 bg-background/50 text-foreground transition-all duration-200',
              'hover:border-primary/40 hover:bg-primary/5 hover:shadow-sm hover:shadow-primary/10',
              'focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'active:scale-[0.96]',
              open && 'border-primary/50 bg-primary/5 shadow-sm shadow-primary/10',
            )}
            aria-haspopup="menu"
            aria-expanded={open}
            title={`Trading Terminal · ${active.label}`}
          >
            <ActiveIcon className={cn('h-4 w-4 transition-colors', TERMINAL_ICON_TONE[active.id])} />
          </button>
        </DropdownMenuPrimitive.Trigger>
        <TerminalDropdownContent
          align="start"
          side="right"
          sideOffset={8}
          mode={mode}
          busy={busy}
          error={error}
          terminalStatus={terminalStatus}
          onSelect={select}
        />
      </DropdownMenuPrimitive.Root>
    );
  }

  return (
    <DropdownMenuPrimitive.Root open={open} onOpenChange={setOpen}>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            'group flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-border/60 bg-background/50 px-3 py-2.5 text-left outline-none transition-all duration-200',
            'hover:border-primary/40 hover:bg-primary/[0.04] hover:shadow-sm hover:shadow-primary/10',
            'focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'active:scale-[0.995]',
            open && 'border-primary/50 bg-primary/[0.06] shadow-sm shadow-primary/10',
          )}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Trading Terminal · ${active.label}`}
        >
          <span className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
            open || busy
              ? 'border-primary/20 bg-primary/10'
              : 'border-border/60 bg-muted/40 group-hover:border-primary/20 group-hover:bg-primary/10',
          )}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <ActiveIcon className={cn('h-4 w-4 transition-colors', TERMINAL_ICON_TONE[active.id])} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Terminal
            </span>
            <span className={cn('block text-xs font-bold tracking-wide', TERMINAL_ACCENT[active.id])}>
              {active.label}
            </span>
          </span>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform duration-200',
              'group-hover:text-foreground/70',
              open && 'rotate-180 text-primary/70',
            )}
            aria-hidden="true"
          />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <TerminalDropdownContent
        align="start"
        side="bottom"
        sideOffset={4}
        mode={mode}
        busy={busy}
        error={error}
        terminalStatus={terminalStatus}
        onSelect={select}
      />
    </DropdownMenuPrimitive.Root>
  );
}

/**
 * TerminalDropdownContent — the shared premium dropdown panel used by both
 * expanded and collapsed modes. Uses Radix portal by default to escape any
 * stacking context issues.
 */
function TerminalDropdownContent({
  align,
  side,
  sideOffset,
  mode,
  busy,
  error,
  terminalStatus,
  onSelect,
}: {
  align: 'start' | 'end';
  side: 'bottom' | 'right';
  sideOffset: number;
  mode: TradingMode;
  busy: boolean;
  error: string | null;
  terminalStatus: (id: TradingMode) => { tone: string; dot: string; label: string } | null;
  onSelect: (target: TradingMode) => void;
}) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          'z-[70] min-w-[260px] overflow-hidden rounded-2xl border border-border/70 bg-popover p-1.5 shadow-xl shadow-black/10',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=right]:slide-in-from-left-2',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <ArrowUpDown className="h-3.5 w-3.5 text-primary/60" />
          <div className="flex flex-col">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70">
              Trading Terminal
            </span>
            <span className="text-[10px] text-muted-foreground/50">
              Select trading environment
            </span>
          </div>
        </div>

        <div className="mx-3 h-px bg-border/50" />

        {/* Terminal items */}
        <div className="py-1.5">
          {TRADING_TERMINALS.map((t) => {
            const Icon = TERMINAL_ICONS[t.id];
            const st = terminalStatus(t.id);
            const isActive = mode === t.id;
            return (
              <DropdownMenuPrimitive.Item
                key={t.id}
                onSelect={() => onSelect(t.id)}
                disabled={busy}
                className={cn(
                  'group/item relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 outline-none transition-all duration-150',
                  'focus:bg-muted/60 focus:outline-none',
                  isActive
                    ? 'bg-primary/[0.08]'
                    : 'hover:bg-muted/50',
                  busy && 'opacity-60 cursor-not-allowed',
                )}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_6px] shadow-primary/40" />
                )}

                {/* Terminal icon */}
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-all duration-150',
                    isActive
                      ? 'border-primary/20 bg-primary/10 shadow-sm shadow-primary/10'
                      : 'border-border/60 bg-muted/30 group-hover/item:border-border group-hover/item:bg-muted/60',
                  )}
                >
                  <Icon className={cn('h-4 w-4 transition-colors', TERMINAL_ICON_TONE[t.id])} />
                </span>

                {/* Label + description */}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'truncate text-sm font-semibold leading-tight',
                        isActive ? 'text-primary' : 'text-foreground',
                      )}
                    >
                      {t.label}
                    </span>
                    {st && (
                      <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                        <span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} />
                        {st.label}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground/60">
                    {isActive ? `${t.hint} · active` : t.hint}
                  </span>
                </span>

                {/* Checkmark */}
                {isActive && (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Check className="h-3 w-3" aria-hidden="true" />
                  </span>
                )}
              </DropdownMenuPrimitive.Item>
            );
          })}
        </div>

        {/* Status messages */}
        {busy && (
          <>
            <div className="mx-3 h-px bg-border/50" />
            <div className="px-3 py-2">
              <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[10px] text-primary">
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                <span>Switching terminal — sidebar and data source update together.</span>
              </div>
            </div>
          </>
        )}
        {!busy && error && (
          <>
            <div className="mx-3 h-px bg-border/50" />
            <div className="px-3 py-2">
              <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[10px] text-warning">
                {error}
              </div>
            </div>
          </>
        )}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}
