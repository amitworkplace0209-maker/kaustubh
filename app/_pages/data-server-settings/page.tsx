'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Server, Save, Monitor, Database, Bell, Shield, Download, Upload,
  RefreshCw, FileJson,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { istDateKey } from '@/lib/ist';

const STORAGE_KEY = 'data-server-settings';

interface DataServerSettings {
  display: {
    tickTablePageSize: string;
    timestampFormat: string;
    showEmaColumns: boolean;
    autoRefreshInterval: string;
  };
  dataPreferences: {
    defaultExchange: string;
    priceDecimalPlaces: string;
    volumeDisplay: string;
    changeDisplay: string;
  };
  notifications: {
    tickAlertThreshold: string;
    priceChangeAlert: boolean;
    alertSound: boolean;
  };
  dataQuality: {
    staleTickThreshold: string;
    autoPauseOnStale: boolean;
    qualityScoreMinimum: string;
  };
}

const DEFAULT_SETTINGS: DataServerSettings = {
  display: {
    tickTablePageSize: '25',
    timestampFormat: 'ist-12h',
    showEmaColumns: true,
    autoRefreshInterval: '3s',
  },
  dataPreferences: {
    defaultExchange: 'NSE',
    priceDecimalPlaces: '2',
    volumeDisplay: 'raw',
    changeDisplay: 'both',
  },
  notifications: {
    tickAlertThreshold: '100',
    priceChangeAlert: false,
    alertSound: true,
  },
  dataQuality: {
    staleTickThreshold: '5',
    autoPauseOnStale: true,
    qualityScoreMinimum: '80',
  },
};

