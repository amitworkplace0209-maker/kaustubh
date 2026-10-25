'use client';

import { useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, Menu, Search } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTradingMode } from '@/lib/settings-store';
import type { ShellConfig } from '@/components/layout/nav';
import { getAppByRoute, getAppMeta } from '@/lib/navigation/registry';
import {
  buildStatusLinks,
  getPhaseLabel,
  resolvePageContext,
} from '@/lib/topbar/context-registry';
import { useStatusState } from '@/components/layout/topbar/use-status-state';
import { StatusPill } from '@/components/layout/topbar/status-pill';
import { ThemeSelector } from '@/components/layout/topbar/theme-selector';
import { NotificationCenter } from '@/components/layout/topbar/notification-center';
import { AlertControl } from '@/components/layout/topbar/alert-control';
import { PhaseSwitcher } from '@/components/layout/phase-switcher';
import { UniversalSearch, useSearchShortcut } from '@/components/layout/universal-search';
import { useMobileNav } from '@/components/layout/mobile-nav-drawer';
import {
  ManualLoginButton,
  SessionCountdownChip,
  useSessionController,
} from '@/components/layout/topbar/session-action';
import { cn } from '@/lib/utils';

/**
 * GlobalTopBar — ONE shared topbar for every KAUSTUBH phase and page.
 *
 *   ROW 1 (≥md)   menu · PHASE › Page breadcrumb · four indicator cards ·
 *                 centred search field · session action · alerts · bell ·
 *                 theme · phase switcher
 *   ROW 2 (<md)   the four indicator cards on their own compact row
 *
 * The indicators carry the real backend plan: hovering one answers "what is
 * the state, what happens next, and when" without opening anything. The SESSION
 * indicator additionally hosts the Manual Login action (which is what the user
 * needs once the market has closed) and shows the live "auto-logs out in MM:SS"
 * countdown once a session exists. Everything is driven by the ONE central
 * realtime snapshot, the ONE /api/system poll and the ONE SessionSyncProvider.
 */
