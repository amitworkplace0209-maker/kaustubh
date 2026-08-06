'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Bell, CheckCheck, Trash2, RefreshCw, AlertCircle, Info,
  AlertTriangle, CheckCircle2, Volume2, Smartphone,
  Settings as SettingsIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  getNotifications, markNotificationRead, markAllNotificationsRead,
  deleteNotification, clearAllNotifications, getSettings, updateSetting,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

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
  info: 'text-primary', warn: 'text-warning', error: 'text-destructive', success: 'text-success',
};

const NOTIFICATION_SETTINGS = [
  { key: 'notification_trading', label: 'Trading Alerts' },
  { key: 'notification_login', label: 'Login Alerts' },
  { key: 'notification_connection', label: 'Connection Alerts' },
  { key: 'notification_scheduler', label: 'Scheduler Alerts' },
  { key: 'notification_mongo', label: 'MongoDB Alerts' },
  { key: 'notification_download', label: 'Download Alerts' },
  { key: 'notification_system', label: 'System Alerts' },
  { key: 'notification_error', label: 'Error Alerts' },
];

function safeTime(ts: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeTab, setActiveTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const { toast } = useToast();

  const fetch = useCallback(async () => {
    try {
      const params = activeTab !== 'all' ? `?category=${activeTab}` : '';
      const data = await getNotifications(params);
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [activeTab]);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await getSettings();
      setSettings(data.settings || {});
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetch();
    fetchSettings();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [fetch, fetchSettings]);

  const handleToggle = async (key: string, value: boolean) => {
    setSettings((prev) => ({ ...prev, [key]: { ...prev[key], value } }));
    try {
      await updateSetting(key, value);
      toast({ title: 'Setting saved' });
    } catch {
      toast({ title: 'Error', variant: 'destructive' });
    }
  };

  const handleMarkRead = async (id: string) => { await markNotificationRead(id); fetch(); };
  const handleMarkAllRead = async () => { await markAllNotificationsRead(); toast({ title: 'All marked as read' }); fetch(); };
  const handleDelete = async (id: string) => { await deleteNotification(id); fetch(); };
  const handleClearAll = async () => { await clearAllNotifications(); toast({ title: 'All cleared' }); fetch(); };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Bell className="h-6 w-6 text-primary" />
            {unreadCount > 0 && (
              <span className="absolute -top-2 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                {unreadCount}
              </span>
            )}
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
            <p className="text-sm text-muted-foreground">{unreadCount} unread</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handleMarkAllRead}>
            <CheckCheck className="h-4 w-4 mr-2" /> Mark All Read
          </Button>
          <Button size="sm" variant="ghost" onClick={fetch}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" variant="destructive" onClick={handleClearAll}>
            <Trash2 className="h-4 w-4 mr-2" /> Clear All
          </Button>
        </div>
      </div>

      {/* Notification Settings */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><SettingsIcon className="h-4 w-4" /> Notification Preferences</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            {NOTIFICATION_SETTINGS.map((s) => (
              <div key={s.key} className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-sm font-medium">{s.label}</span>
                <Switch
                  checked={settings[s.key]?.value ?? true}
                  onCheckedChange={(v) => handleToggle(s.key, v)}
                />
              </div>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-3 mt-4 pt-4 border-t">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2"><Volume2 className="h-4 w-4 text-muted-foreground" /><span className="text-sm">Sound</span></div>
              <Switch checked={settings.notification_sound?.value ?? true} onCheckedChange={(v) => handleToggle('notification_sound', v)} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2"><Bell className="h-4 w-4 text-muted-foreground" /><span className="text-sm">Popup</span></div>
              <Switch checked={settings.notification_popup?.value ?? true} onCheckedChange={(v) => handleToggle('notification_popup', v)} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-muted-foreground" /><span className="text-sm">Push</span></div>
              <Switch checked={settings.notification_push?.value ?? false} onCheckedChange={(v) => handleToggle('notification_push', v)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Category Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex flex-wrap h-auto gap-1">
          {CATEGORIES.map((cat) => (
            <TabsTrigger key={cat.key} value={cat.key}>{cat.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Notification List */}
      <Card>
        <CardContent className="p-0">
          <div className="max-h-[500px] overflow-y-auto">
            {loading ? (
              <p className="p-8 text-center text-muted-foreground">Loading...</p>
            ) : notifications.length === 0 ? (
              <p className="p-8 text-center text-muted-foreground">No notifications</p>
            ) : (
              <div className="space-y-1 p-3">
                {notifications.map((n) => {
                  const Icon = LEVEL_ICONS[n.level] ?? Info;
                  return (
                    <div key={n._id} className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${n.read ? 'opacity-60' : 'bg-muted/30'}`}>
                      <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${LEVEL_COLORS[n.level] ?? 'text-primary'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{n.title}</span>
                          {!n.read && <span className="h-2 w-2 rounded-full bg-destructive" />}
                          <Badge variant="secondary" className="text-xs">{n.category}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">{n.message}</p>
                        <p className="text-xs text-muted-foreground/70 mt-1">{safeTime(n.ts)}</p>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {!n.read && (
                          <Button size="sm" variant="ghost" onClick={() => handleMarkRead(n._id)}>
                            <CheckCheck className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => handleDelete(n._id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
