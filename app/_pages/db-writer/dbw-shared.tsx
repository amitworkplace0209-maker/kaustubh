'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Shared chrome for the four DISTINCT db-writer service pages.
 *
 * Layout/labels only — every page keeps its OWN data connection:
 *   overview    → WS#2 `db_writer_engine` engine channel (+ DB monitoring plane)
 *   storage     → GET  /api/services/engines/db_writer_engine/storage
 *   permissions → GET/PUT /api/services/engines/db_writer_engine/tick-persistence
 *   settings    → GET  /api/settings + /api/settings/runtime (+ knob PUT)
 */

const TABS = [
  { key: 'overview', href: '/services/db-writer/overview', label: 'Overview' },
  { key: 'storage', href: '/services/db-writer/storage', label: 'Storage' },
  { key: 'permissions', href: '/services/db-writer/permissions', label: 'Permissions' },
  { key: 'settings', href: '/services/db-writer/settings', label: 'Settings' },
] as const;

export type DbwTabKey = (typeof TABS)[number]['key'];

const TAB_ACTIVE: Record<DbwTabKey, string> = {
  overview: 'border-teal-500/50 bg-teal-500/10 text-teal-700',
  storage: 'border-sky-500/50 bg-sky-500/10 text-sky-700',
  permissions: 'border-amber-500/50 bg-amber-500/10 text-amber-700',
  settings: 'border-violet-500/50 bg-violet-500/10 text-violet-700',
};

/** Nav strip shown on every db-writer page (active page highlighted). */
export function DbwPageTabs({ active }: { active: DbwTabKey }) {
  return (
    <nav aria-label="DB Writer pages" className="flex flex-wrap items-center gap-1.5">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            'rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors',
            t.key === active ? TAB_ACTIVE[t.key] : 'border-border/60 text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** IST wall-clock badge (formatting only; the timezone owner is the backend). */
export function DbwIstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Badge variant="outline" className="tabular-nums">
      IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}
    </Badge>
  );
}

/** Backend-reported number → en-IN digits, missing → '—' (honest). */
export function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN');
}
