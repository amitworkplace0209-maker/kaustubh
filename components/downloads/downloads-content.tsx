'use client';

// ---- Data Center (/downloads) ----
//
// Composition root. All metrics flow through ONE normalized state
// (lib/data-center.ts useDataCenter) and ONE shared SSE tick stream
// (hooks/use-latest-ticks). Export runs as a REAL backend job:
//
//   POST /api/downloads/exports → poll status → stream artifact → save file
//
// The stock/field selection is cleared ONLY after the export COMPLETED and
// the browser download was initiated successfully (never on click, never on
// failure — so a failed export can simply be retried).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download as DownloadIcon, History, Clock, ShieldAlert, RefreshCw,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { getStocks } from '@/lib/api';
import {
  createExportJob, getExportJob, fetchExportArtifact,
} from '@/lib/api';
import { updateDownloadsState, useDownloadsState } from '@/lib/downloads-store';
import { cn } from '@/lib/utils';

import FieldPicker, { type FieldGroup } from '@/components/downloads/field-picker';
import DateFilter, { applyPreset } from '@/components/downloads/date-filter';

import SummaryCards from '@/components/data-center/summary-cards';
import HealthPanel from '@/components/data-center/health-panel';
import StockSelection, { type DcStock, type StockMode } from '@/components/data-center/stock-selection';
import ExportConfig from '@/components/data-center/export-config';
import DcHistory from '@/components/data-center/dc-history';
import DcSchedules from '@/components/data-center/dc-schedules';
import { toUiStage, type ExportStage } from '@/components/data-center/export-progress';

import { deriveHealthRows, useDataCenter } from '@/lib/data-center-status';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { LiveStatus } from '@/components/account/live-status';
import { RefreshButton } from '@/components/account/refresh-button';

