'use client';

import { useMemo, useState } from 'react';
import { Search, ShieldCheck, Wifi } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { PageHeader, StatusBadge } from '@/components/design-system';
import { SETTINGS_PATH } from '@/lib/settings/paths';
import { SECTIONS, searchSections } from '@/lib/settings/schema';
import { SectionCard, SettingsFooterBar } from '@/components/settings/settings-page-shell';
import { useSettings } from '@/lib/settings/store';

export default function SettingsControlCenter() {
  const [query, setQuery] = useState('');
  const { status, errors } = useSettings();

  const sections = useMemo(() => (query.trim() ? searchSections(query) : SECTIONS), [query]);

  return (
    <div>
      <div className="mb-5">
        <PageHeader
          title="Settings Control Center"
          subtitle="Every switch below is wired straight into the Data Saver backend — scheduler windows, WebSocket supervisor and the tick pipeline react to what you change here, with no page reload."
        >
          {status === 'error' || Object.keys(errors).length > 0 ? (
            <StatusBadge status="danger" label="Sync interrupted · retrying" />
          ) : status === 'loading' ? (
            <StatusBadge status="warning" label="Loading…" />
          ) : (
            <StatusBadge status="success" label="Live" />
          )}
        </PageHeader>
      </div>

      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings (e.g. websocket, schedule, lock)…"
          className="h-10 pl-9"
        />
      </div>

      {sections.length === 0 ? (
        <div className="rounded-xl border border-dashed py-14 text-center">
          <p className="text-sm font-medium">No matches for “{query}”</p>
          <p className="mt-1 text-xs text-muted-foreground">Try “websocket”, “scheduler” or “retention”.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => (
            <SectionCard key={s.id} section={s} settingsPath={SETTINGS_PATH} />
          ))}
        </div>
      )}

      <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-border/60 bg-card/50 px-4 py-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Wifi className="h-3.5 w-3.5" /> Scheduler, WebSocket & tick settings apply live
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" /> Sensitive values are never exported
        </span>
      </div>

      <SettingsFooterBar />
    </div>
  );
}