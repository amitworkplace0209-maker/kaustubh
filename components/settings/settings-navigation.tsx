'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, Menu, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DATA_SAVER_PHASE } from '@/lib/settings/phase-config';
import { iconFor } from '@/lib/settings/icons';
import { SECTIONS } from '@/lib/settings/schema';

const OPEN_THRESHOLD = 56;
const CLOSE_THRESHOLD = 40;
const DRAWER_WIDTH = 288;

/** Shared section list. */
function NavList({ settingsPath, onNavigate }: { settingsPath: string; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="space-y-0.5" aria-label="Settings sections">
      <Link
        href={settingsPath}
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
          pathname === settingsPath
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Search className="h-4 w-4 shrink-0" />
        Control Center
      </Link>
      {SECTIONS.map((section) => {
        const Icon = iconFor(section.icon);
        const href = `${settingsPath}/${section.id}`;
        const active = pathname === href;
        return (
          <Link
            key={section.id}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{section.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

function useCurrentSection(settingsPath: string): { label: string; Icon: React.ElementType } {
  const pathname = usePathname();
  const current = SECTIONS.find((s) => pathname === `${settingsPath}/${s.id}`);
  return { label: current?.label ?? 'Control Center', Icon: iconFor(current?.icon ?? 'LayoutGrid') };
}

/**
 * Mobile: sticky header + swipe-to-open drawer (left-edge swipe right, drawer
 * swipe left, backdrop click, Escape). Always rendered; hidden on desktop.
 */
export function SettingsMobileNav({ settingsPath }: { settingsPath: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [startX, setStartX] = useState<number | null>(null);
  const [startY, setStartY] = useState<number | null>(null);
  const { label, Icon } = useCurrentSection(settingsPath);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const begin = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    setStartX(e.clientX);
    setStartY(e.clientY);
  };
  const moveEdge = (e: React.PointerEvent) => {
    if (open || startX === null || startY === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (e.clientX < OPEN_THRESHOLD && dx > 40) setOpen(true);
  };
  const moveDrawer = (e: React.PointerEvent) => {
    if (!open || startX === null || startY === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (e.clientX > DRAWER_WIDTH - 24 && dx < -CLOSE_THRESHOLD) setOpen(false);
  };
  const end = () => {
    setStartX(null);
    setStartY(null);
  };

  return (
    <div className="md:hidden">
      <div
        className="sticky top-0 z-30 border-b border-border/60 bg-background/90 backdrop-blur"
        onPointerDown={begin}
        onPointerMove={moveEdge}
        onPointerUp={end}
        onPointerLeave={end}
      >
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Button
            variant="ghost"
            size="icon"
            aria-expanded={open}
            aria-controls="settings-drawer"
            aria-label={open ? 'Close settings navigation' : 'Open settings navigation'}
            className="h-9 w-9"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <Icon className="h-4 w-4 text-amber-500" />
          <p className="text-sm font-semibold">{label}</p>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
            {DATA_SAVER_PHASE.phaseShortName}
          </span>
        </div>
      </div>

      <div
        id="settings-drawer"
        className={cn(
          'fixed inset-0 z-40 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
      >
        <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden="true" />
        <div
          onPointerDown={begin}
          onPointerMove={moveDrawer}
          onPointerUp={end}
          onPointerLeave={end}
          style={{ width: DRAWER_WIDTH, transform: open ? 'translateX(0)' : 'translateX(-100%)' }}
          className="absolute inset-y-0 left-0 flex flex-col bg-background shadow-xl transition-transform duration-300 ease-out"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-3">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ backgroundColor: 'rgba(245,158,11,0.15)', color: DATA_SAVER_PHASE.phaseThemeColor }}
            >
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">Settings</p>
              <p className="truncate text-[10px] text-muted-foreground">{DATA_SAVER_PHASE.phaseName}</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close settings navigation"
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-2 py-3">
            <NavList settingsPath={settingsPath} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Desktop: static sidebar column. */
export function SettingsDesktopNav({ settingsPath }: { settingsPath: string }) {
  const { Icon } = useCurrentSection(settingsPath);
  return (
    <aside className="hidden md:block">
      <div className="sticky top-20 space-y-1">
        <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
          Settings
        </p>
        <NavList settingsPath={settingsPath} />
        <p className="px-3 pt-4 text-[10px] text-muted-foreground/60">
          <Icon className="mr-1 inline h-3 w-3" />
          Changes persist to the backend — no reload needed.
        </p>
      </div>
    </aside>
  );
}