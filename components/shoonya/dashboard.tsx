'use client';

// Shoonya real dashboard.
//
// The standard broker-agnostic DashboardPage already renders real data for
// whatever terminal the backend session is active on (funds, positions,
// holdings, orders, P&L — all from /api/trading/dashboard for the 'shoonya'
// adapter once an OAuth session exists). This wrapper adds the honest Shoonya
// context strip: when no session is active it says exactly that — nothing is
// simulated.

import { Radar } from 'lucide-react';
import DashboardPage from '@/app/_pages/dashboard/page';

export function ShoonyaDashboardPage() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-info/30 bg-info/[0.06] px-4 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-info/15 text-info ring-1 ring-inset ring-info/30">
          <Radar className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Shoonya Trading</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Real broker data is served once an OAuth session is active — until then this dashboard
            reports the exact backend state (Not Configured / Not Connected), never a simulation.
          </p>
        </div>
      </div>
      <DashboardPage />
    </div>
  );
}