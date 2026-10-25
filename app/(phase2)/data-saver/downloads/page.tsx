'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, Calendar, Clock, FileDown, Settings2, Package,
  Check, Loader2, AlertCircle, X, Archive, History,
  Braces, FileText, FileSpreadsheet, Database, Eye, EyeOff,
  Sparkles, Search, Layers, SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  PageHeader, SectionCard, StatusBadge,
} from '@/components/design-system';
import {
  getDownloadFormats, getDownloadFields, getDownloadPreview,
  createExportJob, getExportJob, fetchExportArtifact, cancelExportJob,
  getDownloadHistory,
} from '@/lib/api';
import StockSearchPopover from '@/components/downloads/stock-search';
import DbStocks from '@/components/downloads/db-stocks';
import { cn } from '@/lib/utils';
import { istDateKey } from '@/lib/ist';

type ExportStage =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'reading'
  | 'exporting'
  | 'compressing'
  | 'ready'
  | 'downloading'
  | 'completed'
  | 'failed';

type FormatInfo = {
  id: string;
  name?: string;
  displayName?: string;
  extension?: string;
  available?: boolean;
  category?: string;
  description?: string;
  compression?: boolean;
  streaming?: boolean;
};

type FieldDetail = {
  name: string;
  type?: string;
  source?: string;
  description?: string;
  isDefault?: boolean;
};

type ExportResult = {
  jobId: string;
  status: string;
  records: number | null;
  files: number;
  size: number | null;
  duration: number | null;
  fileName: string | null;
  createdAt: string | null;
  completedAt: string | null;
  error: string | null;
  formats: string[];
};

type PreviewAggregate = {
  symbolCount: number;
  estimatedRecords: number;
  effectiveRecords: number;
  serverRowLimit: number;
  streamLimit: number;
  estimatedSize: number;
  willTruncate: boolean;
  perFormat: { format: string; size: number; available: boolean }[];
  sampleSize: number;
};

type HistoryEntry = {
  _id: string;
  symbols: string[];
  format: string;
  count: number;
  fileName?: string;
  ts?: string;
  fileSizeBytes?: number;
  status?: string;
  jobId?: string;
};

const FORMAT_ICONS: Record<string, React.ElementType> = {
  csv: FileText, csv_bom: FileText, tsv: FileText, txt: FileText,
  json: Braces, jsonl: Braces, ndjson: Braces,
  parquet: Archive, feather: Archive, arrow_ipc: Archive,
  xlsx: FileSpreadsheet, ods: FileSpreadsheet,
  sql: FileText, sqlite: Database,
  xml: FileText, html: FileText, markdown: FileText,
  yaml: FileText, toml: FileText,
  zip: Archive, gzip: Archive, csv_gz: FileText,
  avro: Archive,
};

/** Colorful per-category accents for the format picker. */
const FORMAT_TINTS: Record<string, { ring: string; bg: string; text: string }> = {
  Tabular: { ring: 'border-teal-500/60', bg: 'from-teal-500/20 to-emerald-500/10', text: 'text-teal-500' },
  JSON: { ring: 'border-amber-500/60', bg: 'from-amber-500/20 to-orange-500/10', text: 'text-amber-500' },
  Columnar: { ring: 'border-violet-500/60', bg: 'from-violet-500/20 to-purple-500/10', text: 'text-violet-500' },
  Spreadsheet: { ring: 'border-emerald-500/60', bg: 'from-emerald-500/20 to-green-500/10', text: 'text-emerald-500' },
  Database: { ring: 'border-sky-500/60', bg: 'from-sky-500/20 to-blue-500/10', text: 'text-sky-500' },
  Archive: { ring: 'border-rose-500/60', bg: 'from-rose-500/20 to-pink-500/10', text: 'text-rose-500' },
};

function formatTint(category: string) {
  return FORMAT_TINTS[category] ?? {
    ring: 'border-primary/60', bg: 'from-primary/20 to-primary/5', text: 'text-primary',
  };
}

const IST_TZ = 'Asia/Kolkata';

