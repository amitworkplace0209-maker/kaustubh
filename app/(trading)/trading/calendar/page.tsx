'use client';

import DummyCalendar from '@/components/dummy/pages/calendar';
import { TerminalRouteGate } from '@/components/terminal/route-scope';

export default function TradingCalendarPage() {
  return (
    <TerminalRouteGate path="/trading/calendar" allowed={['dummy']}>
      <DummyCalendar />
    </TerminalRouteGate>
  );
}