const FIELD_GROUPS: FieldGroup[] = [
  {
    name: 'Identity',
    fields: [['symbol', 'Symbol'], ['instrumentToken', 'Instrument Token'], ['exchangeSegment', 'Exchange Segment']],
  },
  {
    name: 'Price',
    fields: [['ltp', 'LTP'], ['averagePrice', 'Average Price'], ['change', 'Change'], ['changePercent', 'Change %']],
  },
  {
    name: 'OHLC',
    fields: [['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['close', 'Close']],
  },
  {
    name: 'Volume',
    fields: [['volume', 'Volume'], ['ltq', 'Last Traded Quantity'], ['oi', 'Open Interest']],
  },
  {
    name: 'Market Depth',
    fields: [['tbq', 'Total Buy Qty'], ['tsq', 'Total Sell Qty'], ['bp', 'Best Bid Price'], ['sp', 'Best Ask Price'], ['bq', 'Bid Qty'], ['bs', 'Ask Qty']],
  },
  {
    name: 'Timestamp',
    fields: [['ts', 'Tick Time'], ['receivedAt', 'Received At'], ['timestamp', 'Timestamp']],
  },
];

const ALL_FIELDS_COUNT = FIELD_GROUPS.reduce((n, g) => n + g.fields.length, 0);

const POLL_INTERVAL_MS = 900;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

type JobPhase = 'idle' | 'running' | 'ready' | 'error';

export default function DownloadsContent() {
  const { toast } = useToast();

  // ---- Persisted export configuration (shared store) ----
  const store = useDownloadsState();
  const [stocks, setStocks] = useState<DcStock[]>([]);
  const [stocksLoading, setStocksLoading] = useState(true);

  // ---- Export job state ----
  const [jobPhase, setJobPhase] = useState<JobPhase>('idle');
  const [jobStage, setJobStage] = useState<ExportStage>('queued');
  const [progressPct, setProgressPct] = useState(0);
  const exportingRef = useRef(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [downloading, setDownloading] = useState(false);

  // ---- ONE metrics poller + ONE live tick stream for the whole page ----
  const dc = useDataCenter();
  const live = useLatestTicks(true);

  const fetchStocks = useCallback(() => {
    setStocksLoading(true);
    getStocks()
      .then((d) => {
        const list = (d.data ?? d.stocks ?? []).map((s: Record<string, unknown>) => ({
          symbol: String(s.symbol ?? ''),
          active: Boolean(s.active),
          company_name: (s.company_name as string) || (s.pDesc as string) || '',
          instrumentToken: s.instrumentToken != null ? String(s.instrumentToken) : '',
          exchangeSegment: s.exchangeSegment != null ? String(s.exchangeSegment) : '',
        }));
        setStocks(list.filter((s: DcStock) => s.symbol));
      })
      .catch(() => { /* keep previous list */ })
      .finally(() => setStocksLoading(false));
  }, []);

  useEffect(() => { fetchStocks(); }, [fetchStocks]);

  const handleRefresh = useCallback(() => {
    void dc.refresh();
    fetchStocks();
  }, [dc, fetchStocks]);

  // ---- Store setters ----
  const setSelectedFormats = useCallback((v: Set<string> | string[]) => {
    updateDownloadsState({ selectedFormats: Array.isArray(v) ? v : Array.from(v) });
  }, []);
  const setSelectedStocks = useCallback((v: Set<string> | string[]) => {
    updateDownloadsState({ selectedStocks: Array.isArray(v) ? v : Array.from(v) });
  }, []);
  const setStockMode = useCallback((v: string) => updateDownloadsState({ stockMode: v }), []);
  const setSelectedFields = useCallback((v: Set<string> | string[]) => {
    updateDownloadsState({ selectedFields: Array.isArray(v) ? v : Array.from(v) });
  }, []);
  const setFieldMode = useCallback((v: string) => updateDownloadsState({ fieldMode: v }), []);

  const handlePresetChange = (preset: string) => {
    if (preset !== 'custom') {
      const range = applyPreset(preset);
      updateDownloadsState({ datePreset: preset, startDate: range.start, endDate: range.end });
    } else {
      updateDownloadsState({ datePreset: preset });
    }
  };

  const handleClearDates = () => {
    updateDownloadsState({ datePreset: 'custom', startDate: '', endDate: '' });
  };

  // ---- Download (backend export job pipeline) ----
  const selectedStockSet = new Set(store.selectedStocks);
  const stockMode = store.stockMode as StockMode;
  const effectiveCount =
    stockMode === 'all_active'
      ? stocks.filter((s) => s.active).length
      : stockMode === 'all'
        ? stocks.length
        : selectedStockSet.size;

  const resetSelectionAfterSuccess = useCallback(() => {
    // Requirement #23/#24 — only after COMPLETED + download initiated.
    // Schedules / history / settings are never touched.
    updateDownloadsState({
      selectedStocks: [],
      selectedFields: [],
      fieldMode: 'all',
    });
  }, []);

  const handleDownload = async () => {
    if (exportingRef.current) return; // duplicate-click guard (#32)

    if (effectiveCount === 0) {
      toast({ title: 'No stocks selected', description: 'Pick stocks or switch to All Active / All.', variant: 'destructive' });
      return;
    }
    if (store.selectedFormats.length === 0) {
      toast({ title: 'No format selected', description: 'Choose CSV, JSON or XLSX.', variant: 'destructive' });
      return;
    }
    if (store.fieldMode === 'custom' && new Set(store.selectedFields).size === 0) {
      toast({ title: 'No fields selected', variant: 'destructive' });
      return;
    }
    if (store.startDate && store.endDate) {
      const s = new Date(store.startDate).getTime();
      const e = new Date(store.endDate).getTime();
      if (!isNaN(s) && !isNaN(e) && e < s) {
        toast({ title: 'Invalid date range', description: 'End must be after start.', variant: 'destructive' });
        return;
      }
    }

    exportingRef.current = true;
    setDownloading(true);
    setJobPhase('running');
    setJobStage('queued');
    setProgressPct(0);

    try {
      const payload: Record<string, unknown> = {
        symbolMode: stockMode,
        symbols: stockMode === 'custom' ? Array.from(selectedStockSet) : undefined,
        formats: store.selectedFormats.filter((f) => f !== 'zip'),
        packageZip: true,
        clientId: `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
      if (store.startDate) payload.start = new Date(store.startDate).toISOString();
      if (store.endDate) payload.end = new Date(store.endDate).toISOString();
      if (store.fieldMode === 'custom') payload.fields = Array.from(new Set(store.selectedFields)).join(',');

      const { jobId } = await createExportJob(payload as Parameters<typeof createExportJob>[0]);
      let filename = '';
      let sizeBytes = 0;

      // Poll the real backend job until it finishes.
      const startedAt = Date.now();
      while (true) {
        if (Date.now() - startedAt > JOB_TIMEOUT_MS) throw new Error('Export timed out');
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const job = await getExportJob(jobId);
        setProgressPct(job.progressPercent ?? 0);
        setJobStage(toUiStage(job.stage));

        if (job.status === 'COMPLETED') break;
        if (job.status === 'FAILED') throw new Error(job.error || 'Export failed');
        if (job.status === 'CANCELLED') throw new Error('Export cancelled');
      }

      // Stream the artifact and hand it to the browser.
      const { blob, filename: fname } = await fetchExportArtifact(jobId);
      triggerBrowserDownload(blob, fname);
      filename = fname;
      sizeBytes = blob.size;

      toast({
        title: 'Download complete',
        description: `${filename} (${(sizeBytes / 1024).toFixed(1)} KB)`,
      });

      // Success → surface in History and reset selection.
      setHistoryRefreshKey((k) => k + 1);
      resetSelectionAfterSuccess();
      setJobPhase('ready');
      setTimeout(() => {
        setJobPhase('idle');
        setJobStage('queued');
        setProgressPct(0);
      }, 4000);
    } catch (err) {
      setJobPhase('error');
      setTimeout(() => setJobPhase('idle'), 3000);
      let message = err instanceof Error ? err.message : 'Unknown error';
      if (/no data found/i.test(message)) message = 'No tick data for the selected parameters.';
      else if (/no stocks/i.test(message)) message = 'Server reports no matching stocks.';
      toast({
        title: 'Download failed',
        description: `${message} · selection kept so you can retry.`,
        variant: 'destructive',
      });
    } finally {
      exportingRef.current = false;
      setDownloading(false);
    }
  };

  // ---- Derived health rows ----
  const healthRows = dc.status
    ? deriveHealthRows(dc.status, { sseConnected: live.connected, nowMs: dc.now })
    : [];

  const updatedLabel = dc.lastSuccessAt != null
    ? `Updated ${new Date(dc.lastSuccessAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}`
    : undefined;

  const unavailable = dc.status == null && dc.error != null && !dc.loading;

  // Skeletons only on the very first load — later polls update content in
  // place.
  const initialLoad = dc.loading && dc.status == null;
  return (
    <div className="space-y-6">
      {/* PAGE HEADER */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Data Center</h1>
          <p className="text-sm text-muted-foreground">Export and monitor market tick data</p>
        </div>
        <div className="flex items-center gap-2">
          <LiveStatus freshness={unavailable ? 'offline' : dc.freshness} updatedLabel={updatedLabel} />
          <RefreshButton onClick={handleRefresh} refreshing={dc.loading} />
        </div>
      </div>

      {/* Error state — never fake metrics */}
      {unavailable && (
        <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] p-4 sm:flex-row sm:items-center">
          <ShieldAlert className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-destructive">Data Center unavailable</p>
            <p className="text-xs text-muted-foreground">{dc.error}</p>
            {dc.lastSuccessAt == null && (
              <p className="mt-0.5 text-[10px] text-muted-foreground">No successful update yet.</p>
            )}
          </div>
          <Button size="sm" variant="outline" className="shrink-0 gap-1.5 rounded-lg text-xs" onClick={handleRefresh} disabled={dc.loading}>
            <RefreshCw className={cn('h-3 w-3', dc.loading && 'animate-spin')} /> Retry
          </Button>
        </div>
      )}

      {/* SUMMARY — 4 premium cards */}
      <SummaryCards status={dc.status} loading={initialLoad} />

      {/* SYSTEM HEALTH panel */}
      <HealthPanel rows={healthRows} loading={initialLoad} />

      {/* DATA EXPORT tabs — forceMount keeps sections mounted so switching
          tabs never remounts/refetches or shifts layout */}
      <Tabs defaultValue="download">
        <TabsList>
          <TabsTrigger value="download" className="gap-2">
            <DownloadIcon className="h-4 w-4" /> Download
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2">
            <History className="h-4 w-4" /> History
          </TabsTrigger>
          <TabsTrigger value="schedule" className="gap-2">
            <Clock className="h-4 w-4" /> Schedule
          </TabsTrigger>
        </TabsList>

        <TabsContent value="download" forceMount className="mt-4 space-y-4 data-[state=inactive]:hidden">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <StockSelection
                stocks={stocks}
                loading={stocksLoading}
                selectedStocks={selectedStockSet}
                onSelectionChange={setSelectedStocks}
                mode={stockMode}
                onModeChange={setStockMode}
                live={live}
              />
            </div>
            <div className="space-y-4">
              <DateFilter
                startDate={store.startDate}
                endDate={store.endDate}
                onStartChange={(v) => updateDownloadsState({ startDate: v })}
                onEndChange={(v) => updateDownloadsState({ endDate: v })}
                onClear={handleClearDates}
                preset={store.datePreset}
                onPresetChange={handlePresetChange}
              />
              <FieldPicker
                groups={FIELD_GROUPS}
                selectedFields={new Set(store.selectedFields)}
                onSelectionChange={setSelectedFields}
                mode={store.fieldMode as 'all' | 'custom'}
                onModeChange={setFieldMode}
              />
            </div>
          </div>

          <ExportConfig
            config={{
              stockMode,
              selectedStocks: store.selectedStocks,
              selectedFormats: store.selectedFormats,
              fieldMode: store.fieldMode,
              selectedFields: store.selectedFields,
              startDate: store.startDate,
              endDate: store.endDate,
            }}
            stocks={stocks}
            fieldsCount={ALL_FIELDS_COUNT}
            downloading={downloading}
            jobPhase={jobPhase}
            jobStage={jobStage}
            progressPercent={progressPct}
            onDownload={handleDownload}
            onFormatsChange={setSelectedFormats}
          />
        </TabsContent>

        <TabsContent value="history" forceMount className="mt-4 data-[state=inactive]:hidden">
          <DcHistory refreshKey={historyRefreshKey} />
        </TabsContent>

        <TabsContent value="schedule" forceMount className="mt-4 data-[state=inactive]:hidden">
          <DcSchedules />
        </TabsContent>
      </Tabs>
    </div>
  );
}
