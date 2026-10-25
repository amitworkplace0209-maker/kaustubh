'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, BellRing, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SM, fmtNum } from '@/app/_pages/session-manager/sm-shared';

/**
 * Session Manager → PWA + notification support.
 *
 * - `usePwaInstall` / `PwaInstallButton`: captures `beforeinstallprompt` so the
 *   app can be installed from inside the section UI (the manifest + service
 *   worker already exist at the app shell level).
 * - `useSessionAlerts`: polls the REAL overview snapshot and derives honest
 *   alerts (expiry, disconnected connections, degraded health, revision drift,
 *   inactive session). Nothing is fabricated — no snapshot, no alerts.
 * - `NotificationBell`: in-app alert center dropdown + browser-Notification
 *   fan-out for NEW critical alerts once the user grants permission.
 */

export type SmAlert = {
  id: string;
  severity: 'critical' | 'warn' | 'info';
  title: string;
  detail: string;
};

function deriveAlerts(overview: any): SmAlert[] {
  if (!overview) return [];
  const alerts: SmAlert[] = [];
  const counts = overview.counts ?? {};
  const status = overview.statusCounts ?? {};
  const health = overview.health ?? {};
  const rev = overview.revisionApply ?? {};
  const conns = overview.connections ?? [];
  const ws = overview.websocket ?? {};
  const active = overview.active ?? false;

  const expired = Number(status.EXPIRED ?? 0);
  const expiring = Number(status.EXPIRING ?? 0);
  if (expired > 0) {
    alerts.push({
      id: 'expired', severity: 'warn',
      title: `${fmtNum(expired)} instruments expired`,
      detail: 'Wall-clock expiry enforced — historical ticks are archived, never purged.',
    });
  }
  if (expiring > 0) {
    alerts.push({
      id: 'expiring', severity: 'info',
      title: `${fmtNum(expiring)} instruments expiring`,
      detail: 'Inside the expiry-warning horizon. See the Expiry page.',
    });
  }
  if (!active) {
    alerts.push({
      id: 'inactive', severity: 'warn',
      title: 'No active session',
      detail: 'Session Manager reports no active owner session.',
    });
  }
  if (ws.state && ws.state !== 'CONNECTED') {
    alerts.push({
      id: 'ws', severity: 'warn',
      title: `WebSocket ${ws.state}`,
      detail: 'Feed WebSocket is not connected.',
    });
  }
  for (const c of conns) {
    const cid = c.connection_id ?? c.id ?? 'conn';
    if (c.state === 'DISCONNECTED' || c.state === 'ERROR') {
      alerts.push({
        id: `conn-${cid}`, severity: 'critical',
        title: `Connection ${cid} ${String(c.state).toLowerCase()}`,
        detail: `Broker ${c.broker ?? '—'} · reconnects ${fmtNum(c.reconnect_count)}`,
      });
    }
  }
  if (health && health.ok === false) {
    alerts.push({
      id: 'health', severity: 'warn',
      title: 'Engine health degraded',
      detail: (health.reasons ?? []).join('; ') || 'See Diagnostics.',
    });
  }
  if (rev && rev.fully_applied === false) {
    alerts.push({
      id: 'revision', severity: 'warn',
      title: 'Revision drift',
      detail: `Desired ${fmtNum(rev.desired)} not fully applied on every connection.`,
    });
  }
  if (Number(counts.total ?? 0) === 0) {
    alerts.push({
      id: 'empty', severity: 'info',
      title: 'No instruments yet',
      detail: 'Canonical registry is empty — add instruments from the Instruments page.',
    });
  }
  return alerts;
}

export function useSessionAlerts(pollMs = 30000): {
  alerts: SmAlert[];
  critical: number;
  badge: number;
  loading: boolean;
  refresh: () => void;
} {
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const seenCritical = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${SM}/overview`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      const data = body?.data ?? body;
      setOverview(data?.realStatus ?? data ?? null);
    } catch {
      /* backend unreachable — no alerts rather than fake ones */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const alerts = deriveAlerts(overview);

  /* Browser fan-out: NEW critical alerts only, permission-gated. */
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    for (const a of alerts) {
      if (a.severity !== 'critical' || seenCritical.current.has(a.id)) continue;
      seenCritical.current.add(a.id);
      try {
        new Notification(`Session Manager · ${a.title}`, { body: a.detail, tag: a.id });
      } catch {
        /* ignore — in-app bell still shows everything */
      }
    }
  }, [alerts]);

  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const badge = alerts.filter((a) => a.severity !== 'info').length;
  return { alerts, critical, badge, loading, refresh };
}

export function useNotifyPermission(): {
  permission: NotificationPermission | 'unsupported';
  request: () => Promise<void>;
} {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );
  const request = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return;
    }
    try {
      const p = await Notification.requestPermission();
      setPermission(p);
    } catch {
      setPermission(Notification.permission);
    }
  }, []);
  return { permission, request };
}

type BipEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export function usePwaInstall(): {
  canInstall: boolean;
  installed: boolean;
  promptInstall: () => Promise<void>;
} {
  const [deferred, setDeferred] = useState<BipEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) setInstalled(true);
    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BipEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice.catch(() => undefined);
    } finally {
      setDeferred(null);
    }
  }, [deferred]);

  return { canInstall: !!deferred && !installed, installed, promptInstall };
}

export function PwaInstallButton({ compact }: { compact?: boolean }) {
  const { canInstall, installed, promptInstall } = usePwaInstall();
  if (installed) {
    return (
      <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 border-emerald-500/25">
        <Download className="mr-1 h-3 w-3" /> Installed
      </Badge>
    );
  }
  if (!canInstall) return null;
  return (
    <Button size="sm" variant="outline" onClick={() => void promptInstall()} title="Install this app on your device">
      <Download className="mr-1 h-3.5 w-3.5" /> {compact ? 'Install' : 'Install app'}
    </Button>
  );
}

const SEVERITY_DOT: Record<SmAlert['severity'], string> = {
  critical: 'bg-rose-400',
  warn: 'bg-amber-400',
  info: 'bg-sky-400',
};

export function NotificationBell() {
  const { alerts, badge, critical, refresh } = useSessionAlerts();
  const { permission, request } = useNotifyPermission();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="relative" aria-label="Session alerts">
          {critical > 0 ? <BellRing className="h-4 w-4 text-amber-700" /> : <Bell className="h-4 w-4" />}
          {badge > 0 && (
            <span className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-bold ${critical > 0 ? 'bg-rose-500 text-white' : 'bg-amber-500 text-black'}`}>
              {badge}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          Session alerts
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => refresh()}>Refresh</Button>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          {permission === 'granted' ? (
            <p className="text-[11px] text-emerald-700">Browser notifications ON — critical alerts pop up even in background.</p>
          ) : permission === 'denied' ? (
            <p className="text-[11px] text-muted-foreground">Browser notifications blocked in site settings.</p>
          ) : permission === 'unsupported' ? (
            <p className="text-[11px] text-muted-foreground">This browser has no Notification API.</p>
          ) : (
            <Button size="sm" variant="outline" className="w-full" onClick={() => void request()}>
              <Bell className="mr-1.5 h-3.5 w-3.5" /> Enable browser notifications
            </Button>
          )}
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-auto">
          {alerts.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">All clear — no session alerts right now.</p>
          )}
          {alerts.map((a) => (
            <DropdownMenuItem key={a.id} className="flex cursor-default items-start gap-2 py-2" onSelect={(e) => e.preventDefault()}>
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[a.severity]}`} />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{a.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{a.detail}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/services/session-manager/diagnostics" className="text-xs text-muted-foreground">Open Diagnostics →</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
