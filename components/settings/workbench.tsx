'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BellRing,
  CalendarClock,
  CandlestickChart,
  Coins,
  Database,
  History,
  LayoutDashboard,
  LineChart,
  Lock,
  Palette,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  SlidersHorizontal,
  UserRound,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  getDemoAccount,
  getSettingsAudit,
  getSettingsHealth,
  getSettingsRuntime,
  getSettingsSchema,
  getSystemStatus,
  patchSettings,
  type SettingSchemaRow,
  type SettingsAuditEntry,
  type SettingsHealth,
} from '@/lib/api';
import {
  getSettingsStore,
  useTradingMode,
  useTradingSettings,
  type TradingMode,
} from '@/lib/settings-store';
import { getTerminalState, type TerminalState } from '@/lib/terminal-service';
import { cn } from '@/lib/utils';
import { BackupPanel } from './backup-panel';
import { DummyPanel } from './dummy-panel';
import {
  AccountSection,
  AdvancedSection,
  AppearanceSection,
  BrokerSection,
  MarketDataSection,
  NotificationsSection,
  OverviewSection,
  RiskSection,
  ScheduleSection,
  TradingSection,
} from './sections';
import { SecurityPanel } from './security-panel';
import {
  Callout,
  Pill,
  SaveDot,
  SearchField,
  formatRelative,
} from './settings-primitives';
import { SystemCatalog } from './system-catalog';

type SectionKey =
  | 'overview'
  | 'account'
  | 'trading'
  | 'risk'
  | 'schedule'
  | 'market'
  | 'notifications'
  | 'appearance'
  | 'broker'
  | 'advanced'
  | 'system'
  | 'security'
  | 'dummy'
  | 'backup';

type SectionDef = {
  key: SectionKey;
  label: string;
  group: 'Workspace' | 'Experience' | 'System';
  icon: React.ElementType;
  keywords: string;
};

const SECTIONS: SectionDef[] = [
  { key: 'overview', label: 'Overview', group: 'Workspace', icon: LayoutDashboard, keywords: 'home dashboard health audit' },
  { key: 'account', label: 'Account & Connection', group: 'Workspace', icon: UserRound, keywords: 'profile identity broker session demo account' },
  { key: 'trading', label: 'Trading Defaults', group: 'Workspace', icon: CandlestickChart, keywords: 'order product quantity exchange validity confirm target stop loss' },
  { key: 'risk', label: 'Risk', group: 'Workspace', icon: Shield, keywords: 'limits exposure loss drawdown preset' },
  { key: 'schedule', label: 'Schedule & Square-off', group: 'Workspace', icon: CalendarClock, keywords: 'scheduler timeline login square off time session' },
  { key: 'market', label: 'Market Data', group: 'Experience', icon: LineChart, keywords: 'quotes ltp websocket feed watchlist ticks' },
  { key: 'notifications', label: 'Notifications', group: 'Experience', icon: BellRing, keywords: 'alerts sound push pwa events' },
  { key: 'appearance', label: 'Appearance', group: 'Experience', icon: Palette, keywords: 'theme density display formatting tokens studio' },
  { key: 'broker', label: 'Broker', group: 'System', icon: Plug, keywords: 'connection routing feed margin session kotak shoonya' },
  { key: 'advanced', label: 'Advanced', group: 'System', icon: Zap, keywords: 'timeouts retries polling logging engine runtime' },
  { key: 'system', label: 'System Catalogue', group: 'System', icon: Database, keywords: 'backend keys schema categories atomic patch import export' },
  { key: 'security', label: 'Security', group: 'System', icon: Lock, keywords: 'pin app lock mode lock biometric access' },
  { key: 'dummy', label: 'Dummy Engine', group: 'System', icon: Coins, keywords: 'simulation paper engine slippage retention' },
  { key: 'backup', label: 'Backup & Audit', group: 'System', icon: History, keywords: 'export import restore audit trail reset danger' },
];

const MODE_LABEL: Record<TradingMode, string> = {
  dummy: 'Dummy Mode',
  'kotak-neo': 'Kotak Neo',
  shoonya: 'Shoonya',
};

