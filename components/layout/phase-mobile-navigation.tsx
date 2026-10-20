'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getMobilePrimaryItems,
  type ShellConfig,
  type NavItem,
} from '@/components/layout/nav';
import { useMobileNav } from '@/components/layout/mobile-nav-drawer';

function shortLabel(item: NavItem): string {
  const parts = item.label.split(' ');
  return parts.length > 1 ? parts[0] : item.label;
}

/**
 * Mobile/PWA bottom tab bar — the ONLY mobile primary navigation.
 *
 * The bar owns the MAIN pages of the active workspace (registry-driven from
 * the shell config's `mobilePrimary`, never hardcoded here). Every INNER page
 * lives in the sidebar drawer (`MobileNavDrawer`), which the trailing MENU
 * button opens — so the bar stays a fixed, thumb-reachable set of destinations
 * and the page tree is never crammed into it.
 *
 * Safe-area aware (inset bottom) and never overlapped by floating UI.
 */
export function PhaseMobileNavigation({ config }: { config: ShellConfig }) {
  const pathname = usePathname();
  const { toggle: toggleDrawer } = useMobileNav();
  const items = getMobilePrimaryItems(config, 4);

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-bottom-nav border-t bg-card/95 backdrop-blur-md border-border pb-[env(safe-area-inset-bottom)]"
      aria-label="Primary navigation"
    >
      <div className="flex h-16 items-center justify-around">
        {items.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 transition-colors duration-200',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Icon className="h-5 w-5" />
              <span className="max-w-full truncate text-[10px] font-medium leading-none">
                {shortLabel(item)}
              </span>
            </Link>
          );
        })}

        {/* MENU — opens the sidebar with every inner page. */}
        <button
          type="button"
          onClick={toggleDrawer}
          aria-label="Open navigation menu"
          className="flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 text-muted-foreground transition-colors duration-200"
        >
          <Menu className="h-5 w-5" />
          <span className="max-w-full truncate text-[10px] font-medium leading-none">
            Menu
          </span>
        </button>
      </div>
    </nav>
  );
}
