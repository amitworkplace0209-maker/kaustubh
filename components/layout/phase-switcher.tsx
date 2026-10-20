'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Check, ChevronDown, Circle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { KAUSTUBH_APPS, getAppByPath } from '@/lib/apps';
import type { AppId } from '@/lib/apps';
import { setPhase2CurrentApp } from '@/lib/phase2-theme';
import { getPhaseConfig, getAvailablePhases } from '@/lib/settings/phase-config';

/**
 * GlobalTopBar phase selector — the ONLY place where switching between
 * KAUSTUBH phases (Trading Terminal / Data Saver / Services / Khumbha AI)
 * happens. The current phase is derived from the active route (authoritative),
 * not from front-end state.
 */
export function PhaseSwitcher({
  variant = 'full',
  collapsed = false,
}: {
  variant?: 'full' | 'compact';
  collapsed?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // Route is authoritative: which phase the user is really in.
  const activeId = getAppByPath(pathname);
  const active = KAUSTUBH_APPS.find((a) => a.id === activeId) ?? KAUSTUBH_APPS[0];

  const handleSelect = (appId: AppId) => {
    const app = KAUSTUBH_APPS.find((a) => a.id === appId);
    if (!app) return;
    setPhase2CurrentApp(appId);
    // Client-side navigation only; the destination phase's theme is applied
    // before the route commits. The route change (not a full reload) drives it.
    router.push(app.defaultRoute);
  };

  const triggerLabel = `Switch application phase (current: ${active.name})`;
  const activePhase = getPhaseConfig(active.id);

  if (variant === 'compact') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background/50 px-2.5 text-xs font-medium text-foreground transition-all duration-200 hover:border-border hover:bg-accent"
            aria-label="Switch application phase"
            aria-haspopup="menu"
            title={triggerLabel}
          >
            <active.icon className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="hidden sm:inline">{active.shortName}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="px-2 py-1">
            <span className="block text-[10px] uppercase tracking-widest text-muted-foreground">
              Switch phase
            </span>
            {activePhase && (
              <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                {activePhase.phaseTagline || activePhase.phaseDescription}
              </span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {getAvailablePhases().map((phase) => {
            const app = KAUSTUBH_APPS.find((a) => a.id === phase.appId);
            if (!app) return null;
            const isActive = app.id === active.id;
            return (
              <DropdownMenuItem
                key={app.id}
                onClick={() => handleSelect(app.id)}
                disabled={!phase.available}
                className={cn('gap-3 py-2.5', isActive && 'bg-primary/10', !phase.available && 'opacity-50')}
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  <app.icon className="h-4 w-4" />
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {phase.phaseName}
                    {isActive && <Check className="h-3 w-3 text-primary" />}
                  </span>
                  <span className="line-clamp-1 text-[10px] text-muted-foreground">
                    {phase.phaseDescription}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    <Circle className={cn('size-1.5', phase.available ? 'text-success' : 'text-destructive')} aria-hidden />
                    {phase.available ? 'Available' : phase.availabilityNote ?? 'Unavailable'}
                  </span>
                </span>
                {isActive && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                    Current
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'group flex items-center gap-3 text-left focus:outline-none',
            collapsed && 'flex-col gap-1',
          )}
          aria-label="Switch application phase"
          aria-haspopup="menu"
          title={triggerLabel}
        >
          <span
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary via-primary to-secondary text-primary-foreground shadow-md shadow-primary/20',
            )}
          >
            <active.icon className="h-4 w-4" />
          </span>
          {!collapsed && (
            <span className="flex min-w-0 flex-col">
              <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/70">
                KAUSTUBH
              </span>
              <span className="truncate text-sm font-bold leading-tight tracking-tight text-foreground">
                {active.name}
              </span>
              <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-primary/90">
                {active.shortName}
              </span>
            </span>
          )}
          <ChevronDown className="ml-1 h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:text-foreground group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs uppercase tracking-widest text-muted-foreground">
          Switch application
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {KAUSTUBH_APPS.map((app) => {
          const isActive = app.id === active.id;
          return (
            <DropdownMenuItem
              key={app.id}
              onClick={() => handleSelect(app.id)}
              className={cn(
                'gap-3 py-2.5',
                isActive && 'bg-primary/10',
              )}
            >
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                <app.icon className="h-4 w-4" />
              </span>
              <span className="flex flex-1 flex-col">
                <span className="text-sm font-medium text-foreground">
                  {app.name}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {app.shortName} · {app.description}
                </span>
              </span>
              {isActive && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <Check className="h-3 w-3" />
                  Current
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}