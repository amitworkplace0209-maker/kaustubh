'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  BellRing,
  CandlestickChart,
  CheckCircle2,
  Clock,
  Coins,
  Database,
  Gauge,
  History,
  IndianRupee,
  Layers,
  LineChart,
  Loader2,
  Lock,
  Monitor,
  Palette,
  Play,
  Radar,
  RefreshCw,
  RotateCcw,
  Server,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Target,
  Timer,
  TrendingDown,
  Volume2,
  Wallet,
  Wifi,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/use-toast';
import {
  getDemoAccount,
  resetDemoAccount,
  type SettingSchemaRow,
  type SettingsAuditEntry,
  type SettingsHealth,
} from '@/lib/api';
import type {
  NotificationEventSettings,
  TradingMode,
  TradingSettings,
} from '@/lib/settings-store';
import {
  disablePush,
  enablePush,
  fetchPushStatus,
  isPushNotificationSupported,
  sendTestPush,
  type PushStatus,
} from '@/lib/push-notifications';
import { ThemeStudio } from '@/components/theme/theme-studio';
import { cn } from '@/lib/utils';
import {
  Callout,
  FieldRow,
  InlineLink,
  NumberControl,
  Panel,
  Pill,
  SectionIntro,
  Segmented,
  SelectControl,
  StatTile,
  ToggleRow,
  classifyAction,
  formatRelative,
  formatValue,
  valuesEqual,
} from './settings-primitives';

export type FieldUpdater = (path: string, value: any) => Promise<void>;
export type BatchUpdater = (label: string, values: Record<string, any>) => Promise<void>;
export type BackendWriter = (key: string, value: any) => Promise<void>;

type SchemaMap = Map<string, SettingSchemaRow>;

const MODE_META: Record<
  TradingMode,
  {
    label: string;
    blurb: string;
    icon: React.ElementType;
    accent: string;
    iconBox: string;
    tone: 'purple' | 'info' | 'success';
  }
