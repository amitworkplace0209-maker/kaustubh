'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  getMobilePrimaryItems,
  isTradingShellConfig,
  type NavItem,
  type ShellConfig,
} from '@/components/layout/nav';
import { NavContent, SidebarBrand } from '@/components/layout/phase-sidebar';
import { SidebarTerminalSwitcher } from '@/components/layout/sidebar-terminal-switcher';

/**
 * MobileNav — the phone/tablet navigation model of the app.
 *
 *   BOTTOM BAR  → the MAIN pages of the active workspace (Dashboard, Trade,
 *                 Positions, …). Always visible, always one tap away.
 *   SIDEBAR     → every INNER page (the pages that live inside a main page:
 *                 Order Engine → Orders / History / Basket, Session Manager →
 *                 Session / Instruments / Sources / …).
 *
 * The drawer is the ONLY place the inner pages live on a small screen, so the
 * whole navigation tree must be reachable from it — that is the whole point of
 * keeping the bottom bar for main pages and moving the inner pages into a
 * sidebar.
 */

interface MobileNavContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const MobileNavContext = createContext<MobileNavContextValue | null>(null);

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo<MobileNavContextValue>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen((v) => !v),
    }),
    [open],
  );
  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>;
}

/**
 * `useMobileNav` is intentionally forgiving: a component that renders outside
 * the provider (isolated stories, error boundaries) gets a no-op controller
 * instead of crashing the whole tree.
 */
export function useMobileNav(): MobileNavContextValue {
  const ctx = useContext(MobileNavContext);
  if (ctx) return ctx;
  return { open: false, setOpen: () => {}, toggle: () => {} };
}

/** True when the item (or one of its children) is the current route. */
function isActiveRoute(item: NavItem, pathname: string): boolean {
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.children ?? []).some(
    (child) => pathname === child.href || pathname.startsWith(`${child.href}/`),
  );
}

/**
 * MobileNavDrawer — the phone sidebar.
 *
 * Three stacked sections:
 *   1. Brand + terminal switcher (trading only).
 *   2. MAIN PAGES — the same registry the bottom bar uses, as a quick grid.
 *   3. ALL PAGES — the full nav tree. The branch that owns the current route
 *      is expanded automatically, so the page you are on always shows its own
 *      siblings right next to it.
 */
export function MobileNavDrawer({ config }: { config: ShellConfig }) {
  const pathname = usePathname() ?? '/';
  const { open, setOpen } = useMobileNav();
  const router = useRouter();
  const isTradingShell = isTradingShellConfig(config);
  const mainPages = getMobilePrimaryItems(config, 4);
  const pendingHref = useRef<string | null>(null);

  const close = useCallback(() => setOpen(false), [setOpen]);

  // -------------------------------------------------------------------------
  // Android hardware-back integration.
  //
  // A native Android app pops its own stack when you press back; a PWA has to
  // borrow the browser history for that. While the drawer is open we push ONE
  // sentinel entry onto the history stack:
  //
  //   · back pressed  → the sentinel is popped, the drawer closes and the app
  //                     stays exactly where it was (no page change).
  //   · drawer closed → the sentinel is popped again, so the stack is unchanged
  //                     and a later back press still leaves the app.
  //   · link tapped  → the sentinel is popped FIRST, then the router navigates,
  //                     so the stack stays clean (no "dead" back step).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;

    window.history.pushState({ __kaustubhNavGuard: true }, '');

    const onPop = () => {
      const href = pendingHref.current;
      pendingHref.current = null;
      if (href) {
        // The sentinel was removed — now perform the navigation the user
        // asked for.
        router.push(href);
        return;
      }
      // Pure "back" gesture: swallow it and close the drawer.
      window.history.pushState({ __kaustubhNavGuard: true }, '');
      setOpen(false);
    };

    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed without a back gesture — drop the sentinel so the history
      // stack is exactly where it was before the drawer opened.
      if (window.history.state?.__kaustubhNavGuard) {
        window.history.back();
      }
    };
  }, [open, setOpen, router]);

  // Intercept navigation inside the drawer so the sentinel is removed BEFORE
  // the router pushes the new page (otherwise the stack keeps a dead entry).
  const onLinkClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!open) return;
      const anchor = (event.target as HTMLElement)?.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      event.preventDefault();
      event.stopPropagation();
      pendingHref.current = href;
      // Popping the sentinel triggers `onPop`, which performs the push.
      window.history.back();
    },
    [open],
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="left"
        onClickCapture={onLinkClick}
        className="flex w-[86vw] max-w-[21rem] flex-col gap-0 border-r border-border bg-card p-0 sm:max-w-[21rem]"
        data-mobile-nav-drawer
      >
        <SheetHeader className="shrink-0 border-b border-border px-4 pb-3 pt-4 text-left">
          <SheetTitle className="sr-only">{config.brand} navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Main pages live in the bottom bar. Inner pages are listed here.
          </SheetDescription>
          <div className="flex items-start gap-2 pr-9">
            <div className="min-w-0 flex-1">
              <SidebarBrand
                config={config}
                isTradingShell={isTradingShell}
                collapsed={false}
              />
            </div>
          </div>
          {isTradingShell && (
            <div className="mt-3 w-full">
              <SidebarTerminalSwitcher />
            </div>
          )}
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-2 pb-8 pt-3">
            {/* ---- MAIN PAGES (mirror of the bottom bar) ---------------- */}
            <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Main pages
            </p>
            <div className="grid grid-cols-2 gap-1.5 px-1 pb-4">
              {mainPages.map((item) => {
                const Icon = item.icon;
                const active = isActiveRoute(item, pathname);
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    onClick={close}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-[44px] items-center gap-2 rounded-xl px-2.5 py-2 text-[11px] font-semibold leading-tight transition-colors',
                      active
                        ? 'bg-primary/[0.14] text-primary ring-1 ring-primary/20'
                        : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>

            {/* ---- ALL PAGES (the full tree, inner pages included) -------- */}
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              All pages
            </p>
            <NavContent config={config} collapsed={false} onNavigate={close} />

            <p className="pt-4 pb-2 text-center text-[10px] text-muted-foreground/70">
              {config.version}
            </p>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
