'use client';

import { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, History, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/design-system';
import { iconFor } from '@/lib/settings/icons';
import { refreshSettings, useSettings } from '@/lib/settings/store';
import type { SettingsSectionDef } from '@/lib/settings/types';

/** Subtitle helpers for pages that don't map to a schema section. */
export function SectionPageHero({
  section,
  breadcrumb,
  summary,
  right,
}: {
  section: SettingsSectionDef;
  breadcrumb?: string;
  summary?: string;
  right?: ReactNode;
}) {
  const Icon = iconFor(section.icon);
  const pathname = usePathname();
  return (
    <header className="mb-5">
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/data-saver/settings" className="hover:text-foreground">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link href={pathname} className="font-medium text-foreground">
          {breadcrumb ?? section.label}
        </Link>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: 'rgba(245,158,11,0.15)', color: '#B45309' }}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight sm:text-xl">{section.label}</h1>
            <p className="text-xs text-muted-foreground">{summary ?? section.description}</p>
          </div>
        </div>
        {right}
      </div>
    </header>
  );
}

/** Sync + activity strip shown at the bottom of every section page. */
export function SettingsFooterBar() {
  const { status, syncedAt, activity, liveKeys, errors } = useSettings();
  const lastActivity = activity[0];
  return (
    <footer className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-card px-4 py-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <RefreshCw className="h-3.5 w-3.5" />
        <span>
          {status === 'loading' ? 'Loading…' : status === 'error' ? 'Sync interrupted' : 'Synced'}
        </span>
        {syncedAt ? <span className="tabular-nums">· {new Date(syncedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}</span> : null}
      </div>
      {status === 'error' || Object.keys(errors).length > 0 ? (
        <StatusBadge status="danger" label="Retrying…" />
      ) : (
        <StatusBadge status="success" label={`${liveKeys.size} live settings`} />
      )}
      {lastActivity ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <History className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate" title={`${lastActivity.key} → ${JSON.stringify(lastActivity.value)}`}>
            Last change: {lastActivity.key} · {new Date(lastActivity.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
          </span>
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-7 px-2 text-[11px]"
        onClick={() => void refreshSettings()}
      >
        Refresh now
      </Button>
    </footer>
  );
}

/** Section index chips shown inside the Control Center cards list. */
export function SectionCard({ section, settingsPath }: { section: SettingsSectionDef; settingsPath: string }) {
  const { liveKeys, pending } = useSettings();
  const Icon = iconFor(section.icon);
  const fields = section.groups.flatMap((g) => g.fields);
  const liveCount = fields.filter((f) => liveKeys.has(f.sourceKey)).length;
  const saving = fields.some((f) => f.sourceKey in pending);
  return (
    <Link
      href={`${settingsPath}/${section.id}`}
      className={cn(
        'group relative overflow-hidden rounded-xl border border-border bg-card p-4 transition-colors',
        'hover:border-primary/40 hover:bg-accent/40',
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'rgba(245,158,11,0.15)', color: '#B45309' }}
        >
          <Icon className="h-4 w-4" />
        </div>
        {liveCount > 0 ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600">
            {liveCount} live
          </span>
        ) : null}
      </div>
      <p className="text-sm font-semibold">{section.label}</p>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{section.description}</p>
      <p className="mt-3 text-[10px] uppercase tracking-wide text-muted-foreground/60">
        {section.groups.length} groups · {fields.length} settings
        {saving ? ' · saving…' : ''}
      </p>
    </Link>
  );
}