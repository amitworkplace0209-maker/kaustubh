'use client';

import { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { SECTION_INDEX } from '@/lib/settings/schema';
import { SettingGroupCard } from './settings-ui';
import { SectionPageHero, SettingsFooterBar } from './settings-page-shell';

/**
 * Standard section body: hero + schema groups + sync/activity footer.
 * Pages that need bespoke content pass `extra`/`footer` slots.
 */
export function SettingsSectionBody({
  sectionId,
  heroRight,
  extra,
  footer,
}: {
  sectionId: string;
  heroRight?: ReactNode;
  extra?: ReactNode;
  footer?: ReactNode;
}) {
  const section = SECTION_INDEX.get(sectionId);
  if (!section) return notFound();
  return (
    <div>
      <SectionPageHero section={section} right={heroRight} />
      {section.groups.length > 0 ? (
        <div className="space-y-4">
          {section.groups.map((g) => (
            <SettingGroupCard key={g.id} group={g} />
          ))}
        </div>
      ) : null}
      {extra}
      {footer ?? <SettingsFooterBar />}
    </div>
  );
}