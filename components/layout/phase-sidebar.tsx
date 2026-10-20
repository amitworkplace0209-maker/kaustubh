'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { findNavByPath, type ShellConfig, type NavItem } from '@/components/layout/nav';
import {
  childActive, subtreeActive,
} from '@/lib/nav-utils';
import { usePhase2 } from '@/components/phase2/provider';
import { KAUSTUBH_APPS, getAppById, type AppId } from '@/lib/apps';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ShoonyaShell } from '@/components/trading/shoonya-shell';
import { SidebarTerminalSwitcher } from '@/components/layout/sidebar-terminal-switcher';
import { useActiveAlertCount, useUnreadCount } from '@/lib/shared-notifications';
import { getDummyNotifications } from '@/lib/dummy';

/**
 * Dummy-phase unread badge. Reads ONLY /api/dummy/notifications so the Dummy
 * sidebar never shows Data Saver / Services alert counts.
 */
function useDummyUnread(): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      getDummyNotifications('', 100)
        .then((res) => {
          if (alive && typeof res?.unread === 'number') setUnread(res.unread);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return unread;
}

/**
 * NavItemButton — one premium navigation row.
 *  · Expanded: active = tinted accent background + hairline indicator + soft ring;
 *    hover = muted surface with a gentle icon slide.
 *  · Collapsed: icon-centred square with a radial hover background and an
 *    instant tooltip (short delay) describing the page.
 */
function NavItemButton({
  item,
  active,
  collapsed,
  badged = 0,
  badgeAccent = false,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  badged?: number;
  badgeAccent?: boolean;
  onClick?: () => void;
}) {
  const Icon = item.icon;
  const row = (
    <Link
      href={item.href}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium outline-none transition-all duration-150',
        'focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        active
          ? 'bg-primary/[0.12] text-primary shadow-sm shadow-primary/5 ring-1 ring-primary/15'
          : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
        collapsed && 'justify-center px-0 hover:bg-muted/60',
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_8px] shadow-primary/40" />
      )}
      <Icon
        className={cn(
          'h-[18px] w-[18px] shrink-0 transition-transform duration-150',
          active && 'text-primary',
          !collapsed && 'group-hover:translate-x-0.5',
        )}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && item.badge && !badged && (
        <span className="ml-auto rounded-full bg-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-secondary-foreground">
          {item.badge}
        </span>
      )}
      {!collapsed && badged > 0 && (
        <span
          className={cn(
            'ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums ring-2 ring-background',
            badgeAccent
              ? 'bg-primary text-primary-foreground'
              : 'bg-destructive text-destructive-foreground',
          )}
        >
          {badged > 99 ? '99+' : badged}
        </span>
      )}
      {collapsed && badged > 0 && (
        <span
          className={cn(
            'absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-background',
            badgeAccent ? 'bg-primary' : 'bg-destructive',
          )}
        />
      )}
    </Link>
  );

  if (!collapsed) return row;

  const childLabels = (item.children ?? []).map((c) => c.label);

  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10} className="max-w-48">
        {item.label}
        {childLabels.length > 0 ? (
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {childLabels.join(' · ')}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Collapsible guide section — one group of nav rows with an animated
 * expand/collapse (grid-rows 1fr→0fr). Defaults to expanded; the visual
 * hierarchy respects each shell's canonical groups.
 */
function Section({
  id,
  label,
  defaultOpen = true,
  allCollapsed,
  children,
}: {
  id: string;
  label: string;
  defaultOpen?: boolean;
  allCollapsed: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);

  if (allCollapsed) {
    return (
      <div className="flex flex-col items-center">
        <span className="h-2.5 w-px bg-border" aria-hidden />
        <span className="mb-1.5 h-1 w-1 rounded-full bg-muted-foreground/25" aria-hidden />
      </div>
    );
  }

  return (
    <div key={id} className="px-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'group/header flex w-full items-center gap-2 px-2 pb-1 pt-3 text-left',
          'text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70',
          'transition-colors hover:text-muted-foreground',
        )}
      >
        <span className="h-px w-3 bg-current opacity-40 transition-all group-hover/header:w-5 group-hover/header:opacity-80" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDown
          className={cn(
            'ml-auto h-3 w-3 opacity-50 transition-transform duration-200 group-hover/header:opacity-100',
            open && 'rotate-180',
          )}
        />
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-300 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
        style={{ opacity: open ? 1 : 0.4, transitionProperty: 'grid-template-rows, opacity' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-0.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * NavSubmenu — a nav row with optional child rows. Contextual behavior:
 *   · submenu is collapsed by default;
 *   · it opens when the route is active on the item or any of its children
 *     (route is the authoritative state — nothing is persisted, so a refresh
 *     restores the correct state from the URL alone);
 *   · clicking the parent row navigates to it AND expands the submenu — a group
 *     row whose href is its default child page (e.g. Trading -> Trade) opens a
 *     real page instead of toggling a dead row, so the group's pages are always
 *     one click away;
 *   · clicking a child navigates to that page (no nesting surprise — the child
 *     click does not toggle the parent);
 *   · on touch there is no hover — clicking the parent expands and the submenu
 *     stays open because the item is route-active.
 * Plain rows (no children) render exactly as before — other Service nav items
 * are unaffected.
 */
function NavSubmenu({
  item,
  activeItem,
  collapsed,
  badged = 0,
  badgeAccent = false,
  onNavigate,
}: {
  item: NavItem;
  activeItem: NavItem | undefined;
  collapsed: boolean;
  badged?: number;
  badgeAccent?: boolean;
  onNavigate?: () => void;
}) {
  const hasChildren = !!item.children && item.children.length > 0;
  const routeOpen = subtreeActive(item, activeItem);
  // `null` means "follow the route". A chevron click pins the state so the
  // operator can collapse a section they are currently inside — and any later
  // navigation away from it releases the pin.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    if (!routeOpen) setOverride(null);
  }, [routeOpen]);

  if (!hasChildren) {
    return (
      <div onClick={onNavigate}>
        <NavItemButton
          item={item}
          active={item.id === activeItem?.id}
          collapsed={collapsed}
          badged={badged}
          badgeAccent={badgeAccent}
        />
      </div>
    );
  }

  const open = override ?? routeOpen;
  const toggle = () => setOverride(!open);

  // The parent row is ALWAYS a link to its own overview page; the chevron beside
  // it is what opens and closes the inner pages. That keeps every section
  // reachable in one click while still giving an explicit show/hide control.
  const parentRow = (
    <div className="flex items-stretch">
      <div className="min-w-0 flex-1">
        <NavItemButton
          item={item}
          active={routeOpen}
          collapsed={collapsed}
          badged={badged}
          badgeAccent={badgeAccent}
        />
      </div>
      {!collapsed && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? `Hide ${item.label} pages` : `Show ${item.label} pages`}
          title={open ? 'Hide inner pages' : 'Show inner pages'}
          className={cn(
            'flex w-7 shrink-0 items-center justify-center rounded-r-xl text-muted-foreground transition-colors',
            'hover:bg-muted/70 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
          )}
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-90')}
          />
        </button>
      )}
    </div>
  );

  return (
    <div>
      <div onClick={onNavigate}>{parentRow}</div>
      {!collapsed && (
        <div
          aria-hidden={!open}
          className={cn(
            'grid transition-[grid-template-rows] duration-200 ease-out',
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
          style={{ opacity: open ? 1 : 0 }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="ml-4 space-y-0.5 border-l border-border pb-1 pl-3">
              {item.children!.map((child) => (
                <div key={child.id} onClick={onNavigate}>
                  <NavItemButton
                    item={child}
                    active={childActive(child, activeItem)}
                    collapsed={false}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function NavContent({
  config,
  collapsed = false,
  onNavigate,
}: {
  config: ShellConfig;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const activeItem = findNavByPath(config.nav, pathname);
  // Dummy shell: alerts/notifications badges are Dummy-phase scoped. The global
  // Data Saver alert count and shared notification count are NOT shown there.
  const isDummyShell = config.id === 'trading-dummy';
  const activeAlertCount = useActiveAlertCount();
  const unreadNotifCount = useUnreadCount();
  const dummyUnread = useDummyUnread();
  const badgeFor = (item: NavItem): { count: number; accent: boolean } => {
    if (item.statusKey === 'alert' || (item.id === 'alerts' && activeAlertCount > 0)) {
      if (isDummyShell) return { count: 0, accent: false };
      return { count: activeAlertCount, accent: false };
    }
    if (item.statusKey === 'notification' || (item.id === 'notifications' && unreadNotifCount > 0)) {
      if (isDummyShell) return { count: dummyUnread, accent: true };
      return { count: unreadNotifCount, accent: true };
    }
    return { count: 0, accent: false };
  };
  return (
    <nav className="flex flex-1 flex-col pt-1" aria-label={config.nav.label}>
      {config.nav.groups.map((group) => (
        <Section
          key={group.label}
          id={`${config.id}:${group.label}`}
          label={group.label}
          allCollapsed={collapsed}
        >
          {group.items.map((item) => {
            const b = badgeFor(item);
            return (
              <NavSubmenu
                key={item.id}
                item={item}
                activeItem={activeItem}
                collapsed={collapsed}
                badged={b.count}
                badgeAccent={b.accent}
                onNavigate={onNavigate}
              />
            );
          })}
        </Section>
      ))}
    </nav>
  );
}

/**
 * SidebarBrand — the premium KAUSTUBH brand block at the top of the sidebar.
 *
 * Expanded mode:
 *   [Logo Icon]  KAUSTUBH
 *                Trading Terminal
 *                [Terminal Selector ▼]  (trading only)
 *
 * Collapsed mode:
 *   [Logo Icon]
 *   [Terminal icon]  (trading only)
 */
export function SidebarBrand({
  config,
  isTradingShell,
  collapsed,
}: {
  config: ShellConfig;
  isTradingShell: boolean;
  collapsed: boolean;
}) {
  const app = isTradingShell
    ? getAppById('trading')
    : (KAUSTUBH_APPS.find((a) => a.id === (config.id as AppId)) ?? KAUSTUBH_APPS[0]);
  const AppIcon = app.icon;

  if (collapsed) {
    return (
      <Tooltip delayDuration={100}>
        <TooltipTrigger asChild>
          <div className="flex flex-col items-center gap-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary via-primary to-secondary text-primary-foreground shadow-md shadow-primary/25 transition-shadow hover:shadow-lg hover:shadow-primary/30">
              <AppIcon className="h-5 w-5" />
            </span>
            {isTradingShell && (
              <SidebarTerminalSwitcher collapsed />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={12}>
          <span className="font-semibold">{app.name}</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary via-primary to-secondary text-primary-foreground shadow-md shadow-primary/25 transition-shadow hover:shadow-lg hover:shadow-primary/30">
        <AppIcon className="h-5 w-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/70">
          KAUSTUBH
        </span>
        <span className="truncate text-sm font-bold leading-tight tracking-tight text-foreground">
          {isTradingShell ? 'Trading Terminal' : app.name}
        </span>
      </div>
    </div>
  );
}

/**
 * PhaseSidebar — the single reusable desktop sidebar for every KAUSTUBH phase
 * (Trading Terminal, Data Saver, Services, Khumbha AI). Layout-driven widths:
 * the aside takes var(--sidebar-width-expanded|collapsed) from the theme engine,
 * and PhaseContent occupies the remaining space via flex — no absolute offsets,
 * so collapsed/expanded can never overlap content. On mobile it is hidden in
 * favour of PhaseMobileNavigation.
 */
export function PhaseSidebar({ config }: { config: ShellConfig }) {
  const { sidebarCollapsed, toggleSidebar } = usePhase2();
  const isTradingShell =
    config.id === 'trading' ||
    config.id === 'trading-kotak' ||
    config.id === 'trading-dummy' ||
    config.id === 'trading-shoonya';

  return (
    <TooltipProvider delayDuration={150}>
      <aside
        className={cn(
          'hidden md:flex h-full flex-col border-r theme-sidebar backdrop-blur-sm transition-all duration-300',
          'border-border',
        )}
        style={{
          width: sidebarCollapsed
            ? 'var(--sidebar-width-collapsed)'
            : 'var(--sidebar-width-expanded)',
        }}
      >
        {/* Header */}
        <div
          className={cn(
            'flex shrink-0 flex-col border-b border-border transition-colors',
            sidebarCollapsed ? 'items-center px-2 pt-3 pb-2' : 'gap-3 px-4 pt-4 pb-3',
          )}
        >
          <div className={cn(
            'flex w-full items-center',
            sidebarCollapsed ? 'justify-center' : 'gap-0',
          )}>
            <SidebarBrand
              config={config}
              isTradingShell={isTradingShell}
              collapsed={sidebarCollapsed}
            />
            {!sidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                className="ml-auto h-7 w-7 shrink-0 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>

          {/* Terminal selector — expanded mode only, trading shell only */}
          {!sidebarCollapsed && isTradingShell && (
            <div className="w-full">
              <SidebarTerminalSwitcher />
            </div>
          )}
        </div>

        {/* Collapsed-mode collapse/expand toggle */}
        {sidebarCollapsed && (
          <div className="flex shrink-0 justify-center py-1.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              className="h-6 w-6 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* Nav */}
        <ScrollArea className="flex-1">
          <NavContent config={config} collapsed={sidebarCollapsed} />
        </ScrollArea>

        {/* Footer */}
        <div className="shrink-0 border-t border-border p-3">
          {isTradingShell && <ShoonyaShell collapsed={sidebarCollapsed} />}
          {!sidebarCollapsed && (
            <p className="px-3 pt-2 text-[10px] text-muted-foreground/70">
              {config.version}
            </p>
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
}
