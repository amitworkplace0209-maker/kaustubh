'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Settings as SettingsIcon, Save, RotateCcw, Server, CandlestickChart,
  Database, Download, ScrollText, Bell, Palette, Shield, User,
  CheckCircle2, RefreshCw, Power, HardDrive, Activity, Wifi, Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useTheme } from 'next-themes';
import {
  getSettings, updateSetting, resetSetting, resetAllSettings,
  getSystemStatus, getMongoStats, clearLogs,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

type SettingEntry = { key: string; value: any; category: string; description: string; updatedAt: string | null };
type SettingsMap = Record<string, SettingEntry>;

const SECTIONS = [
  { key: 'profile', label: 'Profile', icon: User },
  { key: 'theme', label: 'Theme', icon: Palette },
  { key: 'trading', label: 'Trading', icon: CandlestickChart },
  { key: 'python', label: 'Python Service', icon: Server },
  { key: 'data_saver', label: 'Data Saver', icon: Database },
  { key: 'mongodb', label: 'MongoDB', icon: HardDrive },
  { key: 'download', label: 'Downloads', icon: Download },
  { key: 'log', label: 'Logs', icon: ScrollText },
  { key: 'notification', label: 'Notifications', icon: Bell },
  { key: 'security', label: 'Security', icon: Shield },
] as const;

const SELECT_OPTIONS: Record<string, { value: string; label: string }[]> = {
  theme: [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
    { value: 'amoled', label: 'AMOLED' },
  ],
  trading_mode: [
    { value: 'api', label: 'Live API Mode' },
    { value: 'dummy', label: 'Dummy Mode' },
  ],
  default_product: [
    { value: 'MIS', label: 'MIS (Intraday)' },
    { value: 'CNC', label: 'CNC (Delivery)' },
    { value: 'NRML', label: 'NRML' },
  ],
  intraday_default: [
    { value: 'MIS', label: 'MIS' },
    { value: 'NRML', label: 'NRML' },
  ],
  default_order_type: [
    { value: 'MKT', label: 'Market' },
    { value: 'L', label: 'Limit' },
    { value: 'SL', label: 'SL' },
    { value: 'SL-M', label: 'SL-M' },
  ],
  log_level: [
    { value: 'debug', label: 'Debug' },
    { value: 'info', label: 'Info' },
    { value: 'warn', label: 'Warn' },
    { value: 'error', label: 'Error' },
  ],
  sidebar_style: [
    { value: 'default', label: 'Default' },
    { value: 'compact', label: 'Compact' },
    { value: 'icon-only', label: 'Icon Only' },
  ],
  default_exchange: [
    { value: 'nse_cm', label: 'NSE' },
    { value: 'bse_cm', label: 'BSE' },
    { value: 'nse_fo', label: 'NSE F&O' },
    { value: 'mcx_fo', label: 'MCX' },
  ],
  download_default_format: [
    { value: 'csv', label: 'CSV' },
    { value: 'json', label: 'JSON' },
    { value: 'jsonl', label: 'JSONL' },
    { value: 'ndjson', label: 'NDJSON' },
    { value: 'txt', label: 'TXT' },
    { value: 'xlsx', label: 'Excel' },
    { value: 'zip', label: 'ZIP' },
  ],
};

const SELECT_KEYS = new Set(Object.keys(SELECT_OPTIONS));

function SettingField({ setting, onSave, onReset, saving }: {
  setting: SettingEntry; onSave: (key: string, value: any) => void; onReset: (key: string) => void; saving: string | null;
}) {
  const [localValue, setLocalValue] = useState(setting.value);
  const dirty = JSON.stringify(localValue) !== JSON.stringify(setting.value);

  useEffect(() => { setLocalValue(setting.value); }, [setting.value]);

  const isBool = typeof setting.value === 'boolean';
  const isNumber = typeof setting.value === 'number';
  const isSelect = SELECT_KEYS.has(setting.key);
  const isColor = setting.key.includes('color') && setting.key.includes('custom_');

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{setting.description}</Label>
        {dirty && <span className="text-xs text-amber-500">unsaved</span>}
      </div>
      <div className="flex gap-2">
        {isBool ? (
          <div className="flex items-center gap-2 flex-1">
            <Switch checked={localValue} onCheckedChange={setLocalValue} />
            <span className="text-sm text-muted-foreground">{localValue ? 'Enabled' : 'Disabled'}</span>
          </div>
        ) : isSelect ? (
          <Select value={String(localValue)} onValueChange={setLocalValue}>
            <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(SELECT_OPTIONS[setting.key] || []).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : isColor ? (
          <div className="flex items-center gap-2 flex-1">
            <input type="color" value={String(localValue)} onChange={(e) => setLocalValue(e.target.value)} className="h-8 w-12 rounded border" />
            <Input value={String(localValue)} onChange={(e) => setLocalValue(e.target.value)} className="flex-1" />
          </div>
        ) : (
          <Input
            type={isNumber ? 'number' : 'text'}
            value={String(localValue ?? '')}
            onChange={(e) => setLocalValue(isNumber ? Number(e.target.value) : e.target.value)}
            className="flex-1"
          />
        )}
        <Button size="sm" variant="outline" onClick={() => onSave(setting.key, localValue)} disabled={!dirty || saving === setting.key}>
          <Save className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onReset(setting.key)}>
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex justify-between py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium ${ok === true ? 'text-success' : ok === false ? 'text-destructive' : ''}`}>{value}</span>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [mongoStats, setMongoStats] = useState<any>(null);
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();

  const fetchAll = useCallback(async () => {
    try {
      const [settingsData, sysData, mongoData] = await Promise.allSettled([
        getSettings(), getSystemStatus(), getMongoStats(),
      ]);
      if (settingsData.status === 'fulfilled') setSettings(settingsData.value.settings);
      if (sysData.status === 'fulfilled') setSystemStatus(sysData.value);
      if (mongoData.status === 'fulfilled') setMongoStats(mongoData.value);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setMounted(true);
    fetchAll();
    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleSave = async (key: string, value: any) => {
    setSaving(key);
    try {
      await updateSetting(key, value);
      setSettings((prev) => ({ ...prev, [key]: { ...prev[key], value } }));
      if (key === 'theme') setTheme(String(value));
      toast({ title: 'Setting saved', description: settings[key]?.description ?? key });
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    } finally { setSaving(null); }
  };

  const handleReset = async (key: string) => {
    try {
      const res = await resetSetting(key);
      setSettings((prev) => ({ ...prev, [key]: res.setting }));
      toast({ title: 'Setting reset', description: settings[key]?.description ?? key });
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    }
  };

  const handleResetAll = async () => {
    try {
      const res = await resetAllSettings();
      setSettings(res.settings);
      toast({ title: 'All settings reset', description: 'Restored to defaults' });
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    }
  };

  const handleClearLogs = async (category?: string) => {
    try {
      const res = await clearLogs(category);
      toast({ title: 'Logs cleared', description: `${res.deleted} entries removed` });
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    }
  };

  if (!mounted || loading) {
    return <div className="flex items-center justify-center h-full"><SettingsIcon className="h-8 w-8 animate-pulse text-muted-foreground" /></div>;
  }

  const catSettings = (cat: string) => Object.entries(settings).filter(([, v]) => v.category === cat);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Central configuration — every setting saves to the database</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleResetAll}>
          <RotateCcw className="h-4 w-4 mr-2" /> Reset All
        </Button>
      </div>

      <Tabs defaultValue="profile">
        <TabsList className="flex flex-wrap h-auto gap-1">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <TabsTrigger key={s.key} value={s.key} className="gap-2">
                <Icon className="h-4 w-4" />{s.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* 1. Profile */}
        <TabsContent value="profile" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><User className="h-4 w-4" /> Profile Info</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {catSettings('profile').map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Current Status</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                <StatusRow label="Trading Mode" value={settings.trading_mode?.value === 'dummy' ? 'Dummy Mode' : 'Live API Mode'} />
                <StatusRow label="App Version" value={String(settings.app_version?.value ?? '—')} />
                <StatusRow label="User ID" value={String(settings.user_id?.value ?? '—')} />
                <StatusRow label="Kotak Login" value={systemStatus?.pythonStatus?.logged_in ? 'Logged In' : 'Not Logged In'} ok={systemStatus?.pythonStatus?.logged_in} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 2. Theme */}
        <TabsContent value="theme" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Palette className="h-4 w-4" /> Theme</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {catSettings('theme').map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Custom Colors</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {catSettings('profile').filter(([k]) => k.includes('custom_')).map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
                <div className="mt-4 p-4 rounded-lg border-2" style={{ borderColor: String(settings.custom_primary_color?.value ?? '#0f7a52') }}>
                  <p className="text-sm text-muted-foreground mb-2">Preview</p>
                  <Button style={{ backgroundColor: String(settings.custom_primary_color?.value ?? '#0f7a52') }} className="text-white">
                    Primary Button
                  </Button>
                  <Button variant="outline" className="ml-2" style={{ borderColor: String(settings.custom_accent_color?.value ?? '#0d9488'), color: String(settings.custom_accent_color?.value ?? '#0d9488') }}>
                    Accent Button
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 3. Trading */}
        <TabsContent value="trading" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><CandlestickChart className="h-4 w-4" /> Trading Mode</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <SettingField setting={settings.trading_mode} onSave={handleSave} onReset={handleReset} saving={saving} />
                {catSettings('trading').filter(([k]) => k !== 'trading_mode' && k !== 'trading_enabled').map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Risk Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <SettingField setting={settings.max_risk_per_trade} onSave={handleSave} onReset={handleReset} saving={saving} />
                <SettingField setting={settings.max_daily_loss} onSave={handleSave} onReset={handleReset} saving={saving} />
                <SettingField setting={settings.confirm_before_order} onSave={handleSave} onReset={handleReset} saving={saving} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 4. Python Service */}
        <TabsContent value="python" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Server className="h-4 w-4" /> Python Service Status</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                <StatusRow label="Python Status" value={systemStatus?.python?.status ?? '—'} ok={systemStatus?.python?.status === 'ok'} />
                <StatusRow label="SDK Version" value={String(settings.sdk_version?.value ?? '—')} />
                <StatusRow label="Login Status" value={systemStatus?.pythonStatus?.logged_in ? 'Logged In' : 'Not Logged In'} ok={systemStatus?.pythonStatus?.logged_in} />
                <StatusRow label="Session Status" value={systemStatus?.pythonStatus?.session_active ? 'Active' : 'Inactive'} ok={systemStatus?.pythonStatus?.session_active} />
                <StatusRow label="Scheduler Status" value={systemStatus?.schedulerRunning ? 'Running' : 'Stopped'} ok={systemStatus?.schedulerRunning} />
                <StatusRow label="WebSocket Status" value={systemStatus?.websocketConnected ? 'Connected' : 'Disconnected'} ok={systemStatus?.websocketConnected} />
                <StatusRow label="Last Login" value={systemStatus?.lastLogin ? new Date(systemStatus.lastLogin).toISOString().slice(0, 19) : '—'} />
                <StatusRow label="Last Logout" value={systemStatus?.lastLogout ? new Date(systemStatus.lastLogout).toISOString().slice(0, 19) : '—'} />
                <StatusRow label="Last WS Connection" value={systemStatus?.lastWebSocketConnection ? new Date(systemStatus.lastWebSocketConnection).toISOString().slice(0, 19) : '—'} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Python Configuration</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {catSettings('python').map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 5. Data Saver */}
        <TabsContent value="data_saver" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Database className="h-4 w-4" /> Data Saver Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {catSettings('data_saver').map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Current Stats</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                <StatusRow label="Data Saver Status" value={settings.data_saver_enabled?.value ? 'Enabled' : 'Disabled'} ok={settings.data_saver_enabled?.value} />
                <StatusRow label="Current Saved Records" value={String(systemStatus?.buffer?.totalWritten ?? 0)} />
                <StatusRow label="Today's Saved Records" value={String(systemStatus?.todayInserts ?? 0)} />
                <StatusRow label="Buffer Length" value={String(systemStatus?.buffer?.bufferLength ?? 0)} />
                <StatusRow label="Write Errors" value={String(systemStatus?.buffer?.totalWriteErrors ?? 0)} ok={systemStatus?.buffer?.totalWriteErrors === 0} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 6. MongoDB */}
        <TabsContent value="mongodb" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><HardDrive className="h-4 w-4" /> MongoDB Status</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                <StatusRow label="Connection Status" value={mongoStats?.connected ? 'Connected' : 'Disconnected'} ok={mongoStats?.connected} />
                <StatusRow label="Database Name" value={mongoStats?.stats?.dbName ?? '—'} />
                <StatusRow label="Ping" value={mongoStats?.stats ? `${mongoStats.stats.pingMs}ms` : '—'} ok={mongoStats?.connected} />
                <StatusRow label="Storage Used" value={mongoStats?.stats ? `${(mongoStats.stats.totalStorageBytes / 1024 / 1024).toFixed(1)} MB` : '—'} />
                <StatusRow label="Total Objects" value={String(mongoStats?.stats?.totalObjects ?? 0)} />
                <StatusRow label="Index Size" value={mongoStats?.stats ? `${(mongoStats.stats.totalIndexSizeBytes / 1024 / 1024).toFixed(1)} MB` : '—'} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Collections</CardTitle></CardHeader>
              <CardContent>
                {mongoStats?.stats?.collections ? (
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {mongoStats.stats.collections.map((c: any) => (
                      <div key={c.name} className="flex justify-between text-sm border-b border-border/50 py-1">
                        <span className="font-mono">{c.name}</span>
                        <span className="text-muted-foreground">{c.count} docs · {(c.storageBytes / 1024).toFixed(0)} KB</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No collection data available</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 7. Downloads */}
        <TabsContent value="download" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Download className="h-4 w-4" /> Download Settings</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {catSettings('download').map(([key, s]) => (
                <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* 8. Logs */}
        <TabsContent value="log" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><ScrollText className="h-4 w-4" /> Log Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {catSettings('log').map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Clear Logs</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">Clear all log entries from the database. This action cannot be undone.</p>
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" onClick={() => handleClearLogs()}>
                    <ScrollText className="h-4 w-4 mr-2" /> Clear All Logs
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 9. Notifications */}
        <TabsContent value="notification" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bell className="h-4 w-4" /> Notification Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {catSettings('notification').map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 10. Security */}
        <TabsContent value="security" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4" /> Security Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {catSettings('security').map(([key, s]) => (
                  <SettingField key={key} setting={s} onSave={handleSave} onReset={handleReset} saving={saving} />
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
