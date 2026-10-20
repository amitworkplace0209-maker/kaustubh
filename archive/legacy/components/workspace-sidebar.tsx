'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X, ChevronRight, TrendingUp, Database, Server, Menu, RadioTower, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/components/workspace-provider';
import { getWorkspaceNav, WORKSPACE_LIST, type WorkspaceId } from '@/lib/workspace-nav';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

const WORKSPACE_ICONS: Record<WorkspaceId, React.ElementType> = {
  trading: TrendingUp,
  data: RadioTower,
  services: Server,
  ai: Brain,
};

function WorkspaceSwitcher({ onSelect }: { onSelect: () => void }) {
  const { workspace } = useWorkspace();

  const defaultRoutes: Record<WorkspaceId, string> = {
    trading: '/trading/dashboard',
    data: '/data-saver/dashboard',
    services: '/services/system',
    ai: '/ai/dashboard',
  };

  return (
    <div className="p-2 space-y-1">
      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Switch Workspace
      </p>
      {WORKSPACE_LIST.map((ws) => {
        const Icon = WORKSPACE_ICONS[ws.id];
        const active = workspace === ws.id;
        const href = ws.groups[0]?.items[0]?.href || defaultRoutes[ws.id];
        return (
          <Link
            key={ws.id}
            href={href}
            onClick={onSelect}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <div className={cn('flex h-7 w-7 items-center justify-center rounded-lg', ws.iconBg)}>
              <Icon className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{ws.shortLabel}</p>
              <p className="text-[10px] text-muted-foreground truncate">{ws.description.slice(0, 40)}...</p>
            </div>
            {active && <div className="h-1.5 w-1.5 rounded-full bg-primary" />}
          </Link>
        );
      })}
    </div>
  );
}

export function WorkspaceSidebar() {
  const pathname = usePathname();
  const { workspace } = useWorkspace();
  const nav = getWorkspaceNav(workspace);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const accentClass = workspace === 'trading' ? 'text-emerald-500'
    : workspace === 'ai' ? 'text-cyan-500'
    : workspace === 'services' ? 'text-violet-500'
    : 'text-amber-500';

  const accentBg = workspace === 'trading' ? 'bg-emerald-500/10'
    : workspace === 'ai' ? 'bg-cyan-500/10'
    : workspace === 'services' ? 'bg-violet-500/10'
    : 'bg-amber-500/10';

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className={cn(
        'hidden md:flex h-screen w-64 flex-col border-r border-border bg-card/80 backdrop-blur-sm transition-colors duration-300'
      )}>
        {/* Header */}
        <div className="flex h-16 items-center gap-2.5 border-b border-border px-5">
          <div className={cn('flex h-9 w-9 items-center justify-center rounded-xl shadow-soft', nav.iconBg)}>
            {(() => { const Icon = WORKSPACE_ICONS[workspace]; return <Icon className="h-5 w-5 text-white" />; })()}
          </div>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-base font-bold tracking-tight text-foreground">KAUSTUBH</span>
            <span className={cn('text-[10px] font-medium uppercase tracking-wider', accentClass)}>
              {nav.label}
            </span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-5 overflow-y-auto p-3 scrollbar-thin">
          {nav.groups.map((group) => (
            <div key={group.label} className="space-y-1">
              <p className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                {group.label}
              </p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200',
                      active
                        ? cn(accentBg, accentClass, 'shadow-sm')
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <Icon className={cn('h-4 w-4 shrink-0 transition-colors', active ? accentClass : 'text-muted-foreground/50')} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Workspace Switcher */}
        <div className="border-t border-border p-3">
          <button
            onClick={() => setSwitcherOpen(!switcherOpen)}
            className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <div className={cn('h-5 w-5 rounded-md flex items-center justify-center', nav.iconBg)}>
              {workspace === 'trading' && <TrendingUp className="h-3 w-3 text-white" />}
              {workspace === 'data' && <Database className="h-3 w-3 text-white" />}
              {workspace === 'services' && <Server className="h-3 w-3 text-white" />}
              {workspace === 'ai' && <Brain className="h-3 w-3 text-white" />}
            </div>
            Switch Workspace
            <ChevronRight className={cn('h-3 w-3 ml-auto transition-transform duration-200', switcherOpen && 'rotate-90')} />
          </button>
          {switcherOpen && (
            <div className="mt-2 animate-in slide-in-from-top-1 duration-150">
              <WorkspaceSwitcher onSelect={() => setSwitcherOpen(false)} />
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Bottom Nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-16">
          {nav.groups[0]?.items.slice(0, 5).map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex flex-col items-center gap-0.5 px-2 py-1 text-xs transition-colors',
                  active ? accentClass : 'text-muted-foreground'
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[10px]">{item.label}</span>
              </Link>
            );
          })}
          <button
            className={cn('flex flex-col items-center gap-0.5 px-2 py-1 text-xs text-muted-foreground')}
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
            <span className="text-[10px]">More</span>
          </button>
        </div>
      </nav>

      {/* Mobile More Sheet */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="h-[75vh] rounded-t-2xl border-t border-border bg-card">
          <SheetHeader className="pb-4">
            <SheetTitle className="text-base font-bold text-foreground">All Pages</SheetTitle>
          </SheetHeader>

          {/* Workspace switcher in mobile */}
          <div className="mb-4 p-3 rounded-xl bg-muted/50 border border-border">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-2">Workspace</p>
            <div className="flex gap-2">
              {WORKSPACE_LIST.map((ws) => {
                const WsIcon = WORKSPACE_ICONS[ws.id];
                const active = workspace === ws.id;
                const mobileDefaultRoutes: Record<WorkspaceId, string> = {
                  trading: '/trading/dashboard',
                  data: '/data-saver/dashboard',
                  services: '/services/system',
                  ai: '/ai/dashboard',
                };
                return (
                  <Link
                    key={ws.id}
                    href={ws.groups[0]?.items[0]?.href || mobileDefaultRoutes[ws.id]}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      'flex-1 flex flex-col items-center gap-1.5 rounded-lg p-2.5 text-[10px] font-medium transition-all',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted'
                    )}
                  >
                    <div className={cn('h-7 w-7 rounded-lg flex items-center justify-center', ws.iconBg)}>
                      <WsIcon className="h-3.5 w-3.5 text-white" />
                    </div>
                    {ws.shortLabel}
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {nav.groups.map((group) =>
              group.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      'flex items-center gap-2 rounded-lg p-3 text-sm font-medium transition-colors',
                      active ? cn(accentBg, accentClass) : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {item.label}
                  </Link>
                );
              })
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