export function GlobalTopBar({ config }: { config: ShellConfig }) {
  const pathname = usePathname();
  const { toggle: toggleMobileNav } = useMobileNav();
  const tradingMode = useTradingMode();
  const isTrading = config.id.startsWith('trading');

  const links = useMemo(() => buildStatusLinks(config), [config]);
  const cluster = useStatusState(links);
  const session = useSessionController();
  const page = useMemo(
    () => resolvePageContext(config, pathname, isTrading ? tradingMode : undefined),
    [config, pathname, isTrading, tradingMode],
  );

  const [searchOpen, setSearchOpen] = useState(false);
  useSearchShortcut(setSearchOpen);

  const phaseLabel = useMemo(() => getPhaseLabel(page.phase), [page.phase]);
  const appMeta = getAppMeta(getAppByRoute(pathname));

  // The session indicator only exists in a real-broker terminal; DUMMY has no
  // broker session surface at all and must never render a login affordance.
  const sessionForPill = isTrading && session.terminal.terminal !== 'dummy' ? session : null;
  const showRightClusterSession = Boolean(sessionForPill && (session.active || session.needsLogin));
  // The honest market-closed line, shown only when the market really is closed.
  const marketNote = cluster.gate.closed ? cluster.gate.reason : null;
  /*
   * In DUMMY the SESSION indicator can be red with no action available. That is
   * correct (the dummy terminal is isolated and has no broker session), but
   * unexplained it reads as a broken button — so say so instead of leaving the
   * user staring at an indicator that will never respond.
   */
  const sessionNote =
    !isTrading
      ? null
      : session.terminal.terminal === 'dummy'
        ? 'Simulated terminal — the dummy engine has no broker session.'
        : marketNote;

  const pills = cluster.entries.map((entry) => (
    <StatusPill
      key={entry.id}
      entry={entry}
      session={entry.id === 'sess' ? sessionForPill : null}
      contextNote={entry.id === 'sess' ? sessionNote : null}
    />
  ));

  return (
    <TooltipProvider delayDuration={250}>
      <UniversalSearch open={searchOpen} onOpenChange={setSearchOpen} />

      <header
        className="sticky top-0 z-topbar w-full"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        {/* ROW 1 — 56px: identity · four indicator cards · center search · actions */}
        <div className="topbar-glass flex min-h-14 items-center gap-1.5 border-b border-border/60 px-3 sm:gap-2 sm:px-4">
          {/* Left: menu + app mark + PHASE > Page breadcrumb.
              Below md the permanent sidebar does not exist, so this button
              opens the mobile SIDEBAR (which carries every inner page).
              From md up the sidebar is permanent and carries its own
              collapse control, so the button is not rendered at all. */}
          <div className="flex min-w-0 shrink items-center gap-2">
            <button
              type="button"
              onClick={toggleMobileNav}
              aria-label="Open navigation"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
            >
              <Menu className="size-5" aria-hidden />
            </button>

            <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <appMeta.icon className="size-3.5" aria-hidden />
              </span>
              <span className="hidden whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70 xl:inline">
                {phaseLabel}
              </span>
              <span className="hidden text-muted-foreground/40 xl:inline" aria-hidden>
                <ArrowUpRight className="size-3 -rotate-45" />
              </span>
              <span
                className={cn('truncate text-sm font-semibold text-foreground', 'max-w-[110px] md:max-w-[150px] xl:max-w-[220px]')}
                data-topbar-breadcrumb
              >
                {page.title}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 sm:hidden">
              <appMeta.icon className="size-4 shrink-0 text-primary" aria-hidden />
              <span className="truncate text-sm font-semibold">{page.title}</span>
            </div>
          </div>

          {/* The four indicator cards (≥md) */}
          <div className="hidden shrink-0 items-center gap-1 md:flex" data-topbar-cluster>
            {pills}
          </div>

          {/* Center: universal search field — visibly centered, capped width */}
          <div className="flex min-w-0 flex-1 items-center justify-center px-1 lg:px-2">
            <div className="w-full min-w-0 max-w-[200px] lg:max-w-[300px] xl:max-w-[420px]">
              <SearchControl onOpenChange={setSearchOpen} />
            </div>
          </div>

          {/* Right: contextual session action · alerts · notifications · theme · phase */}
          <div className="flex shrink-0 items-center justify-end gap-0.5 sm:gap-1">
            {showRightClusterSession && (
              <>
                {session.active ? <SessionCountdownChip controller={session} /> : <ManualLoginButton controller={session} className="max-sm:px-2 max-sm:text-[10px]" />}
              </>
            )}

            <AlertControl config={config} />
            <NotificationCenter config={config} />
            <ThemeSelector />

            <span className="mx-0.5 hidden h-5 w-px bg-border lg:block" aria-hidden />

            <div className="hidden lg:block">
              <PhaseSwitcher variant="compact" />
            </div>
          </div>
        </div>

        {/* ROW 2 — mobile/PWA only (<md): the four indicator cards on ONE row.
            This used to be `grid-cols-2 ... sm:grid-cols-4`, which wrapped into
            two rows below 640px and permanently consumed ~110px of a phone
            viewport before the page even started — the single biggest obstacle
            to a one-screen order flow in the PWA. Four columns fit at 390px
            (≈93px each) and give the trade ticket ~55px of its height back.
            Tapping SESSION opens the same panel with the login/logout action. */}
        <div
          className="topbar-glass-sub grid grid-cols-4 items-center gap-1 border-b border-border/60 px-2 py-1.5 md:hidden"
          data-topbar-cluster-mobile
        >
          {pills}
        </div>
      </header>
    </TooltipProvider>
  );
}

/**
 * Search trigger: a real field from lg up (centred, capped), and a 44px tap
 * target below that — it now appears as a field on tablets too so the search
 * section is never reduced to an unlabelled icon on a wide-ish screen.
 */
function SearchControl({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return (
    <>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            aria-label="Open search (Ctrl+K)"
            className="hidden h-9 w-full select-none items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:inline-flex"
          >
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">Search pages, stocks, actions…</span>
            <kbd className="inline-flex shrink-0 items-center gap-0.5 rounded border bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
              <span className="text-[8px]">Ctrl</span>K
            </kbd>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Search everything (Ctrl+K)</TooltipContent>
      </Tooltip>

      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label="Open search"
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
      >
        <Search className="size-5" aria-hidden />
      </button>
    </>
  );
}

export { GlobalTopBar as ShellTopbar };