function modePillClass(mode: TradingMode): string {
  if (mode === 'dummy') return 'border-purple/30 bg-purple/10 text-purple';
  if (mode === 'shoonya') return 'border-info/30 bg-info/10 text-info';
  return 'border-success/30 bg-success/10 text-success';
}

export function SettingsWorkbench() {
  const { toast } = useToast();
  const store = getSettingsStore();
  const settings = useTradingSettings();
  const mode = useTradingMode();

  const [section, setSection] = useState<SectionKey>('overview');
  const [navFilter, setNavFilter] = useState('');
  const [schema, setSchema] = useState<SettingSchemaRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [health, setHealth] = useState<SettingsHealth | null>(null);
  const [audit, setAudit] = useState<SettingsAuditEntry[]>([]);
  const [runtime, setRuntime] = useState<any>(null);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [terminalState, setTerminalState] = useState<TerminalState | null>(null);
  const [demoAccount, setDemoAccount] = useState<any>(null);
  const [focusCategory, setFocusCategory] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(true);
  const [schemaLoading, setSchemaLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [writeState, setWriteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileNavRef = useRef<HTMLDivElement>(null);

  const schemaMap = useMemo(() => new Map(schema.map((row) => [row.key, row])), [schema]);

  const flash = useCallback((state: 'saved' | 'error') => {
    setWriteState(state);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setWriteState('idle'), state === 'saved' ? 1600 : 3200);
  }, []);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const fetchSchema = useCallback(async () => {
    setSchemaLoading(true);
    try {
      const res = await getSettingsSchema();
      const rows = Array.isArray(res?.settings) ? res.settings : [];
      setSchema(rows);
      const nextCategories =
        Array.isArray(res?.categories) && res.categories.length > 0
          ? res.categories
          : [...new Set(rows.map((row) => row.category))].sort();
      setCategories(nextCategories);
      setSyncError(null);
      return true;
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'The backend settings catalogue is unreachable.');
      return false;
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      setHealth(await getSettingsHealth());
    } catch {
      setHealth(null);
    }
  }, []);

  const fetchAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await getSettingsAudit({ limit: 150 });
      setAudit(Array.isArray(res?.changes) ? res.changes : []);
    } catch {
      setAudit([]);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const fetchRuntime = useCallback(async () => {
    try {
      setRuntime(await getSettingsRuntime());
    } catch {
      setRuntime(null);
    }
  }, []);

  const fetchEnvironment = useCallback(async () => {
    const [status, terminal, demo] = await Promise.allSettled([
      getSystemStatus(),
      getTerminalState(),
      getDemoAccount(),
    ]);
    if (status.status === 'fulfilled') setSystemStatus(status.value);
    if (terminal.status === 'fulfilled') setTerminalState(terminal.value);
    if (demo.status === 'fulfilled') setDemoAccount(demo.value?.account ?? null);
  }, []);

  const refreshAll = useCallback(async () => {
    setSyncing(true);
    try {
      await store.loadFromBackend();
      await Promise.allSettled([
        fetchSchema(),
        fetchHealth(),
        fetchAudit(),
        fetchRuntime(),
        fetchEnvironment(),
      ]);
      setLastSync(new Date());
    } finally {
      setSyncing(false);
    }
  }, [store, fetchSchema, fetchHealth, fetchAudit, fetchRuntime, fetchEnvironment]);

  const refreshMeta = useCallback(async () => {
    await Promise.allSettled([fetchSchema(), fetchHealth(), fetchAudit(), fetchRuntime()]);
  }, [fetchSchema, fetchHealth, fetchAudit, fetchRuntime]);

  const refreshCatalog = useCallback(async () => {
    setSyncing(true);
    try {
      await Promise.allSettled([fetchSchema(), fetchHealth(), fetchAudit()]);
      setLastSync(new Date());
    } finally {
      setSyncing(false);
    }
  }, [fetchSchema, fetchHealth, fetchAudit]);

  useEffect(() => {
    void refreshAll();
    // The store and fetchers are module singletons; load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (section === 'dummy' && mode !== 'dummy') setSection('overview');
  }, [mode, section]);

  useEffect(() => {
    if (section === 'system' && mobileNavRef.current) {
      mobileNavRef.current.scrollLeft = 0;
    }
  }, [section]);

  const openSection = useCallback((key: SectionKey) => {
    setSection(key);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.getElementById('settings-workbench-content')?.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }, []);

  const openCatalog = useCallback((category?: string) => {
    setFocusCategory(category ?? null);
    setSection('system');
  }, []);

  const consumeFocus = useCallback(() => setFocusCategory(null), []);

  const handleFieldUpdate = useCallback(
    async (path: string, value: any) => {
      setPendingWrites((count) => count + 1);
      setWriteState('saving');
      try {
        const ok = await store.updateSetting(path, value);
        flash(ok ? 'saved' : 'error');
        if (!ok) {
          setSyncError('The backend could not persist the last change; it is stored locally and will sync when the service is reachable.');
        }
      } catch (err) {
        flash('error');
        toast({
          title: 'Could not save setting',
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        });
      } finally {
        setPendingWrites((count) => Math.max(0, count - 1));
      }
    },
    [store, flash, toast],
  );

  const handleBatchUpdate = useCallback(
    async (label: string, values: Record<string, any>) => {
      setPendingWrites((count) => count + values.length);
      setWriteState('saving');
      try {
        const results = await Promise.all(
          Object.entries(values).map(([path, value]) => store.updateSetting(path, value)),
        );
        const failed = results.filter((ok) => !ok).length;
        if (failed === 0) {
          flash('saved');
          toast({ title: `${label} applied` });
        } else {
          flash('error');
          toast({
            title: `${label} partially applied`,
            description: `${failed} value${failed === 1 ? '' : 's'} could not be persisted to the backend.`,
            variant: 'destructive',
          });
        }
      } catch (err) {
        flash('error');
        toast({
          title: `${label} failed`,
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        });
        throw err;
      } finally {
        setPendingWrites((count) => Math.max(0, count - values.length));
      }
    },
    [store, flash, toast],
  );

  const handleBackendWrite = useCallback(
    async (key: string, value: any) => {
      setPendingWrites((count) => count + 1);
      setWriteState('saving');
      try {
        const res = await patchSettings({ [key]: value });
        if (res?.updated && res.updated[key] === false) {
          throw new Error('The backend rejected this value. Check the declared bounds for the key.');
        }
        setSchema((rows) =>
          rows.map((row) =>
            row.key === key ? { ...row, value, updatedAt: new Date().toISOString() } : row,
          ),
        );
        flash('saved');
        void refreshMeta();
      } catch (err) {
        flash('error');
        throw err;
      } finally {
        setPendingWrites((count) => Math.max(0, count - 1));
      }
    },
    [flash, refreshMeta],
  );

  const handleDemoReset = useCallback(async () => {
    try {
      const res = await getDemoAccount();
      setDemoAccount(res?.account ?? null);
    } catch {
      /* the demo endpoint may still be starting */
    }
    toast({ title: 'Demo account reset', description: 'Virtual balance restored to 100,000 Coins.' });
  }, [toast]);

  const handleResetAll = useCallback(async () => {
    store.reset();
    await refreshAll();
  }, [store, refreshAll]);

  const filteredSections = useMemo(() => {
    const q = navFilter.trim().toLowerCase();
    return SECTIONS.filter((item) => {
      if (item.key === 'dummy' && mode !== 'dummy') return false;
      if (!q) return true;
      return `${item.label} ${item.keywords} ${item.group}`.toLowerCase().includes(q);
    });
  }, [navFilter, mode]);

  const groupedSections = useMemo(() => {
    const groups: Array<{ label: SectionDef['group']; items: SectionDef[] }> = [];
    for (const group of ['Workspace', 'Experience', 'System'] as const) {
      const items = filteredSections.filter((item) => item.group === group);
      if (items.length > 0) groups.push({ label: group, items });
    }
    return groups;
  }, [filteredSections]);

  const currentSection = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0];
  const CurrentIcon = currentSection.icon;
  const backendOnline = Boolean(health) && !syncError;
  const databaseOk = health?.database === 'connected';

  const navButton = (item: SectionDef) => {
    const Icon = item.icon;
    const active = section === item.key;
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => openSection(item.key)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors',
          active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <Icon className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground/80')} />
        <span className="truncate">{item.label}</span>
        {item.key === 'system' && schema.length > 0 && (
          <span className="ml-auto rounded-full bg-muted/70 px-1.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
            {schema.length}
          </span>
        )}
        {item.key === 'backup' && audit.length > 0 && (
          <span className="ml-auto rounded-full bg-muted/70 px-1.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
            {audit.length}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-[calc(100dvh-3.5rem)] -m-3 overflow-hidden bg-background md:-m-6">
      {/* Desktop navigation */}
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-border/60 bg-card/30 lg:flex">
        <div className="border-b border-border/50 px-3.5 pb-3 pt-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/70">
              <Settings2 className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold leading-5">Settings</div>
              <div className="truncate text-[10px] text-muted-foreground">Advanced workbench</div>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold', modePillClass(mode))}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {MODE_LABEL[mode]}
            </span>
            <Pill tone={databaseOk ? 'success' : backendOnline ? 'warning' : 'danger'} dot>
              {health ? `mongo ${health.database}` : 'backend offline'}
            </Pill>
          </div>
        </div>

        <div className="px-2.5 py-2">
          <SearchField
            value={navFilter}
            onChange={setNavFilter}
            placeholder="Find a section…"
            className="[&_input]:h-7 [&_input]:text-[11px]"
          />
        </div>

        <nav className="flex-1 space-y-3 overflow-y-auto px-2 pb-3">
          {groupedSections.length === 0 ? (
            <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              No section matches “{navFilter}”.
            </div>
          ) : (
            groupedSections.map((group) => (
              <div key={group.label} className="space-y-0.5">
                <div className="px-2.5 pb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  {group.label}
                </div>
                {group.items.map(navButton)}
              </div>
            ))
          )}
        </nav>

        <div className="space-y-1.5 border-t border-border/50 p-2.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-full justify-start gap-1.5 text-[11px]"
            onClick={() => openCatalog()}
          >
            <Database className="h-3.5 w-3.5" /> System catalogue
          </Button>
          <div className="flex items-center justify-between px-0.5 text-[9px] text-muted-foreground/70">
            <span>{health ? `${health.customizedKeys}/${health.totalKeys} customized` : 'catalogue pending'}</span>
            <span>{lastSync ? `sync ${formatRelative(lastSync.toISOString())}` : 'not synced'}</span>
          </div>
        </div>
      </aside>

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 md:px-6 md:py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card lg:hidden">
                <CurrentIcon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h1 className="truncate text-sm font-semibold leading-5">{currentSection.label}</h1>
                  <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold lg:hidden', modePillClass(mode))}>
                    <span className="h-1 w-1 rounded-full bg-current" />
                    {MODE_LABEL[mode]}
                  </span>
                </div>
                <p className="truncate text-[10px] text-muted-foreground">
                  {syncing
                    ? 'Syncing with the backend…'
                    : lastSync
                      ? `Synced ${formatRelative(lastSync.toISOString())} · ${settings ? 'local snapshot live' : 'loading'}`
                      : 'Waiting for the first sync'}
                  {pendingWrites > 0 ? ` · ${pendingWrites} write${pendingWrites === 1 ? '' : 's'} in flight` : ''}
                </p>
              </div>
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <SaveDot
                state={writeState === 'idle' && pendingWrites > 0 ? 'saving' : writeState}
              />
              <Pill tone={databaseOk ? 'success' : backendOnline ? 'warning' : 'danger'} dot className="hidden sm:inline-flex">
                {databaseOk ? 'live backend' : backendOnline ? 'degraded' : 'offline'}
              </Pill>
              <Pill tone="info" className="hidden md:inline-flex">
                {health?.auditCount ?? audit.length} audit
              </Pill>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => void refreshAll()}
                disabled={syncing}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
                <span className="hidden sm:inline">Sync</span>
              </Button>
            </div>
          </div>

          {/* Mobile navigation chips */}
          <div
            ref={mobileNavRef}
            className="scrollbar-thin flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden"
          >
            {filteredSections.map((item) => {
              const Icon = item.icon;
              const active = section === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => openSection(item.key)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors',
                    active
                      ? 'border-primary/40 bg-primary/15 text-primary'
                      : 'border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </header>

        <div
          id="settings-workbench-content"
          className="flex-1 overflow-y-auto px-3 py-4 pb-24 md:px-6 md:py-5 md:pb-8"
        >
          <div className="mx-auto max-w-[1440px] space-y-4">
            {syncError && (
              <Callout tone="warning" title="Backend catalogue unavailable">
                <div className="space-y-1">
                  <p>The last backend request failed. Local preferences remain editable and will sync when the service recovers.</p>
                  <p className="truncate font-mono text-[10px] opacity-80">{syncError}</p>
                </div>
              </Callout>
            )}

            {section === 'overview' && (
              <OverviewSection
                mode={mode}
                settings={settings}
                health={health}
                runtime={runtime}
                audit={audit}
                schema={schema}
                systemStatus={systemStatus}
                demoAccount={demoAccount}
                onNavigate={(key) => openSection(key as SectionKey)}
                onOpenCatalog={openCatalog}
                onResetDemo={() => openSection('account')}
              />
            )}

            {section === 'account' && (
              <AccountSection
                mode={mode}
                schemaMap={schemaMap}
                systemStatus={systemStatus}
                terminalState={terminalState}
                onBackendWrite={handleBackendWrite}
                onNavigate={(key) => openSection(key as SectionKey)}
                onDemoReset={handleDemoReset}
              />
            )}

            {section === 'trading' && (
              <TradingSection mode={mode} settings={settings} onFieldUpdate={handleFieldUpdate} />
            )}

            {section === 'risk' && (
              <RiskSection
                settings={settings}
                onFieldUpdate={handleFieldUpdate}
                onBatchUpdate={handleBatchUpdate}
              />
            )}

            {section === 'schedule' && (
              <ScheduleSection
                mode={mode}
                settings={settings}
                schemaMap={schemaMap}
                onFieldUpdate={handleFieldUpdate}
                onBackendWrite={handleBackendWrite}
                runtime={runtime}
              />
            )}

            {section === 'market' && (
              <MarketDataSection
                settings={settings}
                schemaMap={schemaMap}
                onFieldUpdate={handleFieldUpdate}
                onBackendWrite={handleBackendWrite}
                onOpenCatalog={openCatalog}
              />
            )}

            {section === 'notifications' && (
              <NotificationsSection
                settings={settings}
                schemaMap={schemaMap}
                onFieldUpdate={handleFieldUpdate}
                onBackendWrite={handleBackendWrite}
              />
            )}

            {section === 'appearance' && (
              <AppearanceSection mode={mode} settings={settings} onFieldUpdate={handleFieldUpdate} />
            )}

            {section === 'broker' && (
              <BrokerSection
                mode={mode}
                schemaMap={schemaMap}
                systemStatus={systemStatus}
                terminalState={terminalState}
                onBackendWrite={handleBackendWrite}
              />
            )}

            {section === 'advanced' && (
              <AdvancedSection
                settings={settings}
                schemaMap={schemaMap}
                onFieldUpdate={handleFieldUpdate}
                onBackendWrite={handleBackendWrite}
                onOpenCatalog={openCatalog}
                runtime={runtime}
              />
            )}

            {section === 'system' && (
              <SystemCatalog
                schema={schema}
                categories={categories}
                loading={schemaLoading || syncing}
                onRefresh={refreshCatalog}
                focusCategory={focusCategory}
                onFocusConsumed={consumeFocus}
              />
            )}

            {section === 'security' && <SecurityPanel />}

            {section === 'dummy' && mode === 'dummy' && <DummyPanel />}

            {section === 'backup' && (
              <BackupPanel
                health={health}
                audit={audit}
                auditLoading={auditLoading}
                onRefresh={refreshCatalog}
                onResetAll={handleResetAll}
              />
            )}

            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/40 pt-3 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Activity className={cn('h-3 w-3', backendOnline ? 'text-success' : 'text-warning')} />
                {backendOnline ? 'Backend catalogue connected' : 'Working from the local snapshot'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <SlidersHorizontal className="h-3 w-3" />
                {schema.length} catalogued keys · {health?.liveKeyCount ?? runtime?.liveKeys?.length ?? 0} live
              </span>
              <span className="ml-auto inline-flex items-center gap-1.5">
                <Search className="h-3 w-3" />
                Use the sidebar search or the{' '}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => openCatalog()}>
                  system catalogue
                </button>
                for any backend key.
              </span>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsWorkbench;
