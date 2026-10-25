'use client';

import { BookOpen, Cpu, Server } from 'lucide-react';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { useSettings } from '@/lib/settings/store';
import { SECTIONS } from '@/lib/settings/schema';

export default function AboutPage() {
  const { settings, status, syncedAt, liveKeys } = useSettings();

  const rows: { label: string; value: string }[] = [
    { label: 'App version', value: String(settings.app_version ?? 'â€”') },
    { label: 'SDK version', value: String(settings.sdk_version ?? 'â€”') },
    { label: 'Profile', value: String(settings.profile_name ?? 'â€”') },
    { label: 'Trading mode', value: String(settings.trading_mode ?? 'â€”') },
    {
      label: 'Backend API',
      // The browser talks to its OWN origin and the Next.js rewrite forwards
      // /api to the Python service — an absolute `127.0.0.1:8000` would point
      // at the phone on a mobile device. Show the URL the browser really uses.
      value:
        typeof window !== 'undefined'
          ? `${window.location.origin}/api`
          : `${process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000'}/api`,
    },
    { label: 'Settings sections', value: String(SECTIONS.length) },
    { label: 'Live runtime keys', value: `${liveKeys.size} broadcast by backend` },
  ];

  return (
    <SettingsSectionBody
      sectionId="about"
      extra={
        <div className="mt-4 space-y-4">
          <section className="rounded-xl border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
              <Cpu className="h-4 w-4 text-amber-500" />
              <p className="text-sm font-semibold">Product & backend</p>
            </header>
            <div className="divide-y divide-border/60 px-4">
              {rows.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-sm text-muted-foreground">{r.label}</span>
                  <code className="rounded bg-muted px-2 py-1 text-left font-mono text-[11px]">{r.value}</code>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
              <Server className="h-4 w-4 text-amber-500" />
              <p className="text-sm font-semibold">Backend sync</p>
            </header>
            <div className="px-4 py-3 text-xs text-muted-foreground">
              <p>
                {status === 'loading' ? 'Loadingâ€¦' : status === 'error' ? 'Connection interrupted â€” retrying.' : 'Connected to the settings backend.'}
                {syncedAt ? ` Last refresh ${new Date(syncedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}.` : ''}
              </p>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
              <BookOpen className="h-4 w-4 text-amber-500" />
              <p className="text-sm font-semibold">Documentation</p>
            </header>
            <div className="px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                The Data Saver settings app is a single-schema control center: every control persists to MongoDB through
                the backend <code className="rounded bg-muted px-1">/api/settings</code> endpoints, and the scheduler,
                WebSocket supervisor and tick pipeline apply changes live within seconds.
              </p>
            </div>
          </section>
        </div>
      }
    />
  );
}