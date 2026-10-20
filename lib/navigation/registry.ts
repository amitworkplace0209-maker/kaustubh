// Canonical KAUSTUBH navigation registry.
//
// Single spec-shaped API over the ONE authoritative nav data source
// (components/layout/nav.ts — the ShellConfig registry). Never redefine nav
// data here; this module only resolves, flattens and annotates the canonical
// config so every consumer (search, sidebar, topbar, mobile drawer) agrees on
// the same structure.
//
//   getNavigation({ app, terminal })
//       → the resolved ShellConfig for the active phase/terminal.
//   getSearchIndex()
//       → flattened cross-phase items for the command palette.
//   getBreadcrumb({ app, terminal, pathname })
//       → phase label + current page for the topbar breadcrumb.

import {
  DATA_SAVER_SHELL,
  DUMMY_SHELL,
  KHUMBHA_AI_SHELL,
  KOTAK_NEO_SHELL,
  SERVICES_SHELL,
  SHOONYA_SHELL,
  SHELL_CONFIGS,
  TRADING_SHELL,
  findNavByPath,
  getTradingShellConfig,
} from '@/components/layout/nav';
import type { NavGroup, NavItem, ShellWorkspace } from '@/components/layout/nav';
import type { TerminalMode } from '@/components/layout/nav';
import { KAUSTUBH_APPS, getAppByPath } from '@/lib/apps';
import type { AppId, KaustubhApp } from '@/lib/apps';

export type { AppId, KaustubhApp, NavGroup, NavItem, ShellWorkspace, TerminalMode };

/** Which ShellConfig each KAUSTUBH phase resolves to (terminal-independent). */
const SHELL_BY_APP: Record<AppId, ShellWorkspace> = {
  trading: 'trading',
  'data-saver': 'data-saver',
  services: 'services',
  'khumbha-ai': 'khumbha-ai',
};

/** All terminal-specific shell configs (for the cross-phase search index). */
const TERMINAL_SHELLS: ShellConfigLike[] = [TRADING_SHELL, DUMMY_SHELL, KOTAK_NEO_SHELL, SHOONYA_SHELL];

type ShellConfigLike = {
  id: string;
  brand: string;
  tagline: string;
  monogram: string;
  nav: { label: string; groups: NavGroup[] };
};

export type NavigationOptions = {
  app: AppId;
  terminal: TerminalMode;
};

export function getAppByRoute(pathname: string): AppId {
  return getAppByPath(pathname);
}

export function getAppMeta(id: AppId): KaustubhApp {
  return KAUSTUBH_APPS.find((a) => a.id === id) ?? KAUSTUBH_APPS[0];
}

export function getAllApps(): KaustubhApp[] {
  return KAUSTUBH_APPS;
}

/** Resolve the canonical ShellConfig for the active phase + trading terminal. */
export function getNavigation({ app, terminal }: NavigationOptions) {
  if (app === 'trading') return getTradingShellConfig(terminal);
  return SHELL_CONFIGS[SHELL_BY_APP[app]];
}

/** Groups for the active phase (trading terminal aware). */
export function getNavigationGroups(options: NavigationOptions): NavGroup[] {
  return getNavigation(options).nav.groups;
}

export function flattenGroups(nav: ShellConfigLike['nav']): NavItem[] {
  const out: NavItem[] = [];
  const walk = (items: NavItem[]) => {
    for (const item of items) {
      out.push(item);
      if (item.children?.length) walk(item.children);
    }
  };
  for (const group of nav.groups) walk(group.items);
  return out;
}

export type SearchIndexItem = {
  id: string;
  href: string;
  label: string;
  icon?: React.ElementType;
  keywords: string[];
  badge?: string;
  app: AppId;
  appName: string;
  appShort: string;
  monogram: string;
};

/** Flatten every phase + terminal shell into one deduped search index. */
export function getSearchIndex(): SearchIndexItem[] {
  const index: SearchIndexItem[] = [];
  const seen = new Set<string>();
  const pushShell = (app: AppId, shell: ShellConfigLike) => {
    const meta = getAppMeta(app);
    for (const item of flattenGroups(shell.nav)) {
      const key = `${app}:${item.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      index.push({
        id: item.id,
        href: item.href,
        label: item.label,
        icon: item.icon,
        keywords: item.keywords ?? [],
        badge: item.badge,
        app,
        appName: meta.name,
        appShort: meta.shortName,
        monogram: meta.monogram,
      });
    }
  };
  pushShell('trading', TERMINAL_SHELLS[0]);
  // Trading terminal pages are shared across the trading app; still surface
  // terminal-specific items even when the common set already covered the route.
  for (const shell of TERMINAL_SHELLS) pushShell('trading', shell);
  for (const app of ['data-saver', 'services', 'khumbha-ai'] as AppId[]) {
    pushShell(app, SHELL_BY_APP[app] === 'trading' ? TRADING_SHELL : SHELL_CONFIGS[SHELL_BY_APP[app]]);
  }
  return index;
}

export type BreadcrumbTarget = {
  app: KaustubhApp;
  page?: NavItem;
};

/** Resolve the phase + current page for the topbar breadcrumb. */
export function getBreadcrumb(
  app: AppId,
  terminal: TerminalMode,
  pathname: string,
): BreadcrumbTarget {
  const config = getNavigation({ app, terminal });
  return { app: getAppMeta(app), page: findNavByPath(config.nav, pathname) };
}

export { DATA_SAVER_SHELL, DUMMY_SHELL, KHUMBHA_AI_SHELL, KOTAK_NEO_SHELL, SERVICES_SHELL, SHOONYA_SHELL, TRADING_SHELL };