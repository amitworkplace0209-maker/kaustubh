'use client';

import DummyAudit from '@/components/dummy/pages/audit';
import KotakAudit from '@/components/kotak/pages/audit';
import { KotakGate } from '@/components/kotak/ui';
import { TerminalRouteGate } from '@/components/terminal/route-scope';

export default function TradingAuditPage() {
  return (
    <TerminalRouteGate path="/trading/audit" allowed={['dummy', 'kotak-neo']}>
      <KotakGate dummy={<DummyAudit />} kotak={<KotakAudit />} />
    </TerminalRouteGate>
  );
}