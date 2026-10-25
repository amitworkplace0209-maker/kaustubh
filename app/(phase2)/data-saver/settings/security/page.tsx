'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { StatusBadge } from '@/components/design-system';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';

export default function SecurityPage() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/setup')
      .then((r) => r.json())
      .then((d) => alive && setConfigured(Boolean(d.configured)))
      .catch(() => alive && setConfigured(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <SettingsSectionBody
      sectionId="security"
      extra={
        <section className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-medium">PIN protection</p>
              <p className="text-[11px] text-muted-foreground">
                {configured === null ? 'Checking…' : configured ? 'A 6-digit PIN protects the Data Saver UI' : 'No PIN is set'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={configured ? 'success' : 'neutral'} label={configured ? 'Active' : 'Inactive'} />
            <Link
              href="/data-saver/settings/app-lock"
              className="text-xs font-medium text-primary hover:underline"
            >
              Manage
            </Link>
          </div>
        </section>
      }
    />
  );
}