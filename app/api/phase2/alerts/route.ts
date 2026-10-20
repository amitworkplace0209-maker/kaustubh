import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Alerts.
 *
 * Active alerts are derived ON the backend from real system conditions only
 * (WebSocket state, MongoDB connectivity, write failures, quality score,
 * storage and internet probe) and already carry `eventId` → the underlying
 * lifecycle event plus `created_at` = when the condition actually happened.
 * THIS route is a thin re-shape of that single source of truth (plus the
 * real notification-store unread state). No fake alerts are ever created and
 * no timestamp is ever fabricated — old alerts keep their original times.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const hours = Math.max(1, Math.min(720, Number(url.searchParams.get('hours')) || 24));

  // ONE backend dashboard read (cached + single-flighted server-side) instead
  // of four independent health polls → no divergent alert derivations.
  const [notifRes, dashRes] = await Promise.all([
    backendFetch('/api/notifications?limit=100', { timeoutMs: 6000 }),
    backendFetch(`/api/system/dashboard?hours=${hours}`, { timeoutMs: 10000 }),
  ]);

  const notifs = notifRes.data?.notifications ?? [];
  const dash: any = dashRes.data || {};
  const dashAlerts: any[] = Array.isArray(dash.alerts) ? dash.alerts : [];
  const dashWs: any = dash.ws || {};
  const dashStorage: any = dash.storage || {};
  const storagePct = num(dashStorage.usedPercent) ?? null;
  const internetOk = Boolean(dashWs.internetOk);

  // Real active alerts — the backend already bound them to the triggering
  // event (created_at = WHEN THE ALERT HAPPENED, never the page clock). When a
  // timestamp is missing it stays null; it is NEVER replaced with "now".
  const activeAlerts: any[] = dashAlerts.map((a: any) => ({
    id: a.id,
    ruleId: `rule-${a.category ?? 'system'}`,
    category: a.category ?? 'System',
    severity: a.severity ?? 'info',
    title: a.title ?? a.message,
    message: a.message,
    reason: a.reason ?? null,
    triggeredAt: a.created_at ?? null,
    durationSec: null,
    eventId: a.eventId ?? null,
    impact: a.detail ?? a.message,
    status: a.status ?? 'active',
    resolvedAt: null,
    symbol: a.symbol ?? null,
    updatedAt: a.created_at ?? null,
    source: 'backend /api/system/dashboard (real conditions)',
    component: a.component ?? a.category ?? 'system',
    reasonCode: a.reasonCode ?? 'system',
  }));

  // Alert history from the real notification store. Timestamps come only from
  // the stored notifications; a missing one stays null, never "now".
  const severityMap: Record<string, 'info' | 'warning' | 'critical'> = {
    info: 'info', warning: 'warning', error: 'critical', critical: 'critical',
  };
  const history = notifs.slice(0, 50).map((n: any) => {
    const triggeredAt = n.ts ?? n.created_at ?? null;
    const resolvedAt = n.resolvedAt ?? null;
    let durationSec: number | null = null;
    if (resolvedAt && triggeredAt) {
      const from = new Date(triggeredAt).getTime();
      const to = new Date(resolvedAt).getTime();
      if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
        durationSec = Math.floor((to - from) / 1000);
      }
    }
    return {
      id: String(n._id ?? ''),
      category: n.category ?? 'system',
      component: n.category ?? 'system',
      title: n.title ?? n.message ?? 'Notification',
      message: n.title ?? n.message ?? '',
      severity: severityMap[n.level] ?? 'info',
      reason: n.reason ?? null,
      reasonCode: 'system',
      source: 'notifications',
      triggeredAt,
      started: triggeredAt,
      resolvedAt,
      durationSec,
      status: n.read ? (resolvedAt ? 'resolved' : 'acknowledged') : 'active',
      symbol: n.symbol ?? null,
    };
  });

  // Operational alert rules — enabled flags reflect the real current state.
  const rules = [
    { id: 'rule-ws', category: 'WebSocket', name: 'WebSocket Connection Drop', enabled: true, severity: 'critical' as const, threshold: 1, duration: 30, cooldown: 60, repeatInterval: 300, affectedStocks: [], affectedExchanges: [] },
    { id: 'rule-db', category: 'Database', name: 'Database Write Failures', enabled: true, severity: 'warning' as const, threshold: 5, duration: 60, cooldown: 120, repeatInterval: 600, affectedStocks: [], affectedExchanges: [] },
    { id: 'rule-storage', category: 'Storage', name: 'Disk Usage High', enabled: storagePct != null && storagePct >= 90, severity: 'warning' as const, threshold: 90, duration: 300, cooldown: 600, repeatInterval: 1800, affectedStocks: [], affectedExchanges: [] },
    { id: 'rule-internet', category: 'Internet', name: 'Internet Connectivity Lost', enabled: internetOk, severity: 'warning' as const, threshold: 1, duration: 30, cooldown: 60, repeatInterval: 300, affectedStocks: [], affectedExchanges: [] },
    { id: 'rule-quality', category: 'Data Quality', name: 'Quality Score Below 80', enabled: true, severity: 'info' as const, threshold: 80, duration: 300, cooldown: 600, repeatInterval: 1800, affectedStocks: [], affectedExchanges: [] },
  ];

  return Response.json({ rules, activeAlerts, history });
}

/**
 * Acknowledge all real notifications. Proxies to the real backend
 * `PUT /api/notifications/read-all`, which clears the unread count that
 * drives the derived "unread notifications" active alert.
 */
export async function POST() {
  const res = await backendFetch('/api/notifications/read-all', { method: 'PUT', timeoutMs: 6000 });
  if (!res.ok) {
    return Response.json({ ok: false, message: res.data?.detail || res.data?.message || 'Failed to acknowledge' }, { status: res.status || 502 });
  }
  return Response.json(res.data);
}