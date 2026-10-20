import type { NavItem } from '@/components/layout/nav';

/** Small hover delay so moving between the parent row and its children never
 *  tears the submenu (flicker guard). */
export const SUBMENU_HOVER_DELAY_MS = 150;

/** Longest-matching item for a pathname — descends into NavItem.children, so a
 *  child route resolves to the child (which then keeps the parent highlighted). */
export function findNavItemByPath(items: readonly NavItem[], pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  const walk = (item: NavItem) => {
    if (pathname === item.href || pathname.startsWith(item.href + '/')) {
      if (!best || item.href.length > best.href.length) best = item;
    }
    item.children?.forEach(walk);
  };
  for (const item of items) walk(item);
  return best;
}

/** Is `active` the item itself or one of its descendants (subtree)? */
export function subtreeActive(item: NavItem, active: NavItem | undefined): boolean {
  if (!active) return false;
  if (item.id === active.id) return true;
  return (item.children ?? []).some((c) => c.id === active.id);
}

/** Route-driven submenu open state. Route is the authoritative source — there
 *  is no persisted ("permanently open") state to reconcile on refresh. */
export function submenuRouteOpen(item: NavItem, active: NavItem | undefined): boolean {
  return subtreeActive(item, active);
}

/** Combined open state the sidebar renders: route-open OR temporary hover. */
export function submenuOpen(item: NavItem, active: NavItem | undefined, hover: boolean): boolean {
  return hover || submenuRouteOpen(item, active);
}

/** Is a specific child row the currently active route item? */
export function childActive(child: NavItem, active: NavItem | undefined): boolean {
  return !!active && child.id === active.id;
}