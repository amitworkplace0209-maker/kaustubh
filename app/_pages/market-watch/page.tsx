'use client';

import { useEffect, useState } from 'react';
import {
  LayoutDashboard, ListFilter, Rows3, Pin, Search, AlertCircle, CalendarClock, FileText,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/design-system';
import { MWRow } from './mw-shared';
import MarketWatchStatusBar from './status-bar';
import OverviewTab from './overview';
import MoversTab from './movers';
import RankTab from './rank';
import FiltersTab from './filters';
import PinsTab from './pins';
import SymbolTab from './symbol';
import WeeklyTab from './weekly';
import ReportTab from './report';
import { useEngineProgress, isLifecycleTerminal, lifecycleLabel, runtimeWindowLabel } from './mw-shared';

export type MarketWatchTab =
  | 'overview'
  | 'movers'
  | 'rank'
  | 'filters'
  | 'pins'
  | 'symbol'
  | 'weekly'
  | 'report';

const TABS: { id: MarketWatchTab; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'movers', label: 'Movers', icon: ListFilter },
  { id: 'rank', label: 'Volume & Rank', icon: Rows3 },
  { id: 'filters', label: 'Filters', icon: ListFilter },
  { id: 'pins', label: 'Pins', icon: Pin },
  { id: 'symbol', label: 'Stock Detail', icon: Search },
  // doc §32: the Saturday review is the only place weekly membership changes.
  { id: 'weekly', label: 'Weekly Review', icon: CalendarClock },
  // doc §26: the EOD report is stored and previously had no reader at all.
  { id: 'report', label: 'Report', icon: FileText },
];

export default function MarketWatchPage({ initialTab }: { initialTab?: MarketWatchTab }) {
  const [tab, setTab] = useState<MarketWatchTab>(initialTab ?? 'overview');
  const [symbolQuery, setSymbolQuery] = useState('');
  // Backend-applied filter matches handed from Filters → Volume & Rank so both
  // tabs render the one canonical table.
  const [prefilter, setPrefilter] = useState<{ rows: MWRow[]; total: number } | null>(null);

  const { state, resolved, progress } = useEngineProgress();

  // Check if engine is in a terminal state (RUNTIME_INACTIVE, MARKET_WATCH_STOPPED, etc.)
  const isTerminal = resolved && isLifecycleTerminal(state);
  const isRuntimeInactive = state === 'RUNTIME_INACTIVE';
  // doc §8 — rendered from the engine's published schedule, not a local constant.
  const runtimeWindow = runtimeWindowLabel(progress.lifecycle?.schedule);

  const openSymbol = (row: MWRow) => {
    setSymbolQuery(row.symbol);
    setTab('symbol');
  };

  const viewInRank = (rows: MWRow[], total: number) => {
    setPrefilter({ rows, total });
    setTab('rank');
  };

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  // Deep links must reach the canonical page, not a dead query string.
  // universal-search navigates to `/trading/market-watch?search=<SYMBOL>`, and the
  // wrappers may also pass `?tab=<id>`. Read them from the URL directly (rather
  // than useSearchParams) so this page needs no Suspense boundary in the
  // prerendered route shells.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const wanted = sp.get('tab');
    if (wanted && TABS.some((t) => t.id === wanted)) setTab(wanted as MarketWatchTab);
    const search = (sp.get('search') || sp.get('symbol') || '').trim();
    if (search) {
      setSymbolQuery(search);
      setTab('symbol');
    }
  }, []);

  // Render full-page offline state when engine is in RUNTIME_INACTIVE
  if (isTerminal && isRuntimeInactive) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Market Watch"
          subtitle="Engine is outside its runtime window"
        >
          <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-300 px-2.5 py-1.5">
            <AlertCircle className="h-4 w-4" aria-hidden />
            <div className="leading-tight">
              <div className="text-[10px] uppercase tracking-wide opacity-80">Engine State</div>
              <div className="text-sm font-semibold">Runtime Inactive</div>
            </div>
          </div>
        </PageHeader>

        <section className="rounded-lg border border-border/60 bg-card/60 p-6 text-center">
          <AlertCircle className="h-12 w-12 mx-auto text-muted-foreground/50" aria-hidden />
          <h2 className="mt-4 text-lg font-semibold">Market Watch Engine is Offline</h2>
          <p className="mt-2 text-muted-foreground">
            The Market Watch Engine only runs during its configured runtime window:
          </p>
          {/* doc §8/§24 — the window is operator configuration published by the
              engine. This used to hardcode "08:50 – 15:30", which would quietly
              contradict a configured window. Fall back to an honest dash if the
              engine has not published a schedule. */}
          <div className="mt-4 font-mono text-lg">
            {runtimeWindow ?? '—'}
          </div>
          <p className="mt-4 text-muted-foreground">
            Current engine state: <span className="font-mono">{lifecycleLabel('RUNTIME_INACTIVE')}</span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            No live market data, rankings, or pins are available outside this window.
          </p>
        </section>

        {/* doc §8: outside the runtime window the frontend may still show a valid
            stored report. The Report tab now actually exists, so the pointer is
            live instead of dead text. */}
        <section className="rounded-lg border border-border/60 bg-card/60 p-6 mt-6">
          <h3 className="font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4" aria-hidden />
            Stored report available
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Market Watch is outside its runtime window, so live ticks, rankings and the active universe are paused.
            The last generated report is still readable.
          </p>
          <button
            onClick={() => setTab('report')}
            className="mt-3 rounded border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
          >
            Open Report
          </button>
        </section>
      </div>
    );
  }

  // Normal rendering when engine is running or has a report
  return (
    <div className="space-y-6">
      <PageHeader
        title="Market Watch"
        subtitle="Monitors exactly the Saturday-locked weekly universe · backend-owned 1m/5m/10m/30m, circuit, margin and rankings"
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as MarketWatchTab)}>
          <TabsList className="flex-wrap">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="gap-1.5 text-xs">
                <t.icon className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t.label}</span>
                <span className="sm:hidden">{t.label.slice(0, 1).toUpperCase()}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </PageHeader>

      {/* One canonical engine phase/lifecycle indicator, shared by every route
          and phase shell. Driven only by real backend state. */}
      <MarketWatchStatusBar />

      {tab === 'overview' && <OverviewTab onNavigate={(t) => setTab(t as MarketWatchTab)} />}
      {tab === 'movers' && <MoversTab onOpenSymbol={openSymbol} />}
      {tab === 'rank' && (
        <RankTab
          onOpenSymbol={openSymbol}
          prefiltered={prefilter?.rows}
          prefilterTotal={prefilter?.total}
          onClearPrefilter={() => setPrefilter(null)}
        />
      )}
      {tab === 'filters' && <FiltersTab onViewInRank={viewInRank} />}
      {tab === 'pins' && <PinsTab onOpenSymbol={openSymbol} />}
      {tab === 'symbol' && <SymbolTab initialSymbol={symbolQuery || undefined} onPinChange={() => {}} />}
      {tab === 'weekly' && <WeeklyTab />}
      {tab === 'report' && <ReportTab />}
    </div>
  );
}