function loadSettings(): DataServerSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      display: { ...DEFAULT_SETTINGS.display, ...parsed.display },
      dataPreferences: { ...DEFAULT_SETTINGS.dataPreferences, ...parsed.dataPreferences },
      notifications: { ...DEFAULT_SETTINGS.notifications, ...parsed.notifications },
      dataQuality: { ...DEFAULT_SETTINGS.dataQuality, ...parsed.dataQuality },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: DataServerSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function FieldRow({ label, description, children }: {
  label: string; description?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {description && <div className="text-[10px] text-muted-foreground mt-0.5">{description}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {children}
      </div>
    </div>
  );
}

function SectionCard({ title, icon: Icon, accent, children }: {
  title: string; icon: React.ElementType; accent?: string; children: React.ReactNode;
}) {
  return (
    <Card className={cn('border-border/40 bg-card', accent)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-foreground">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">{children}</CardContent>
    </Card>
  );
}

export default function DataServerSettingsPage() {
  const [settings, setSettings] = useState<DataServerSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const updateField = useCallback(<K extends keyof DataServerSettings>(
    section: K,
    field: keyof DataServerSettings[K],
    value: any
  ) => {
    setSettings((prev) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [field]: value,
      },
    }));
  }, []);

  const handleSave = useCallback(() => {
    setSaving(true);
    saveSettings(settings);
    const now = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    setLastSaved(now);
    setTimeout(() => setSaving(false), 400);
    toast({ title: 'Settings saved successfully' });
  }, [settings, saveSettings, toast]);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `data-server-settings-${istDateKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Settings exported' });
  }, [settings, toast]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        const merged: DataServerSettings = {
          display: { ...DEFAULT_SETTINGS.display, ...parsed.display },
          dataPreferences: { ...DEFAULT_SETTINGS.dataPreferences, ...parsed.dataPreferences },
          notifications: { ...DEFAULT_SETTINGS.notifications, ...parsed.notifications },
          dataQuality: { ...DEFAULT_SETTINGS.dataQuality, ...parsed.dataQuality },
        };
        setSettings(merged);
        saveSettings(merged);
        toast({ title: 'Settings imported successfully' });
      } catch {
        toast({ title: 'Invalid settings file', variant: 'destructive' });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [toast]);

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6 space-y-5">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Page Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Server className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground">Data Server Settings</h1>
            <p className="text-xs text-muted-foreground">Configure data server preferences and display options</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastSaved && (
            <span className="text-[10px] text-muted-foreground">Last saved: {lastSaved}</span>
          )}
          <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={saving}>
            {saving ? (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1.5" />
            )}
            Save Settings
          </Button>
        </div>
      </div>

      {/* Display Settings */}
      <SectionCard title="Display Settings" icon={Monitor}>
        <FieldRow label="Tick Table Page Size" description="Number of rows displayed per page in tick table">
          <Select
            value={settings.display.tickTablePageSize}
            onValueChange={(v) => updateField('display', 'tickTablePageSize', v)}
          >
            <SelectTrigger className="w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10 rows</SelectItem>
              <SelectItem value="25">25 rows</SelectItem>
              <SelectItem value="50">50 rows</SelectItem>
              <SelectItem value="100">100 rows</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Timestamp Format" description="How timestamps are displayed in tick data">
          <Select
            value={settings.display.timestampFormat}
            onValueChange={(v) => updateField('display', 'timestampFormat', v)}
          >
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ist-12h">IST (12h)</SelectItem>
              <SelectItem value="ist-24h">IST (24h)</SelectItem>
              <SelectItem value="utc">UTC</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Show EMA Columns" description="Display Exponential Moving Average columns in tick table">
          <Switch
            checked={settings.display.showEmaColumns}
            onCheckedChange={(v) => updateField('display', 'showEmaColumns', v)}
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Auto-refresh Interval" description="How often the tick table refreshes with new data">
          <Select
            value={settings.display.autoRefreshInterval}
            onValueChange={(v) => updateField('display', 'autoRefreshInterval', v)}
          >
            <SelectTrigger className="w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1s">1 second</SelectItem>
              <SelectItem value="3s">3 seconds</SelectItem>
              <SelectItem value="5s">5 seconds</SelectItem>
              <SelectItem value="10s">10 seconds</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      </SectionCard>

      {/* Data Preferences */}
      <SectionCard title="Data Preferences" icon={Database}>
        <FieldRow label="Default Exchange" description="Pre-selected exchange for data queries">
          <Select
            value={settings.dataPreferences.defaultExchange}
            onValueChange={(v) => updateField('dataPreferences', 'defaultExchange', v)}
          >
            <SelectTrigger className="w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="NSE">NSE</SelectItem>
              <SelectItem value="BSE">BSE</SelectItem>
              <SelectItem value="BOTH">BOTH</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Price Decimal Places" description="Number of decimal places for price display">
          <Select
            value={settings.dataPreferences.priceDecimalPlaces}
            onValueChange={(v) => updateField('dataPreferences', 'priceDecimalPlaces', v)}
          >
            <SelectTrigger className="w-20 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="3">3</SelectItem>
              <SelectItem value="4">4</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Volume Display" description="How trading volume numbers are formatted">
          <Select
            value={settings.dataPreferences.volumeDisplay}
            onValueChange={(v) => updateField('dataPreferences', 'volumeDisplay', v)}
          >
            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="raw">Raw</SelectItem>
              <SelectItem value="compact">Compact (1.2K, 3.4M)</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Change Display" description="How price change values are shown">
          <Select
            value={settings.dataPreferences.changeDisplay}
            onValueChange={(v) => updateField('dataPreferences', 'changeDisplay', v)}
          >
            <SelectTrigger className="w-36 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="both">Absolute + %</SelectItem>
              <SelectItem value="percent">Only %</SelectItem>
              <SelectItem value="absolute">Only Absolute</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      </SectionCard>

      {/* Notifications */}
      <SectionCard title="Notifications" icon={Bell}>
        <FieldRow label="Tick Alert Threshold" description="Minimum ticks per second to trigger an alert">
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min="0"
              value={settings.notifications.tickAlertThreshold}
              onChange={(e) => updateField('notifications', 'tickAlertThreshold', e.target.value)}
              className="w-20 h-8 text-xs text-center font-mono"
            />
            <span className="text-[10px] text-muted-foreground">TPS</span>
          </div>
        </FieldRow>
        <Separator />
        <FieldRow label="Price Change Alert" description="Alert when price changes more than the threshold">
          <Switch
            checked={settings.notifications.priceChangeAlert}
            onCheckedChange={(v) => updateField('notifications', 'priceChangeAlert', v)}
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Alert Sound" description="Play a sound when alerts are triggered">
          <Switch
            checked={settings.notifications.alertSound}
            onCheckedChange={(v) => updateField('notifications', 'alertSound', v)}
          />
        </FieldRow>
      </SectionCard>

      {/* Data Quality */}
      <SectionCard title="Data Quality" icon={Shield}>
        <FieldRow label="Stale Tick Threshold" description="Seconds before a tick is considered stale">
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min="1"
              value={settings.dataQuality.staleTickThreshold}
              onChange={(e) => updateField('dataQuality', 'staleTickThreshold', e.target.value)}
              className="w-20 h-8 text-xs text-center font-mono"
            />
            <span className="text-[10px] text-muted-foreground">sec</span>
          </div>
        </FieldRow>
        <Separator />
        <FieldRow label="Auto-pause on Stale" description="Automatically pause display when data goes stale">
          <Switch
            checked={settings.dataQuality.autoPauseOnStale}
            onCheckedChange={(v) => updateField('dataQuality', 'autoPauseOnStale', v)}
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Quality Score Minimum" description="Minimum quality score (0-100) to display tick data">
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min="0"
              max="100"
              value={settings.dataQuality.qualityScoreMinimum}
              onChange={(e) => updateField('dataQuality', 'qualityScoreMinimum', e.target.value)}
              className="w-20 h-8 text-xs text-center font-mono"
            />
            <span className="text-[10px] text-muted-foreground">%</span>
          </div>
        </FieldRow>
      </SectionCard>

      {/* Export / Import */}
      <Card className="border-border/40 bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-foreground">
            <FileJson className="h-4 w-4 text-muted-foreground" />
            Export / Import Settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleExport}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export to JSON
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleImport}>
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Import from File
            </Button>
          </div>
          <div className="mt-3 text-[10px] text-muted-foreground">
            Export saves your current preferences as a JSON file. Import restores settings from a previously exported file.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
