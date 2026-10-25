'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bell, CheckCheck, Trash2, RefreshCw, AlertCircle, Info,
  AlertTriangle, CheckCircle2, Smartphone,
  Send, Power, PowerOff,
  Settings as SettingsIcon, Layers, Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  getNotifications, markNotificationRead, markAllNotificationsRead,
  deleteNotification, clearAllNotifications,
} from '@/lib/api';
import {
  isPushNotificationSupported, getNotificationPermission,
  fetchPushStatus, enablePush, disablePush, sendTestPush,
  hasActivePushSubscription,
} from '@/lib/push-notifications';
import { useToast } from '@/hooks/use-toast';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';
import {
  PageHeader, SectionCard, StatusBadge, EmptyState, LoadingState, ErrorState,
} from '@/components/design-system';

type Notification = {
  _id: string; category: string; level: string; title: string;
  message: string; read: boolean; ts: string;
};

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'trading', label: 'Trading' },
  { key: 'login', label: 'Login' },
  { key: 'connection', label: 'Connection' },
  { key: 'scheduler', label: 'Scheduler' },
  { key: 'mongo', label: 'MongoDB' },
  { key: 'download', label: 'Download' },
  { key: 'system', label: 'System' },
  { key: 'error', label: 'Error' },
];

const LEVEL_ICONS: Record<string, React.ElementType> = {
  info: Info, warn: AlertTriangle, error: AlertCircle, success: CheckCircle2,
};

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-info', warn: 'text-warning', error: 'text-destructive', success: 'text-success',
};

const LEVEL_BG: Record<string, string> = {
  info: 'bg-info/10', warn: 'bg-warning/10', error: 'bg-destructive/10', success: 'bg-success/10',
};

function toIst(ts: string): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }) + ' IST';
  } catch { return '—'; }
}

