'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Settings,
  Palette,
  RotateCcw,
  Trash2,
  Save,
  Bell,
  BellOff,
  ShieldCheck,
  ScrollText,
  Lock,
  Unlock,
  Zap,
  Smartphone,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SectionCard, ErrorState, StatusBadge } from '@/components/design-system';
import { getDummyPrefs, updateDummyPrefs, runDummyRetention, type DummyPrefs } from '@/lib/dummy';
import { getModeLockStatus, securityCall, type ModeLockStatus } from '@/lib/terminal-service';
import { DummyThemedPage } from '@/components/dummy/ui';
import { useToast } from '@/hooks/use-toast';
import { ThemeStudio } from '@/components/theme/theme-studio';
import {
  enablePush,
  disablePush,
  fetchPushStatus,
  getNotificationPermission,
  isPushNotificationSupported,
  sendTestPush,
  type PushStatus,
} from '@/lib/push-notifications';
import { cn } from '@/lib/utils';

type Tab = 'simulation' | 'notifications' | 'theme' | 'security' | 'audit';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'simulation', label: 'Simulation', icon: Settings },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'theme', label: 'Theme', icon: Palette },
  { id: 'security', label: 'Security PIN', icon: ShieldCheck },
  { id: 'audit', label: 'Audit & Maintenance', icon: ScrollText },
];

