'use client';

import DcSchedules from '@/components/data-center/dc-schedules';
import { PageHeader } from '@/components/design-system';

export default function DataSchedulesPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Schedules" subtitle="Manage recurring data export schedules" />
      <DcSchedules />
    </div>
  );
}
