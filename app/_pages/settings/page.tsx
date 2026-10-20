'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Settings as SettingsIcon, Save, RotateCcw, Server, CandlestickChart,
  Database, Download, ScrollText, Bell, Palette, Shield, User,
  CheckCircle2, RefreshCw, HardDrive, Activity, Wifi, WifiOff,
  Target, AlertTriangle, Clock, Volume2, VolumeX, Monitor,
  Zap, Search, TrendingUp, TrendingDown, Coins, IndianRupee,
  Lock as LockIcon, Loader2, AlertCircle, Landmark, Radar, Layers,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSettingsStore, useTradingSettings, useTradingMode, type TradingSettings, type TradingMode } from '@/lib/settings-store';
import {
  getSettings, updateSetting, resetAllSettings,
  getSystemStatus, getMongoStats,
  getDemoAccount, resetDemoAccount,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { getTerminalState, type TerminalState } from '@/lib/terminal-service';
import { ThemeStudio } from '@/components/theme/theme-studio';

const SECTIONS = [
  { key: 'account', label: 'Account & Connection', icon: User },
  { key: 'trading', label: 'Trading', icon: CandlestickChart },
  { key: 'risk', label: 'Risk', icon: Shield },
  { key: 'squareoff', label: 'Square-Off', icon: Clock },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'sound', label: 'Sound', icon: Volume2 },
  { key: 'marketdata', label: 'Market Data', icon: Activity },
  { key: 'display', label: 'Display', icon: Monitor },
  { key: 'theme', label: 'Theme', icon: Palette },
  { key: 'broker', label: 'Broker', icon: Wifi },
  { key: 'advanced', label: 'Advanced', icon: Zap },
  { key: 'security', label: 'Security', icon: Shield },
] as const;

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState('account');
  // Reactive snapshot from the single settings store — hydration-safe and
  // updated in place by updateSetting (no local duplicate state).
  const settings = useTradingSettings();
  const [backendSettings, setBackendSettings] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [mongoStats, setMongoStats] = useState<any>(null);
  const [showResetDemo, setShowResetDemo] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [demoAccount, setDemoAccount] = useState<any>(null);
  const { toast } = useToast();
  const store = getSettingsStore();

  const fetchAll = useCallback(async () => {
    // Persisted settings are already applied from the localStorage cache by
    // the store constructor; this syncs with the backend in the background.
    try {
      await store.loadFromBackend();
    } catch { /* ignore */ }
    const [settingsData, sysData, mongoData, demoData] = await Promise.allSettled([
      getSettings(), getSystemStatus(), getMongoStats(), getDemoAccount(),
    ]);
    if (settingsData.status === 'fulfilled') {
      setBackendSettings(settingsData.value.settings || {});
    }
    if (sysData.status === 'fulfilled') setSystemStatus(sysData.value);
    if (mongoData.status === 'fulfilled') setMongoStats(mongoData.value);
    if (demoData.status === 'fulfilled') {
      setDemoAccount(demoData.value?.account ?? null);
    }
  }, [store]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const updateField = async (path: string, value: any) => {
    setSaving(path);
    const ok = await store.updateSetting(path, value);
    setSaving(null);
    if (ok) {
      toast({ title: 'Setting saved' });
    } else {
      toast({ title: 'Failed to save', variant: 'destructive' });
    }
  };

  const handleResetAll = async () => {
    try {
      const res = await resetAllSettings();
      setBackendSettings(res.settings);
      store.reset();
      await store.loadFromBackend();
      toast({ title: 'All settings reset' });
    } catch (err) {
      toast({ title: 'Reset failed', variant: 'destructive' });
    }
  };

  const handleResetDemo = async () => {
    try {
      const res = await resetDemoAccount(100000);
      setDemoAccount(res?.account ?? null);
      setShowResetDemo(false);
      setResetConfirmText('');
      toast({ title: 'Demo account reset', description: 'Balance restored to 100,000 Coins' });
    } catch (err) {
      toast({ title: 'Reset failed', variant: 'destructive' });
    }
  };

  const isDemo = settings.accountMode === 'demo';
  const tradingMode = useTradingMode();

  return (
    <div className="flex h-full gap-0 -m-4 md:-m-6">
      {/* Left Navigation */}
      <div className="w-[200px] shrink-0 border-r border-border/40 bg-card/50 flex flex-col">
        <div className="p-3 border-b border-border/30">
          <h1 className="text-sm font-bold tracking-tight flex items-center gap-2">
            <SettingsIcon className="h-4 w-4" /> Settings
          </h1>
          <div className="mt-2">
            <ModeIndicator mode={tradingMode} />
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.key;
            return (
              <button
                key={section.key}
                onClick={() => setActiveSection(section.key)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition-all',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {section.label}
              </button>
            );
          })}
        </nav>
        <div className="p-2 border-t border-border/30 space-y-1">
          <Button variant="outline" size="sm" className="w-full text-[11px]" onClick={handleResetAll}>
            <RotateCcw className="h-3 w-3 mr-1.5" /> Reset All
          </Button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto p-4 md:p-5 space-y-4">
        {activeSection === 'account' && (
          <AccountSection
            tradingMode={tradingMode}
            isDemo={isDemo}
            systemStatus={systemStatus}
            demoAccount={demoAccount}
            onShowResetDemo={() => setShowResetDemo(true)}
          />
        )}
        {activeSection === 'trading' && (
          <TradingSection
            settings={settings}
            onFieldUpdate={updateField}
            saving={saving}
          />
        )}
        {activeSection === 'risk' && <RiskSection settings={settings} onFieldUpdate={updateField} saving={saving} />}
        {activeSection === 'squareoff' && <SquareOffSection settings={settings} onFieldUpdate={updateField} saving={saving} />}
        {activeSection === 'notifications' && <NotificationsSection settings={settings} onFieldUpdate={updateField} saving={saving} />}
        {activeSection === 'sound' && <SoundSection settings={settings} onFieldUpdate={updateField} saving={saving} />}
        {activeSection === 'marketdata' && <MarketDataSection settings={settings} onFieldUpdate={updateField} saving={saving} />}
        {activeSection === 'display' && <DisplaySection settings={settings} onFieldUpdate={updateField} saving={saving} />}
        {activeSection === 'theme' && <ThemeSection mode={tradingMode} />}
        {activeSection === 'broker' && <BrokerSection settings={settings} systemStatus={systemStatus} />}
        {activeSection === 'advanced' && <AdvancedSection settings={settings} onFieldUpdate={updateField} saving={saving} />}
        {activeSection === 'security' && <SecuritySection />}
      </div>

      {/* Reset Demo Confirmation */}
      <Dialog open={showResetDemo} onOpenChange={setShowResetDemo}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" /> Reset Demo Account
            </DialogTitle>
            <DialogDescription>
              This will reset demo balance, demo positions and demo orders.
              Your real broker account will not be affected.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 text-xs text-warning">
              This action is irreversible. All demo trade history will be cleared.
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                Type <span className="font-bold text-foreground">RESET</span> to confirm
              </Label>
              <Input
                value={resetConfirmText}
                onChange={(e) => setResetConfirmText(e.target.value)}
                placeholder="Type RESET"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowResetDemo(false); setResetConfirmText(''); }}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleResetDemo}
              disabled={resetConfirmText !== 'RESET'}
            >
              Reset Demo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModeIndicator({ mode }: { mode: TradingMode }) {
  return (
    <div className={cn(
      'flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11px] font-semibold',
      mode === 'dummy' ? 'bg-purple/15 text-purple' : mode === 'shoonya' ? 'bg-info/15 text-info' : 'bg-success/15 text-success'
    )}>
      <span className={cn(
        'h-2 w-2 rounded-full',
        mode === 'dummy' ? 'bg-purple animate-pulse' : mode === 'shoonya' ? 'bg-info animate-pulse' : 'bg-success animate-pulse'
      )} />
      {mode === 'dummy' ? 'DUMMY MODE' : mode === 'shoonya' ? 'SHOONYA' : 'KOTAK NEO'}
      <span className="text-[10px] font-normal opacity-70 ml-auto">
        {mode === 'dummy' ? 'Virtual Coins' : mode === 'shoonya' ? 'OAuth session' : 'Kotak Connected'}
      </span>
    </div>
  );
}