function toIstDate(ts: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

export default function NotificationsPage() {
  const [activeTab, setActiveTab] = useState('all');
  const { toast } = useToast();

  const { data, live, loading, error: fetchError, refresh } =
    useRealtimeChannel<{ notifications: Notification[]; unreadCount: number }>('notifications', {
      fallbackMs: 10000,
      fallbackKey: 'notifications:feed',
      fallback: () => {
        const params = activeTab !== 'all' ? `?category=${activeTab}` : '';
        return getNotifications(params).then((r) => ({
          notifications: (r?.notifications ?? []) as Notification[],
          unreadCount: Number(r?.unreadCount ?? 0),
        }));
      },
      select: (doc) => {
        const d = doc as { notifications?: any[]; unreadCount?: number };
        const all = (d.notifications ?? []) as Notification[];
        return {
          notifications: activeTab === 'all' ? all : all.filter((n) => n.category === activeTab),
          unreadCount: Number(d.unreadCount ?? 0),
        };
      },
    });

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;

  // ---- Push (PWA / Web) state ----
  const [pushStatus, setPushStatus] = useState<{ enabled: boolean; vapidPublicKey: string | null; subscriptions: number } | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushPerm, setPushPerm] = useState<NotificationPermission>('default');

  const refreshPush = useCallback(async () => {
    if (!isPushNotificationSupported()) { setPushStatus({ enabled: false, vapidPublicKey: null, subscriptions: 0 }); return; }
    try {
      const s = await fetchPushStatus();
      setPushStatus({ enabled: !!s.enabled, vapidPublicKey: s.vapidPublicKey ?? null, subscriptions: Number(s.subscriptions ?? 0) });
    } catch {
      setPushStatus({ enabled: false, vapidPublicKey: null, subscriptions: 0 });
    }
    setPushPerm(getNotificationPermission());
  }, []);

  useEffect(() => { void refreshPush(); }, [refreshPush]);

  const handleEnablePush = async () => {
    setPushBusy(true);
    try {
      const res = await enablePush('notifications-page');
      if (res.ok) {
        toast({ title: 'Push enabled', description: 'This device will receive notifications even when the app is closed.' });
      } else {
        toast({ title: 'Push not enabled', description: res.reason ?? 'unknown reason' });
      }
    } finally {
      setPushBusy(false);
      void refreshPush();
    }
  };

  const handleDisablePush = async () => {
    setPushBusy(true);
    try {
      await disablePush();
      toast({ title: 'Push disabled' });
    } finally {
      setPushBusy(false);
      void refreshPush();
    }
  };

  const handleTestPush = async () => {
    setPushBusy(true);
    try {
      const res = await sendTestPush();
      if (res.ok) {
        toast({ title: 'Test push sent', description: `delivered to ${res.sent ?? 0} device(s)` });
      } else {
        toast({ title: 'Test push failed', description: (res as any).reason ?? 'backend not ready' });
      }
    } catch (err: any) {
      toast({ title: 'Test push failed', description: err?.message ?? String(err) });
    } finally {
      setPushBusy(false);
      void refreshPush();
    }
  };

  const handleMarkRead = async (id: string) => {
    await markNotificationRead(id);
    refresh();
  };
  const handleMarkAllRead = async () => {
    await markAllNotificationsRead();
    toast({ title: 'All marked as read' });
    refresh();
  };
  const handleDelete = async (id: string) => {
    await deleteNotification(id);
    refresh();
  };
  const handleClearAll = async () => {
    await clearAllNotifications();
    toast({ title: 'All cleared' });
    refresh();
  };

  const pushSupported = isPushNotificationSupported();
  const pushEnabled = !!pushStatus?.enabled;
  const subscribed = hasActivePushSubscription();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        subtitle="Trading, system & download alerts · notification_engine · real-time via /api/notifications · PWA/Web Push"
      >
        <StatusBadge status={unreadCount > 0 ? 'danger' : 'success'} label={unreadCount > 0 ? `${unreadCount} unread` : 'all read'} />
        <Badge variant="outline" className={live ? 'border-success/40 text-success' : 'border-warning/40 text-warning'} title={live ? 'Pushed over the WebSocket' : 'REST fallback polling'}>
          {live ? 'WS live' : 'REST fallback'}
        </Badge>
        <Badge variant="outline" className="hidden sm:inline-flex font-mono text-[10px]">
          {notifications.length} total · {activeTab}
        </Badge>
        <Button size="sm" variant="outline" asChild title="Notification preferences live in Settings">
          <a href="/trading/settings">
            <SettingsIcon className="h-4 w-4 mr-1" /> Preferences
          </a>
        </Button>
        <Button size="sm" variant="outline" onClick={handleMarkAllRead} disabled={unreadCount === 0}>
          <CheckCheck className="h-4 w-4 mr-1" /> Mark All Read
        </Button>
        <Button size="sm" variant="ghost" onClick={() => refresh()} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="destructive" onClick={handleClearAll} disabled={notifications.length === 0}>
          <Trash2 className="h-4 w-4 mr-1" /> Clear All
        </Button>
      </PageHeader>

      {fetchError && <ErrorState message={fetchError} onRetry={() => refresh()} />}

      {/* Push Notifications (PWA + Web) */}
      <SectionCard title="Push Notifications (PWA + Web)" icon={Smartphone} className="shadow-soft">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Backend push</p>
            <p className={`font-mono text-sm font-bold ${pushEnabled ? 'text-success' : 'text-warning'}`}>
              {pushStatus === null ? '—' : pushEnabled ? 'ENABLED' : 'DISABLED'}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Subscribed devices</p>
            <p className="font-mono text-sm font-bold">{pushStatus ? pushStatus.subscriptions : '—'}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Browser permission</p>
            <p className={`font-mono text-sm font-bold ${pushPerm === 'granted' ? 'text-success' : pushPerm === 'denied' ? 'text-destructive' : 'text-warning'}`}>
              {pushSupported ? pushPerm.toUpperCase() : 'UNSUPPORTED'}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">This device</p>
            <p className={`font-mono text-sm font-bold ${subscribed ? 'text-success' : 'text-muted-foreground'}`}>
              {subscribed ? 'SUBSCRIBED' : 'NOT SUBSCRIBED'}
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleEnablePush} disabled={pushBusy || !pushSupported || !pushEnabled}>
            <Power className="h-3.5 w-3.5 mr-1" /> {pushBusy ? 'Working…' : 'Enable push on this device'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleDisablePush} disabled={pushBusy || !subscribed}>
            <PowerOff className="h-3.5 w-3.5 mr-1" /> Disable
          </Button>
          <Button size="sm" variant="outline" onClick={handleTestPush} disabled={pushBusy || !pushEnabled}>
            <Send className="h-3.5 w-3.5 mr-1" /> Send test push
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void refreshPush()} disabled={pushBusy}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        {!pushSupported && (
          <p className="mt-2 text-[11px] text-warning">
            This browser does not support Web Push (no service worker / PushManager). Use Chrome/Edge/Firefox on desktop or Android.
          </p>
        )}
        {pushSupported && pushPerm === 'denied' && (
          <p className="mt-2 text-[11px] text-destructive">
            Notification permission is blocked. Re-enable it in the browser site settings, then click "Enable push".
          </p>
        )}
        {pushEnabled && pushStatus?.vapidPublicKey && (
          <p className="mt-2 font-mono text-[10px] text-muted-foreground/70 break-all">
            VAPID public key: {pushStatus.vapidPublicKey}
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Pushes are sent by the backend on every new notification (fan-out to all subscribed devices). Dead endpoints (404/410) are pruned automatically.
        </p>
      </SectionCard>

      {/* Category Tabs */}
      <SectionCard title="Categories" icon={Layers} className="shadow-soft">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            {CATEGORIES.map((cat) => (
              <TabsTrigger key={cat.key} value={cat.key}>{cat.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </SectionCard>

      {/* Notification List */}
      <SectionCard title="Notifications" icon={Bell} headerRight={<Badge variant="outline">{notifications.length} · {unreadCount} unread</Badge>} className="shadow-soft">
        {loading ? (
          <LoadingState text="Loading notifications…" />
        ) : notifications.length === 0 ? (
          <EmptyState icon={Bell} title="No notifications" description="Notifications from trading, downloads, and system will appear here. Filter by category above or wait for real events from the notification_engine." />
        ) : (
          <div className="max-h-[600px] overflow-y-auto divide-y divide-border/30 rounded-lg border border-border/50">
            {notifications.map((n) => {
              const Icon = LEVEL_ICONS[n.level] ?? Info;
              const levelColor = LEVEL_COLORS[n.level] ?? 'text-primary';
              const levelBg = LEVEL_BG[n.level] ?? 'bg-primary/10';
              return (
                <div
                  key={n._id}
                  className={`flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/30 ${n.read ? 'opacity-60' : ''}`}
                >
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${levelBg}`}>
                    <Icon className={`h-4 w-4 ${levelColor}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{n.title}</span>
                      {!n.read && <StatusBadge status="danger" label="UNREAD" />}
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">{n.category}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">{n.message}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-[11px] text-muted-foreground/70 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {toIst(n.ts)}
                      </span>
                      <span className="text-[11px] text-muted-foreground/50">{toIstDate(n.ts)}</span>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {!n.read && (
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleMarkRead(n._id)}>
                        <CheckCheck className="h-3.5 w-3.5 text-success" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleDelete(n._id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive/70" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