function notifCapable(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/* -------- notification feed display prefs (moved from Notifications page) -- */

const COLOR_KEYS = ['emerald', 'red', 'amber', 'sky', 'violet', 'slate'] as const;
type ColorKey = (typeof COLOR_KEYS)[number];

const COLOR_STYLE: Record<ColorKey, { text: string; dot: string }> = {
  emerald: { text: 'text-emerald-500', dot: 'bg-emerald-500' },
  red: { text: 'text-red-500', dot: 'bg-red-500' },
  amber: { text: 'text-amber-500', dot: 'bg-amber-500' },
  sky: { text: 'text-sky-500', dot: 'bg-sky-500' },
  violet: { text: 'text-violet-500', dot: 'bg-violet-500' },
  slate: { text: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
};

const DEFAULT_COLORS: Record<string, ColorKey> = {
  ORDER: 'emerald',
  BASKET: 'sky',
  TARGET: 'amber',
  ALERT: 'red',
  SUGGESTION: 'violet',
  SYSTEM: 'slate',
};

const KNOWN_TYPES = ['ORDER', 'BASKET', 'TARGET', 'ALERT', 'SUGGESTION', 'SYSTEM'];
const COLORS_KEY = 'notif.colors.v1';
const MUTED_KEY = 'dummy.notif.muted';

function loadColors(): Record<string, ColorKey> {
  try {
    const raw = window.localStorage.getItem(COLORS_KEY);
    if (!raw) return { ...DEFAULT_COLORS };
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out = { ...DEFAULT_COLORS };
    for (const [k, v] of Object.entries(parsed)) {
      if ((COLOR_KEYS as readonly string[]).includes(v)) out[k] = v as ColorKey;
    }
    return out;
  } catch {
    return { ...DEFAULT_COLORS };
  }
}

export default function DummySettings() {
  const [tab, setTab] = useState<Tab>('simulation');
  const [prefs, setPrefs] = useState<DummyPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [retentionNote, setRetentionNote] = useState<string | null>(null);
  const [lock, setLock] = useState<ModeLockStatus | null>(null);
  const [pin, setPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [pushNotice, setPushNotice] = useState<string | null>(null);
  // Feed display prefs (colors + mute) + PWA push — moved from Notifications page.
  const [notifColors, setNotifColors] = useState<Record<string, ColorKey>>(DEFAULT_COLORS);
  const [notifMuted, setNotifMuted] = useState<Record<string, boolean>>({});
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const { toast } = useToast();

  const load = async () => {
    setError(null);
    try {
      const res = await getDummyPrefs();
      setPrefs(res.prefs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    }
  };

  const loadLock = async () => {
    try {
      setLock(await getModeLockStatus());
    } catch {
      setLock(null);
    }
  };

  useEffect(() => {
    void load();
    void loadLock();
    try {
      const raw = window.localStorage.getItem(MUTED_KEY);
      if (raw) setNotifMuted(JSON.parse(raw));
    } catch { /* ignore */ }
    setNotifColors(loadColors());
    fetchPushStatus().then(setPushStatus).catch(() => setPushStatus(null));
  }, []);

  const save = async () => {
    if (!prefs) return;
    setSaved(null);
    try {
      await updateDummyPrefs({
        autoRefreshMs: Math.max(1500, Number(prefs.autoRefreshMs) || 1500),
        defaultProduct: prefs.defaultProduct,
        defaultOrderType: prefs.defaultOrderType,
        defaultBasketPolicy: prefs.defaultBasketPolicy,
        confirmBasketExecute: Boolean(prefs.confirmBasketExecute),
        alertCooldownSec: Math.max(0, Number(prefs.alertCooldownSec) || 0),
        autoSquareOffOnTarget: Boolean(prefs.autoSquareOffOnTarget),
        slippageBps: Math.max(0, Math.min(200, Number(prefs.slippageBps) || 0)),
        maxDailyOrders: Math.max(0, Number(prefs.maxDailyOrders) || 0),
        maxOrderValue: Math.max(0, Number(prefs.maxOrderValue) || 0),
        retentionDays: Math.max(1, Math.min(30, Number(prefs.retentionDays) || 7)),
        notificationDelivery: {
          inApp: Boolean(prefs.notificationDelivery?.inApp),
          popup: Boolean(prefs.notificationDelivery?.popup),
          sound: Boolean(prefs.notificationDelivery?.sound),
          push: Boolean(prefs.notificationDelivery?.push),
        },
      });
      setSaved(`Saved at ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
    }
  };

  const setDelivery = (key: keyof DummyPrefs['notificationDelivery'], value: boolean) => {
    if (!prefs) return;
    const n = { ...(prefs.notificationDelivery ?? { inApp: true, popup: false, sound: false, push: false }) };
    n[key] = value;
    if (key === 'push' && value && notifCapable()) {
      void (async () => {
        const perm = await Notification.requestPermission();
        setPushNotice(perm === 'granted' ? 'Push permission granted in this browser.' : `Push permission ${perm} — alerts stay in-app only.`);
        if (perm !== 'granted') {
          setDelivery('push', false);
          return;
        }
      })();
    }
    setPrefs({ ...prefs, notificationDelivery: n });
  };

  const setNotifColor = (type: string, color: ColorKey) => {
    setNotifColors((prev) => {
      const next = { ...prev, [type]: color };
      try {
        window.localStorage.setItem(COLORS_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  };

  const toggleNotifType = (type: string) => {
    setNotifMuted((prev) => {
      const next = { ...prev, [type]: !prev[type] };
      try {
        window.localStorage.setItem(MUTED_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  };

  const loadPush = async () => {
    try {
      setPushStatus(await fetchPushStatus());
    } catch {
      setPushStatus(null);
    }
  };

  const onEnablePush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    const res = await enablePush('trading-pwa');
    setPushMsg(res.ok ? 'Push enabled — order alerts will buzz this device.' : (res.reason ?? 'Enable failed.'));
    await loadPush();
    setPushBusy(false);
  };
  const onDisablePush = async () => {
    setPushBusy(true);
    await disablePush();
    setPushMsg('Push disabled on this device.');
    await loadPush();
    setPushBusy(false);
  };
  const onTestPush = async () => {
    setPushBusy(true);
    try {
      const res = await sendTestPush();
      setPushMsg(res.sent > 0 ? `Test sent to ${res.sent} device(s).` : 'No devices subscribed yet.');
    } catch (e) {
      setPushMsg(e instanceof Error ? e.message : 'Test failed.');
    }
    setPushBusy(false);
  };

  const setPinNow = async () => {
    if (!pin || pin.length < 4) {
      toast({ variant: 'destructive', title: 'PIN too short', description: 'Use at least 4 digits.' });
      return;
    }
    try {
      await securityCall('/pin', { action: 'set', pin });
      toast({ title: 'PIN configured', description: 'Mode Lock PIN saved for terminal switching.' });
      setPin('');
      void loadLock();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'PIN failed', description: e?.body?.detail?.message ?? e?.message });
    }
  };

  const changePinNow = async () => {
    if (!currentPin || !newPin || newPin.length < 4) {
      toast({ variant: 'destructive', title: 'Invalid input', description: 'Current PIN and a new 4+ digit PIN are required.' });
      return;
    }
    try {
      await securityCall('/pin', { action: 'change', currentPin, newPin });
      toast({ title: 'PIN changed' });
      setCurrentPin('');
      setNewPin('');
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Change failed', description: e?.body?.detail?.message ?? e?.message });
    }
  };

  const disablePinNow = async () => {
    if (!currentPin) {
      toast({ variant: 'destructive', title: 'PIN required', description: 'Enter your PIN to disable Mode Lock.' });
      return;
    }
    try {
      await securityCall('/pin', { action: 'disable', pin: currentPin });
      toast({ title: 'Mode Lock disabled' });
      setCurrentPin('');
      void loadLock();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Disable failed', description: e?.body?.detail?.message ?? e?.message });
    }
  };

  const toggleLock = async (enabled: boolean) => {
    try {
      await securityCall('/lock', { enabled });
      void loadLock();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Toggle failed', description: e?.body?.detail?.message ?? e?.message });
    }
  };

  const runRetention = async () => {
    setRetentionNote(null);
    const days = prefs?.retentionDays ?? 7;
    try {
      const res = await runDummyRetention(days);
      setRetentionNote(`Retention ran: purged ${res.purged} order(s) older than ${days} days.`);
    } catch (e) {
      setRetentionNote(e instanceof Error ? e.message : 'retention failed');
    }
  };

  if (error && !prefs) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void load()} /></DummyThemedPage>;
  }
  if (!prefs) {
    return <DummyThemedPage><div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading settings…</div></DummyThemedPage>;
  }

  const delivery = prefs.notificationDelivery ?? { inApp: true, popup: false, sound: false, push: false };
  const pushSupported = isPushNotificationSupported();
  const permission = getNotificationPermission();

  return (
    <DummyThemedPage>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dummy Terminal Settings</h1>
          <p className="text-sm text-muted-foreground">Simulation behaviour, notification delivery, Mode Lock PIN and maintenance.</p>
        </div>
        {tab !== 'security' && tab !== 'audit' && tab !== 'theme' ? (
          <Button size="sm" onClick={() => void save()}>
            <Save className="h-4 w-4" /> Save
          </Button>
        ) : null}
      </div>

      {tab !== 'security' && tab !== 'audit' && tab !== 'theme' && (saved || error) && (
        <p className={`text-sm ${error ? 'text-red-500' : 'text-emerald-600'}`}>{error || saved}</p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.id ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'simulation' && (
        <div className="space-y-4">
        <SectionCard title="Simulation behaviour" icon={Settings}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Auto-refresh interval (ms)</Label>
              <Input
                type="number" min={1500} step={500}
                value={prefs.autoRefreshMs}
                onChange={(e) => setPrefs({ ...prefs, autoRefreshMs: Number(e.target.value) || 1500 })}
              />
              <p className="text-xs text-muted-foreground">How often Dummy pages poll /api/dummy/state (min 1500).</p>
            </div>
            <div className="space-y-2">
              <Label>Default product</Label>
              <Select value={prefs.defaultProduct} onValueChange={(v) => setPrefs({ ...prefs, defaultProduct: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CNC">CNC — Delivery</SelectItem>
                  <SelectItem value="MIS">MIS — Intraday</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Default order type</Label>
              <Select value={prefs.defaultOrderType} onValueChange={(v) => setPrefs({ ...prefs, defaultOrderType: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MKT">MARKET</SelectItem>
                  <SelectItem value="LMT">LIMIT</SelectItem>
                  <SelectItem value="SL">SL-LIMIT</SelectItem>
                  <SelectItem value="SL-M">SL-MARKET</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Alert cooldown (sec)</Label>
              <Input
                type="number" min={0} step={5}
                value={prefs.alertCooldownSec}
                onChange={(e) => setPrefs({ ...prefs, alertCooldownSec: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label>Order retention (days)</Label>
              <Input
                type="number" min={1} max={30}
                value={prefs.retentionDays}
                onChange={(e) => setPrefs({ ...prefs, retentionDays: Number(e.target.value) || 7 })}
              />
              <p className="text-xs text-muted-foreground">Orders older than this are purged on the next retention run.</p>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Dummy Execution Settings" icon={Zap}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Market slippage (bps)</Label>
              <Input
                type="number" min={0} max={200} step={5}
                value={prefs.slippageBps}
                onChange={(e) => setPrefs({ ...prefs, slippageBps: Number(e.target.value) || 0 })}
              />
              <p className="text-xs text-muted-foreground">Basis-point slippage applied when simulating a MARKET fill. Harsher settings test your risk controls.</p>
            </div>
            <div className="space-y-2">
              <Label>Daily order cap (0 = unlimited)</Label>
              <Input
                type="number" min={0}
                value={prefs.maxDailyOrders}
                onChange={(e) => setPrefs({ ...prefs, maxDailyOrders: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label>Max order value, ₹ (0 = unlimited)</Label>
              <Input
                type="number" min={0}
                value={prefs.maxOrderValue}
                onChange={(e) => setPrefs({ ...prefs, maxOrderValue: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label>Default basket policy</Label>
              <Select value={prefs.defaultBasketPolicy} onValueChange={(v) => setPrefs({ ...prefs, defaultBasketPolicy: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">ALL</SelectItem>
                  <SelectItem value="MIN">MIN</SelectItem>
                  <SelectItem value="EXACT">EXACT</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
              <span className="text-sm">Confirm before executing a basket</span>
              <Switch checked={prefs.confirmBasketExecute} onCheckedChange={(v) => setPrefs({ ...prefs, confirmBasketExecute: v })} />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
              <span className="text-sm">Auto square-off when a target fires</span>
              <Switch checked={prefs.autoSquareOffOnTarget} onCheckedChange={(v) => setPrefs({ ...prefs, autoSquareOffOnTarget: v })} />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Execution settings shape how simulated fills are produced (slippage), how many orders are permitted per day, the largest
            notional accepted per order, and how baskets are judged complete. They feed the Dummy order engine and the risk checks on
            Suggestion processing.
          </p>
        </SectionCard>
        </div>
      )}

      {tab === 'notifications' && (
        <div className="space-y-4">
        <SectionCard title="Notification delivery" icon={Bell}>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
              <span className="text-sm">In-app feed (terminal bell)</span>
              <Switch checked={delivery.inApp} onCheckedChange={(v) => setDelivery('inApp', v)} />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
              <span className="text-sm">Pop-up toast on alert/target</span>
              <Switch checked={delivery.popup} onCheckedChange={(v) => setDelivery('popup', v)} />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
              <span className="text-sm">Sound cue on fill</span>
              <Switch checked={delivery.sound} onCheckedChange={(v) => setDelivery('sound', v)} />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
              <div>
                <span className="text-sm">Browser push permission</span>
                <p className="text-xs text-muted-foreground">
                  {notifCapable() ? 'Alerts may surface via the OS when the tab is hidden.' : 'This browser does not support the Notification API.'}
                </p>
              </div>
              <Switch checked={delivery.push} disabled={!notifCapable()} onCheckedChange={(v) => setDelivery('push', v)} />
            </div>
            {pushNotice && <p className="text-xs text-muted-foreground">{pushNotice}</p>}
            <p className="text-xs text-muted-foreground">Delivery preferences are stored in the Dummy backend and honoured by alert / target / audit hooks.</p>
          </div>
        </SectionCard>

        <SectionCard
          title="Color theme per type"
          icon={Palette}
          headerRight={<span className="text-[11px] text-muted-foreground">saved on this device</span>}
        >
          <div className="space-y-2.5">
            {KNOWN_TYPES.map((type) => (
              <div key={type} className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleNotifType(type)}
                  title={notifMuted[type] ? 'Unmute' : 'Mute'}
                  className={cn(
                    'inline-flex w-28 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                    !notifMuted[type] ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground',
                  )}
                >
                  {notifMuted[type] ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                  {type}
                </button>
                <div className="flex items-center gap-1">
                  {COLOR_KEYS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNotifColor(type, c)}
                      aria-label={`${type} ${c}`}
                      className={cn(
                        'h-6 w-6 rounded-full ring-offset-2 ring-offset-background',
                        COLOR_STYLE[c].dot,
                        notifColors[type] === c ? 'ring-2 ring-primary' : 'opacity-60 hover:opacity-100',
                      )}
                    />
                  ))}
                </div>
                <span className={cn('text-[11px] font-medium', COLOR_STYLE[notifColors[type] ?? 'slate'].text)}>
                  preview text
                </span>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Muted types hide from the Notifications feed but stay in backend history. Colors paint badges, card rails and unread dots.
            </p>
          </div>
        </SectionCard>

        <SectionCard
          title="Push on this device (PWA)"
          icon={Smartphone}
          headerRight={
            pushStatus && (
              <span className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-bold',
                pushStatus.enabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-amber-500/40 bg-amber-500/10 text-amber-500',
              )}>
                {pushStatus.enabled ? `backend ready · ${pushStatus.subscriptions} device(s)` : 'backend not configured'}
              </span>
            )
          }
        >
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">supported: {pushSupported ? 'yes' : 'no'}</Badge>
              <Badge variant="outline">permission: {permission}</Badge>
            </div>
            <p>Order fills, square-offs, targets and alerts buzz this device even with the app closed — same payload the trading app shows.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void onEnablePush()} disabled={pushBusy || !pushSupported}>
                <Bell className="h-3.5 w-3.5" /> Enable push
              </Button>
              <Button size="sm" variant="outline" onClick={() => void onDisablePush()} disabled={pushBusy}>
                <BellOff className="h-3.5 w-3.5" /> Disable
              </Button>
              <Button size="sm" variant="outline" onClick={() => void onTestPush()} disabled={pushBusy}>
                Send test
              </Button>
            </div>
            {pushMsg && <p className="text-xs font-medium text-foreground">{pushMsg}</p>}
          </div>
        </SectionCard>
        </div>
      )}

      {tab === 'theme' && (
        <ThemeStudio
          scope={{
            appId: 'trading',
            scope: 'dummy',
            label: 'Dummy Terminal',
          }}
        />
      )}

      {tab === 'security' && (
        <SectionCard title="Mode Lock (Security PIN)" icon={ShieldCheck}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <StatusBadge status={lock?.configured ? 'success' : 'neutral'} label={lock?.configured ? 'PIN configured' : 'No PIN set'} />
            <StatusBadge status={lock?.lockEnabled ? 'success' : 'neutral'} label={lock?.lockEnabled ? 'Lock enabled' : 'Lock off'} />
            <StatusBadge status={lock?.webauthnRegistered ? 'success' : 'neutral'} label="WebAuthn" />
          </div>

          {!lock?.configured ? (
            <div className="space-y-2 sm:max-w-xs">
              <Label>Set a 4+ digit PIN</Label>
              <div className="flex gap-2">
                <Input type="password" inputMode="numeric" maxLength={8} placeholder="••••" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void setPinNow(); }} />
                <Button size="sm" onClick={() => void setPinNow()}><Lock className="mr-1 h-3.5 w-3.5" /> Set PIN</Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Change PIN</Label>
                <Input type="password" placeholder="Current PIN" value={currentPin} onChange={(e) => setCurrentPin(e.target.value)} />
                <Input type="password" placeholder="New PIN (4+ digits)" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
                <Button size="sm" variant="outline" onClick={() => void changePinNow()}>Change PIN</Button>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                  <span className="text-sm">Lock terminal switching when unlocked sessions become stale</span>
                  <Switch checked={Boolean(lock?.lockEnabled)} disabled={!lock?.configured} onCheckedChange={(v) => void toggleLock(v)} />
                </div>
                <div className="flex items-center gap-2">
                  <Input type="password" placeholder="PIN to disable Mode Lock" value={currentPin} onChange={(e) => setCurrentPin(e.target.value)} className="max-w-xs" />
                  <Button size="sm" variant="destructive" onClick={() => void disablePinNow()}><Unlock className="mr-1 h-3.5 w-3.5" /> Disable</Button>
                </div>
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Mode Lock applies to terminal switching across Dummy / Kotak NEO / Shoonya shells, not to the broker sessions themselves.</p>
        </SectionCard>
      )}

      {tab === 'audit' && (
        <div className="space-y-4">
          <SectionCard title="Audit trail" icon={ScrollText}>
            <p className="mb-3 text-sm text-muted-foreground">Every order, basket, alert, target, preference change and maintenance action on the Dummy terminal is logged with an IST timestamp and a category filter (last 500 events).</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/trading/audit">Open Audit Trail</Link>
            </Button>
          </SectionCard>

          <SectionCard title="Maintenance" icon={RotateCcw}>
            <p className="mb-3 text-sm text-muted-foreground">Run the order-retention cleanup now. This purges Dummy orders older than the configured window.</p>
            <Button variant="outline" size="sm" onClick={() => void runRetention()}>
              <Trash2 className="h-4 w-4" /> Run retention cleanup
            </Button>
            {retentionNote && <p className="mt-2 text-xs text-muted-foreground">{retentionNote}</p>}
          </SectionCard>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline" size="sm">
          <Link href="/trading/notifications"><Bell className="h-4 w-4" /> Notification centre</Link>
        </Button>
      </div>
    </DummyThemedPage>
  );
}