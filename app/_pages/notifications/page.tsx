'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Bell, CheckCheck, Trash2, RefreshCw, AlertCircle, Info,
  AlertTriangle, CheckCircle2,
  Settings as SettingsIcon, Clock, Layers,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  getNotifications, markNotificationRead, markAllNotificationsRead,
  deleteNotification, clearAllNotifications,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import {
  PageHeader,
  SectionCard,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
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
  info: 'text-info',
  warn: 'text-warning',
  error: 'text-destructive',
  success: 'text-success',
};

const LEVEL_BG: Record<string, string> = {
  info: 'bg-info/10',
  warn: 'bg-warning/10',
  error: 'bg-destructive/10',
  success: 'bg-success/10',
};

function toIst(ts: string): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' IST';
  } catch { return '—'; }
}

function toIstDate(ts: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch { return ''; }
}

/** Notifications feed — list only. All preference switches live in
 *  Settings → Notifications; this page only shows, reads and deletes. */
export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeTab, setActiveTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const { toast } = useToast();

  const fetch = useCallback(async () => {
    try {
      const params = activeTab !== 'all' ? `?category=${activeTab}` : '';
      const data = await getNotifications(params);
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
      setFetchError(null);
    } catch (e: any) {
      setFetchError(e?.message ?? String(e));
    }
    finally { setLoading(false); }
  }, [activeTab]);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [fetch]);

  const handleMarkRead = async (id: string) => { await markNotificationRead(id); fetch(); };
  const handleMarkAllRead = async () => { await markAllNotificationsRead(); toast({ title: 'All marked as read' }); fetch(); };
  const handleDelete = async (id: string) => { await deleteNotification(id); fetch(); };
  const handleClearAll = async () => { await clearAllNotifications(); toast({ title: 'All cleared' }); fetch(); };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        subtitle="Trading, system & download alerts · notification_engine · real-time via /api/notifications"
      >
        <StatusBadge status={unreadCount > 0 ? 'danger' : 'success'} label={unreadCount > 0 ? `${unreadCount} unread` : 'all read'} />
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
        <Button size="sm" variant="ghost" onClick={fetch} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="destructive" onClick={handleClearAll} disabled={notifications.length === 0}>
          <Trash2 className="h-4 w-4 mr-1" /> Clear All
        </Button>
      </PageHeader>

      {fetchError && <ErrorState message={fetchError} onRetry={fetch} />}

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
