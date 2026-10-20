'use client';

// ---- Export configuration + real pre-download preview ----
//
// • Data Type: only types that actually exist in this backend (tick data).
// • File Format: curated selectable cards — CSV / JSON / XLSX — gated on the
//   backend serializer registry availability. No 25-pill soup.
// • ZIP packaging: explicit card; forced ON whenever the export contains
//   more than one file (multiple stocks or multiple formats).
// • Preview: real estimates from GET /api/downloads/preview (same query the
//   export runs). Unavailable values render as N/A, never "-".

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, Braces, Check, Database, Download, FileDown, FileSpreadsheet, FileText,
  Loader2, SlidersHorizontal, TriangleAlert,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getDownloadFormats, getDownloadPreview } from '@/lib/api';
import { fmtBytes } from '@/lib/data-center';
import type { DcStock, StockMode } from '@/components/data-center/stock-selection';
import ExportProgress, {
  stageButtonLabel, type ExportStage,
} from '@/components/data-center/export-progress';

export interface ExportConfigState {
  stockMode: StockMode;
  selectedStocks: string[];
  selectedFormats: string[];
  fieldMode: string;
  selectedFields: string[];
  startDate: string;
  endDate: string;
}

type FormatInfo = {
  id: string;
  displayName?: string;
  extension: string;
  available: boolean;
  category?: string;
};

/** Format icons mapping for known format categories */
const FORMAT_ICON_MAP: Record<string, React.ElementType> = {
  csv: FileText, csv_bom: FileText, tsv: FileText, txt: FileText,
  markdown: FileText, html: FileText, xml: FileText,
  json: Braces, jsonl: Braces, ndjson: Braces, json_gz: Braces, jsonl_gz: Braces,
  sql: FileText,
  xlsx: FileSpreadsheet, ods: FileSpreadsheet,
  parquet: Archive, feather: Archive, arrow_ipc: Archive,
  avro: Archive,
  sqlite: Database, yaml: FileText, toml: FileText,
  zip: Archive, gzip: Archive, csv_gz: FileText,
};

/** Format category labels for grouping */
const FORMAT_CATEGORIES: Record<string, string> = {
  Tabular: 'Tabular',
  'Structured': 'Structured',
  Spreadsheet: 'Spreadsheet',
  'Columnar': 'Columnar',
  Database: 'Database',
  Archive: 'Archive',
};

const PREVIEW_DEBOUNCE_MS = 400;