> = {
  dummy: {
    label: 'Dummy Mode',
    blurb:
      'Virtual funds, real market data. Orders are executed by the server-side Dummy Trading Engine and never reach a broker.',
    icon: Coins,
    accent: 'border-purple/35 bg-purple/5',
    iconBox: 'bg-purple/15 text-purple ring-purple/25',
    tone: 'purple',
  },
  'kotak-neo': {
    label: 'Kotak Neo',
    blurb:
      'Live broker account. Real funds and real execution through the Kotak Neo SDK session.',
    icon: IndianRupee,
    accent: 'border-success/35 bg-success/5',
    iconBox: 'bg-success/15 text-success ring-success/25',
    tone: 'success',
  },
  shoonya: {
    label: 'Shoonya',
    blurb:
      'Live broker account. Real funds and real execution through the Shoonya OAuth session.',
    icon: Radar,
    accent: 'border-info/35 bg-info/5',
    iconBox: 'bg-info/15 text-info ring-info/25',
    tone: 'info',
  },
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function OverviewSection({
  mode,
  settings,
  health,
  runtime,
  audit,
  schema,
  systemStatus,
  demoAccount,
  onNavigate,
  onOpenCatalog,
  onResetDemo,
}: {
  mode: TradingMode;
  settings: TradingSettings;
  health: SettingsHealth | null;
  runtime: any;
  audit: SettingsAuditEntry[];
  schema: SettingSchemaRow[];
  systemStatus: any;
  demoAccount: any;
  onNavigate: (section: string) => void;
  onOpenCatalog: (category?: string) => void;
  onResetDemo: () => void;
}) {
  const meta = MODE_META[mode];
  const ModeIcon = meta.icon;
  const loggedIn = Boolean(systemStatus?.pythonStatus?.logged_in);
  const liveKeys: string[] = Array.isArray(runtime?.liveKeys) ? runtime.liveKeys : [];
  const snapshot = runtime?.snapshot ?? {};

  const warnings = useMemo(() => {
    const list: Array<{ tone: 'warning' | 'danger'; title: string; body: string; section: string }> = [];
    if (!settings.risk.maxDailyLoss || settings.risk.maxDailyLoss <= 0) {
      list.push({
        tone: 'danger',
        title: 'Daily loss cap is disabled',
        body: 'Set a maximum daily loss so the risk engine can stop new entries after the cap is hit.',
        section: 'risk',
      });
    }
    if (!settings.risk.maxOrderValue || settings.risk.maxOrderValue <= 0) {
      list.push({
        tone: 'danger',
        title: 'No per-order value ceiling',
        body: 'A single oversized order can bypass the rest of the risk profile. Set a max order value.',
        section: 'risk',
      });
    }
    if (mode !== 'dummy' && !settings.confirm.confirmLiveOrder) {
      list.push({
        tone: 'warning',
        title: 'Live orders are not confirmed',
        body: `You are in ${meta.label} and order confirmation is off. A mis-click will go straight to the broker.`,
        section: 'trading',
      });
    }
    if (mode !== 'dummy' && !settings.squareOff.enabled) {
      list.push({
        tone: 'warning',
        title: 'Auto square-off is off',
        body: 'Intraday positions will not be closed automatically at the configured time.',
        section: 'schedule',
      });
    }
    if (settings.target.enabled && settings.stopLoss.enabled && settings.target.mode === settings.stopLoss.mode) {
      if (settings.stopLoss.value >= settings.target.value) {
        list.push({
          tone: 'danger',
          title: 'Stop loss is wider than the target',
          body: `Target is ${settings.target.value} and stop loss is ${settings.stopLoss.value}. The risk/reward is inverted.`,
          section: 'trading',
        });
      }
    }
    const backendStatus = health?.database;
    if (backendStatus && backendStatus !== 'connected') {
      list.push({
        tone: 'danger',
        title: 'Settings database is not connected',
        body: 'Backend writes may not persist. Check the Python service and MongoDB connection.',
        section: 'backup',
      });
    }
    return list;
  }, [settings, mode, meta.label, health]);

  const categories = Object.entries(health?.categories ?? {}).sort((a, b) => b[1] - a[1]);
  const maxCategory = Math.max(1, ...categories.map(([, count]) => count));
  const demo = demoAccount ?? {};

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Control room"
        title="Settings Overview"
        description="A single live view of the terminal identity, risk posture, backend catalogue and recent configuration changes."
        actions={
          <>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => onNavigate('system')}>
              <Database className="h-3.5 w-3.5" /> System catalogue
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => onNavigate('backup')}>
              <History className="h-3.5 w-3.5" /> Audit log
            </Button>
          </>
        }
      />

      <div className={cn('relative overflow-hidden rounded-2xl border p-4 sm:p-5', meta.accent)}>
        <div className="flex flex-wrap items-start gap-3">
          <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset', meta.iconBox)}>
            <ModeIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold">{meta.label}</h3>
              <Pill tone={mode === 'dummy' ? 'purple' : mode === 'shoonya' ? 'info' : 'success'} dot>
                active terminal
              </Pill>
              {mode !== 'dummy' && (
                <Pill tone={loggedIn ? 'success' : 'danger'} dot>
                  {loggedIn ? 'broker session live' : 'broker disconnected'}
                </Pill>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-[11px] leading-5 text-muted-foreground">{meta.blurb}</p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => onNavigate('account')}>
                <Wifi className="h-3 w-3" /> Account &amp; connection
              </Button>
              <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => onNavigate('risk')}>
                <Shield className="h-3 w-3" /> Review risk
              </Button>
              <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => onNavigate('security')}>
                <Lock className="h-3 w-3" /> Security
              </Button>
              {mode === 'dummy' && (
                <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={onResetDemo}>
                  <RotateCcw className="h-3 w-3" /> Reset demo
                </Button>
              )}
            </div>
          </div>

          <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:grid-cols-4">
            {mode === 'dummy' ? (
              <>
                <HeroStat label="Balance" value={`${Number(demo.balance ?? 0).toLocaleString('en-IN')}`} unit="coins" />
                <HeroStat label="Free" value={`${Number(demo.freeMargin ?? 0).toLocaleString('en-IN')}`} unit="coins" tone="success" />
                <HeroStat label="Used" value={`${Number(demo.usedMargin ?? 0).toLocaleString('en-IN')}`} unit="coins" tone="warning" />
                <HeroStat
                  label="P&L"
                  value={`${Number(demo.totalPnl ?? 0) >= 0 ? '+' : ''}${Number(demo.totalPnl ?? 0).toLocaleString('en-IN')}`}
                  unit="coins"
                  tone={Number(demo.totalPnl ?? 0) >= 0 ? 'success' : 'danger'}
                />
              </>
            ) : (
              <>
                <HeroStat label="Session" value={loggedIn ? 'Connected' : 'Offline'} tone={loggedIn ? 'success' : 'danger'} />
                <HeroStat label="Auto square-off" value={settings.squareOff.enabled ? settings.squareOff.time : 'Off'} tone={settings.squareOff.enabled ? 'success' : 'warning'} />
                <HeroStat label="Live knobs" value={String(liveKeys.length)} unit="keys" />
                <HeroStat label="Audit events" value={String(health?.auditCount ?? 0)} />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Catalogue keys"
          value={health?.totalKeys ?? schema.length}
          sub={`${health?.defaultKeys ?? 0} at default`}
          icon={Database}
        />
        <StatTile
          label="Customized"
          value={health?.customizedKeys ?? 0}
          sub={health?.lastChange ? `last ${formatRelative(health.lastChange)}` : 'no changes yet'}
          icon={SlidersHorizontal}
          tone="warning"
        />
        <StatTile
          label="Live runtime"
          value={liveKeys.length}
          sub="applied without restart"
          icon={Activity}
          tone="success"
        />
        <StatTile
          label="Audit trail"
          value={health?.auditCount ?? audit.length}
          sub={`${audit.length} loaded`}
          icon={History}
          tone="info"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Panel title="Configuration warnings" description="Derived from the active profile and live backend health." icon={ShieldAlert}>
          {warnings.length === 0 ? (
            <Callout tone="success" title="No configuration warnings">
              Risk caps, confirmations and square-off are coherent for this terminal mode.
            </Callout>
          ) : (
            <ul className="space-y-2">
              {warnings.map((warning) => (
                <li key={warning.title}>
                  <button
                    type="button"
                    onClick={() => onNavigate(warning.section)}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                      warning.tone === 'danger'
                        ? 'border-destructive/25 bg-destructive/5 hover:bg-destructive/10'
                        : 'border-warning/25 bg-warning/5 hover:bg-warning/10',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('text-[11px] font-semibold', warning.tone === 'danger' ? 'text-destructive' : 'text-warning')}>
                        {warning.title}
                      </span>
                      <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    </div>
                    <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{warning.body}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Catalogue health" description="Backend-declared keys per category." icon={Layers}>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Pill tone={health?.database === 'connected' ? 'success' : 'warning'} dot>
              mongo {health?.database ?? 'unknown'}
            </Pill>
            <Pill tone="info">{health?.liveKeyCount ?? liveKeys.length} live</Pill>
            <Pill tone="neutral">{schema.filter((row) => row.sensitive).length} protected</Pill>
          </div>
          <ul className="space-y-1.5">
            {categories.slice(0, 8).map(([category, count]) => (
              <li key={category}>
                <button
                  type="button"
                  onClick={() => onOpenCatalog(category)}
                  className="group flex w-full items-center gap-2 text-left"
                >
                  <span className="w-28 shrink-0 truncate text-[10px] capitalize text-muted-foreground group-hover:text-foreground">
                    {category.replace(/_/g, ' ')}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60">
                    <span
                      className="block h-full rounded-full bg-primary/60 transition-all group-hover:bg-primary"
                      style={{ width: `${Math.max(4, (count / maxCategory) * 100)}%` }}
                    />
                  </span>
                  <span className="w-6 text-right text-[10px] font-semibold tabular-nums">{count}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-border/40 pt-2">
            <InlineLink onClick={() => onNavigate('system')}>Open the full catalogue</InlineLink>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Panel
          title="Recent changes"
          description="Every settings write is attributed and replayable."
          icon={History}
          actions={<InlineLink onClick={() => onNavigate('backup')}>View all</InlineLink>}
          bodyClassName="p-0"
        >
          {audit.length === 0 ? (
            <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
              No changes recorded yet. Edit a backend key to start the audit trail.
            </div>
          ) : (
            <ul className="divide-y divide-border/40">
              {audit.slice(0, 6).map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 px-4 py-2">
                  <Pill tone={classifyAction(entry.action)} className="uppercase">
                    {entry.action.replace(/-/g, ' ')}
                  </Pill>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
                    {entry.key ?? `${entry.keys.length} keys`}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelative(entry.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Live runtime"
          description="Values currently applied to schedulers, websockets and the engine."
          icon={Activity}
          actions={
            <Pill tone={liveKeys.length > 0 ? 'success' : 'neutral'} dot>
              {liveKeys.length} knobs
            </Pill>
          }
        >
          {Object.keys(snapshot).length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No runtime snapshot is available for this build.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {Object.entries(snapshot)
                .slice(0, 10)
                .map(([key, value]) => (
                  <div key={key} className="flex min-w-0 items-center justify-between gap-2 border-b border-border/30 pb-1">
                    <dt className="truncate text-[10px] text-muted-foreground">{key.replace(/_/g, ' ')}</dt>
                    <dd className="truncate font-mono text-[10px] font-semibold">{formatValue(value)}</dd>
                  </div>
                ))}
            </dl>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full', liveKeys.length ? 'animate-pulse bg-success' : 'bg-muted-foreground/50')} />
            <span className="text-[10px] text-muted-foreground">
              {liveKeys.length ? 'Runtime propagation is active' : 'No live keys registered'}
            </span>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function HeroStat({
  label,
  value,
  unit,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = {
    neutral: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-destructive',
  }[tone];
  return (
    <div className="min-w-[92px] rounded-lg border border-border/50 bg-background/50 px-2.5 py-1.5">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className={cn('truncate text-sm font-bold tabular-nums', toneClass)}>
        {value}
        {unit && <span className="ml-0.5 text-[9px] font-normal text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export function AccountSection({
  mode,
  schemaMap,
  systemStatus,
  terminalState,
  onBackendWrite,
  onNavigate,
  onDemoReset,
}: {
  mode: TradingMode;
  schemaMap: SchemaMap;
  systemStatus: any;
  terminalState: any;
  onBackendWrite: BackendWriter;
  onNavigate: (section: string) => void;
  onDemoReset: () => Promise<void>;
}) {
  const meta = MODE_META[mode];
  const ModeIcon = meta.icon;
  const [demo, setDemo] = useState<any>(null);
  const [demoLoading, setDemoLoading] = useState(mode === 'dummy');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const loggedIn = Boolean(systemStatus?.pythonStatus?.logged_in);
  const shoonyaOk = Boolean(terminalState?.ok && terminalState?.isLoggedIn);

  useEffect(() => {
    if (mode !== 'dummy') return;
    let alive = true;
    setDemoLoading(true);
    getDemoAccount()
      .then((data) => {
        if (alive) setDemo(data?.account ?? null);
      })
      .catch(() => {
        if (alive) setDemo(null);
      })
      .finally(() => {
        if (alive) setDemoLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mode]);

  const doReset = async () => {
    setResetBusy(true);
    try {
      const res = await resetDemoAccount(100000);
      setDemo(res?.account ?? null);
      setResetOpen(false);
      setResetText('');
      await onDemoReset();
    } finally {
      setResetBusy(false);
    }
  };

  const connected = mode === 'dummy' ? true : mode === 'shoonya' ? shoonyaOk : loggedIn;

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Identity"
        title="Account & Connection"
        description="The terminal mode is the source of truth for which account, broker session and risk profile are active."
        actions={
          <Pill tone={mode === 'dummy' ? 'purple' : mode === 'shoonya' ? 'info' : 'success'} dot>
            {meta.label}
          </Pill>
        }
      />

      <div className={cn('flex flex-wrap items-start gap-3 rounded-xl border p-4', meta.accent)}>
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset', meta.iconBox)}>
          <ModeIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">{meta.label}</span>
            <Pill tone={connected ? 'success' : 'danger'} dot>
              {connected ? 'connected' : 'disconnected'}
            </Pill>
          </div>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{meta.blurb}</p>
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onNavigate('broker')}>
          <Wifi className="mr-1.5 h-3.5 w-3.5" /> Connection details
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Profile" description="Stored on the backend and shared across terminals." icon={BadgeCheck}>
          {['profile_name', 'profile_email', 'user_id'].map((key) => (
            <BackendField key={key} row={schemaMap.get(key)} onCommit={onBackendWrite} />
          ))}
          <BackendField row={schemaMap.get('terminal_mode')} onCommit={onBackendWrite} />
        </Panel>

        <Panel
          title={mode === 'dummy' ? 'Virtual account' : 'Broker session'}
          description={mode === 'dummy' ? 'Server-side paper account. Reset restores the starting balance.' : 'Live session state reported by the broker adapter.'}
          icon={mode === 'dummy' ? Wallet : Wifi}
          actions={
            mode === 'dummy' ? (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setResetOpen(true)}>
                <RotateCcw className="mr-1 h-3 w-3" /> Reset demo
              </Button>
            ) : (
              <Pill tone={connected ? 'success' : 'danger'} dot>
                {connected ? 'active' : 'offline'}
              </Pill>
            )
          }
        >
          {mode === 'dummy' ? (
            demoLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading virtual account…
              </div>
            ) : demo ? (
              <div className="grid grid-cols-2 gap-2">
                <DemoStat label="Balance" value={demo.balance ?? 0} />
                <DemoStat label="Free margin" value={demo.freeMargin ?? 0} tone="success" />
                <DemoStat label="Used margin" value={demo.usedMargin ?? 0} tone="warning" />
                <DemoStat label="Total P&L" value={demo.totalPnl ?? 0} tone={Number(demo.totalPnl ?? 0) >= 0 ? 'success' : 'danger'} />
                <DemoStat label="Charges" value={demo.totalCharges ?? 0} />
                <DemoStat label="Positions" value={demo.positionCount ?? demo.openPositions ?? 0} raw />
              </div>
            ) : (
              <Callout tone="warning" title="Virtual account unavailable">
                The dummy account endpoint did not return data. The engine may still be starting.
              </Callout>
            )
          ) : (
            <div className="space-y-1">
              <FieldRow label="Session state" description={mode === 'shoonya' ? 'Shoonya OAuth session' : 'Kotak Neo SDK session'}>
                <Pill tone={connected ? 'success' : 'danger'} dot>
                  {connected ? 'CONNECTED' : 'DISCONNECTED'}
                </Pill>
              </FieldRow>
              <FieldRow label="Broker" description="Terminal identity reported by the adapter.">
                <span className="font-mono text-xs">{terminalState?.broker ?? terminalState?.terminal ?? meta.label}</span>
              </FieldRow>
              <FieldRow label="Feed source" description="Tick source currently wired to the engine.">
                <BackendFieldInline row={schemaMap.get('ws_feed_broker')} onCommit={onBackendWrite} />
              </FieldRow>
              <FieldRow label="Funds" description="Live balance is on the broker account page.">
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => onNavigate('broker')}>
                  Open broker view
                </Button>
              </FieldRow>
              {!connected && (
                <Callout tone="warning" className="mt-2" title="No live broker session">
                  {mode === 'shoonya'
                    ? 'Complete the Shoonya OAuth login from the terminal switcher before sending live orders.'
                    : 'Log in to Kotak Neo from the terminal header. Dummy mode remains available without a session.'}
                </Callout>
              )}
            </div>
          )}
        </Panel>
      </div>

      {mode === 'dummy' && (
        <Callout tone="purple" icon={Coins} title="Simulation only">
          Reset demo clears balance, positions and orders for the virtual account. Real broker accounts are never touched.
        </Callout>
      )}

      <Dialog open={resetOpen} onOpenChange={(open) => !open && setResetOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-warning" /> Reset demo account
            </DialogTitle>
            <DialogDescription className="text-xs">
              Demo balance, positions, orders and trade history return to the starting state. Real accounts are unaffected.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Type <span className="font-mono font-bold text-foreground">RESET</span> to confirm.
            </p>
            <Input value={resetText} onChange={(e) => setResetText(e.target.value)} placeholder="RESET" className="h-9 font-mono" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)} disabled={resetBusy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={doReset} disabled={resetBusy || resetText !== 'RESET'}>
              {resetBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Reset demo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DemoStat({ label, value, tone = 'neutral', raw = false }: { label: string; value: any; tone?: 'neutral' | 'success' | 'warning' | 'danger'; raw?: boolean }) {
  const toneClass = {
    neutral: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-destructive',
  }[tone];
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('truncate text-sm font-bold tabular-nums', toneClass)}>
        {raw ? value : `${Number(value ?? 0).toLocaleString('en-IN')} coins`}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trading defaults
// ---------------------------------------------------------------------------

const PER_MODE_NOTE = 'These order, risk and protection values are remembered separately for each terminal mode.';

export function TradingSection({
  mode,
  settings,
  onFieldUpdate,
}: {
  mode: TradingMode;
  settings: TradingSettings;
  onFieldUpdate: FieldUpdater;
}) {
  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Execution defaults"
        title="Trading Defaults"
        description="Pre-filled order values, protection brackets and confirmation policy for the active terminal profile."
        actions={<Pill tone={mode === 'dummy' ? 'purple' : 'success'}>{mode === 'dummy' ? 'virtual profile' : 'live profile'}</Pill>}
      />
      <Callout tone="info" icon={Layers}>{PER_MODE_NOTE}</Callout>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Order defaults" description="Applied to every new order form." icon={CandlestickChart}>
          <FieldRow label="Default side" description="Pre-selected BUY or SELL.">
            <Segmented
              value={settings.orderDefaults.side}
              onChange={(v) => onFieldUpdate('orderDefaults.side', v)}
              options={[
                { value: 'BUY', label: 'BUY' },
                { value: 'SELL', label: 'SELL' },
              ]}
            />
          </FieldRow>
          <FieldRow label="Product" description="Position product type.">
            <SelectControl
              value={settings.orderDefaults.product}
              onChange={(v) => onFieldUpdate('orderDefaults.product', v)}
              options={[
                { value: 'MIS', label: 'MIS (Intraday)' },
                { value: 'CNC', label: 'CNC (Delivery)' },
                { value: 'NRML', label: 'NRML' },
              ]}
              width="w-36"
            />
          </FieldRow>
          <FieldRow label="Order type" description="Default execution type.">
            <SelectControl
              value={settings.orderDefaults.orderType}
              onChange={(v) => onFieldUpdate('orderDefaults.orderType', v)}
              options={[
                { value: 'MKT', label: 'Market' },
                { value: 'L', label: 'Limit' },
                { value: 'SL', label: 'SL' },
                { value: 'SL-M', label: 'SL-M' },
              ]}
              width="w-28"
            />
          </FieldRow>
          <FieldRow label="Quantity" description="Default lot/quantity.">
            <NumberControl
              value={settings.orderDefaults.quantity}
              onChange={(v) => onFieldUpdate('orderDefaults.quantity', v)}
              min={1}
              step={1}
              width="w-20"
            />
          </FieldRow>
          <FieldRow label="Exchange" description="Default exchange segment.">
            <SelectControl
              value={settings.orderDefaults.exchange}
              onChange={(v) => onFieldUpdate('orderDefaults.exchange', v)}
              options={[
                { value: 'nse_cm', label: 'NSE' },
                { value: 'bse_cm', label: 'BSE' },
                { value: 'nse_fo', label: 'NSE F&O' },
                { value: 'mcx_fo', label: 'MCX' },
              ]}
              width="w-28"
            />
          </FieldRow>
          <FieldRow label="Validity" description="Order time-in-force.">
            <Segmented
              value={settings.orderDefaults.validity}
              onChange={(v) => onFieldUpdate('orderDefaults.validity', v)}
              options={[
                { value: 'DAY', label: 'DAY' },
                { value: 'IOC', label: 'IOC' },
              ]}
            />
          </FieldRow>
        </Panel>

        <Panel title="Confirmations" description="Require an explicit click before an order leaves the terminal." icon={Shield}>
          <ToggleRow
            label="Confirm BUY orders"
            description="Show a review dialog before submitting a buy."
            checked={settings.confirm.confirmBuy}
            onChange={(v) => onFieldUpdate('confirm.confirmBuy', v)}
          />
          <ToggleRow
            label="Confirm SELL orders"
            description="Show a review dialog before submitting a sell."
            checked={settings.confirm.confirmSell}
            onChange={(v) => onFieldUpdate('confirm.confirmSell', v)}
          />
          <ToggleRow
            label="Confirm square-off"
            description="Ask before closing every open position."
            checked={settings.confirm.confirmSquareOff}
            onChange={(v) => onFieldUpdate('confirm.confirmSquareOff', v)}
          />
          <ToggleRow
            label="Confirm live orders"
            description="Extra guard for real broker accounts. Recommended whenever the terminal is in live mode."
            checked={settings.confirm.confirmLiveOrder}
            onChange={(v) => onFieldUpdate('confirm.confirmLiveOrder', v)}
          />
          {mode !== 'dummy' && !settings.confirm.confirmLiveOrder && (
            <Callout tone="warning" className="mt-2" icon={AlertTriangle} title="Live confirmations are off">
              Orders will be sent to {MODE_META[mode].label} immediately after validation.
            </Callout>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Target" description="Automatic take-profit bracket." icon={Target}>
          <ToggleRow
            label="Enable target"
            description="Attach a take-profit exit to new positions."
            checked={settings.target.enabled}
            onChange={(v) => onFieldUpdate('target.enabled', v)}
          />
          <div className={cn(!settings.target.enabled && 'pointer-events-none opacity-40')}>
            <FieldRow label="Target mode" description="Percent or fixed amount.">
              <Segmented<'PERCENT' | 'FIXED'>
                tone="success"
                value={settings.target.mode === 'FIXED' ? 'FIXED' : 'PERCENT'}
                onChange={(v) => onFieldUpdate('target.mode', v)}
                options={[
                  { value: 'PERCENT', label: '% Percent' },
                  { value: 'FIXED', label: '₹ Fixed' },
                ]}
              />
            </FieldRow>
            <FieldRow label="Target value" description={settings.target.mode === 'PERCENT' ? 'Percentage gain.' : 'Fixed gain per unit.'}>
              <NumberControl
                value={settings.target.value}
                onChange={(v) => onFieldUpdate('target.value', v)}
                min={0}
                step={0.1}
                prefix={settings.target.mode === 'PERCENT' ? undefined : '₹'}
                unit={settings.target.mode === 'PERCENT' ? '%' : undefined}
                width="w-24"
              />
            </FieldRow>
          </div>
        </Panel>

        <Panel title="Stop loss" description="Automatic downside protection." icon={TrendingDown}>
          <ToggleRow
            label="Enable stop loss"
            description="Attach a protective exit to new positions."
            checked={settings.stopLoss.enabled}
            onChange={(v) => onFieldUpdate('stopLoss.enabled', v)}
          />
          <div className={cn(!settings.stopLoss.enabled && 'pointer-events-none opacity-40')}>
            <FieldRow label="Stop-loss mode" description="Percent or fixed amount.">
              <Segmented<'PERCENT' | 'FIXED'>
                tone="danger"
                value={settings.stopLoss.mode === 'FIXED' ? 'FIXED' : 'PERCENT'}
                onChange={(v) => onFieldUpdate('stopLoss.mode', v)}
                options={[
                  { value: 'PERCENT', label: '% Percent' },
                  { value: 'FIXED', label: '₹ Fixed' },
                ]}
              />
            </FieldRow>
            <FieldRow label="Stop-loss value" description={settings.stopLoss.mode === 'PERCENT' ? 'Percentage loss.' : 'Fixed loss per unit.'}>
              <NumberControl
                value={settings.stopLoss.value}
                onChange={(v) => onFieldUpdate('stopLoss.value', v)}
                min={0}
                step={0.1}
                prefix={settings.stopLoss.mode === 'PERCENT' ? undefined : '₹'}
                unit={settings.stopLoss.mode === 'PERCENT' ? '%' : undefined}
                width="w-24"
              />
            </FieldRow>
          </div>
        </Panel>
      </div>

      {settings.target.enabled && settings.stopLoss.enabled && (
        <Callout
          tone={settings.stopLoss.value >= settings.target.value ? 'danger' : 'success'}
          icon={settings.stopLoss.value >= settings.target.value ? AlertTriangle : CheckCircle2}
          title={settings.stopLoss.value >= settings.target.value ? 'Inverted risk/reward' : 'Risk/reward looks healthy'}
        >
          Target {settings.target.value} · Stop loss {settings.stopLoss.value}. Aim for a target that is larger than the
          stop distance so a single win covers more than one loss.
        </Callout>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

const RISK_PRESETS: Array<{
  id: string;
  label: string;
  blurb: string;
  values: Record<string, number | string | boolean>;
  tone: 'success' | 'info' | 'warning' | 'danger';
}> = [
  {
    id: 'conservative',
    label: 'Conservative',
    blurb: 'Small size, tight loss cap, few open positions.',
    tone: 'success',
    values: {
      'risk.maxOrderValue': 100000,
      'risk.maxDailyLoss': 5,
      'risk.maxDailyProfitTarget': 10,
      'risk.maxDailyOrders': 20,
      'risk.maxOpenPositions': 5,
      'risk.maxQtyPerPosition': 900,
      'risk.maxExposure': 200000,
      'risk.maxDemoRisk': 2,
      'risk.maxLiveRisk': 1,
      'target.enabled': true,
      'target.mode': 'PERCENT',
      'target.value': 1.5,
      'stopLoss.enabled': true,
      'stopLoss.mode': 'PERCENT',
      'stopLoss.value': 1,
    },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Default profile with moderate exposure.',
    tone: 'info',
    values: {
      'risk.maxOrderValue': 250000,
      'risk.maxDailyLoss': 10,
      'risk.maxDailyProfitTarget': 20,
      'risk.maxDailyOrders': 40,
      'risk.maxOpenPositions': 10,
      'risk.maxQtyPerPosition': 1800,
      'risk.maxExposure': 500000,
      'risk.maxDemoRisk': 5,
      'risk.maxLiveRisk': 3,
      'target.enabled': true,
      'target.mode': 'PERCENT',
      'target.value': 2,
      'stopLoss.enabled': true,
      'stopLoss.mode': 'PERCENT',
      'stopLoss.value': 1,
    },
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    blurb: 'Larger size and wider daily envelope.',
    tone: 'warning',
    values: {
      'risk.maxOrderValue': 500000,
      'risk.maxDailyLoss': 15,
      'risk.maxDailyProfitTarget': 30,
      'risk.maxDailyOrders': 80,
      'risk.maxOpenPositions': 20,
      'risk.maxQtyPerPosition': 3600,
      'risk.maxExposure': 1000000,
      'risk.maxDemoRisk': 10,
      'risk.maxLiveRisk': 6,
      'target.enabled': true,
      'target.mode': 'PERCENT',
      'target.value': 3,
      'stopLoss.enabled': true,
      'stopLoss.mode': 'PERCENT',
      'stopLoss.value': 1.5,
    },
  },
  {
    id: 'scalper',
    label: 'Scalper',
    blurb: 'High order count, tight brackets, small clips.',
    tone: 'danger',
    values: {
      'risk.maxOrderValue': 150000,
      'risk.maxDailyLoss': 4,
      'risk.maxDailyProfitTarget': 6,
      'risk.maxDailyOrders': 150,
      'risk.maxOpenPositions': 6,
      'risk.maxQtyPerPosition': 1200,
      'risk.maxExposure': 300000,
      'risk.maxDemoRisk': 3,
      'risk.maxLiveRisk': 2,
      'target.enabled': true,
      'target.mode': 'PERCENT',
      'target.value': 0.6,
      'stopLoss.enabled': true,
      'stopLoss.mode': 'PERCENT',
      'stopLoss.value': 0.35,
    },
  },
];

export function RiskSection({
  settings,
  onFieldUpdate,
  onBatchUpdate,
}: {
  settings: TradingSettings;
  onFieldUpdate: FieldUpdater;
  onBatchUpdate: BatchUpdater;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPreset, setConfirmPreset] = useState<(typeof RISK_PRESETS)[number] | null>(null);

  const applyPreset = async () => {
    if (!confirmPreset) return;
    setBusy(confirmPreset.id);
    try {
      await onBatchUpdate(`${confirmPreset.label} risk preset`, confirmPreset.values);
      toast({ title: `${confirmPreset.label} profile applied` });
      setConfirmPreset(null);
    } finally {
      setBusy(null);
    }
  };

  const ratio =
    settings.target.enabled && settings.stopLoss.enabled && settings.stopLoss.value > 0
      ? settings.target.value / settings.stopLoss.value
      : null;

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Capital protection"
        title="Risk"
        description="Hard limits applied before an order is accepted. Presets rewrite the whole profile; individual fields stay editable."
        actions={
          ratio != null ? (
            <Pill tone={ratio >= 1.5 ? 'success' : ratio >= 1 ? 'warning' : 'danger'} dot>
              R:R {ratio.toFixed(2)}
            </Pill>
          ) : undefined
        }
      />

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {RISK_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => setConfirmPreset(preset)}
            disabled={busy !== null}
            className="group rounded-xl border border-border/60 bg-card/60 p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">{preset.label}</span>
              <Pill tone={preset.tone}>{preset.tone === 'danger' ? 'high risk' : preset.tone === 'warning' ? 'elevated' : 'profile'}</Pill>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{preset.blurb}</p>
            <div className="mt-2 flex items-center gap-1 text-[10px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
              <Play className="h-2.5 w-2.5" /> Apply preset
            </div>
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Exposure limits" description="Applied to every new order and position." icon={Gauge}>
          <FieldRow label="Max order value" description="Largest notional value accepted for a single order.">
            <NumberControl value={settings.risk.maxOrderValue} onChange={(v) => onFieldUpdate('risk.maxOrderValue', v)} min={0} step={1000} prefix="₹" width="w-28" />
          </FieldRow>
          <FieldRow label="Max daily loss" description="Stop accepting orders after this loss for the day.">
            <NumberControl value={settings.risk.maxDailyLoss} onChange={(v) => onFieldUpdate('risk.maxDailyLoss', v)} min={0} step={500} prefix="₹" width="w-28" />
          </FieldRow>
          <FieldRow label="Daily profit target" description="Optional target that stops trading for the day.">
            <NumberControl value={settings.risk.maxDailyProfitTarget} onChange={(v) => onFieldUpdate('risk.maxDailyProfitTarget', v)} min={0} step={500} prefix="₹" width="w-28" />
          </FieldRow>
          <FieldRow label="Max daily orders" description="Order count ceiling for the session.">
            <NumberControl value={settings.risk.maxDailyOrders} onChange={(v) => onFieldUpdate('risk.maxDailyOrders', v)} min={0} step={1} width="w-20" />
          </FieldRow>
          <FieldRow label="Max open positions" description="Concurrent open positions across the account.">
            <NumberControl value={settings.risk.maxOpenPositions} onChange={(v) => onFieldUpdate('risk.maxOpenPositions', v)} min={0} step={1} width="w-20" />
          </FieldRow>
        </Panel>

        <Panel title="Position & mode limits" description="Per-position and per-mode guard rails." icon={ShieldAlert}>
          <FieldRow label="Max quantity / position" description="Largest quantity allowed in one instrument.">
            <NumberControl value={settings.risk.maxQtyPerPosition} onChange={(v) => onFieldUpdate('risk.maxQtyPerPosition', v)} min={0} step={1} width="w-24" />
          </FieldRow>
          <FieldRow label="Max exposure" description="Total notional exposure across open positions.">
            <NumberControl value={settings.risk.maxExposure} onChange={(v) => onFieldUpdate('risk.maxExposure', v)} min={0} step={10000} prefix="₹" width="w-28" />
          </FieldRow>
          <FieldRow label="Dummy risk budget" description="Maximum risk allowed in the virtual account.">
            <NumberControl value={settings.risk.maxDemoRisk} onChange={(v) => onFieldUpdate('risk.maxDemoRisk', v)} min={0} step={500} prefix="₹" width="w-28" />
          </FieldRow>
          <FieldRow label="Live risk budget" description="Maximum risk allowed on a real broker account.">
            <NumberControl value={settings.risk.maxLiveRisk} onChange={(v) => onFieldUpdate('risk.maxLiveRisk', v)} min={0} step={500} prefix="₹" width="w-28" />
          </FieldRow>
          {settings.risk.maxLiveRisk > settings.risk.maxDemoRisk && (
            <Callout tone="warning" className="mt-2" icon={AlertTriangle} title="Live budget exceeds dummy budget">
              Practice risk is smaller than real-money risk. Consider lowering the live budget until the strategy is proven.
            </Callout>
          )}
          {settings.risk.maxDailyProfitTarget > 0 && settings.risk.maxDailyProfitTarget < settings.risk.maxDailyLoss && (
            <Callout tone="warning" className="mt-2" icon={AlertTriangle} title="Asymmetric daily envelope">
              The stop is larger than the target. A losing day will cost more than a winning day earns.
            </Callout>
          )}
        </Panel>
      </div>

      <Callout tone="neutral" icon={SlidersHorizontal}>
        Risk values are enforced by the backend order engine, not only by this UI. Changing them here also updates
        the per-mode profile for the active terminal.
      </Callout>

      <Dialog open={confirmPreset !== null} onOpenChange={(open) => !open && setConfirmPreset(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Apply {confirmPreset?.label} profile?</DialogTitle>
            <DialogDescription className="text-xs">
              This rewrites order size, daily caps, open-position limits, target and stop-loss for the active mode.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-[11px] text-muted-foreground">
            <div>Max order ₹{Number(confirmPreset?.values['risk.maxOrderValue'] ?? 0).toLocaleString('en-IN')}</div>
            <div>Daily loss ₹{Number(confirmPreset?.values['risk.maxDailyLoss'] ?? 0).toLocaleString('en-IN')}</div>
            <div>
              Target {String(confirmPreset?.values['target.value'] ?? '')}% · Stop {String(confirmPreset?.values['stopLoss.value'] ?? '')}%
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmPreset(null)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button onClick={applyPreset} disabled={busy !== null}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Apply profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule & automation
// ---------------------------------------------------------------------------

const SCHEDULE_ROWS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'sched_login_time', label: 'Broker login', hint: 'Session start' },
  { key: 'sched_ws_start_time', label: 'WebSocket connect', hint: 'Feed comes online' },
  { key: 'sched_tick_collection_start_time', label: 'Tick collection', hint: 'Ticks start persisting' },
  { key: 'sched_pre_market_start_time', label: 'Pre-market', hint: 'Phase begins' },
  { key: 'sched_limit_order_start_time', label: 'Limit-order window', hint: 'Limit orders allowed' },
  { key: 'sched_equilibrium_start_time', label: 'Equilibrium', hint: 'Equilibrium phase' },
  { key: 'sched_buffer_start_time', label: 'Buffer', hint: 'Pre-open buffer' },
  { key: 'sched_feed_start_time', label: 'Live feed', hint: 'Market open' },
  { key: 'sched_feed_stop_time', label: 'Feed stop', hint: 'Broker feed stops' },
  { key: 'sched_ws_stop_time', label: 'WebSocket stop', hint: 'Feed disconnected' },
  { key: 'sched_logout_time', label: 'Broker logout', hint: 'Session end' },
];

function timeMinutes(value: any): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function ScheduleSection({
  mode,
  settings,
  schemaMap,
  onFieldUpdate,
  onBackendWrite,
  runtime,
}: {
  mode: TradingMode;
  settings: TradingSettings;
  schemaMap: SchemaMap;
  onFieldUpdate: FieldUpdater;
  onBackendWrite: BackendWriter;
  runtime: any;
}) {
  const rows = SCHEDULE_ROWS.map((row) => ({ ...row, schema: schemaMap.get(row.key) })).filter((row) => row.schema);
  const withTimes = rows
    .map((row) => ({ ...row, minutes: timeMinutes(row.schema?.value) }))
    .filter((row) => row.minutes != null)
    .sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
  const snapshot = runtime?.snapshot ?? {};
  const squareOffEnabled = Boolean(schemaMap.get('sched_square_off_enabled')?.value);
  const squareOffRow = schemaMap.get('sched_square_off_enabled');

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Automation"
        title="Schedule & Square-off"
        description="The scheduler is the single source of truth for login, feed and square-off timings. Changes propagate to the live runtime immediately."
        actions={
          <Pill tone={schemaMap.get('sched_enabled')?.value ? 'success' : 'warning'} dot>
            {schemaMap.get('sched_enabled')?.value ? 'scheduler enabled' : 'scheduler paused'}
          </Pill>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.05fr_1fr]">
        <Panel
          title="Scheduler timeline"
          description="Asia/Kolkata · authoritative sched_* keys."
          icon={Timer}
          actions={<BackendFieldInline row={schemaMap.get('sched_enabled')} onCommit={onBackendWrite} />}
        >
          {withTimes.length === 0 ? (
            <Callout tone="warning" title="Scheduler catalogue unavailable">
              The backend did not return the sched_* keys. Refresh the catalogue or check the Python service.
            </Callout>
          ) : (
            <ol className="relative ml-1 space-y-0 border-l border-border/50 pl-4">
              {withTimes.map((row) => (
                <li key={row.key} className="relative pb-3 last:pb-0">
                  <span className="absolute -left-[22px] top-1.5 h-2 w-2 rounded-full border border-background bg-primary/70" />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-semibold text-primary">
                          {String(row.schema?.value ?? '—')}
                        </span>
                        <span className="text-[11px] font-medium">{row.label}</span>
                      </div>
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">{row.hint}</div>
                    </div>
                    <BackendFieldInline row={row.schema} onCommit={onBackendWrite} compact />
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-3 border-t border-border/40 pt-2">
            <BackendFieldInline row={schemaMap.get('sched_market_timezone')} onCommit={onBackendWrite} />
            <BackendFieldInline row={schemaMap.get('sched_trading_day_behavior')} onCommit={onBackendWrite} />
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel title="Square-off" description="Close intraday positions before the broker window ends." icon={Clock}>
            <ToggleRow
              label="Enable auto square-off"
              description="The engine closes square-off-eligible positions at the configured time."
              checked={settings.squareOff.enabled}
              onChange={(v) => onFieldUpdate('squareOff.enabled', v)}
            />
            <FieldRow label="Square-off time" description="Linked to the authoritative sched_square_off_time key.">
              <Input
                type="time"
                value={settings.squareOff.time}
                onChange={(e) => onFieldUpdate('squareOff.time', e.target.value)}
                className="h-8 w-28 font-mono text-xs"
              />
            </FieldRow>
            <FieldRow label="Apply to" description="Products included in the automatic square-off.">
              <SelectControl
                value={settings.squareOff.applyTo}
                onChange={(v) => onFieldUpdate('squareOff.applyTo', v)}
                options={[
                  { value: 'MIS', label: 'MIS only' },
                  { value: 'CNC', label: 'CNC only' },
                  { value: 'NRML', label: 'NRML only' },
                  { value: 'ALL', label: 'All products' },
                ]}
                width="w-32"
              />
            </FieldRow>
            <FieldRow label="Scheduler trigger" description="The scheduler also owns a square-off enable flag.">
              <div className="flex items-center gap-2">
                {squareOffRow ? (
                  <BackendFieldInline row={squareOffRow} onCommit={onBackendWrite} compact />
                ) : (
                  <span className="text-[10px] text-muted-foreground">unavailable</span>
                )}
                <Pill tone={squareOffEnabled ? 'success' : 'warning'} dot>
                  {squareOffEnabled ? 'armed' : 'disarmed'}
                </Pill>
              </div>
            </FieldRow>
            {!settings.squareOff.enabled && mode !== 'dummy' && (
              <Callout tone="warning" className="mt-2" icon={AlertTriangle} title="Live square-off is off">
                Positions can carry overnight risk if they are not closed manually.
              </Callout>
            )}
          </Panel>

          <Panel title="Runtime state" description="What the scheduler and feed are doing right now." icon={Activity}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {[
                ['scheduler', snapshot.scheduler_running ?? snapshot.scheduler],
                ['websocket', snapshot.ws_connected ?? snapshot.websocket],
                ['market', snapshot.market_phase ?? snapshot.phase],
                ['ticks', snapshot.tick_collection ?? snapshot.ticks],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex items-center justify-between gap-2 border-b border-border/30 pb-1">
                  <dt className="text-[10px] capitalize text-muted-foreground">{String(label)}</dt>
                  <dd className="max-w-[110px] truncate font-mono text-[10px] font-semibold">{formatValue(value)}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-2 text-[10px] text-muted-foreground">
              {Object.keys(snapshot).length === 0
                ? 'No runtime snapshot reported.'
                : `${Object.keys(snapshot).length} runtime fields reported by the backend.`}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export function MarketDataSection({
  settings,
  schemaMap,
  onFieldUpdate,
  onBackendWrite,
  onOpenCatalog,
}: {
  settings: TradingSettings;
  schemaMap: SchemaMap;
  onFieldUpdate: FieldUpdater;
  onBackendWrite: BackendWriter;
  onOpenCatalog: (category?: string) => void;
}) {
  const watchKeys = [
    'mwr_ranking_interval_seconds',
    'mwr_stale_threshold_seconds',
    'mwr_tick_retention_days',
    'mwr_persist_ticks',
    'mwr_persist_candles',
    'mwr_page_size',
  ];

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Quotes"
        title="Market Data"
        description="Display density, refresh cadence and backend market-watch engine tuning."
        actions={<InlineLink onClick={() => onOpenCatalog('market_watch')}>Full market-watch catalogue</InlineLink>}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Quote display" description="Fields shown in watchlists and depth panels." icon={LineChart}>
          <FieldRow label="Refresh interval" description="Frontend quote polling cadence.">
            <SelectControl
              value={settings.marketData.refreshInterval}
              onChange={(v) => onFieldUpdate('marketData.refreshInterval', v)}
              options={[
                { value: '500', label: '500 ms' },
                { value: '1000', label: '1 second' },
                { value: '2000', label: '2 seconds' },
                { value: '5000', label: '5 seconds' },
              ]}
              width="w-32"
            />
          </FieldRow>
          <div className="grid gap-x-8 sm:grid-cols-2">
            <ToggleRow label="LTP" checked={settings.marketData.showLTP} onChange={(v) => onFieldUpdate('marketData.showLTP', v)} />
            <ToggleRow label="Bid" checked={settings.marketData.showBid} onChange={(v) => onFieldUpdate('marketData.showBid', v)} />
            <ToggleRow label="Ask" checked={settings.marketData.showAsk} onChange={(v) => onFieldUpdate('marketData.showAsk', v)} />
            <ToggleRow label="Volume" checked={settings.marketData.showVolume} onChange={(v) => onFieldUpdate('marketData.showVolume', v)} />
            <ToggleRow label="OHLC" checked={settings.marketData.showOHLC} onChange={(v) => onFieldUpdate('marketData.showOHLC', v)} />
            <ToggleRow label="Circuit" checked={settings.marketData.showCircuit} onChange={(v) => onFieldUpdate('marketData.showCircuit', v)} />
            <ToggleRow label="Average price" checked={settings.marketData.showAvgPrice} onChange={(v) => onFieldUpdate('marketData.showAvgPrice', v)} />
          </div>
        </Panel>

        <Panel title="Market-watch engine" description="Live backend knobs for ranking and persistence." icon={Radar}>
          {watchKeys.map((key) => (
            <BackendField key={key} row={schemaMap.get(key)} onCommit={onBackendWrite} />
          ))}
          {watchKeys.every((key) => !schemaMap.get(key)) && (
            <Callout tone="warning" title="Market-watch keys unavailable">
              Refresh the system catalogue to load the market-watch settings.
            </Callout>
          )}
        </Panel>
      </div>

      <Panel title="WebSocket feed" description="Connection health and reconnect policy for the tick feed." icon={Wifi}>
        <div className="grid gap-x-8 sm:grid-cols-2">
          <BackendField row={schemaMap.get('ws_enabled')} onCommit={onBackendWrite} />
          <BackendField row={schemaMap.get('ws_auto_reconnect')} onCommit={onBackendWrite} />
          <BackendField row={schemaMap.get('ws_max_reconnect_attempts')} onCommit={onBackendWrite} />
          <BackendField row={schemaMap.get('ws_reconnect_delay_ms')} onCommit={onBackendWrite} />
          <BackendField row={schemaMap.get('ws_heartbeat')} onCommit={onBackendWrite} />
          <BackendField row={schemaMap.get('ws_tick_persistence')} onCommit={onBackendWrite} />
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const NOTIF_EVENTS: Array<{ key: keyof NotificationEventSettings; label: string }> = [
  { key: 'orderPlaced', label: 'Order placed' },
  { key: 'orderCompleted', label: 'Order completed' },
  { key: 'orderRejected', label: 'Order rejected' },
  { key: 'orderCancelled', label: 'Order cancelled' },
  { key: 'targetReached', label: 'Target reached' },
  { key: 'stopLossTriggered', label: 'Stop loss hit' },
  { key: 'squareOffExecuted', label: 'Square-off executed' },
  { key: 'marginWarning', label: 'Margin warning' },
  { key: 'riskLimitReached', label: 'Risk limit reached' },
  { key: 'brokerDisconnected', label: 'Broker disconnected' },
  { key: 'brokerSessionExpired', label: 'Session expired' },
  { key: 'marketOpen', label: 'Market open' },
  { key: 'marketClosed', label: 'Market closed' },
];

export function NotificationsSection({
  settings,
  schemaMap,
  onFieldUpdate,
  onBackendWrite,
}: {
  settings: TradingSettings;
  schemaMap: SchemaMap;
  onFieldUpdate: FieldUpdater;
  onBackendWrite: BackendWriter;
}) {
  const { toast } = useToast();
  const [push, setPush] = useState<PushStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const supported = isPushNotificationSupported();

  const refreshPush = () => {
    if (!supported) return;
    fetchPushStatus()
      .then(setPush)
      .catch(() => setPush(null));
  };

  useEffect(() => {
    refreshPush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enable = async () => {
    setPushBusy(true);
    try {
      const res = await enablePush('trading-pwa');
      if (!res.ok) {
        toast({ title: 'Push could not be enabled', description: res.reason, variant: 'destructive' });
      } else {
        toast({ title: 'Push notifications enabled' });
      }
      refreshPush();
    } finally {
      setPushBusy(false);
    }
  };

  const disable = async () => {
    setPushBusy(true);
    try {
      await disablePush();
      toast({ title: 'Push notifications disabled' });
      refreshPush();
    } finally {
      setPushBusy(false);
    }
  };

  const test = async () => {
    setSendingTest(true);
    try {
      const res = await sendTestPush();
      toast({ title: res.ok ? 'Test push sent' : 'Test push failed', description: `${res.sent} device(s).` });
    } catch (err) {
      toast({
        title: 'Test push failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setSendingTest(false);
    }
  };

  const enabledEvents = NOTIF_EVENTS.filter((event) => settings.notifications[event.key]).length;

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Alerts"
        title="Notifications & Sound"
        description="Choose which trading events produce an alert and where that alert is delivered."
        actions={<Pill tone="info">{enabledEvents}/{NOTIF_EVENTS.length} events on</Pill>}
      />

      <Panel
        title="Delivery channels"
        description="Every enabled channel receives the events selected below."
        icon={BellRing}
      >
        <div className="grid gap-x-8 sm:grid-cols-3">
          <ToggleRow
            label="In-app feed"
            description="Notification centre."
            checked={settings.notificationChannels.inApp}
            onChange={(v) => onFieldUpdate('notificationChannels.inApp', v)}
          />
          <ToggleRow
            label="Browser"
            description="Desktop popups."
            checked={settings.notificationChannels.browser}
            onChange={(v) => onFieldUpdate('notificationChannels.browser', v)}
          />
          <ToggleRow
            label="Sound"
            description="Audible cue."
            checked={settings.notificationChannels.sound}
            onChange={(v) => onFieldUpdate('notificationChannels.sound', v)}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
          <div>
            <div className="text-xs font-medium">Browser push (PWA)</div>
            <div className="text-[10px] text-muted-foreground">
              {!supported
                ? 'This browser does not support push notifications.'
                : push?.enabled
                  ? `${push.subscriptions} registered device${push.subscriptions === 1 ? '' : 's'}.`
                  : 'Not registered for push delivery.'}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {push?.enabled && (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={test} disabled={sendingTest}>
                {sendingTest ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <BellRing className="mr-1 h-3 w-3" />}
                Send test
              </Button>
            )}
            <Button
              size="sm"
              variant={push?.enabled ? 'outline' : 'default'}
              className="h-7 text-[11px]"
              onClick={push?.enabled ? disable : enable}
              disabled={!supported || pushBusy}
            >
              {pushBusy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {push?.enabled ? 'Disable push' : 'Enable push'}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="Event types" description="Turn individual trading events on or off." icon={BellRing}>
        <div className="grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
          {NOTIF_EVENTS.map((event) => (
            <ToggleRow
              key={event.key}
              label={event.label}
              checked={settings.notifications[event.key]}
              onChange={(v) => onFieldUpdate(`notifications.${event.key}`, v)}
            />
          ))}
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Sound" description="Volume and event-specific cues." icon={Volume2}>
          <ToggleRow
            label="Enable sound"
            description="Master switch for all audible cues."
            checked={settings.sound.enabled}
            onChange={(v) => onFieldUpdate('sound.enabled', v)}
          />
          <FieldRow label="Volume" description="Playback volume for in-terminal cues.">
            <div className="flex w-44 items-center gap-2">
              <Slider
                value={[settings.sound.volume]}
                min={0}
                max={100}
                step={5}
                onValueChange={([v]) => onFieldUpdate('sound.volume', v)}
                disabled={!settings.sound.enabled}
              />
              <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">{settings.sound.volume}%</span>
            </div>
          </FieldRow>
          <div className={cn('grid gap-x-8 sm:grid-cols-2', !settings.sound.enabled && 'pointer-events-none opacity-40')}>
            <ToggleRow label="Order success" checked={settings.sound.orderSuccess} onChange={(v) => onFieldUpdate('sound.orderSuccess', v)} />
            <ToggleRow label="Order rejection" checked={settings.sound.orderRejection} onChange={(v) => onFieldUpdate('sound.orderRejection', v)} />
            <ToggleRow label="Target" checked={settings.sound.target} onChange={(v) => onFieldUpdate('sound.target', v)} />
            <ToggleRow label="Stop loss" checked={settings.sound.stopLoss} onChange={(v) => onFieldUpdate('sound.stopLoss', v)} />
            <ToggleRow label="Square-off" checked={settings.sound.squareOff} onChange={(v) => onFieldUpdate('sound.squareOff', v)} />
          </div>
        </Panel>

        <Panel title="Backend alert bridge" description="Mirror the selected events into the backend alert ledger." icon={Zap}>
          {[
            'notif_order_placed',
            'notif_order_completed',
            'notif_order_rejected',
            'notif_target_reached',
            'notif_sl_triggered',
            'notif_margin_warning',
          ].map((key) => (
            <BackendField key={key} row={schemaMap.get(key)} onCommit={onBackendWrite} />
          ))}
          <Callout tone="neutral" icon={Zap}>
            The backend alert bridge is configured in the system catalogue. Keys here mirror the UI toggles so server-side
            alerting stays consistent with in-app delivery.
          </Callout>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

export function AppearanceSection({
  mode,
  settings,
  onFieldUpdate,
}: {
  mode: TradingMode;
  settings: TradingSettings;
  onFieldUpdate: FieldUpdater;
}) {
  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Interface"
        title="Appearance"
        description="Theme scope, density and number formatting. The Theme Studio writes scoped design tokens that apply instantly."
        actions={<Pill tone="info">{mode === 'dummy' ? 'dummy scope' : mode === 'shoonya' ? 'shoonya scope' : 'kotak scope'}</Pill>}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Display" description="Terminal-wide display preferences." icon={Monitor}>
          <FieldRow label="Theme" description="Base colour mode. The Theme Studio below applies the detailed tokens.">
            <SelectControl
              value={settings.display.theme}
              onChange={(v) => onFieldUpdate('display.theme', v)}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
                { value: 'system', label: 'System' },
              ]}
              width="w-32"
            />
          </FieldRow>
          <FieldRow label="Density" description="Spacing used by tables and panels.">
            <Segmented
              value={settings.display.density}
              onChange={(v) => onFieldUpdate('display.density', v)}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'comfortable', label: 'Comfort' },
                { value: 'spacious', label: 'Spacious' },
              ]}
            />
          </FieldRow>
          <FieldRow label="Number format" description="Grouping style for prices and amounts.">
            <Segmented
              value={settings.display.numberFormat}
              onChange={(v) => onFieldUpdate('display.numberFormat', v)}
              options={[
                { value: 'indian', label: 'Indian' },
                { value: 'international', label: 'International' },
              ]}
            />
          </FieldRow>
          <FieldRow label="Decimal places" description="Precision for price columns.">
            <NumberControl
              value={settings.display.decimalPlaces}
              onChange={(v) => onFieldUpdate('display.decimalPlaces', v)}
              min={0}
              max={4}
              step={1}
              width="w-16"
            />
          </FieldRow>
        </Panel>

        <Panel title="Live preview" description="A compact sample of the current formatting." icon={Palette}>
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="flex items-center justify-between border-b border-border/40 pb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Instrument</span>
              <span>LTP</span>
              <span>Change</span>
            </div>
            {[
              ['NIFTY 50', 24185.35, 0.82],
              ['BANKNIFTY', 52840.1, -0.44],
              ['RELIANCE', 2941.5, 1.16],
            ].map(([symbol, price, change]) => (
              <div key={String(symbol)} className="flex items-center justify-between py-1 text-[11px]">
                <span className="font-medium">{symbol}</span>
                <span className="font-mono tabular-nums">
                  {Number(price).toLocaleString(settings.display.numberFormat === 'indian' ? 'en-IN' : 'en-US', {
                    minimumFractionDigits: settings.display.decimalPlaces,
                    maximumFractionDigits: settings.display.decimalPlaces,
                  })}
                </span>
                <span className={cn('font-mono tabular-nums', Number(change) >= 0 ? 'text-success' : 'text-destructive')}>
                  {Number(change) >= 0 ? '+' : ''}
                  {Number(change).toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
          <Callout tone="neutral" icon={Sparkles} className="mt-3">
            Density changes the spacing of dense tables. Theme changes are scoped per terminal so Kotak, Shoonya and
            Dummy can look different.
          </Callout>
        </Panel>
      </div>

      <ThemeStudio scope={{ appId: 'trading', scope: mode, label: `${MODE_META[mode].label} Terminal` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

export function BrokerSection({
  mode,
  schemaMap,
  systemStatus,
  terminalState,
  onBackendWrite,
}: {
  mode: TradingMode;
  schemaMap: SchemaMap;
  systemStatus: any;
  terminalState: any;
  onBackendWrite: BackendWriter;
}) {
  const meta = MODE_META[mode];
  const loggedIn = Boolean(systemStatus?.pythonStatus?.logged_in);
  const shoonyaOk = Boolean(terminalState?.ok && terminalState?.isLoggedIn);
  const connected = mode === 'dummy' ? true : mode === 'shoonya' ? shoonyaOk : loggedIn;

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Connectivity"
        title="Broker"
        description="Read-only session facts plus the few backend switches that control which feed the engine consumes."
        actions={
          <Pill tone={connected ? 'success' : 'danger'} dot>
            {connected ? 'session active' : 'no session'}
          </Pill>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Session" description="Reported by the backend broker adapter." icon={Server}>
          <FieldRow label="Terminal" description="Active terminal identity.">
            <span className="font-mono text-xs">{terminalState?.terminal ?? meta.label}</span>
          </FieldRow>
          <FieldRow label="Broker" description="Broker adapter bound to the terminal.">
            <span className="font-mono text-xs">{terminalState?.broker ?? '—'}</span>
          </FieldRow>
          <FieldRow label="Mode" description="Backend mode flag.">
            <Pill tone={mode === 'dummy' ? 'purple' : 'success'}>{terminalState?.mode ?? mode}</Pill>
          </FieldRow>
          <FieldRow label="Connected" description="Live broker session state.">
            <Pill tone={connected ? 'success' : 'danger'} dot>
              {connected ? 'CONNECTED' : 'DISCONNECTED'}
            </Pill>
          </FieldRow>
          <FieldRow label="Available margin" description="Last value reported by the broker.">
            <span className="font-mono text-xs">
              ₹{Number(schemaMap.get('broker_available_margin')?.value ?? 0).toLocaleString('en-IN')}
            </span>
          </FieldRow>
          <FieldRow label="Last sync" description="Most recent broker state refresh.">
            <span className="text-[11px] text-muted-foreground">{formatRelative(schemaMap.get('broker_last_sync')?.value)}</span>
          </FieldRow>
        </Panel>

        <Panel title="Feed & routing" description="Changes apply to the live engine." icon={Wifi}>
          <BackendField row={schemaMap.get('ws_feed_broker')} onCommit={onBackendWrite} />
          <BackendField row={schemaMap.get('ws_enabled')} onCommit={onBackendWrite} />
          <BackendField row={schemaMap.get('ws_auto_reconnect')} onCommit={onBackendWrite} />
          <BackendField row={schemaMap.get('python_service_url')} onCommit={onBackendWrite} />
          <Callout tone={mode === 'dummy' ? 'purple' : 'info'} className="mt-2" icon={mode === 'dummy' ? Coins : Wifi}>
            {mode === 'dummy'
              ? 'Dummy mode still consumes the real feed; orders are simulated locally.'
              : `${meta.label} uses the live broker session. Verify the feed source before the market opens.`}
          </Callout>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

export function AdvancedSection({
  settings,
  schemaMap,
  onFieldUpdate,
  onBackendWrite,
  onOpenCatalog,
  runtime,
}: {
  settings: TradingSettings;
  schemaMap: SchemaMap;
  onFieldUpdate: FieldUpdater;
  onBackendWrite: BackendWriter;
  onOpenCatalog: (category?: string) => void;
  runtime: any;
}) {
  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Engine"
        title="Advanced"
        description="Timeouts, retries and latency-sensitive polling intervals. Defaults are safe; change them only with a reason."
        actions={<InlineLink onClick={() => onOpenCatalog('engine')}>Engine catalogue</InlineLink>}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Network" description="How the terminal talks to the backend and broker adapters." icon={Zap}>
          <FieldRow label="Order API timeout" description="Maximum wait for an order acknowledgement.">
            <NumberControl value={settings.advanced.orderApiTimeout} onChange={(v) => onFieldUpdate('advanced.orderApiTimeout', v)} min={3} max={120} step={1} unit="s" width="w-20" />
          </FieldRow>
          <FieldRow label="Quote timeout" description="Maximum wait for a quote request.">
            <NumberControl value={settings.advanced.quoteTimeout} onChange={(v) => onFieldUpdate('advanced.quoteTimeout', v)} min={1} max={60} step={1} unit="s" width="w-20" />
          </FieldRow>
          <FieldRow label="Retry count" description="Attempts before surfacing an order error.">
            <NumberControl value={settings.advanced.retryCount} onChange={(v) => onFieldUpdate('advanced.retryCount', v)} min={0} max={10} step={1} width="w-20" />
          </FieldRow>
          <FieldRow label="Retry delay" description="Backoff between attempts.">
            <NumberControl value={settings.advanced.retryDelay} onChange={(v) => onFieldUpdate('advanced.retryDelay', v)} min={100} max={30000} step={100} unit="ms" width="w-24" />
          </FieldRow>
          <Callout tone="warning" className="mt-2" icon={AlertTriangle} title="Latency vs. certainty">
            Very short timeouts can produce false failures on a slow broker response. Keep order timeouts above 10 seconds
            on mobile networks.
          </Callout>
        </Panel>

        <Panel title="Polling" description="Background refresh cadence for order and position views." icon={RefreshCw}>
          <FieldRow label="Order polling" description="How often open orders are refreshed.">
            <NumberControl value={settings.advanced.orderPollingInterval} onChange={(v) => onFieldUpdate('advanced.orderPollingInterval', v)} min={1000} max={60000} step={500} unit="ms" width="w-24" />
          </FieldRow>
          <FieldRow label="Position refresh" description="Open-position refresh cadence.">
            <NumberControl value={settings.advanced.positionRefreshInterval} onChange={(v) => onFieldUpdate('advanced.positionRefreshInterval', v)} min={1000} max={60000} step={500} unit="ms" width="w-24" />
          </FieldRow>
          <FieldRow label="History refresh" description="Trade history refresh cadence.">
            <NumberControl value={settings.advanced.historyRefreshInterval} onChange={(v) => onFieldUpdate('advanced.historyRefreshInterval', v)} min={1000} max={300000} step={1000} unit="ms" width="w-24" />
          </FieldRow>
          <div className="border-t border-border/40 pt-2">
            <BackendField row={schemaMap.get('log_level')} onCommit={onBackendWrite} />
            <BackendField row={schemaMap.get('log_retention_days')} onCommit={onBackendWrite} />
          </div>
        </Panel>
      </div>

      <Panel title="Runtime snapshot" description="Raw live-runtime values reported by the backend." icon={Activity}>
        {runtime?.snapshot && Object.keys(runtime.snapshot).length > 0 ? (
          <pre className="max-h-64 overflow-auto rounded-lg border border-border/50 bg-muted/20 p-3 font-mono text-[10px] leading-5 text-muted-foreground">
            {JSON.stringify(runtime.snapshot, null, 2)}
          </pre>
        ) : (
          <Callout tone="neutral">No runtime snapshot is available.</Callout>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backend field primitives
// ---------------------------------------------------------------------------

export function BackendField({
  row,
  onCommit,
  label,
  description,
}: {
  row: SettingSchemaRow | undefined;
  onCommit: BackendWriter;
  label?: string;
  description?: string;
}) {
  const [draft, setDraft] = useState<string>(row ? String(row.value ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(row ? String(row.value ?? '') : '');
  }, [row, row?.value]);

  if (!row) return null;

  const commit = async (value: any) => {
    if (valuesEqual(value, row.value)) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(row.key, value);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Write failed');
    } finally {
      setBusy(false);
    }
  };

  const control = () => {
    if (row.sensitive) return <span className="font-mono text-xs text-muted-foreground">••••••</span>;
    if (row.type === 'boolean') {
      return (
        <div className="flex items-center gap-2">
          <Pill tone={row.value ? 'success' : 'neutral'}>{row.value ? 'On' : 'Off'}</Pill>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(row.value)}
            disabled={busy}
            onClick={() => void commit(!row.value)}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
              row.value ? 'bg-primary' : 'bg-input',
              busy && 'opacity-60',
            )}
          >
            <span
              className={cn(
                'block h-5 w-5 rounded-full bg-background shadow transition-transform',
                row.value ? 'translate-x-5' : 'translate-x-0',
              )}
            />
          </button>
        </div>
      );
    }
    if (row.type === 'select' && row.options && row.options.length > 0) {
      return (
        <SelectControl
          value={String(row.value ?? '')}
          onChange={(v) => void commit(v)}
          options={row.options.map((option) => ({ value: String(option), label: String(option) }))}
          width="w-40"
          disabled={busy}
        />
      );
    }
    if (row.type === 'number') {
      return (
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={draft}
            min={row.min ?? undefined}
            max={row.max ?? undefined}
            step={Number.isInteger(row.default) ? 1 : 0.1}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit(Number(draft))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(Number(draft));
            }}
            className="h-8 w-24 text-center font-mono text-xs"
          />
          {row.unit && <span className="text-[10px] text-muted-foreground">{row.unit}</span>}
        </div>
      );
    }
    const isTime = /HH:MM/i.test(row.description);
    return (
      <Input
        type={isTime ? 'time' : 'text'}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit(draft);
        }}
        className={cn('h-8 text-xs', isTime ? 'w-28 font-mono' : 'w-52')}
      />
    );
  };

  return (
    <FieldRow
      label={label ?? row.description}
      hint={row.live ? 'live' : undefined}
      description={description ?? `${row.key}${row.min != null || row.max != null ? ` · ${row.min ?? '−∞'}…${row.max ?? '∞'}` : ''}`}
      saved={saved}
      error={error}
    >
      <div className="flex items-center gap-1.5">
        {control()}
        {busy ? <Loader2 className="h-3 w-3 animate-spin text-info" /> : null}
      </div>
    </FieldRow>
  );
}

/** Compact inline variant used inside dense rows (timeline, account summary). */
export function BackendFieldInline({
  row,
  onCommit,
  compact = false,
}: {
  row: SettingSchemaRow | undefined;
  onCommit: BackendWriter;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!row) return null;

  const commit = async (value: any) => {
    setBusy(true);
    setError(null);
    try {
      await onCommit(row.key, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Write failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {row.type === 'boolean' ? (
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(row.value)}
          disabled={busy}
          onClick={() => void commit(!row.value)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
            row.value ? 'bg-primary' : 'bg-input',
            busy && 'opacity-60',
          )}
        >
          <span
            className={cn(
              'block h-4 w-4 rounded-full bg-background shadow transition-transform',
              row.value ? 'translate-x-4' : 'translate-x-0',
            )}
          />
        </button>
      ) : row.type === 'select' && row.options ? (
        <SelectControl
          value={String(row.value ?? '')}
          onChange={(v) => void commit(v)}
          options={row.options.map((option) => ({ value: String(option), label: String(option) }))}
          width={compact ? 'w-28' : 'w-36'}
          disabled={busy}
        />
      ) : (
        <Input
          type={/HH:MM/i.test(row.description) ? 'time' : 'text'}
          defaultValue={String(row.value ?? '')}
          disabled={busy}
          onBlur={(e) => void commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit((e.target as HTMLInputElement).value);
          }}
          className={cn('h-7 text-[11px]', compact ? 'w-24 font-mono' : 'w-44')}
        />
      )}
      {busy && <Loader2 className="h-3 w-3 animate-spin text-info" />}
      {error && <span className="text-[9px] text-destructive">{error}</span>}
    </div>
  );
}
