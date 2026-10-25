'use client';

import NotificationsPage from '@/app/_pages/notifications/page';
import DummyNotifications from '@/components/dummy/pages/notifications';
import { DummyGate } from '@/components/dummy/gate';
import { ShoonyaPending } from '@/components/shoonya/status';
import { useTradingMode } from '@/lib/settings-store';

export default function TradingNotificationsPage() {
  const mode = useTradingMode();
  if (mode === 'shoonya') return <ShoonyaPending />;
  return <DummyGate dummy={<DummyNotifications />} standard={<NotificationsPage />} />;
}