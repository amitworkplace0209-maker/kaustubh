import type { Metadata } from 'next';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { SECTION_INDEX } from '@/lib/settings/schema';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const section = SECTION_INDEX.get(id);
  return {
    title: section ? `${section.label} · Settings · Data Saver` : 'Settings · Data Saver',
  };
}

export default async function SettingsSectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SettingsSectionBody sectionId={id} />;
}