function toIso(localDt: string): string {
  if (!localDt) return '';
  const d = new Date(localDt);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

export default function ExportConfig({
  config,
  stocks,
  fieldsCount,
  downloading,
  jobPhase,
  jobStage,
  progressPercent,
  onDownload,
  onFormatsChange,
}: {
  config: ExportConfigState;
  stocks: DcStock[];
  /** Total known tick fields (for "All fields" count). */
  fieldsCount: number;
  downloading: boolean;
  jobPhase: 'idle' | 'running' | 'ready' | 'error';
  jobStage: ExportStage;
  progressPercent: number;
  onDownload: () => void;
  onFormatsChange: (next: string[]) => void;
}) {
  const [backendFormats, setBackendFormats] = useState<FormatInfo[]>([]);
  const [preview, setPreview] = useState<{
    symbols?: string[];
    symbolCount?: number;
    estimatedRecords?: number;
    effectiveRecords?: number;
    serverRowLimit?: number;
    estimatedSizeBytes?: number;
    willTruncate?: boolean;
    formatAvailable?: boolean;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDownloadFormats()
      .then((d) => { if (!cancelled) setBackendFormats(d.formats ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const availableIds = useMemo(
    () => new Set(backendFormats.filter((f) => f.available).map((f) => f.id)),
    [backendFormats],
  );

  // Group formats by category
  const formatGroups = useMemo(() => {
    const groups: Record<string, FormatInfo[]> = {};
    backendFormats.forEach((f) => {
      const cat = f.category || 'General';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(f);
    });
    return groups;
  }, [backendFormats]);

  const formatIcons = useMemo(() => {
    const map: Record<string, React.ElementType> = {};
    backendFormats.forEach((f) => {
      const base = f.id.replace(/_gz$/, '');
      map[f.id] = FORMAT_ICON_MAP[f.id] || FORMAT_ICON_MAP[base] || FileText;
    });
    return map;
  }, [backendFormats]);

  // Effective export parameters (mirrors what the download request sends).
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (config.selectedFormats.length > 0) p.format = config.selectedFormats.join(',');
    if (config.fieldMode === 'custom' && config.selectedFields.length > 0) {
      p.fields = config.selectedFields.join(',');
    }
    if (config.stockMode === 'all_active' || config.stockMode === 'all') {
      p.all = 'true';
    } else if (config.selectedStocks.length > 0) {
      p.symbols = config.selectedStocks.slice(0, 50).join(',');
    }
    if (config.startDate) p.start = toIso(config.startDate);
    if (config.endDate) p.end = toIso(config.endDate);
    return p;
  }, [config]);

  // Debounced preview fetch.
  const seqRef = useRef(0);
  useEffect(() => {
    if (backendFormats.length === 0) return;
    const hasSelection =
      config.stockMode !== 'custom' || config.selectedStocks.length > 0;
    if (!hasSelection) { setPreview(null); return; }
    const seq = ++seqRef.current;
    setPreviewLoading(true);
    const t = setTimeout(() => {
      getDownloadPreview(params)
        .then((d) => { if (seq === seqRef.current) setPreview(d); })
        .catch(() => { if (seq === seqRef.current) setPreview(null); })
        .finally(() => { if (seq === seqRef.current) setPreviewLoading(false); });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [params, backendFormats.length, config.stockMode, config.selectedStocks.length]);

  const activeSymbols =
    config.stockMode === 'custom'
      ? config.selectedStocks.length
      : config.stockMode === 'all_active'
        ? stocks.filter((s) => s.active).length
        : stocks.length;

  // ZIP packaging is required whenever the output contains >1 file.
  const zipForced = activeSymbols > 1 || config.selectedFormats.length > 1 ||
    (config.stockMode === 'all_active' || config.stockMode === 'all');

  const canDownload =
    activeSymbols > 0 &&
    config.selectedFormats.length > 0 &&
    (config.fieldMode !== 'custom' || config.selectedFields.length > 0) &&
    !downloading;

  const toggleFormat = (id: string) => {
    const next = config.selectedFormats.includes(id)
      ? config.selectedFormats.filter((x) => x !== id)
      : [...config.selectedFormats, id];
    onFormatsChange(next);
  };

  const formatSummary =
    config.selectedFormats.map((f) => f.toUpperCase()).join(' + ') + ' · ZIP';

  const dateRangeLabel = useMemo(() => {
    if (!config.startDate && !config.endDate) return null;
    const fmt = (v: string) => {
      const d = new Date(v);
      return isNaN(d.getTime())
        ? 'N/A'
        : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    };
    return `${fmt(config.startDate)} – ${fmt(config.endDate)}`;
  }, [config.startDate, config.endDate]);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {/* EXPORT CONFIGURATION — data type + format cards */}
      <Card className="shadow-soft">
        <CardContent className="px-4 py-3.5">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple/10 text-purple ring-1 ring-inset ring-purple/25">
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </span>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Data Type &amp; File Format
            </h3>
            <Badge variant="outline" className="ml-auto h-5 border-border/50 bg-muted/40 px-1.5 py-0 text-[10px]">
              {config.selectedFormats.length > 0
                ? `${config.selectedFormats.length} format${config.selectedFormats.length > 1 ? 's' : ''}`
                : 'no format'}
            </Badge>
            {backendFormats.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (config.selectedFormats.length > 0) {
                    onFormatsChange([]);
                  } else {
                    onFormatsChange(backendFormats.filter((f) => f.available).map((f) => f.id));
                  }
                }}
                className="ml-1 text-[9px] text-muted-foreground hover:text-primary transition-colors"
              >
                {config.selectedFormats.length > 0 ? 'clear all' : 'select all'}
              </button>
            )}
          </div>

          {/* DATA TYPE — only what the backend actually captures */}
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Data Type
          </p>
          <button
            type="button"
            aria-pressed="true"
            className="mb-4 flex w-full items-center gap-3 rounded-xl border border-primary/50 bg-primary/[0.07] px-3 py-2.5 text-left"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <FileDown className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">Tick Data</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                Tick-by-tick market events · live capture infrastructure
              </span>
            </span>
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="h-3 w-3" />
            </span>
          </button>

          {/* FILE FORMAT cards — grouped by backend category */}
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            File Format
          </p>
          {Object.keys(formatGroups).length === 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[74px] animate-pulse rounded-xl bg-muted/50" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(formatGroups).map(([category, formats]) => (
                <div key={category}>
                  <p className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {FORMAT_CATEGORIES[category] || category}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {formats.map((fmt) => {
                      const Icon = formatIcons[fmt.id] || FileText;
                      const selected = config.selectedFormats.includes(fmt.id);
                      const displayName = fmt.displayName || fmt.id.toUpperCase();
                      return (
                        <button
                          key={fmt.id}
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          aria-label={`${displayName} (.${fmt.extension}) — ${fmt.available ? 'available' : 'not installed'}`}
                          disabled={!fmt.available}
                          onClick={() => toggleFormat(fmt.id)}
                          className={cn(
                            'group relative flex flex-col items-start gap-1 rounded-xl border px-2.5 py-2 text-left transition-all',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                            !fmt.available && 'opacity-40 cursor-not-allowed',
                            selected
                              ? 'border-primary/60 bg-primary/[0.08] shadow-[0_0_18px_-6px_hsl(var(--primary)/0.45)]'
                              : 'border-border/60 bg-background hover:border-border hover:bg-muted/30',
                          )}
                          title={!fmt.available ? `${displayName} — dependency not installed` : undefined}
                        >
                          <span className="flex w-full items-center justify-between">
                            <Icon className={cn('h-3.5 w-3.5', selected ? 'text-primary' : 'text-muted-foreground')} />
                            {selected && (
                              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                <Check className="h-2.5 w-2.5" />
                              </span>
                            )}
                          </span>
                          <span className={cn('text-[11px] font-bold leading-none', selected && 'text-primary')}>
                            {displayName}
                          </span>
                          <span className="text-[9px] leading-tight text-muted-foreground">.{fmt.extension}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ZIP PACKAGING — informational when forced, still a clear card */}
          <button
            type="button"
            aria-pressed="true"
            aria-disabled={zipForced}
            className={cn(
              'mt-3 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left',
              'border-primary/40 bg-primary/[0.06]',
              zipForced ? 'cursor-default' : '',
            )}
            title={zipForced ? 'ZIP is required for multi-stock / multi-format exports' : undefined}
          >
            <Archive className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">ZIP Package{zipForced ? ' (required)' : ''}</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {zipForced
                  ? 'Multiple stocks/formats are delivered as one archive'
                  : 'Export is delivered as a compressed archive'}
              </span>
            </span>
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="h-3 w-3" />
            </span>
          </button>

          {availableIds.size < backendFormats.length && backendFormats.length > 0 && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              {backendFormats.length - availableIds.size} format{backendFormats.length - availableIds.size !== 1 ? 's' : ''} greyed out — install the required Python packages to enable them.
            </p>
          )}
        </CardContent>
      </Card>

      {/* DOWNLOAD PREVIEW */}
      <Card className={cn('shadow-soft', downloading && 'ring-1 ring-primary/40')}>
        <CardContent className="flex h-full flex-col px-4 py-3.5">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
              <FileDown className="h-3.5 w-3.5" />
            </span>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Download Preview</h3>
            {previewLoading && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>

          {!params.format ? (
            <div className="flex flex-1 items-center justify-center py-6 text-center">
              <p className="text-sm text-muted-foreground">Select at least one format to enable download.</p>
            </div>
          ) : activeSymbols === 0 ? (
            <div className="flex flex-1 items-center justify-center py-6 text-center">
              <p className="text-sm text-muted-foreground">
                No stocks selected — pick stocks or switch to All Active.
              </p>
            </div>
          ) : (
            <>
              <dl className="space-y-1">
                <div className="flex min-h-[26px] items-start justify-between gap-3">
                  <dt className="shrink-0 pt-0.5 text-sm text-muted-foreground">Stocks</dt>
                  <dd className="min-w-0 text-right">
                    <span className="font-mono text-sm font-semibold tabular-nums">{activeSymbols}</span>
                    {config.stockMode === 'custom' && config.selectedStocks.length > 0 && (
                      <span className="ml-2 inline-flex max-w-[240px] flex-wrap justify-end gap-1 align-middle">
                        {config.selectedStocks.slice(0, 3).map((s) => (
                          <Badge key={s} variant="secondary" className="h-4 px-1 py-0 font-mono text-[9px]">{s}</Badge>
                        ))}
                        {config.selectedStocks.length > 3 && (
                          <Badge variant="secondary" className="h-4 px-1 py-0 text-[9px]">
                            +{config.selectedStocks.length - 3}
                          </Badge>
                        )}
                      </span>
                    )}
                  </dd>
                </div>
                <div className="flex min-h-[24px] items-center justify-between gap-3">
                  <dt className="text-sm text-muted-foreground">Date Range</dt>
                  <dd className="truncate font-mono text-xs tabular-nums" title={dateRangeLabel ?? undefined}>
                    {dateRangeLabel ?? 'All recorded history'}
                  </dd>
                </div>
                <div className="flex min-h-[24px] items-center justify-between gap-3">
                  <dt className="text-sm text-muted-foreground">Data Type</dt>
                  <dd className="text-xs font-medium">Tick Data</dd>
                </div>
                <div className="flex min-h-[24px] items-center justify-between gap-3">
                  <dt className="text-sm text-muted-foreground">Fields</dt>
                  <dd className="font-mono text-xs tabular-nums">
                    {config.fieldMode === 'custom' ? config.selectedFields.length : fieldsCount}
                    <span className="text-muted-foreground"> of {fieldsCount}</span>
                  </dd>
                </div>
                <div className="flex min-h-[24px] items-center justify-between gap-3">
                  <dt className="text-sm text-muted-foreground">Format</dt>
                  <dd className="font-mono text-xs font-medium">{formatSummary}</dd>
                </div>
                <div className="flex min-h-[26px] items-center justify-between gap-3">
                  <dt className="text-sm text-muted-foreground">Estimated Records</dt>
                  <dd className="font-mono text-sm font-medium tabular-nums">
                    {preview?.estimatedRecords != null
                      ? preview.estimatedRecords.toLocaleString('en-IN')
                      : 'N/A'}
                  </dd>
                </div>
                <div className="flex min-h-[26px] items-center justify-between gap-3">
                  <dt className="text-sm text-muted-foreground">Estimated Size</dt>
                  <dd className="font-mono text-sm font-medium tabular-nums">
                    {preview?.estimatedSizeBytes != null && preview.estimatedSizeBytes > 0
                      ? fmtBytes(preview.estimatedSizeBytes)
                      : 'N/A'}
                  </dd>
                </div>
              </dl>

              {preview?.willTruncate && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  Matching rows exceed the server limit of{' '}
                  {(preview.serverRowLimit ?? 0).toLocaleString('en-IN')} — the export will contain the
                  first {(preview.effectiveRecords ?? 0).toLocaleString('en-IN')} records. Narrow the date range for full data.
                </p>
              )}

              {jobPhase === 'running' && (
                <div className="mt-3">
                  <ExportProgress stage={jobStage} progressPercent={progressPercent} />
                </div>
              )}

              {jobPhase === 'ready' && (
                <p className="mt-3 flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2.5 py-2 text-xs font-medium text-success">
                  <Check className="h-3.5 w-3.5 shrink-0" /> Download started — selection has been reset.
                </p>
              )}

              <div className="mt-auto pt-3">
                <Button
                  className="w-full gap-2 rounded-xl"
                  size="lg"
                  disabled={!canDownload}
                  onClick={onDownload}
                >
                  {downloading ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> {stageButtonLabel(jobStage) || 'Working…'}</>
                  ) : (
                    <><Download className="h-4 w-4" /> Start Download</>
                  )}
                </Button>
                <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
                  Server-side export job · real tick data · recorded in History when complete
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
