'use client';

// Session, Alerts & Broker-Health cards — honest backend/SSE state only.
//
//   Session card     ← useSessionSync (backend expiresAt) + realtime session.
//   Alerts card      ← realtime notificationsState (Alert Center frames).
//   Broker Health    ← realtime broker WS + app connection + internet.
// No timestamps here are invented: expiry = backend expiresAt, ages = server clock.

import {
  BellRing, CircleAlert, Globe, KeyRound, Radio, ShieldAlert, Wifi, WifiOff,
} from 'lucide-react';
import { useRealtime } from '@/components/realtime-provider';
import { useSessionSync } from '@/components/session-sync-provider';
import { useServerNow, ageLabel } from '@/lib/time-engine';
import { StatusBadge } from '@/components/design-system';
import { Card, CardContent } from '@/components/ui/card';

function maskId(id: string | null): string {
  const s = String(id ?? '');
  if (s.length < 8) return s || '\u2014';
  return `${s.slice(0, 4)}\u2022\u2022\u2022${s.slice(-4)}`;
}

export function SessionCard() {
  const { active, status, loginSource, sessionId, remainingMs } = useSessionSync();
  const { state } = useRealtime();
  const now = useServerNow();

  const mode = String(state.session?.mode ?? '').toUpperCase();
  const lastRest = state.session?.lastRestSuccessAt ?? null;
  const remaining = remainingMs != null ? Math.max(0, remainingMs) : null;
  const hours = remaining != null ? Math.floor(remaining / 3_600_000) : null;
  const mins = remaining != null ? Math.floor((remaining % 3_600_000) / 60_000) : null;

  const badge = !active
    ? { status: 'neutral' as const, label: status === 'UNKNOWN' ? 'Checking\u2026' : 'No Session' }
    : { status: 'success' as const, label: 'Authenticated' };

  return (
    <Card data-verify="session-status" className="group h-full overflow-hidden">
      <CardContent className="flex h-full flex-col justify-between gap-3 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground ring-1 ring-inset ring-border/50">
              <KeyRound className="h-4 w-4" />
            </span>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Session</p>
          </div>
          <StatusBadge status={badge.status} label={badge.label} />
        </div>

        <div className="space-y-1 text-xs font-normal text-muted-foreground tabular-nums">
          <p className="flex items-center justify-between gap-2">
            <span>Terminal</span>
            <span className="font-medium text-foreground">{mode || 'UNKNOWN'}</span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span>Expires in</span>
            <span className="font-medium text-foreground">
              {active && remaining != null ? `${hours}h ${mins}m` : '\u2014'}
            </span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span>Owner</span>
            <span className="font-medium text-foreground">{loginSource ?? 'None'}</span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span>Session ID</span>
            <span className="font-mono text-[11px] text-foreground">{maskId(sessionId)}</span>
          </p>
          {lastRest ? (
            <p className="flex items-center justify-between gap-2 pt-1 text-[11px] text-muted-foreground/70">
              <span>Broker REST sync</span>
              <span>{ageLabel(lastRest, now) ?? '\u2014'}</span>
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

const ALERT_TONE: Record<string, string> = {
  critical: 'text-destructive',
  high: 'text-destructive',
  medium: 'text-warning',
  low: 'text-info',
  info: 'text-info',
};

export function AlertsCard() {
  const { notificationsState } = useRealtime();
  const now = useServerNow();
  const { unreadCount, activeAlerts, latestAlerts } = notificationsState;
  const shown = latestAlerts.slice(0, 3);

  return (
    <Card data-verify="alerts-summary" className="group h-full overflow-hidden">
      <CardContent className="flex h-full flex-col gap-3 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground ring-1 ring-inset ring-border/50">
              <BellRing className="h-4 w-4" />
            </span>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Alerts</p>
          </div>
          <div className="flex items-center gap-2 text-xs font-medium tabular-nums">
            <StatusBadge status={activeAlerts > 0 ? 'warning' : 'success'} label={`${activeAlerts} active`} />
            {unreadCount > 0 ? (
              <span className="text-warning">{unreadCount} unread</span>
            ) : null}
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 text-[11px] text-muted-foreground">
            <CircleAlert className="h-3.5 w-3.5" />
            No active alerts.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {shown.map((a, i) => (
              <li key={a.alert_id ?? a._id ?? i} className="flex items-start justify-between gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  <span className={`font-medium ${ALERT_TONE[a.severity ?? ''] ?? 'text-foreground'}`}>
                    {a.severity ? `${String(a.severity).toUpperCase()}: ` : ''}
                  </span>
                  {a.title ?? a.message ?? a.component ?? 'Alert'}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground/60">
                  {ageLabel(a.last_seen_at ?? a.triggered_at ?? a.created_at, now) ?? '\u2014'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function BrokerHealthCard() {
  const { appConnection, brokerWsConnected, brokerWsState, internetConnected, sessionActive } = useRealtime();
  const wsTone = brokerWsConnected === true ? 'success' : brokerWsConnected === false ? 'danger' : 'neutral';
  const wsLabel = brokerWsConnected === true ? 'Connected' : brokerWsConnected === false ? 'Disconnected' : brokerWsState;
  const appTone = appConnection === 'CONNECTED' ? 'success' : appConnection === 'OFFLINE' || appConnection === 'DISCONNECTED' ? 'danger' : 'warning';
  const netTone = internetConnected === true ? 'success' : internetConnected === false ? 'danger' : 'neutral';

  return (
    <Card data-verify="broker-health" className="group h-full overflow-hidden">
      <CardContent className="flex h-full flex-col justify-between gap-3 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground ring-1 ring-inset ring-border/50">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Broker Health</p>
        </div>

        <div className="space-y-1.5 text-xs font-normal text-muted-foreground tabular-nums">
          <HealthRow
            icon={Radio}
            dot={wsTone}
            label="Broker WebSocket"
            value={wsLabel}
          />
          <HealthRow
            icon={Globe}
            dot={netTone}
            label="Internet"
            value={internetConnected === true ? 'Reachable' : internetConnected === false ? 'Offline' : 'Checking'}
          />
          <HealthRow
            icon={Wifi}
            dot={appTone}
            label="Backend Stream"
            value={appConnection}
          />
          <HealthRow
            icon={WifiOff}
            dot={sessionActive === true ? 'success' : 'neutral'}
            label="Broker Session"
            value={sessionActive === true ? 'Authenticated' : sessionActive === false ? 'Not connected' : 'Checking'}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function HealthRow({
  icon: Icon, dot, label, value,
}: {
  icon: React.ElementType; dot: 'success' | 'danger' | 'warning' | 'neutral'; label: string; value: string;
}) {
  const dotCls = {
    success: 'bg-success [box-shadow:0_0_5px_hsl(var(--success)/0.7)]',
    danger: 'bg-destructive [box-shadow:0_0_5px_hsl(var(--destructive)/0.6)]',
    warning: 'bg-warning animate-pulse',
    neutral: 'bg-muted-foreground/50 animate-pulse',
  }[dot];
  return (
    <p className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-muted-foreground/80">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
        {value}
      </span>
    </p>
  );
}

export function TradingOpsRow() {
  return (
    <section aria-label="Session, alerts and broker health" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      <SessionCard />
      <AlertsCard />
      <BrokerHealthCard />
    </section>
  );
}