function fmtIST(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Not available';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Not available';
    return d.toLocaleString('en-IN', {
      timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return 'Not available';
  }
}

function fmtDateIST(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Not available';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Not available';
    return d.toLocaleDateString('en-IN', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return 'Not available';
  }
}

function fmtBytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b) || b <= 0) return 'Not available';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'Not available';
  return n.toLocaleString('en-IN');
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'Not available';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function toISTDateInput(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const ist = new Date(d.toLocaleString('en-US', { timeZone: IST_TZ }));
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
function fromISTInputs(dateVal: string, timeVal: string): string {
  if (!dateVal) return '';
  const time = timeVal || '09:15';
  return `${dateVal}T${time}:00+05:30`;
}

const STAGE_MAP: Record<string, ExportStage> = {
  queued: 'queued', fetching: 'reading', generating: 'exporting',
  saving: 'exporting', zipping: 'compressing', completed: 'ready',
  failed: 'failed', cancelled: 'failed',
};

const STAGE_LABELS: Record<ExportStage, string> = {
  idle: 'Idle', queued: 'Queued', preparing: 'Preparing',
  reading: 'Reading Data', exporting: 'Exporting',
  compressing: 'Compressing', ready: 'Package Ready',
  downloading: 'Downloading', completed: 'Completed', failed: 'Failed',
};

const STAGE_ICONS: Record<ExportStage, React.ElementType> = {
  idle: Settings2, queued: Clock, preparing: Settings2,
  reading: FileDown, exporting: FileDown,
  compressing: Archive, ready: Package,
  downloading: ArrowDownToLine, completed: Check, failed: AlertCircle,
};

export default function Phase2DownloadsPage() {
  const [selectedStocks, setSelectedStocks] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [timeFrom, setTimeFrom] = useState('09:15');
  const [timeTo, setTimeTo] = useState('15:30');
  const [formats, setFormats] = useState<FormatInfo[]>([]);
  const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());
  const [compression, setCompression] = useState('none');
  const [fields, setFields] = useState<FieldDetail[]>([]);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [fieldMode, setFieldMode] = useState<'all' | 'custom'>('all');
  const [subscribedSymbols, setSubscribedSymbols] = useState<Set<string>>(new Set());
  const [dbStockCount, setDbStockCount] = useState<number | null>(null);

  const [formatsLoading, setFormatsLoading] = useState(true);
  const [fieldsLoading, setFieldsLoading] = useState(true);
  const [preview, setPreview] = useState<PreviewAggregate | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [jobStage, setJobStage] = useState<ExportStage>('idle');
  const [jobProgress, setJobProgress] = useState(0);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [showFields, setShowFields] = useState(false);
  const [fieldSearch, setFieldSearch] = useState('');

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const f = await getDownloadFormats();
        if (!mounted) return;
        const fmts = (f?.formats ?? []).filter((x: any) => x.available !== false);
        setFormats(fmts);
        if (fmts.length) {
          const csvFmt = fmts.find((x: any) => x.id === 'csv');
          setSelectedFormats(new Set([csvFmt ? 'csv' : fmts[0].id]));
        }
      } catch { /* keep empty */ }
      setFormatsLoading(false);
    })();
    (async () => {
      try {
        const d = await getDownloadFields();
        if (!mounted) return;
        setFields(d?.fieldDetails ?? []);
        setSelectedFields(new Set<string>(d?.defaultFields ?? []));
        setSubscribedSymbols(new Set<string>());
      } catch { /* ignore */ }
      setFieldsLoading(false);
    })();
    return () => { mounted = false; };
  }, []);

  const handleDbLoaded = useCallback((symbols: Set<string>, count: number) => {
    setSubscribedSymbols(symbols);
    setDbStockCount(count);
  }, []);

  const toggleStock = useCallback((symbol: string) => {
    setSelectedStocks((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol],
    );
  }, []);

  const selectDbSymbols = useCallback((symbols: string[]) => {
    setSelectedStocks((prev) => {
      const next = new Set(prev);
      symbols.forEach((s) => next.add(s));
      return Array.from(next);
    });
  }, []);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const effectiveFields = useMemo(() => {
    if (fieldMode === 'all') return fields.map((f) => f.name);
    return Array.from(selectedFields);
  }, [fieldMode, selectedFields, fields]);

  const filteredFieldGroups = useMemo(() => {
    const groups: Record<string, FieldDetail[]> = {};
    for (const f of fields) {
      const group = f.source?.includes('Broker') ? 'Broker Stream'
        : f.source?.includes('Derived') ? 'Derived'
        : f.source?.includes('System') ? 'System'
        : 'Other';
      if (!groups[group]) groups[group] = [];
      groups[group].push(f);
    }
    if (fieldSearch) {
      const q = fieldSearch.toLowerCase();
      for (const key of Object.keys(groups)) {
        groups[key] = groups[key].filter(
          (f) => f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q),
        );
      }
    }
    return groups;
  }, [fields, fieldSearch]);

  const formatGroups = useMemo(() => {
    const groups: Record<string, FormatInfo[]> = {};
    for (const f of formats) {
      const cat = f.category || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(f);
    }
    return groups;
  }, [formats]);

  const hasDateRange = dateFrom || dateTo;
  const dateValidation = useMemo(() => {
    if (!dateFrom || !dateTo) return null;
    const from = new Date(fromISTInputs(dateFrom, timeFrom));
    const to = new Date(fromISTInputs(dateTo, timeTo));
    if (from > to) return 'Date From must be before Date To';
    return null;
  }, [dateFrom, dateTo, timeFrom, timeTo]);

  const canExport = selectedStocks.length > 0 && selectedFormats.size > 0 && !dateValidation && jobStage === 'idle';

  const toggleFormat = useCallback((id: string) => {
    setSelectedFormats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllFormats = useCallback((ids: string[]) => {
    setSelectedFormats((prev) => {
      const next = new Set(prev);
      let anyMissing = false;
      for (const id of ids) if (!next.has(id)) { anyMissing = true; break; }
      if (anyMissing) ids.forEach((id) => next.add(id));
      else ids.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const handleEstimate = useCallback(async () => {
    const symbols = selectedStocks;
    const fmts = Array.from(selectedFormats);
    const fieldsStr = fieldMode === 'custom' ? effectiveFields.join(',') : '';
    if (symbols.length === 0 || fmts.length === 0) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    try {
      const baseParams: Record<string, string> = {
        symbols: symbols.join(','),
        fields: fieldsStr,
      };
      if (dateFrom) baseParams.start = fromISTInputs(dateFrom, timeFrom);
      if (dateTo) baseParams.end = fromISTInputs(dateTo, timeTo);

      const perPromise = fmts.map(async (fmt) => {
        try {
          const p = await getDownloadPreview({ ...baseParams, format: fmt });
          return { format: fmt, p };
        } catch {
          return { format: fmt, p: null };
        }
      });
      const settled = await Promise.all(perPromise);
      const valid = settled.filter((s) => s.p && s.p.formatAvailable !== false) as {
        format: string; p: any;
      }[];
      if (valid.length === 0) {
        setPreview(null);
        setPreviewLoading(false);
        return;
      }
      const first = valid[0].p;
      const estimatedSize = valid.reduce((sum, s) => sum + (Number(s.p.estimatedSizeBytes) || 0), 0);
      const perFormat = valid.map((s) => ({
        format: s.format,
        size: Number(s.p.estimatedSizeBytes) || 0,
        available: s.p.formatAvailable !== false,
      }));
      setPreview({
        symbolCount: Number(first.symbolCount) || symbols.length,
        estimatedRecords: Number(first.estimatedRecords) || 0,
        effectiveRecords: Number(first.effectiveRecords) || 0,
        serverRowLimit: Number(first.serverRowLimit) || 50000,
        streamLimit: 50000,
        estimatedSize,
        willTruncate: !!(first.willTruncate),
        perFormat,
        sampleSize: Number(first.sampleSize) || 0,
      });
    } catch {
      setPreview(null);
    }
    setPreviewLoading(false);
  }, [selectedStocks, selectedFormats, fieldMode, effectiveFields, dateFrom, dateTo, timeFrom, timeTo]);

  useEffect(() => {
    if (selectedStocks.length > 0 && selectedFormats.size > 0) {
      const t = setTimeout(handleEstimate, 400);
      return () => clearTimeout(t);
    }
    setPreview(null);
  }, [selectedStocks, selectedFormats, fieldMode, effectiveFields, dateFrom, dateTo, timeFrom, timeTo, handleEstimate]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const h = await getDownloadHistory({ limit: 5 });
      setHistory(h?.items ?? []);
    } catch {
      setHistory([]);
    }
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const startExport = useCallback(async () => {
    if (!canExport) return;
    setError(null);
    setExportResult(null);
    setJobStage('queued');
    setJobProgress(0);
    abortRef.current = false;
    startTimeRef.current = Date.now();
    setElapsed(0);

    const tick = setInterval(() => {
      setElapsed(Date.now() - startTimeRef.current);
    }, 200);

    const payloadFormats = Array.from(selectedFormats).filter((f) => f !== 'zip');
    const packageZip = compression === 'zip';

    try {
      const payload: Record<string, unknown> = {
        symbols: selectedStocks,
        symbolMode: 'custom',
        formats: payloadFormats.length ? payloadFormats : ['csv'],
        packageZip,
        clientId: `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
      if (fieldMode === 'custom' && effectiveFields.length > 0) {
        payload.fields = effectiveFields.join(',');
      }
      if (dateFrom) payload.start = fromISTInputs(dateFrom, timeFrom);
      if (dateTo) payload.end = fromISTInputs(dateTo, timeTo);

      const { jobId } = await createExportJob(payload as any);
      setActiveJobId(jobId);

      while (true) {
        if (abortRef.current) throw new Error('Cancelled');
        await new Promise((r) => setTimeout(r, 900));
        const job = await getExportJob(jobId);
        const stage = STAGE_MAP[job.stage] || 'queued';
        setJobStage(stage);
        setJobProgress(job.progressPercent ?? 0);

        if (job.status === 'COMPLETED') {
          setJobStage('downloading');
          const art = await fetchExportArtifact(jobId);
          triggerBrowserDownload(art.blob, art.filename);
          setJobStage('completed');
          setExportResult({
            jobId,
            status: 'completed',
            records: job.recordCount ?? null,
            files: payloadFormats.length,
            size: job.fileSize ?? null,
            duration: Date.now() - startTimeRef.current,
            fileName: art.filename,
            createdAt: job.createdAt ?? null,
            completedAt: job.completedAt ?? null,
            error: null,
            formats: packageZip ? [...payloadFormats] : payloadFormats,
          });
          loadHistory();
          break;
        }
        if (job.status === 'FAILED') {
          throw new Error(job.error || 'Export failed');
        }
        if (job.status === 'CANCELLED') {
          throw new Error('Export cancelled');
        }
      }
    } catch (e: any) {
      if (e?.message !== 'Cancelled') {
        setJobStage('failed');
        setError(e?.message || 'Export failed');
        setExportResult({
          jobId: activeJobId ?? '',
          status: 'failed',
          records: null,
          files: 0,
          size: null,
          duration: Date.now() - startTimeRef.current,
          fileName: null,
          createdAt: null,
          completedAt: null,
          error: e?.message || 'Export failed',
          formats: Array.from(selectedFormats),
        });
      } else {
        setJobStage('idle');
      }
    } finally {
      clearInterval(tick);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
  }, [canExport, selectedStocks, selectedFormats, fieldMode, effectiveFields, dateFrom, dateTo, timeFrom, timeTo, activeJobId, compression, loadHistory]);

  const handleCancel = useCallback(() => {
    if (activeJobId) {
      abortRef.current = true;
      cancelExportJob(activeJobId).catch(() => {});
      setJobStage('idle');
      setJobProgress(0);
      setActiveJobId(null);
    }
  }, [activeJobId]);

  const resetForm = useCallback(() => {
    setJobStage('idle');
    setJobProgress(0);
    setActiveJobId(null);
    setExportResult(null);
    setError(null);
    setElapsed(0);
  }, []);

  const StageIcon = (jobStage === 'completed' || jobStage === 'failed') ? (exportResult?.status === 'completed' ? Check : AlertCircle) : STAGE_ICONS[jobStage];

  const groupedFormats = Object.entries(formatGroups);
  const totalSelectedFormatCount = selectedFormats.size;

  return (
    <div className="space-y-4 pb-6">
      <PageHeader
        title="Downloads"
        subtitle="Export real tick data in one or more formats with live preview"
      />

      {/* Colorful hero — live pipeline snapshot */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-teal-500/15 via-sky-500/10 to-violet-500/15 px-5 py-4">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-to-br from-teal-500/25 to-violet-500/20 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-12 -left-8 h-36 w-36 rounded-full bg-gradient-to-br from-amber-500/20 to-rose-500/15 blur-2xl" />
        <div className="relative flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-lg shadow-teal-500/25">
              <ArrowDownToLine className="h-5 w-5" />
            </span>
            <div>
              <p className="flex items-center gap-1.5 text-sm font-bold">
                Tick Data Export <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              </p>
              <p className="text-[11px] text-muted-foreground">Pick DB stocks or search the full instrument master</p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <HeroStat
              gradient="from-teal-500 to-emerald-500"
              value={dbStockCount == null ? '…' : String(dbStockCount)}
              label="Stocks in DB"
            />
            <HeroStat
              gradient="from-sky-500 to-blue-500"
              value={selectedStocks.length > 0 ? String(selectedStocks.length) : '0'}
              label="Selected"
            />
            <HeroStat
              gradient="from-violet-500 to-purple-500"
              value={formatsLoading ? '…' : String(formats.length)}
              label="Formats"
            />
            <HeroStat
              gradient="from-amber-500 to-orange-500"
              value={historyLoading ? '…' : String(history.length)}
              label="Recent exports"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {jobStage === 'idle' && !exportResult && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2 space-y-4">
            {/* 01 · STOCKS */}
            <SectionCard
              title="01 · Stock Selection"
              icon={Search}
              className="border-t-2 border-t-teal-500"
              headerRight={
                selectedStocks.length > 0 ? (
                  <Badge className="border-0 bg-gradient-to-r from-teal-500 to-emerald-500 text-[10px] text-white">
                    {selectedStocks.length} selected
                  </Badge>
                ) : null
              }
            >
              <div className="space-y-4">
                <div>
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold">
                    <Search className="h-3.5 w-3.5 text-teal-500" /> Search full instrument master
                  </p>
                  <StockSearchPopover
                    selected={selectedStocks}
                    onSelect={setSelectedStocks}
                    subscribedSymbols={subscribedSymbols}
                  />
                </div>
                <div className="border-t border-dashed border-border pt-3">
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
                    <Database className="h-3.5 w-3.5 text-emerald-500" /> Ya DB ke stocks me se chuno
                    <span className="font-normal text-muted-foreground">— naam + aaj ke ticks ke saath</span>
                  </p>
                  <DbStocks
                    selected={selectedStocks}
                    onToggle={toggleStock}
                    onSelectAll={selectDbSymbols}
                    onClear={() => setSelectedStocks([])}
                    onLoaded={handleDbLoaded}
                  />
                </div>
              </div>
            </SectionCard>

            {/* 02 · DATE & TIME */}
            <SectionCard title="02 · Date & Time Range" icon={Calendar} className="border-t-2 border-t-sky-500">
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => {
                      const today = new Date();
                      const y = today.getFullYear();
                      const m = String(today.getMonth() + 1).padStart(2, '0');
                      const d = String(today.getDate()).padStart(2, '0');
                      setDateFrom(`${y}-${m}-${d}`);
                      setDateTo(`${y}-${m}-${d}`);
                    }}
                  >
                    Today
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => {
                      const today = new Date();
                      today.setDate(today.getDate() - 1);
                      const y = today.getFullYear();
                      const m = String(today.getMonth() + 1).padStart(2, '0');
                      const d = String(today.getDate()).padStart(2, '0');
                      setDateFrom(`${y}-${m}-${d}`);
                      setDateTo(`${y}-${m}-${d}`);
                    }}
                  >
                    Yesterday
                  </Button>
                  {[
                    { label: 'Last 7 days', days: 7 },
                    { label: 'Last 30 days', days: 30 },
                  ].map((p) => (
                    <Button
                      key={p.label}
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => {
                        const end = new Date();
                        const start = new Date();
                        start.setDate(start.getDate() - p.days);
                        setDateFrom(toISTDateInput(start.toISOString()));
                        setDateTo(toISTDateInput(end.toISOString()));
                      }}
                    >
                      {p.label}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => { setDateFrom(''); setDateTo(''); }}
                  >
                    Clear
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Date From</label>
                    <Input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Date To</label>
                    <Input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Time From</label>
                    <Input
                      type="time"
                      value={timeFrom}
                      onChange={(e) => setTimeFrom(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Time To</label>
                    <Input
                      type="time"
                      value={timeTo}
                      onChange={(e) => setTimeTo(e.target.value)}
                    />
                  </div>
                </div>
                {dateValidation && (
                  <p className="text-[11px] text-destructive">{dateValidation}</p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  All times in IST (Asia/Kolkata) · Trading hours: 09:15 → 15:30
                </p>
              </div>
            </SectionCard>

            {/* 03 · FORMAT */}
            <SectionCard
              title="03 · Format"
              icon={Layers}
              className="border-t-2 border-t-violet-500"
              headerRight={
                <Badge className="border-0 bg-gradient-to-r from-violet-500 to-purple-500 text-[10px] text-white">
                  {totalSelectedFormatCount} selected
                </Badge>
              }
            >
              {formatsLoading ? (
                <div className="grid grid-cols-3 gap-2">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-20 animate-pulse rounded-lg bg-muted/50" />
                  ))}
                </div>
              ) : formats.length === 0 ? (
                <p className="text-xs text-muted-foreground">No formats available</p>
              ) : (
                <div className="space-y-3">
                  {groupedFormats.map(([category, fmts]) => {
                    const groupIds = fmts.map((f) => f.id);
                    const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedFormats.has(id));
                    return (
                      <div key={category}>
                        <div className="mb-1.5 flex items-center justify-between">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                            {category}
                          </p>
                          <button
                            type="button"
                            onClick={() => toggleAllFormats(groupIds)}
                            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {allSelected ? 'Clear group' : 'Select all'}
                          </button>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6">
                          {fmts.map((f) => {
                            const Icon = FORMAT_ICONS[f.id] || FileText;
                            const sel = selectedFormats.has(f.id);
                            const tint = formatTint(category);
                            return (
                              <button
                                key={f.id}
                                type="button"
                                role="checkbox"
                                aria-checked={sel}
                                aria-label={`${f.displayName || f.name || f.id} format`}
                                onClick={() => toggleFormat(f.id)}
                                disabled={!f.available}
                                className={cn(
                                  'flex flex-col items-center gap-1 rounded-xl border-2 px-2 py-2.5 text-center transition-all hover:-translate-y-px hover:shadow-md',
                                  !f.available && 'opacity-40 cursor-not-allowed',
                                  sel
                                    ? cn(tint.ring, `bg-gradient-to-b ${tint.bg} shadow-sm`)
                                    : 'border-border/70 text-muted-foreground hover:bg-muted/30',
                                )}
                              >
                                <Icon className={cn('h-5 w-5', sel ? tint.text : '')} />
                                <span className={cn('text-[10px] font-bold', sel && tint.text)}>
                                  {(f.displayName || f.name || f.id).toUpperCase()}
                                </span>
                                {f.extension && (
                                  <span className="rounded bg-muted px-1 text-[9px] font-mono text-muted-foreground">.{f.extension}</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionCard>

            {/* 04 · FIELDS */}
            <SectionCard
              title="04 · Fields"
              icon={SlidersHorizontal}
              className="border-t-2 border-t-amber-500"
              headerRight={
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-[10px]">
                    {fieldMode === 'all' ? `${fields.length} / ${fields.length}` : `${selectedFields.size} / ${fields.length}`}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setShowFields(!showFields)}
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5"
                  >
                    {showFields ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    {showFields ? 'Hide' : 'Show'}
                  </button>
                </div>
              }
            >
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <ToggleGroup
                    type="single"
                    value={fieldMode}
                    onValueChange={(v) => { if (v) setFieldMode(v as 'all' | 'custom'); }}
                    className="justify-start"
                  >
                    <ToggleGroupItem value="all" className="text-xs h-7">All Fields</ToggleGroupItem>
                    <ToggleGroupItem value="custom" className="text-xs h-7">Custom</ToggleGroupItem>
                  </ToggleGroup>
                </div>

                {showFields && fieldMode === 'custom' && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Search fields..."
                        value={fieldSearch}
                        onChange={(e) => setFieldSearch(e.target.value)}
                        className="h-8 text-xs"
                      />
                      <Button size="sm" variant="outline" className="h-8 text-xs whitespace-nowrap"
                        onClick={() => setSelectedFields(new Set(fields.map((f) => f.name)))}>
                        Select All
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 text-xs"
                        onClick={() => setSelectedFields(new Set())}>
                        Clear
                      </Button>
                    </div>
                    {Object.entries(filteredFieldGroups).map(([group, groupFields]) => {
                      const allSel = groupFields.length > 0 && groupFields.every((f) => selectedFields.has(f.name));
                      return (
                        <div key={group} className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">{group}</p>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedFields((prev) => {
                                  const next = new Set(prev);
                                  const ids = groupFields.map((f) => f.name);
                                  if (allSel) ids.forEach((id) => next.delete(id));
                                  else ids.forEach((id) => next.add(id));
                                  return next;
                                });
                              }}
                              className="text-[10px] text-muted-foreground hover:text-foreground"
                            >
                              {allSel ? 'Clear group' : 'Select all'}
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                            {groupFields.map((f) => (
                              <label
                                key={f.name}
                                className={cn(
                                  'flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-xs transition',
                                  selectedFields.has(f.name)
                                    ? 'border-primary/30 bg-primary/5'
                                    : 'hover:bg-muted/40',
                                )}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={f.name}
                                  checked={selectedFields.has(f.name)}
                                  onChange={() => {
                                    const next = new Set(selectedFields);
                                    if (next.has(f.name)) next.delete(f.name);
                                    else next.add(f.name);
                                    setSelectedFields(next);
                                  }}
                                  className="h-3.5 w-3.5 rounded border-border"
                                />
                                <span className="truncate">{f.name}</span>
                                {f.type && (
                                  <span className="ml-auto text-[9px] text-muted-foreground">{f.type}</span>
                                )}
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {showFields && fieldMode === 'all' && (
                  <div className="flex flex-wrap gap-1">
                    {fields.map((f) => (
                      <Badge key={f.name} variant="secondary" className="text-[10px] font-mono">
                        {f.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </SectionCard>

            {/* 05 · COMPRESSION */}
            <SectionCard title="05 · Compression" icon={Archive} className="border-t-2 border-t-rose-500">
              <div className="flex gap-2">
                {['none', 'zip'].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCompression(c)}
                    className={cn(
                      'rounded-lg border px-4 py-2 text-xs font-medium transition-colors',
                      compression === c
                        ? 'border-primary/50 bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {c === 'none' ? 'None' : 'ZIP Archive'}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {compression === 'zip'
                  ? 'All selected formats will be packaged into a single ZIP archive.'
                  : selectedStocks.length > 1
                    ? 'Multiple stocks are always packaged into a ZIP archive with per-symbol folders.'
                    : selectedFormats.size > 1
                      ? 'Multiple formats are bundled into a ZIP archive with one file per format.'
                      : 'A single file will be produced.'}
              </p>
            </SectionCard>

            {/* 06 · ADVANCED */}
            <SectionCard title="06 · Advanced" icon={History} className="border-t-2 border-t-cyan-500">
              <div className="flex items-center justify-between gap-3 text-xs">
                <div>
                  <p className="font-medium">Download History</p>
                  <p className="text-[11px] text-muted-foreground">View and re-download your recent exports</p>
                </div>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={loadHistory} disabled={historyLoading}>
                  {historyLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
                  Refresh
                </Button>
              </div>
              {history.length > 0 ? (
                <div className="mt-3 space-y-1.5">
                  {history.map((h) => (
                    <div key={h._id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {(h.fileName || `${h.format} export`)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {h.symbols?.length ?? 0} stock{h.symbols?.length !== 1 ? 's' : ''} · {fmtCount(h.count)} records · {fmtDateIST(h.ts)}
                        </p>
                      </div>
                      <Badge variant="secondary" className="shrink-0 text-[9px] font-mono">
                        {(h.format || '').toUpperCase()}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {historyLoading ? 'Loading history...' : 'No exports yet.'}
                </p>
              )}
            </SectionCard>
          </div>

          {/* Sticky preview column */}
          <div className="space-y-4">
            <Card className="sticky top-4 overflow-hidden border-t-2 border-t-emerald-500">
              <CardContent className="px-4 py-3.5">
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-md shadow-teal-500/25">
                    <Eye className="h-4 w-4" />
                  </span>
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-wider">Export Preview</h3>
                    <p className="text-[10px] text-muted-foreground">Live estimate as you pick</p>
                  </div>
                </div>

                <dl className="space-y-2">
                  <PreviewRow label="Stocks" value={selectedStocks.length > 0 ? `${selectedStocks.length} selected` : 'None selected'} />
                  {selectedStocks.length > 0 && selectedStocks.length <= 6 && (
                    <div className="flex flex-wrap gap-1 pb-1">
                      {selectedStocks.map((s) => (
                        <Badge key={s} variant="secondary" className="text-[9px] font-mono">{s}</Badge>
                      ))}
                    </div>
                  )}
                  <PreviewRow
                    label="Formats"
                    value={totalSelectedFormatCount > 0 ? `${totalSelectedFormatCount} selected` : 'None'}
                  />
                  {totalSelectedFormatCount > 0 && (
                    <div className="flex flex-wrap gap-1 pb-1">
                      {formats
                        .filter((f) => selectedFormats.has(f.id))
                        .map((f) => (
                          <Badge key={f.id} variant="outline" className="text-[9px] font-mono">
                            {(f.displayName || f.name || f.id).toUpperCase()}
                          </Badge>
                        ))}
                    </div>
                  )}
                  <PreviewRow label="Fields" value={fieldMode === 'all' ? `All (${fields.length})` : `${selectedFields.size} / ${fields.length}`} />
                  <PreviewRow label="Date" value={dateFrom && dateTo ? `${dateFrom} → ${dateTo}` : 'All recorded data'} />
                  <PreviewRow label="Time" value={`${timeFrom} → ${timeTo} IST`} />
                  <PreviewRow label="Compression" value={compression === 'none' ? 'None' : 'ZIP'} />
                  {preview && (
                    <>
                      <PreviewRow label="Estimated Records" value={fmtCount(preview.effectiveRecords)} />
                      <PreviewRow label="Estimated Size" value={fmtBytes(preview.estimatedSize)} />
                      {preview.perFormat.length > 1 && (
                        <div className="border-t border-border/50 pt-1">
                          {preview.perFormat.map((pf) => (
                            <div key={pf.format} className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                              <span className="uppercase">{pf.format}</span>
                              <span className="tabular-nums">{pf.available ? fmtBytes(pf.size) : 'N/A'}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {preview.willTruncate && (
                        <p className="text-[10px] text-warning">Truncated to {fmtCount(preview.serverRowLimit)} records</p>
                      )}
                    </>
                  )}
                </dl>

                {preview && selectedStocks.length > 0 && (
                  <div className="mt-3 rounded-lg border border-border/50 bg-muted/20 p-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Package Structure</p>
                    <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap">
                      {generatePackagePreview(selectedStocks, Array.from(selectedFormats), compression)}
                    </pre>
                  </div>
                )}

                <div className="mt-4 space-y-2">
                  <Button
                    className="w-full border-0 bg-gradient-to-r from-teal-500 via-emerald-500 to-teal-600 font-semibold text-white shadow-lg shadow-teal-500/25 transition-all hover:shadow-xl hover:shadow-teal-500/30 hover:brightness-110 disabled:opacity-50 disabled:shadow-none"
                    disabled={!canExport}
                    onClick={startExport}
                  >
                    <ArrowDownToLine className="h-4 w-4 mr-1.5" />
                    Start Export
                  </Button>
                  {!canExport && selectedStocks.length === 0 && (
                    <p className="text-center text-[10px] text-muted-foreground">Select at least one stock to export</p>
                  )}
                  {previewLoading && (
                    <p className="text-center text-[10px] text-muted-foreground">
                      <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                      Estimating...
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {(jobStage !== 'idle' || exportResult) && (
        <SectionCard
          title={exportResult?.status === 'completed' ? 'Export Completed' : 'Export Progress'}
          icon={StageIcon}
          headerRight={
            (jobStage === 'queued' || jobStage === 'preparing' || jobStage === 'reading' || jobStage === 'exporting' || jobStage === 'compressing') ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={handleCancel}>
                Cancel
              </Button>
            ) : jobStage === 'completed' || jobStage === 'failed' ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={resetForm}>
                New Export
              </Button>
            ) : null
          }
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Badge
                variant={
                  jobStage === 'completed' ? 'default'
                  : jobStage === 'failed' ? 'destructive'
                  : 'secondary'
                }
                className="text-xs"
              >
                {STAGE_LABELS[jobStage]}
              </Badge>
              {jobStage !== 'completed' && jobStage !== 'failed' && jobStage !== 'idle' && (
                <span className="text-xs tabular-nums text-muted-foreground">{jobProgress.toFixed(0)}%</span>
              )}
            </div>

            {jobStage !== 'completed' && jobStage !== 'failed' && jobStage !== 'idle' && (
              <div className="space-y-2">
                <div className="h-2.5 w-full rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-teal-500 via-emerald-500 to-sky-500 transition-all duration-500"
                    style={{ width: `${jobProgress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Elapsed: {fmtDuration(elapsed)}</span>
                  {jobProgress > 5 && (
                    <span>~{fmtDuration((elapsed / jobProgress) * (100 - jobProgress))} remaining</span>
                  )}
                </div>
              </div>
            )}

            {exportResult && exportResult.status === 'completed' && (
              <div className="rounded-lg border border-success/30 bg-success/5 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Check className="h-5 w-5 text-success" />
                  <span className="text-sm font-semibold text-success">Export Completed</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">Job ID</dt>
                  <dd className="font-mono text-[11px]">{exportResult.jobId.slice(0, 16)}...</dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{fmtIST(exportResult.createdAt)}</dd>
                  <dt className="text-muted-foreground">Duration</dt>
                  <dd>{fmtDuration(exportResult.duration)}</dd>
                  <dt className="text-muted-foreground">Stocks</dt>
                  <dd>{selectedStocks.length}</dd>
                  <dt className="text-muted-foreground">Records</dt>
                  <dd>{fmtCount(exportResult.records)}</dd>
                  <dt className="text-muted-foreground">Formats</dt>
                  <dd>{exportResult.formats.length > 0 ? exportResult.formats.map((f) => f.toUpperCase()).join(', ') : '—'}</dd>
                  <dt className="text-muted-foreground">Compression</dt>
                  <dd>{compression === 'none' ? (selectedStocks.length > 1 ? 'ZIP (multi-stock)' : 'None') : 'ZIP'}</dd>
                  <dt className="text-muted-foreground">Package</dt>
                  <dd className="font-mono text-[11px]">{exportResult.fileName || 'Not available'}</dd>
                  <dt className="text-muted-foreground">Size</dt>
                  <dd>{fmtBytes(exportResult.size)}</dd>
                </dl>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={resetForm} className="gap-1.5">
                    <ArrowDownToLine className="h-3.5 w-3.5" /> New Export
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => window.location.href = '/data-saver/download-history'}>
                    View History
                  </Button>
                </div>
              </div>
            )}

            {exportResult && exportResult.status === 'failed' && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                  <span className="text-sm font-semibold text-destructive">Export Failed</span>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-xs text-muted-foreground">{exportResult.error}</p>
                  <StatusBadge status="danger" label="Retry preserves your settings" />
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => { resetForm(); startExport(); }} className="gap-1.5">
                    <ArrowDownToLine className="h-3.5 w-3.5" /> Retry
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function HeroStat({ gradient, value, label }: { gradient: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-3 py-1.5 backdrop-blur">
      <span className={cn('h-7 w-1.5 rounded-full bg-gradient-to-b', gradient)} />
      <span>
        <span className="block text-sm font-bold leading-none tabular-nums">{value}</span>
        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[22px] items-center justify-between gap-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xs font-medium text-right">{value}</dd>
    </div>
  );
}

function generatePackagePreview(stocks: string[], fmts: string[], compression: string): string {
  if (stocks.length === 0) return 'Select stocks to see package preview';
  const exts = fmts.length ? fmts.map((f) => extFor(f)) : ['csv'];
  const zipped = compression === 'zip' || stocks.length > 1 || exts.length > 1;
  const date = istDateKey();

  if (stocks.length === 1 && exts.length === 1 && !zipped) {
    return `KAUSTUBH_${stocks[0]}_${date}.${exts[0]}`;
  }
  const zipName = stocks.length === 1 ? `KAUSTUBH_${stocks[0]}_${date}.zip` : `KAUSTUBH_EXPORT_${date}.zip`;
  let lines = zipName + '\n';
  stocks.forEach((s, i) => {
    const prefix = i === stocks.length - 1 ? '└──' : '├──';
    lines += `${prefix} ${s}/\n`;
    const inner = i === stocks.length - 1 ? '    ' : '│   ';
    exts.forEach((ext, j) => {
      const p = j === exts.length - 1 ? '└──' : '├──';
      lines += `${inner}${p} tick-data.${ext}\n`;
    });
  });
  return lines;
}

function extFor(format: string): string {
  switch (format) {
    case 'csv': case 'csv_bom': return 'csv';
    case 'json': case 'jsonl': case 'ndjson': return format === 'json' ? 'json' : 'jsonl';
    case 'tsv': return 'tsv';
    case 'txt': return 'txt';
    case 'parquet': return 'parquet';
    case 'feather': return 'feather';
    case 'xlsx': return 'xlsx';
    case 'ods': return 'ods';
    case 'sql': return 'sql';
    case 'sqlite': return 'db';
    case 'xml': return 'xml';
    case 'html': return 'html';
    case 'yaml': return 'yaml';
    case 'avro': return 'avro';
    default: return format;
  }
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
