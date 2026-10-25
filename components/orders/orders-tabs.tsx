'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShoppingCart, Sparkles, History } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrdersModuleEmbedded } from '@/components/dummy/orders-context';

const TAB_COLORS: Record<string, { indicator: string; activeBg: string; activeText: string; hoverBg: string; iconActive: string; iconInactive: string }> = {
  trade: {
    indicator: 'bg-emerald-500',
    activeBg: 'bg-emerald-500/10',
    activeText: 'text-emerald-400',
    hoverBg: 'hover:bg-emerald-500/5',
    iconActive: 'text-emerald-400',
    iconInactive: 'text-muted-foreground',
  },
  suggestion: {
    indicator: 'bg-amber-500',
    activeBg: 'bg-amber-500/10',
    activeText: 'text-amber-400',
    hoverBg: 'hover:bg-amber-500/5',
    iconActive: 'text-amber-400',
    iconInactive: 'text-muted-foreground',
  },
  history: {
    indicator: 'bg-violet-500',
    activeBg: 'bg-violet-500/10',
    activeText: 'text-violet-400',
    hoverBg: 'hover:bg-violet-500/5',
    iconActive: 'text-violet-400',
    iconInactive: 'text-muted-foreground',
  },
};

export const ORDER_TABS = [
  { id: 'trade', href: '/trading/trade', label: 'Trade', icon: ShoppingCart },
  { id: 'suggestion', href: '/trading/suggestion', label: 'Suggestion', icon: Sparkles },
  { id: 'history', href: '/trading/history', label: 'History', icon: History },
] as const;

export type OrderTabId = (typeof ORDER_TABS)[number]['id'];

type OrdersTabsProps =
  | {
      /** Controlled module mode: active tab id + change handler (no navigation). */
      value: string;
      onValueChange: (id: OrderTabId) => void;
      /** Optional count badges displayed after the label, e.g. { suggestion: 3 }. */
      counts?: Partial<Record<OrderTabId, number>>;
    }
  | {
      /** Standalone URL-driven mode (kept for the individual sub-routes). */
      value?: undefined;
      onValueChange?: undefined;
      counts?: undefined;
    };

export function OrdersTabs(props: OrdersTabsProps) {
  const pathname = usePathname();
  const embedded = useOrdersModuleEmbedded();
  const controlled = props.value != null && props.onValueChange != null;

  if (embedded && !controlled) return null;

  const active = controlled ? props.value : (pathname ?? '') as string;

  return (
    <nav
      aria-label="Orders"
      className="relative flex w-full items-center gap-1 overflow-x-auto rounded-xl border border-border bg-muted/30 p-1 backdrop-blur-sm"
    >
      {ORDER_TABS.map((t) => {
        const isActive = controlled ? active === t.id : active === t.href;
        const colors = TAB_COLORS[t.id];
        const count = controlled ? props.counts?.[t.id] : undefined;

        const row = (
          <>
            <t.icon
              className={cn(
                'h-4 w-4 shrink-0 transition-all duration-300',
                isActive ? colors.iconActive : colors.iconInactive,
              )}
            />
            <span className="transition-colors duration-300">{t.label}</span>
            {count != null && count > 0 && (
              <span
                className={cn(
                  'ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums transition-colors duration-300',
                  isActive
                    ? 'bg-current/20 text-current'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {count}
              </span>
            )}
          </>
        );

        return (
          <div key={t.id} className="flex-1">
            {controlled ? (
              <button
                type="button"
                onClick={() => props.onValueChange?.(t.id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'group relative inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-300',
                  isActive
                    ? cn(colors.activeBg, colors.activeText, 'shadow-sm')
                    : cn('text-muted-foreground', colors.hoverBg, 'hover:text-foreground'),
                )}
              >
                {row}
              </button>
            ) : (
              <Link
                href={t.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'group relative inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-300',
                  isActive
                    ? cn(colors.activeBg, colors.activeText, 'shadow-sm')
                    : cn('text-muted-foreground', colors.hoverBg, 'hover:text-foreground'),
                )}
              >
                {row}
              </Link>
            )}
          </div>
        );
      })}
    </nav>
  );
}