function ShoonyaSessionBadge() {
  const [state, setState] = useState<TerminalState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    getTerminalState()
      .then((s) => { if (alive) setState(s); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  const ok = Boolean(state?.ok && state.isLoggedIn) && !failed;

  return (
    <Badge variant="outline" className={cn('text-xs', ok ? 'bg-info/15 text-info border-info/30' : 'bg-muted/40 text-muted-foreground border-border/60')}>
      <span className={cn('h-2 w-2 rounded-full mr-1.5', ok ? 'bg-info' : 'bg-muted-foreground')} />
      {ok ? 'CONNECTED' : 'NOT CONNECTED'}
    </Badge>
  );
}

function FieldRow({ label, description, children, saving: isSaving }: {
  label: string; description?: string; children: React.ReactNode; saving?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium">{label}</div>
        {description && <div className="text-[10px] text-muted-foreground mt-0.5">{description}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {children}
        {isSaving && <div className="h-3 w-3 border border-primary border-t-transparent rounded-full animate-spin" />}
      </div>
    </div>
  );
}

function SectionCard({ title, icon: Icon, accent, children }: {
  title: string; icon: React.ElementType; accent?: string; children: React.ReactNode;
}) {
  return (
    <Card className={cn('border-border/40', accent)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">{children}</CardContent>
    </Card>
  );
}

function AccountSection({ tradingMode, isDemo, systemStatus, demoAccount, onShowResetDemo }: {
  tradingMode: TradingMode; isDemo: boolean;
  systemStatus: any; demoAccount: any; onShowResetDemo: () => void;
}) {
  const account = demoAccount ?? {};
  const kotakLoggedIn = Boolean(systemStatus?.pythonStatus?.logged_in);

  const card = tradingMode === 'dummy'
    ? {
        label: 'DUMMY MODE',
        desc: 'Virtual funds. Real market data. Server-side Dummy Trading Engine executes all orders locally — nothing reaches a broker.',
        icon: Coins,
        accent: 'border-purple/40 bg-purple/5',
        box: 'bg-purple/20 text-purple',
        check: 'text-purple',
      }
    : tradingMode === 'shoonya'
      ? {
          label: 'SHOONYA',
          desc: 'Real Shoonya account. Real funds. Real execution through the broker OAuth session.',
          icon: Radar,
          accent: 'border-info/40 bg-info/5',
          box: 'bg-info/20 text-info',
          check: 'text-info',
        }
      : {
          label: 'KOTAK NEO',
          desc: 'Real Kotak account. Real funds. Real execution through the Kotak Neo SDK.',
          icon: IndianRupee,
          accent: 'border-success/40 bg-success/5',
          box: 'bg-success/20 text-success',
          check: 'text-success',
        };
  const CardIcon = card.icon;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Account &amp; Connection</h2>

      {/* CURRENT MODE (selector lives in the Trading Terminal sidebar) */}
      <SectionCard title="Trading Mode" icon={User}>
        <div className={cn('flex items-start gap-3 rounded-xl border p-4', card.accent)}>
          <div className={cn('h-10 w-10 rounded-lg flex items-center justify-center shrink-0', card.box)}>
            <CardIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-bold text-sm">{card.label}</div>
            <div className="text-[10px] text-muted-foreground">{card.desc}</div>
          </div>
          <CheckCircle2 className={cn('h-5 w-5 ml-auto shrink-0', card.check)} />
        </div>
        <Separator className="my-3" />
        <FieldRow label="Switch Terminal" description="Use the Trading Terminal dropdown in the sidebar header">
          <ModeIndicator mode={tradingMode} />
        </FieldRow>
      </SectionCard>

      {/* Demo Account summary (demo mode only) */}
      {isDemo && (
        <SectionCard title="Demo Account" icon={Coins} accent="border-purple/20">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <div className="bg-muted/30 rounded-lg p-2.5">
              <div className="text-[10px] text-muted-foreground">Starting Balance</div>
              <div className="text-sm font-bold font-mono">{(account.balance ?? 0).toLocaleString('en-IN')} Coins</div>
            </div>
            <div className="bg-muted/30 rounded-lg p-2.5">
              <div className="text-[10px] text-muted-foreground">Available</div>
              <div className="text-sm font-bold font-mono text-success">{(account.freeMargin ?? 0).toLocaleString('en-IN')} Coins</div>
            </div>
            <div className="bg-muted/30 rounded-lg p-2.5">
              <div className="text-[10px] text-muted-foreground">Used Margin</div>
              <div className="text-sm font-bold font-mono text-warning">{(account.usedMargin ?? 0).toLocaleString('en-IN')} Coins</div>
            </div>
            <div className="bg-muted/30 rounded-lg p-2.5">
              <div className="text-[10px] text-muted-foreground">Demo P&amp;L</div>
              <div className={cn('text-sm font-bold font-mono', (account.totalPnl ?? 0) >= 0 ? 'text-success' : 'text-destructive')}>
                {(account.totalPnl ?? 0) >= 0 ? '+' : ''}{(account.totalPnl ?? 0).toLocaleString('en-IN')} Coins
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between py-2 border-t border-border/30">
            <div className="text-xs text-muted-foreground">
              Total Charges: <span className="font-mono">{(account.totalCharges ?? 0).toLocaleString('en-IN')} Coins</span>
            </div>
            <Button variant="destructive" size="sm" className="h-7 text-[11px]" onClick={onShowResetDemo}>
              <RotateCcw className="h-3 w-3 mr-1" /> Reset Demo
            </Button>
          </div>
        </SectionCard>
      )}

      {/* Broker connection status */}
      {!isDemo && (
        <SectionCard title="Broker Connection" icon={Wifi}>
          {tradingMode === 'shoonya' ? (
            <>
              <FieldRow label="Shoonya Session" description="OAuth broker session state">
                <ShoonyaSessionBadge />
              </FieldRow>
              <Separator />
              <FieldRow label="Manage Funds" description="View Shoonya funds and connection state">
                <Badge variant="outline" className="text-xs">Account page → Shoonya</Badge>
              </FieldRow>
            </>
          ) : (
            <>
              <FieldRow label="Kotak Neo Session" description={kotakLoggedIn ? 'Broker session is active' : 'No active broker session — login required for API mode'}>
                <Badge variant="outline" className={cn('text-xs', kotakLoggedIn ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
                  <span className={cn('h-2 w-2 rounded-full mr-1.5', kotakLoggedIn ? 'bg-success' : 'bg-destructive')} />
                  {kotakLoggedIn ? 'CONNECTED' : 'DISCONNECTED'}
                </Badge>
              </FieldRow>
              <Separator />
              <FieldRow label="Manage Funds" description="View real funds and connection state in API mode">
                <Badge variant="outline" className="text-xs">Account page → API Mode</Badge>
              </FieldRow>
            </>
          )}
        </SectionCard>
      )}
    </div>
  );
}

function ModePill(props: { mode: TradingMode }) {
  const isLive = props.mode !== 'dummy';
  return (
    <Badge
      variant="outline"
      className={cn(
        'ml-2 align-middle text-[10px] font-semibold',
        isLive
          ? 'border-success/30 text-success bg-success/10'
          : 'border-purple/30 text-purple bg-purple/10',
      )}
    >
      {isLive ? props.mode === 'kotak-neo' ? 'KOTAK NEO' : 'SHOONYA' : 'DUMMY MODE'}
    </Badge>
  );
}

function PerModeNote() {
  const mode = useTradingMode();
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      These settings apply only to the{' '}
      <ModePill mode={mode} /> profile and are remembered per mode.
    </div>
  );
}

function TradingSection({ settings, onFieldUpdate, saving }: {
  settings: TradingSettings; onFieldUpdate: (path: string, value: any) => Promise<void>; saving: string | null;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">
        Trading Settings
        <ModePill mode={useTradingMode()} />
      </h2>
      <PerModeNote />

      {/* Order Defaults */}
      <SectionCard title="Order Defaults" icon={CandlestickChart}>
        <FieldRow label="Default Side" description="Pre-selected order side">
          <Select value={settings.orderDefaults.side} onValueChange={(v) => onFieldUpdate('orderDefaults.side', v)}>
            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="BUY">BUY</SelectItem>
              <SelectItem value="SELL">SELL</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Default Product" description="Pre-selected product type">
          <Select value={settings.orderDefaults.product} onValueChange={(v) => onFieldUpdate('orderDefaults.product', v)}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="MIS">MIS (Intraday)</SelectItem>
              <SelectItem value="CNC">CNC (Delivery)</SelectItem>
              <SelectItem value="NRML">NRML</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Default Order Type" description="Pre-selected order type">
          <Select value={settings.orderDefaults.orderType} onValueChange={(v) => onFieldUpdate('orderDefaults.orderType', v)}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="MKT">Market</SelectItem>
              <SelectItem value="L">Limit</SelectItem>
              <SelectItem value="SL">SL</SelectItem>
              <SelectItem value="SL-M">SL-M</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Default Quantity" description="Pre-filled order quantity">
          <Input
            type="number" min="1"
            value={String(settings.orderDefaults.quantity)}
            onChange={(e) => onFieldUpdate('orderDefaults.quantity', parseInt(e.target.value) || 1)}
            className="w-20 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Default Exchange" description="Pre-selected exchange">
          <Select value={settings.orderDefaults.exchange} onValueChange={(v) => onFieldUpdate('orderDefaults.exchange', v)}>
            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="nse_cm">NSE</SelectItem>
              <SelectItem value="bse_cm">BSE</SelectItem>
              <SelectItem value="nse_fo">NSE F&O</SelectItem>
              <SelectItem value="mcx_fo">MCX</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Default Validity" description="Order validity">
          <div className="flex gap-1">
            {['DAY', 'IOC'].map((v) => (
              <button
                key={v}
                className={cn(
                  'px-3 py-1 rounded text-[11px] font-medium border transition-all',
                  settings.orderDefaults.validity === v
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'border-border/40 text-muted-foreground hover:bg-muted/50'
                )}
                onClick={() => onFieldUpdate('orderDefaults.validity', v)}
              >
                {v}
              </button>
            ))}
          </div>
        </FieldRow>
      </SectionCard>

      {/* Target */}
      <SectionCard title="Target / Take Profit" icon={Target}>
        <FieldRow label="Enable Target" description="Auto-calculate target for orders">
          <Switch checked={settings.target.enabled} onCheckedChange={(v) => onFieldUpdate('target.enabled', v)} />
        </FieldRow>
        {settings.target.enabled && (
          <>
            <Separator />
            <FieldRow label="Target Mode" description="How target is specified">
              <div className="flex gap-1">
                {(['PERCENT', 'FIXED'] as const).map((m) => (
                  <button
                    key={m}
                    className={cn(
                      'px-3 py-1 rounded text-[11px] font-medium border transition-all',
                      settings.target.mode === m
                        ? 'bg-success/15 border-success/40 text-success'
                        : 'border-border/40 text-muted-foreground hover:bg-muted/50'
                    )}
                    onClick={() => onFieldUpdate('target.mode', m)}
                  >
                    {m === 'PERCENT' ? '% Percent' : '₹ Fixed'}
                  </button>
                ))}
              </div>
            </FieldRow>
            <Separator />
            <FieldRow label="Target Value" description={settings.target.mode === 'PERCENT' ? 'Percentage target' : 'Fixed price target'}>
              <div className="flex items-center gap-1">
                <Input
                  type="number" step="0.1" min="0"
                  value={String(settings.target.value)}
                  onChange={(e) => onFieldUpdate('target.value', parseFloat(e.target.value) || 0)}
                  className="w-20 h-8 text-xs text-center font-mono"
                />
                <span className="text-[10px] text-muted-foreground">{settings.target.mode === 'PERCENT' ? '%' : '₹'}</span>
              </div>
            </FieldRow>
          </>
        )}
      </SectionCard>

      {/* Stop Loss */}
      <SectionCard title="Stop Loss" icon={AlertTriangle}>
        <FieldRow label="Enable Stop Loss" description="Auto-calculate stop loss for orders">
          <Switch checked={settings.stopLoss.enabled} onCheckedChange={(v) => onFieldUpdate('stopLoss.enabled', v)} />
        </FieldRow>
        {settings.stopLoss.enabled && (
          <>
            <Separator />
            <FieldRow label="Stop Loss Mode" description="How stop loss is specified">
              <div className="flex gap-1">
                {(['PERCENT', 'FIXED'] as const).map((m) => (
                  <button
                    key={m}
                    className={cn(
                      'px-3 py-1 rounded text-[11px] font-medium border transition-all',
                      settings.stopLoss.mode === m
                        ? 'bg-destructive/15 border-destructive/40 text-destructive'
                        : 'border-border/40 text-muted-foreground hover:bg-muted/50'
                    )}
                    onClick={() => onFieldUpdate('stopLoss.mode', m)}
                  >
                    {m === 'PERCENT' ? '% Percent' : '₹ Fixed'}
                  </button>
                ))}
              </div>
            </FieldRow>
            <Separator />
            <FieldRow label="Stop Loss Value" description={settings.stopLoss.mode === 'PERCENT' ? 'Percentage stop loss' : 'Fixed price stop loss'}>
              <div className="flex items-center gap-1">
                <Input
                  type="number" step="0.1" min="0"
                  value={String(settings.stopLoss.value)}
                  onChange={(e) => onFieldUpdate('stopLoss.value', parseFloat(e.target.value) || 0)}
                  className="w-20 h-8 text-xs text-center font-mono"
                />
                <span className="text-[10px] text-muted-foreground">{settings.stopLoss.mode === 'PERCENT' ? '%' : '₹'}</span>
              </div>
            </FieldRow>
          </>
        )}
      </SectionCard>

      {/* Order Confirmation */}
      <SectionCard title="Order Confirmation" icon={CheckCircle2}>
        <FieldRow label="Confirm BUY orders" description="Show confirmation before placing BUY">
          <Switch checked={settings.confirm.confirmBuy} onCheckedChange={(v) => onFieldUpdate('confirm.confirmBuy', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Confirm SELL orders" description="Show confirmation before placing SELL">
          <Switch checked={settings.confirm.confirmSell} onCheckedChange={(v) => onFieldUpdate('confirm.confirmSell', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Confirm Square-Off" description="Show confirmation before square-off">
          <Switch checked={settings.confirm.confirmSquareOff} onCheckedChange={(v) => onFieldUpdate('confirm.confirmSquareOff', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Confirm Live Orders" description="Always show confirmation for live orders (cannot be disabled)">
          <Switch checked={true} disabled />
        </FieldRow>
      </SectionCard>
    </div>
  );
}

function RiskSection({ settings, onFieldUpdate, saving }: {
  settings: TradingSettings; onFieldUpdate: (path: string, value: any) => Promise<void>; saving: string | null;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">
        Risk Management
        <ModePill mode={useTradingMode()} />
      </h2>
      <PerModeNote />
      <SectionCard title="Risk Limits" icon={Shield}>
        <FieldRow label="Maximum Order Value" description="Block orders exceeding this value">
          <Input
            type="number" min="0" step="10000"
            value={String(settings.risk.maxOrderValue)}
            onChange={(e) => onFieldUpdate('risk.maxOrderValue', parseInt(e.target.value) || 0)}
            className="w-28 h-8 text-xs text-right font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Maximum Daily Loss" description="Block trading when daily loss exceeds this">
          <Input
            type="number" min="0" step="1000"
            value={String(settings.risk.maxDailyLoss)}
            onChange={(e) => onFieldUpdate('risk.maxDailyLoss', parseInt(e.target.value) || 0)}
            className="w-28 h-8 text-xs text-right font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Maximum Daily Profit Target" description="Notify when target profit reached">
          <Input
            type="number" min="0" step="1000"
            value={String(settings.risk.maxDailyProfitTarget)}
            onChange={(e) => onFieldUpdate('risk.maxDailyProfitTarget', parseInt(e.target.value) || 0)}
            className="w-28 h-8 text-xs text-right font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Maximum Daily Orders" description="Block orders beyond this count">
          <Input
            type="number" min="1"
            value={String(settings.risk.maxDailyOrders)}
            onChange={(e) => onFieldUpdate('risk.maxDailyOrders', parseInt(e.target.value) || 1)}
            className="w-20 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Maximum Open Positions" description="Limit concurrent open positions">
          <Input
            type="number" min="1"
            value={String(settings.risk.maxOpenPositions)}
            onChange={(e) => onFieldUpdate('risk.maxOpenPositions', parseInt(e.target.value) || 1)}
            className="w-20 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Maximum Qty Per Position" description="Block quantity exceeding this per stock">
          <Input
            type="number" min="1"
            value={String(settings.risk.maxQtyPerPosition)}
            onChange={(e) => onFieldUpdate('risk.maxQtyPerPosition', parseInt(e.target.value) || 1)}
            className="w-20 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Maximum Exposure" description="Total exposure limit across all positions">
          <Input
            type="number" min="0" step="100000"
            value={String(settings.risk.maxExposure)}
            onChange={(e) => onFieldUpdate('risk.maxExposure', parseInt(e.target.value) || 0)}
            className="w-28 h-8 text-xs text-right font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Max Demo Risk" description="Maximum risk in demo mode">
          <Input
            type="number" min="0" step="1000"
            value={String(settings.risk.maxDemoRisk)}
            onChange={(e) => onFieldUpdate('risk.maxDemoRisk', parseInt(e.target.value) || 0)}
            className="w-28 h-8 text-xs text-right font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Max Live Risk" description="Maximum risk in live mode">
          <Input
            type="number" min="0" step="10000"
            value={String(settings.risk.maxLiveRisk)}
            onChange={(e) => onFieldUpdate('risk.maxLiveRisk', parseInt(e.target.value) || 0)}
            className="w-28 h-8 text-xs text-right font-mono"
          />
        </FieldRow>
      </SectionCard>
    </div>
  );
}

function SquareOffSection({ settings, onFieldUpdate, saving }: {
  settings: TradingSettings; onFieldUpdate: (path: string, value: any) => Promise<void>; saving: string | null;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">
        Auto Square-Off
        <ModePill mode={useTradingMode()} />
      </h2>
      <PerModeNote />
      <SectionCard title="Square-Off Configuration" icon={Clock}>
        <FieldRow label="Enable Auto Square-Off" description="Automatically close positions at specified time">
          <Switch checked={settings.squareOff.enabled} onCheckedChange={(v) => onFieldUpdate('squareOff.enabled', v)} />
        </FieldRow>
        {settings.squareOff.enabled && (
          <>
            <Separator />
            <FieldRow label="Square-Off Time" description="Time to execute auto square-off (IST)">
              <Input
                type="time"
                value={settings.squareOff.time}
                onChange={(e) => onFieldUpdate('squareOff.time', e.target.value)}
                className="w-32 h-8 text-xs font-mono"
              />
            </FieldRow>
            <Separator />
            <FieldRow label="Timezone" description="Timezone for square-off">
              <Badge variant="outline" className="text-xs">{settings.squareOff.timezone}</Badge>
            </FieldRow>
            <Separator />
            <FieldRow label="Apply To" description="Which positions to square off">
              <Select value={settings.squareOff.applyTo} onValueChange={(v) => onFieldUpdate('squareOff.applyTo', v)}>
                <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MIS">MIS / Intraday</SelectItem>
                  <SelectItem value="ALL">All Positions</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
          </>
        )}
      </SectionCard>
      <div className="bg-info/10 border border-info/20 rounded-lg p-3 text-xs text-info">
        <div className="font-medium mb-1">Server-Side Execution</div>
        <div className="text-info/70">
          Square-off runs on the backend scheduler, not the browser.
          This ensures positions are closed even if your browser is closed or laptop is sleeping.
        </div>
      </div>
    </div>
  );
}

function NotificationsSection({ settings, onFieldUpdate, saving }: {
  settings: TradingSettings; onFieldUpdate: (path: string, value: any) => Promise<void>; saving: string | null;
}) {
  const events = [
    { key: 'orderPlaced', label: 'Order Placed' },
    { key: 'orderCompleted', label: 'Order Completed' },
    { key: 'orderRejected', label: 'Order Rejected' },
    { key: 'orderCancelled', label: 'Order Cancelled' },
    { key: 'targetReached', label: 'Target Reached' },
    { key: 'stopLossTriggered', label: 'Stop Loss Triggered' },
    { key: 'squareOffExecuted', label: 'Square-Off Executed' },
    { key: 'marginWarning', label: 'Margin Warning' },
    { key: 'riskLimitReached', label: 'Risk Limit Reached' },
    { key: 'brokerDisconnected', label: 'Broker Disconnected' },
    { key: 'brokerSessionExpired', label: 'Broker Session Expired' },
    { key: 'marketOpen', label: 'Market Open' },
    { key: 'marketClosed', label: 'Market Closed' },
  ] as const;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Notifications</h2>
      <SectionCard title="Notification Events" icon={Bell}>
        {events.map((evt, i) => (
          <div key={evt.key}>
            {i > 0 && <Separator />}
            <FieldRow label={evt.label}>
              <Switch
                checked={(settings.notifications as any)[evt.key]}
                onCheckedChange={(v) => onFieldUpdate(`notifications.${evt.key}`, v)}
              />
            </FieldRow>
          </div>
        ))}
      </SectionCard>
      <SectionCard title="Notification Channels" icon={Activity}>
        <FieldRow label="In-App Notifications" description="Show notifications within the app">
          <Switch checked={settings.notificationChannels.inApp} onCheckedChange={(v) => onFieldUpdate('notificationChannels.inApp', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Browser Notifications" description="Show browser push notifications">
          <Switch checked={settings.notificationChannels.browser} onCheckedChange={(v) => onFieldUpdate('notificationChannels.browser', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Sound Notifications" description="Play sound on events">
          <Switch checked={settings.notificationChannels.sound} onCheckedChange={(v) => onFieldUpdate('notificationChannels.sound', v)} />
        </FieldRow>
      </SectionCard>
      <NotificationCategoryPrefs />
    </div>
  );
}

const NOTIFICATION_CATEGORY_PREFS = [
  { key: 'notification_trading', label: 'Trading Alerts' },
  { key: 'notification_login', label: 'Login Alerts' },
  { key: 'notification_connection', label: 'Connection Alerts' },
  { key: 'notification_scheduler', label: 'Scheduler Alerts' },
  { key: 'notification_mongo', label: 'MongoDB Alerts' },
  { key: 'notification_download', label: 'Download Alerts' },
  { key: 'notification_system', label: 'System Alerts' },
  { key: 'notification_error', label: 'Error Alerts' },
];

/** Backend category + delivery switches, moved out of the Notifications feed
 *  page so the feed stays list-only (show, mark-read, delete). */
function NotificationCategoryPrefs() {
  const [prefs, setPrefs] = useState<Record<string, any>>({});
  const { toast } = useToast();

  useEffect(() => {
    getSettings()
      .then((d) => setPrefs(d.settings || {}))
      .catch(() => {});
  }, []);

  const toggle = async (key: string, value: boolean) => {
    setPrefs((prev) => ({ ...prev, [key]: { ...prev[key], value } }));
    try {
      await updateSetting(key, value);
      toast({ title: 'Setting saved' });
    } catch {
      toast({ title: 'Error', variant: 'destructive' });
    }
  };

  return (
    <SectionCard title="Notification Categories" icon={Layers}>
      {NOTIFICATION_CATEGORY_PREFS.map((s, i) => (
        <div key={s.key}>
          {i > 0 && <Separator />}
          <FieldRow label={s.label}>
            <Switch
              checked={prefs[s.key]?.value ?? true}
              onCheckedChange={(v) => void toggle(s.key, v)}
            />
          </FieldRow>
        </div>
      ))}
      <Separator />
      <FieldRow label="Sound" description="Play a sound on notification">
        <Switch checked={prefs.notification_sound?.value ?? true} onCheckedChange={(v) => void toggle('notification_sound', v)} />
      </FieldRow>
      <Separator />
      <FieldRow label="Popup" description="Show a popup toast on notification">
        <Switch checked={prefs.notification_popup?.value ?? true} onCheckedChange={(v) => void toggle('notification_popup', v)} />
      </FieldRow>
      <Separator />
      <FieldRow label="Push" description="Push to subscribed devices">
        <Switch checked={prefs.notification_push?.value ?? false} onCheckedChange={(v) => void toggle('notification_push', v)} />
      </FieldRow>
    </SectionCard>
  );
}

function SoundSection({ settings, onFieldUpdate, saving }: {
  settings: TradingSettings; onFieldUpdate: (path: string, value: any) => Promise<void>; saving: string | null;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Trading Sounds</h2>
      <SectionCard title="Sound Settings" icon={Volume2}>
        <FieldRow label="Enable Sounds" description="Play sounds for trading events">
          <Switch checked={settings.sound.enabled} onCheckedChange={(v) => onFieldUpdate('sound.enabled', v)} />
        </FieldRow>
        {settings.sound.enabled && (
          <>
            <Separator />
            <FieldRow label="Volume" description="Sound volume level">
              <div className="flex items-center gap-3">
                <VolumeX className="h-3 w-3 text-muted-foreground" />
                <Slider
                  value={[settings.sound.volume]}
                  onValueChange={(v) => onFieldUpdate('sound.volume', v[0])}
                  max={100}
                  step={5}
                  className="w-32"
                />
                <Volume2 className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-mono w-8 text-right">{settings.sound.volume}%</span>
              </div>
            </FieldRow>
            <Separator />
            <FieldRow label="Order Success" description="Sound on order completion">
              <Switch checked={settings.sound.orderSuccess} onCheckedChange={(v) => onFieldUpdate('sound.orderSuccess', v)} />
            </FieldRow>
            <Separator />
            <FieldRow label="Order Rejection" description="Sound on order rejection">
              <Switch checked={settings.sound.orderRejection} onCheckedChange={(v) => onFieldUpdate('sound.orderRejection', v)} />
            </FieldRow>
            <Separator />
            <FieldRow label="Target Reached" description="Sound when target is hit">
              <Switch checked={settings.sound.target} onCheckedChange={(v) => onFieldUpdate('sound.target', v)} />
            </FieldRow>
            <Separator />
            <FieldRow label="Stop Loss" description="Sound when stop loss is triggered">
              <Switch checked={settings.sound.stopLoss} onCheckedChange={(v) => onFieldUpdate('sound.stopLoss', v)} />
            </FieldRow>
            <Separator />
            <FieldRow label="Square-Off" description="Sound on auto square-off">
              <Switch checked={settings.sound.squareOff} onCheckedChange={(v) => onFieldUpdate('sound.squareOff', v)} />
            </FieldRow>
          </>
        )}
      </SectionCard>
    </div>
  );
}

function MarketDataSection({ settings, onFieldUpdate, saving }: {
  settings: TradingSettings; onFieldUpdate: (path: string, value: any) => Promise<void>; saving: string | null;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Market Data</h2>
      <SectionCard title="Quote Display" icon={Activity}>
        <FieldRow label="Quote Refresh Interval" description="How often to refresh market data">
          <Select value={settings.marketData.refreshInterval} onValueChange={(v) => onFieldUpdate('marketData.refreshInterval', v)}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="250">250ms</SelectItem>
              <SelectItem value="500">500ms</SelectItem>
              <SelectItem value="1000">1 second</SelectItem>
              <SelectItem value="2000">2 seconds</SelectItem>
              <SelectItem value="5000">5 seconds</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Show LTP" description="Last traded price">
          <Switch checked={settings.marketData.showLTP} onCheckedChange={(v) => onFieldUpdate('marketData.showLTP', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Show Bid" description="Best bid price and quantity">
          <Switch checked={settings.marketData.showBid} onCheckedChange={(v) => onFieldUpdate('marketData.showBid', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Show Ask" description="Best ask price and quantity">
          <Switch checked={settings.marketData.showAsk} onCheckedChange={(v) => onFieldUpdate('marketData.showAsk', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Show Volume" description="Trading volume">
          <Switch checked={settings.marketData.showVolume} onCheckedChange={(v) => onFieldUpdate('marketData.showVolume', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Show OHLC" description="Open, High, Low, Close data">
          <Switch checked={settings.marketData.showOHLC} onCheckedChange={(v) => onFieldUpdate('marketData.showOHLC', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Show Circuit Limits" description="Upper and lower circuit limits">
          <Switch checked={settings.marketData.showCircuit} onCheckedChange={(v) => onFieldUpdate('marketData.showCircuit', v)} />
        </FieldRow>
        <Separator />
        <FieldRow label="Show Average Price" description="Volume weighted average price">
          <Switch checked={settings.marketData.showAvgPrice} onCheckedChange={(v) => onFieldUpdate('marketData.showAvgPrice', v)} />
        </FieldRow>
      </SectionCard>
    </div>
  );
}

function DisplaySection({ settings, onFieldUpdate, saving }: {
  settings: TradingSettings; onFieldUpdate: (path: string, value: any) => Promise<void>; saving: string | null;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Display</h2>
      <SectionCard title="Display Settings" icon={Monitor}>
        <FieldRow label="Density" description="UI spacing density">
          <Select value={settings.display.density} onValueChange={(v) => onFieldUpdate('display.density', v)}>
            <SelectTrigger className="w-36 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="comfortable">Comfortable</SelectItem>
              <SelectItem value="spacious">Spacious</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Number Format" description="Currency and number formatting">
          <Select value={settings.display.numberFormat} onValueChange={(v) => onFieldUpdate('display.numberFormat', v)}>
            <SelectTrigger className="w-36 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="indian">Indian (1,00,000)</SelectItem>
              <SelectItem value="international">International (100,000)</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Decimal Places" description="Number of decimal places">
          <Select value={String(settings.display.decimalPlaces)} onValueChange={(v) => onFieldUpdate('display.decimalPlaces', parseInt(v))}>
            <SelectTrigger className="w-20 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">0</SelectItem>
              <SelectItem value="1">1</SelectItem>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="3">3</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <Separator />
        <FieldRow label="Demo Currency" description="Currency symbol in demo mode">
          <Badge variant="outline" className="text-xs bg-purple/10 text-purple">Coins</Badge>
        </FieldRow>
        <Separator />
        <FieldRow label="Live Currency" description="Currency symbol in live mode">
          <Badge variant="outline" className="text-xs bg-success/10 text-success">₹ INR</Badge>
        </FieldRow>
      </SectionCard>
    </div>
  );
}

const TERMINAL_LABELS: Record<string, string> = {
  dummy: 'Dummy Terminal',
  'kotak-neo': 'Kotak Neo Terminal',
  shoonya: 'Shoonya Terminal',
};

function ThemeSection({ mode }: { mode: TradingMode }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">
        Theme
        <ModePill mode={mode} />
      </h2>
      <PerModeNote />
      <ThemeStudio
        scope={{
          appId: 'trading',
          scope: mode,
          label: TERMINAL_LABELS[mode] ?? mode,
        }}
      />
    </div>
  );
}

function BrokerSection({ settings, systemStatus }: {
  settings: TradingSettings; systemStatus: any;
}) {
  const tradingMode = useTradingMode();
  const kotakLoggedIn = Boolean(systemStatus?.pythonStatus?.logged_in);
  const sessionActive = Boolean(systemStatus?.pythonStatus?.session_active);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Broker Settings</h2>

      {tradingMode === 'kotak-neo' && (
        <SectionCard title="KOTAK NEO" icon={Landmark}>
          <FieldRow label="Connection" description="Broker API connection status">
            <Badge variant="outline" className={cn('text-xs', kotakLoggedIn ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
              <span className={cn('h-2 w-2 rounded-full mr-1.5', kotakLoggedIn ? 'bg-success' : 'bg-destructive')} />
              {kotakLoggedIn ? 'CONNECTED' : 'DISCONNECTED'}
            </Badge>
          </FieldRow>
          <Separator />
          <FieldRow label="Session" description="Trading session status">
            <Badge variant="outline" className={cn('text-xs', sessionActive ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning')}>
              {sessionActive ? 'VALID' : 'EXPIRED'}
            </Badge>
          </FieldRow>
          <Separator />
          <FieldRow label="Account" description="Masked account identifier">
            <span className="text-xs font-mono text-muted-foreground">
              {settings.broker.accountMasked || '—'}
            </span>
          </FieldRow>
          <Separator />
          <FieldRow label="SDK Version" description="Kotak Neo SDK version">
            <Badge variant="outline" className="text-xs">2.0.2</Badge>
          </FieldRow>
          <Separator />
          <FieldRow label="Last Sync" description="Last successful data sync">
            <span className="text-xs text-muted-foreground font-mono">
              {settings.broker.lastSync || '—'}
            </span>
          </FieldRow>
        </SectionCard>
      )}

      {tradingMode === 'shoonya' && (
        <SectionCard title="SHOONYA" icon={Radar} accent="border-info/20">
          <FieldRow label="Connection" description="Broker OAuth connection status">
            <ShoonyaSessionBadge />
          </FieldRow>
          <Separator />
          <FieldRow label="Sign-in" description="One-time OAuth code flow — entry lives in the Shoonya card in the sidebar">
            <Badge variant="outline" className="text-xs">OAuth</Badge>
          </FieldRow>
          <Separator />
          <FieldRow label="Session token" description="Held server-side, never exposed">
            <span className="text-xs font-mono text-muted-foreground">server-side</span>
          </FieldRow>
        </SectionCard>
      )}

      {tradingMode === 'dummy' && (
        <SectionCard title="DUMMY ENGINE" icon={Coins} accent="border-purple/20">
          <FieldRow label="Mode" description="No broker — orders run on the server-side Dummy Trading Engine">
            <Badge variant="outline" className="text-xs text-purple bg-purple/10 border-purple/30">SIMULATION</Badge>
          </FieldRow>
          <Separator />
          <FieldRow label="Balance" description="Virtual funds, reset any time from Account settings">
            <Badge variant="outline" className="text-xs">Demo Account</Badge>
          </FieldRow>
        </SectionCard>
      )}

      <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 text-xs text-warning">
        <div className="font-medium mb-1">Security Note</div>
        <div className="text-warning/70">
          Passwords, API secrets, access tokens, and refresh tokens are never exposed in the frontend.
          All authentication is handled server-side by the Python service.
        </div>
      </div>
    </div>
  );
}

function AdvancedSection({ settings, onFieldUpdate, saving }: {
  settings: TradingSettings; onFieldUpdate: (path: string, value: any) => Promise<void>; saving: string | null;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Advanced Settings</h2>
      <SectionCard title="API Timeouts" icon={Zap}>
        <FieldRow label="Order API Timeout" description="Maximum wait for order API response (seconds)">
          <Input
            type="number" min="5" max="120"
            value={String(settings.advanced.orderApiTimeout)}
            onChange={(e) => onFieldUpdate('advanced.orderApiTimeout', parseInt(e.target.value) || 30)}
            className="w-20 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Quote Timeout" description="Maximum wait for quote data (seconds)">
          <Input
            type="number" min="1" max="60"
            value={String(settings.advanced.quoteTimeout)}
            onChange={(e) => onFieldUpdate('advanced.quoteTimeout', parseInt(e.target.value) || 10)}
            className="w-20 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
      </SectionCard>
      <SectionCard title="Retry Configuration" icon={RefreshCw}>
        <FieldRow label="Retry Count" description="Number of retries on API failure">
          <Input
            type="number" min="0" max="10"
            value={String(settings.advanced.retryCount)}
            onChange={(e) => onFieldUpdate('advanced.retryCount', parseInt(e.target.value) || 3)}
            className="w-20 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Retry Delay" description="Delay between retries (milliseconds)">
          <Input
            type="number" min="100" max="10000" step="100"
            value={String(settings.advanced.retryDelay)}
            onChange={(e) => onFieldUpdate('advanced.retryDelay', parseInt(e.target.value) || 1000)}
            className="w-24 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
      </SectionCard>
      <SectionCard title="Polling Intervals" icon={Clock}>
        <FieldRow label="Order Polling" description="How often to refresh order book (ms)">
          <Input
            type="number" min="1000" max="30000" step="1000"
            value={String(settings.advanced.orderPollingInterval)}
            onChange={(e) => onFieldUpdate('advanced.orderPollingInterval', parseInt(e.target.value) || 5000)}
            className="w-24 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="Position Refresh" description="How often to refresh positions (ms)">
          <Input
            type="number" min="1000" max="30000" step="1000"
            value={String(settings.advanced.positionRefreshInterval)}
            onChange={(e) => onFieldUpdate('advanced.positionRefreshInterval', parseInt(e.target.value) || 5000)}
            className="w-24 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
        <Separator />
        <FieldRow label="History Refresh" description="How often to refresh order history (ms)">
          <Input
            type="number" min="5000" max="60000" step="1000"
            value={String(settings.advanced.historyRefreshInterval)}
            onChange={(e) => onFieldUpdate('advanced.historyRefreshInterval', parseInt(e.target.value) || 10000)}
            className="w-24 h-8 text-xs text-center font-mono"
          />
        </FieldRow>
      </SectionCard>
    </div>
  );
}

function SecuritySection() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);

  // Setup form
  const [showSetup, setShowSetup] = useState(false);
  const [setupPin, setSetupPin] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');
  const [setupError, setSetupError] = useState('');
  const [savingSetup, setSavingSetup] = useState(false);

  // Change PIN form
  const [showChange, setShowChange] = useState(false);
  const [changeCurrent, setChangeCurrent] = useState('');
  const [changeNew, setChangeNew] = useState('');
  const [changeConfirm, setChangeConfirm] = useState('');
  const [changeError, setChangeError] = useState('');
  const [savingChange, setSavingChange] = useState(false);

  // Disable form
  const [showDisable, setShowDisable] = useState(false);
  const [disablePin, setDisablePin] = useState('');
  const [disableError, setDisableError] = useState('');
  const [savingDisable, setSavingDisable] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/setup');
      const data = await res.json();
      setConfigured(data.configured);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleCreatePin = async () => {
    setSetupError('');
    if (!/^\d{6}$/.test(setupPin)) { setSetupError('PIN must be exactly 6 digits'); return; }
    if (setupPin !== setupConfirm) { setSetupError('PINs do not match'); return; }
    setSavingSetup(true);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'create-pin', pin: setupPin }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: 'App Lock Enabled', description: 'PIN has been set. You will be asked for it on next login.' });
        setConfigured(true);
        setShowSetup(false);
        setSetupPin('');
        setSetupConfirm('');
      } else {
        setSetupError(data.message || 'Failed to create PIN');
      }
    } catch {
      setSetupError('Connection failed');
    }
    setSavingSetup(false);
  };

  const handleChangePin = async () => {
    setChangeError('');
    if (!/^\d{6}$/.test(changeNew)) { setChangeError('New PIN must be exactly 6 digits'); return; }
    if (changeNew !== changeConfirm) { setChangeError('PINs do not match'); return; }
    if (changeCurrent === changeNew) { setChangeError('New PIN must be different'); return; }
    setSavingChange(true);
    try {
      const res = await fetch('/api/auth/pin/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPin: changeCurrent, newPin: changeNew }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: 'PIN Changed', description: 'Your App Lock PIN has been updated.' });
        setShowChange(false);
        setChangeCurrent('');
        setChangeNew('');
        setChangeConfirm('');
      } else {
        setChangeError(data.message || 'Failed to change PIN');
      }
    } catch {
      setChangeError('Connection failed');
    }
    setSavingChange(false);
  };

  const handleDisable = async () => {
    setDisableError('');
    if (!/^\d{6}$/.test(disablePin)) { setDisableError('PIN must be exactly 6 digits'); return; }
    setSavingDisable(true);
    try {
      const res = await fetch('/api/auth/pin/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: disablePin }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: 'App Lock Disabled', description: 'You can now login without a PIN.' });
        setConfigured(false);
        setShowDisable(false);
        setDisablePin('');
      } else {
        setDisableError(data.message || 'Failed to disable App Lock');
      }
    } catch {
      setDisableError('Connection failed');
    }
    setSavingDisable(false);
  };

  const handleLockNow = async () => {
    try { await fetch('/api/auth/login', { method: 'DELETE' }); } catch { /* ignore */ }
    window.location.href = '/login';
  };

  const inputCls = 'h-10 bg-muted/40 border-border/60 focus:border-success/60 focus:ring-success/20 text-foreground placeholder:text-muted-foreground';

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Security</h2>

      <SectionCard title="App Lock" icon={LockIcon}>
        {loading ? (
          <div className="py-4 text-center text-muted-foreground text-xs flex items-center gap-2 justify-center">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading...
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">App Lock is {configured ? 'enabled' : 'disabled'}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {configured
                    ? 'Your session is protected by a 6-digit PIN'
                    : 'Your session has no PIN protection'}
                </p>
              </div>
              <Badge variant="outline" className={configured
                ? 'border-success/30 text-success bg-success/10'
                : 'border-border/60 text-muted-foreground bg-muted/40'
              }>
                {configured ? 'Active' : 'Inactive'}
              </Badge>
            </div>

            <Separator className="bg-border" />

            {!configured && !showSetup && (
              <Button
                onClick={() => setShowSetup(true)}
                className="w-full h-10 bg-success hover:bg-success/90 text-success-foreground"
              >
                <LockIcon className="h-4 w-4 mr-2" />
                Set App Lock PIN
              </Button>
            )}

            {showSetup && (
              <div className="space-y-3 animate-in slide-in-from-top-2 duration-200">
                <div className="rounded-lg bg-muted/40 border border-border/40 p-3 space-y-3">
                  <p className="text-xs text-muted-foreground font-medium">Create a new 6-digit PIN</p>
                  <div>
                    <Label className="text-[11px] text-muted-foreground mb-1 block">PIN</Label>
                    <Input
                      type="password" inputMode="numeric" maxLength={6}
                      placeholder="••••••"
                      value={setupPin} onChange={(e) => setSetupPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground mb-1 block">Confirm PIN</Label>
                    <Input
                      type="password" inputMode="numeric" maxLength={6}
                      placeholder="••••••"
                      value={setupConfirm} onChange={(e) => setSetupConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className={inputCls}
                    />
                  </div>
                  {setupError && (
                    <p className="text-xs text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" /> {setupError}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setShowSetup(false); setSetupPin(''); setSetupConfirm(''); setSetupError(''); }}
                    className="flex-1 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50">
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleCreatePin} disabled={savingSetup || setupPin.length !== 6 || setupConfirm.length !== 6}
                    className="flex-1 bg-success hover:bg-success/90 text-success-foreground disabled:opacity-40">
                    {savingSetup ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <LockIcon className="h-3.5 w-3.5 mr-1" />}
                    Enable
                  </Button>
                </div>
              </div>
            )}

            {configured && !showChange && !showDisable && (
              <div className="flex flex-col sm:flex-row gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowChange(true)}
                  className="flex-1 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50">
                  <LockIcon className="h-3.5 w-3.5 mr-1.5" /> Change PIN
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowDisable(true)}
                  className="flex-1 border-destructive/30 text-destructive/70 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/40">
                  <LockIcon className="h-3.5 w-3.5 mr-1.5" /> Disable
                </Button>
                <Button variant="outline" size="sm" onClick={handleLockNow}
                  className="flex-1 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50">
                  <LockIcon className="h-3.5 w-3.5 mr-1.5" /> Lock Now
                </Button>
              </div>
            )}

            {showChange && (
              <div className="space-y-3 animate-in slide-in-from-top-2 duration-200">
                <div className="rounded-lg bg-muted/40 border border-border/40 p-3 space-y-3">
                  <p className="text-xs text-muted-foreground font-medium">Change your App Lock PIN</p>
                  <div>
                    <Label className="text-[11px] text-muted-foreground mb-1 block">Current PIN</Label>
                    <Input type="password" inputMode="numeric" maxLength={6} placeholder="••••••"
                      value={changeCurrent} onChange={(e) => setChangeCurrent(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className={inputCls} />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground mb-1 block">New PIN</Label>
                    <Input type="password" inputMode="numeric" maxLength={6} placeholder="••••••"
                      value={changeNew} onChange={(e) => setChangeNew(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className={inputCls} />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground mb-1 block">Confirm New PIN</Label>
                    <Input type="password" inputMode="numeric" maxLength={6} placeholder="••••••"
                      value={changeConfirm} onChange={(e) => setChangeConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className={inputCls} />
                  </div>
                  {changeError && (
                    <p className="text-xs text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" /> {changeError}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setShowChange(false); setChangeCurrent(''); setChangeNew(''); setChangeConfirm(''); setChangeError(''); }}
                    className="flex-1 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50">
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleChangePin} disabled={savingChange || changeCurrent.length !== 6 || changeNew.length !== 6 || changeConfirm.length !== 6}
                    className="flex-1 bg-success hover:bg-success/90 text-success-foreground disabled:opacity-40">
                    {savingChange ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <LockIcon className="h-3.5 w-3.5 mr-1" />}
                    Update
                  </Button>
                </div>
              </div>
            )}

            {showDisable && (
              <div className="space-y-3 animate-in slide-in-from-top-2 duration-200">
                <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 space-y-3">
                  <p className="text-xs text-destructive/80 font-medium">Enter your current PIN to disable App Lock</p>
                  <Input type="password" inputMode="numeric" maxLength={6} placeholder="••••••"
                    value={disablePin} onChange={(e) => setDisablePin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className={cn(inputCls, 'border-destructive/30 focus:border-destructive/60 focus:ring-destructive/20')} />
                  {disableError && (
                    <p className="text-xs text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" /> {disableError}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setShowDisable(false); setDisablePin(''); setDisableError(''); }}
                    className="flex-1 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50">
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleDisable} disabled={savingDisable || disablePin.length !== 6}
                    className="flex-1 bg-destructive hover:bg-destructive/90 text-destructive-foreground disabled:opacity-40">
                    {savingDisable ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <LockIcon className="h-3.5 w-3.5 mr-1" />}
                    Disable
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
