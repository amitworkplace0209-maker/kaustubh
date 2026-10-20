'use client';

import { Suspense, useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Braces, Check, Clock, FileSpreadsheet, FileText,
  Globe, Loader2, Save, Search, Server, X as XIcon,
  Settings, Calendar, ChevronDown, HardDrive, Database, Archive,
} from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  getStocks, getDownloadFormats, createScheduledDownload,
  getScheduledDownload, updateScheduledDownload,
} from '@/lib/api';

type Stock = { symbol: string; active: boolean; company_name?: string };
type Format = { id: string; displayName?: string; extension: string; available: boolean; description: string; category?: string };

type FieldGroup = { name: string; fields: [string, string][] };

const FIELD_GROUPS: FieldGroup[] = [
  { name: 'Identity', fields: [['symbol', 'Symbol'], ['instrumentToken', 'Instrument Token'], ['exchangeSegment', 'Exchange Segment']] },
  { name: 'Price', fields: [['ltp', 'LTP'], ['averagePrice', 'Average Price'], ['change', 'Change'], ['changePercent', 'Change %']] },
  { name: 'OHLC', fields: [['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['close', 'Close']] },
  { name: 'Volume', fields: [['volume', 'Volume'], ['ltq', 'Last Traded Quantity'], ['oi', 'Open Interest']] },
  { name: 'Market Depth', fields: [['tbq', 'Total Buy Qty'], ['tsq', 'Total Sell Qty'], ['bp', 'Best Bid Price'], ['sp', 'Best Ask Price'], ['bq', 'Bid Qty'], ['bs', 'Ask Qty']] },
  { name: 'Timestamp', fields: [['ts', 'Tick Time'], ['receivedAt', 'Received At'], ['timestamp', 'Timestamp']] },
];

const ALL_FIELDS = FIELD_GROUPS.flatMap((g) => g.fields.map(([k]) => k));

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Format icon mapping for all 25+ backend formats */
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

/** Timezone the schedule time is interpreted in (persisted backend-side). */
const TIMEZONES = [
  { id: 'Asia/Kolkata', label: 'Asia/Kolkata — IST' },
  { id: 'UTC', label: 'UTC' },
  { id: 'Asia/Dubai', label: 'Asia/Dubai — GST' },
  { id: 'Asia/Singapore', label: 'Asia/Singapore — SGT' },
  { id: 'Europe/London', label: 'Europe/London — GMT/BST' },
  { id: 'America/New_York', label: 'America/New_York — ET' },
];

/**
 * Deliverable destinations. "server" keeps the artifact downloadable from
 * Export History; "local" additionally copies it into a validated server
 * folder. No fake device/cloud targets.
 */
const DESTINATIONS = [
  { id: 'server', name: 'Downloads Center', desc: 'Stored on server · download from History', Icon: Server, available: true },
  { id: 'local', name: 'Server Folder Copy', desc: 'Additional copy into a server folder', Icon: HardDrive, available: true },
];

function sanitizeName(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'EXPORT';
}

const DATE_RANGE_PRESETS = [
  { id: 'previous_day', label: 'Previous Trading Day' },
  { id: 'last_n_days', label: 'Last N Days' },
  { id: 'today', label: 'Today' },
  { id: 'custom', label: 'Custom Range' },
];

const SCHEDULE_TYPES = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Mon\u2013Fri' },
  { id: 'weekly', label: 'Custom Days' },
];

export default function NewSchedulePage() {
  return (
    <Suspense>
      <ScheduleForm />
    </Suspense>
  );
}

function ScheduleForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get('edit');
  const { toast } = useToast();

  const [stocks, setStocks] = useState<Stock[]>([]);
  const [formats, setFormats] = useState<Format[]>([]);
  const [saving, setSaving] = useState(false);

  // 1. Schedule Name
  const [formName, setFormName] = useState('');

  // 2. Stock Selection
  const [stockMode, setStockMode] = useState<'custom' | 'all_active' | 'all'>('custom');
  const [selectedStocks, setSelectedStocks] = useState<Set<string>>(new Set());
  const [stockSearch, setStockSearch] = useState('');

  // 3. File Formats (curated: CSV / JSON / XLSX)
  const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());

  // 4. Data Fields
  const [fieldMode, setFieldMode] = useState<'all' | 'custom'>('all');
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set(ALL_FIELDS));
  const [fieldConfigOpen, setFieldConfigOpen] = useState(false);
  const [fieldSearch, setFieldSearch] = useState('');

  // 5. Data Range
  const [dateRangeType, setDateRangeType] = useState('previous_day');
  const [dateRangeDays, setDateRangeDays] = useState(7);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  // 6. Frequency
  const [scheduleType, setScheduleType] = useState('daily');
  const [selectedDays, setSelectedDays] = useState<number[]>([0, 1, 2, 3, 4]);

  // 7. Download Time + Timezone
  const [execTime, setExecTime] = useState('16:00');
  const [timezone, setTimezone] = useState('Asia/Kolkata');

  // 8. Destination
  const [destination, setDestination] = useState('server');

  useEffect(() => {
    getStocks().then((d) => {
      const list = (d.data || d.stocks || []).map((s: any) => ({
        symbol: s.symbol,
        active: s.active,
        company_name: s.company_name || s.pDesc || '',
      }));
      setStocks(list);
    }).catch(() => {});
    getDownloadFormats().then((d) => setFormats(d.formats || [])).catch(() => {});
  }, []);

  // ---- Edit mode: prefill from existing job (?edit=<id>) ----
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    getScheduledDownload(editId).then((d) => {
      const job = d.job ?? d;
      if (cancelled || !job) return;
      setFormName(job.name ?? '');
      if (job.symbolMode === 'custom' || job.symbolMode === 'all_active' || job.symbolMode === 'all') {
        setStockMode(job.symbolMode);
      }
      setSelectedStocks(new Set(job.symbols ?? []));
      setSelectedFormats(new Set(job.formats ?? []));
      if (job.fields && job.fields.length > 0) setFieldMode('custom');
      const sched = job.schedule ?? {};
      if (sched.type) setScheduleType(sched.type);
      if (Array.isArray(sched.days) && sched.days.length > 0) setSelectedDays(sched.days);
      if (sched.time) setExecTime(sched.time);
      const range = job.dateRange ?? {};
      if (range.type) setDateRangeType(range.type);
      if (typeof range.days === 'number') setDateRangeDays(range.days);
      if (range.startDate) setCustomStartDate(String(range.startDate).slice(0, 10));
      if (range.endDate) setCustomEndDate(String(range.endDate).slice(0, 10));
      if (job.destination) setDestination(job.destination);
      if (job.timezone) setTimezone(job.timezone);
    }).catch(() => {
      toast({ title: 'Failed to load schedule', variant: 'destructive' });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  // Stock filtering
  const filteredStocks = useMemo(() => {
    const list = stockMode === 'all_active' ? stocks.filter((s) => s.active) : stocks;
    if (!stockSearch) return list;
    const q = stockSearch.toLowerCase();
    return list.filter((s) =>
      s.symbol.toLowerCase().includes(q) ||
      (s.company_name && s.company_name.toLowerCase().includes(q))
    );
  }, [stocks, stockSearch, stockMode]);

  // Format availability from the backend registry.
  const availableFormatIds = useMemo(
    () => new Set(formats.filter((f) => f.available).map((f) => f.id)),
    [formats],
  );

  // Group formats by category
  const formatGroups = useMemo(() => {
    const groups: Record<string, Format[]> = {};
    formats.forEach((f) => {
      const cat = f.category || 'General';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(f);
    });
    return groups;
  }, [formats]);

  // Field filtering
  const filteredFieldGroups = useMemo(() => {
    if (!fieldSearch) return FIELD_GROUPS;
    const q = fieldSearch.toLowerCase();
    return FIELD_GROUPS
      .map((g) => ({
        ...g,
        fields: g.fields.filter(([k, label]) =>
          k.toLowerCase().includes(q) || label.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.fields.length > 0);
  }, [fieldSearch]);

  // Stock selection helpers
  const toggleStock = (sym: string) => {
    const next = new Set(selectedStocks);
    if (next.has(sym)) next.delete(sym); else next.add(sym);
    setSelectedStocks(next);
  };

  const selectAllVisibleStocks = () => {
    const next = new Set(selectedStocks);
    filteredStocks.forEach((s) => next.add(s.symbol));
    setSelectedStocks(next);
  };

  const clearStocks = () => setSelectedStocks(new Set());

  const effectiveStockCount = stockMode === 'all_active'
    ? stocks.filter((s) => s.active).length
    : stockMode === 'all'
      ? stocks.length
      : selectedStocks.size;

  // Format selection helpers
  const toggleFormat = (id: string) => {
    const next = new Set(selectedFormats);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedFormats(next);
  };

  const clearFormats = () => setSelectedFormats(new Set());

  // Field selection helpers
  const toggleField = (key: string) => {
    const next = new Set(selectedFields);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelectedFields(next);
  };

  const selectAllFields = () => setSelectedFields(new Set(ALL_FIELDS));
  const clearFields = () => setSelectedFields(new Set());

  // Output structure preview — mirrors the real exporter package layout.
  const outputPreview = useMemo(() => {
    const syms = stockMode === 'custom'
      ? Array.from(selectedStocks).slice(0, 3)
      : stockMode === 'all_active'
        ? stocks.filter((s) => s.active).slice(0, 3).map((s) => s.symbol)
        : stocks.slice(0, 3).map((s) => s.symbol);
    const fmts = Array.from(selectedFormats).slice(0, 2);
    if (syms.length === 0 || fmts.length === 0) return null;
    const stem = sanitizeName(formName || 'EXPORT');
    const lines = [`KAUSTUBH_${stem}_2026-08-17.zip`];
    for (const sym of syms) {
      lines.push(`  ${sym}/`);
      for (const f of fmts) {
        const ext = formats.find((ff) => ff.id === f)?.extension || f;
        lines.push(`    tick-data.${ext}`);
      }
      break; // one folder sample is enough
    }
    if (syms.length > 1) {
      for (const sym of syms.slice(1)) {
        lines.push(`  ${sym}/`);
      }
    }
    return lines.join('\n');
  }, [stockMode, selectedStocks, selectedFormats, stocks, formats, formName]);

  const canSave = formName.trim() && selectedFormats.size > 0 && effectiveStockCount > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: Record<string, any> = {
        name: formName.trim(),
        enabled: true,
        symbolMode: stockMode,
        symbols: stockMode === 'custom' ? Array.from(selectedStocks) : null,
        fields: fieldMode === 'all' ? null : Array.from(selectedFields),
        formats: Array.from(selectedFormats),
        schedule: {
          type: scheduleType,
          time: execTime,
          days: scheduleType === 'weekly' ? selectedDays : [],
        },
        dateRange: {
          type: dateRangeType,
          days: dateRangeDays,
          startDate: dateRangeType === 'custom' ? customStartDate : undefined,
          endDate: dateRangeType === 'custom' ? customEndDate : undefined,
        },
        destination,
        timezone,
      };
      if (editId) {
        await updateScheduledDownload(editId, payload);
        toast({ title: 'Schedule updated' });
      } else {
        await createScheduledDownload(payload);
        toast({ title: 'Schedule created' });
      }
      router.push('/downloads');
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/downloads" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition">
          <ArrowLeft className="h-4 w-4" />
          Back to Downloads
        </Link>
      </div>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">{editId ? 'Edit Schedule' : 'New Schedule'}</h1>
        <p className="text-sm text-muted-foreground mt-1">{editId ? `Editing "${formName || 'schedule'}"` : 'Create a recurring data export schedule'}</p>
      </div>

      {/* 1. Schedule Name */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">1. Schedule Name</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="e.g., Daily RELIANCE export"
          />
        </CardContent>
      </Card>

      {/* 2. Stock Selection */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base font-semibold">2. Stock Selection</CardTitle>
          <Badge variant="secondary" className="text-xs">
            {effectiveStockCount} {stockMode === 'custom' ? 'selected' : 'stocks'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleGroup
            type="single"
            value={stockMode}
            onValueChange={(v) => { if (v) setStockMode(v as typeof stockMode); }}
            className="justify-start"
          >
            <ToggleGroupItem value="custom" className="text-xs">Custom</ToggleGroupItem>
            <ToggleGroupItem value="all_active" className="text-xs">All Active ({stocks.filter((s) => s.active).length})</ToggleGroupItem>
            <ToggleGroupItem value="all" className="text-xs">All ({stocks.length})</ToggleGroupItem>
          </ToggleGroup>

          {stockMode === 'custom' && (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search stocks..."
                  value={stockSearch}
                  onChange={(e) => setStockSearch(e.target.value)}
                  className="pl-10"
                />
                {stockSearch && (
                  <XIcon className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 cursor-pointer text-muted-foreground" onClick={() => setStockSearch('')} />
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={selectAllVisibleStocks}>Select All</Button>
                <Button size="sm" variant="ghost" onClick={clearStocks}>Clear All</Button>
              </div>

              {selectedStocks.size > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Array.from(selectedStocks).map((s) => (
                    <Badge key={s} variant="secondary" className="text-xs cursor-pointer" onClick={() => toggleStock(s)}>
                      {s} <XIcon className="h-3 w-3 ml-1" />
                    </Badge>
                  ))}
                </div>
              )}

              <div className="max-h-48 overflow-y-auto rounded-md border">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="p-2 text-left font-medium w-8">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-border"
                          checked={filteredStocks.length > 0 && filteredStocks.every((s) => selectedStocks.has(s.symbol))}
                          onChange={(e) => {
                            const next = new Set(selectedStocks);
                            filteredStocks.forEach((s) => e.target.checked ? next.add(s.symbol) : next.delete(s.symbol));
                            setSelectedStocks(next);
                          }}
                        />
                      </th>
                      <th className="p-2 text-left font-medium">Symbol</th>
                      <th className="p-2 text-left font-medium hidden sm:table-cell">Company</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStocks.length === 0 ? (
                      <tr><td colSpan={3} className="p-4 text-center text-xs text-muted-foreground">No stocks found</td></tr>
                    ) : (
                      filteredStocks.slice(0, 50).map((stock) => (
                        <tr
                          key={stock.symbol}
                          className={cn('border-b hover:bg-muted/50 transition-colors', selectedStocks.has(stock.symbol) && 'bg-primary/5')}
                        >
                          <td className="p-2">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-border"
                              checked={selectedStocks.has(stock.symbol)}
                              onChange={() => toggleStock(stock.symbol)}
                            />
                          </td>
                          <td className="p-2 font-medium text-xs font-mono">{stock.symbol}</td>
                          <td className="p-2 text-xs text-muted-foreground hidden sm:table-cell truncate max-w-[200px]">{stock.company_name || '\u2014'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 3. File Formats — all 25+ backend formats, grouped by category */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base font-semibold">3. File Formats</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">{selectedFormats.size} selected</Badge>
            {formats.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (selectedFormats.size > 0) {
                    setSelectedFormats(new Set());
                  } else {
                    setSelectedFormats(new Set(formats.filter((f) => f.available).map((f) => f.id)));
                  }
                }}
                className="text-[9px] text-muted-foreground hover:text-primary transition-colors"
              >
                {selectedFormats.size > 0 ? 'clear all' : 'select all'}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.keys(formatGroups).length === 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[74px] animate-pulse rounded-xl bg-muted/50" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(formatGroups).map(([category, categoryFormats]) => (
                <div key={category}>
                  <p className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {category}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3">
                    {categoryFormats.map((fmt) => {
                      const Icon = FORMAT_ICON_MAP[fmt.id] || FileText;
                      const selected = selectedFormats.has(fmt.id);
                      const displayName = fmt.displayName || fmt.id.toUpperCase();
                      return (
                        <button
                          key={fmt.id}
                          type="button"
                          aria-checked={selected}
                          role="checkbox"
                          disabled={!fmt.available}
                          onClick={() => toggleFormat(fmt.id)}
                          className={cn(
                            'flex flex-col items-start gap-1 rounded-xl border px-2.5 py-2 text-left transition',
                            !fmt.available && 'opacity-40 cursor-not-allowed',
                            selected
                              ? 'border-primary/60 bg-primary/[0.08] shadow-[0_0_18px_-6px_hsl(var(--primary)/0.45)]'
                              : 'border-border hover:bg-muted/40',
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
          <p className="text-xs text-muted-foreground">
            Exports are delivered as a single ZIP package with one folder per stock.
          </p>
          {formats.length > 0 && availableFormatIds.size < formats.length && (
            <p className="text-[10px] text-muted-foreground">
              {formats.length - availableFormatIds.size} format{formats.length - availableFormatIds.size !== 1 ? 's' : ''} greyed out — install the required Python packages to enable them.
            </p>
          )}
        </CardContent>
      </Card>

      {/* 4. Data Fields */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base font-semibold">4. Data Fields</CardTitle>
          <Badge variant="secondary" className="text-xs">
            {fieldMode === 'all' ? 'All fields' : `${selectedFields.size} / ${ALL_FIELDS.length}`}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <ToggleGroup
              type="single"
              value={fieldMode}
              onValueChange={(v) => { if (v) setFieldMode(v as typeof fieldMode); }}
              className="justify-start"
            >
              <ToggleGroupItem value="all" className="text-xs">All Fields</ToggleGroupItem>
              <ToggleGroupItem value="custom" className="text-xs">Custom Fields</ToggleGroupItem>
            </ToggleGroup>

            {fieldMode === 'custom' && (
              <Popover open={fieldConfigOpen} onOpenChange={setFieldConfigOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs">
                    <Settings className="h-3.5 w-3.5" />
                    Configure
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[420px] max-h-[500px] overflow-y-auto p-4" align="start">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">Field Configuration</span>
                      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setFieldConfigOpen(false)}>
                        <XIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Input
                      placeholder="Search fields..."
                      value={fieldSearch}
                      onChange={(e) => setFieldSearch(e.target.value)}
                      className="h-8 text-xs"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{selectedFields.size} of {ALL_FIELDS.length} selected</span>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" className="h-6 text-xs" onClick={selectAllFields}>Select All</Button>
                        <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={clearFields}>Clear</Button>
                      </div>
                    </div>
                    <div className="space-y-3">
                      {filteredFieldGroups.map((group) => (
                        <div key={group.name} className="space-y-1.5">
                          <p className="text-xs font-semibold uppercase tracking-wide text-primary">{group.name}</p>
                          <div className="grid grid-cols-2 gap-1">
                            {group.fields.map(([key, label]) => (
                              <label
                                key={key}
                                className={cn(
                                  'flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-xs transition',
                                  selectedFields.has(key) ? 'border-primary/30 bg-primary/5' : 'hover:bg-muted/40',
                                )}
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedFields.has(key)}
                                  onChange={() => toggleField(key)}
                                  className="h-3.5 w-3.5 rounded border-border"
                                />
                                <span>{label}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 5. Data Range */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">5. Data Range</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {DATE_RANGE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setDateRangeType(p.id)}
                className={cn(
                  'rounded-md border p-3 text-left text-sm transition',
                  dateRangeType === p.id
                    ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                    : 'border-border hover:bg-muted/50',
                )}
              >
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 shrink-0" />
                  <span className="font-medium">{p.label}</span>
                </div>
              </button>
            ))}
          </div>

          {dateRangeType === 'last_n_days' && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Number of Days</Label>
              <Input type="number" min="1" max="365" value={dateRangeDays} onChange={(e) => setDateRangeDays(Number(e.target.value))} className="w-32" />
            </div>
          )}

          {dateRangeType === 'custom' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Start Date</Label>
                <Input type="date" value={customStartDate} onChange={(e) => setCustomStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">End Date</Label>
                <Input type="date" value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 6. Frequency */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">6. Frequency</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {SCHEDULE_TYPES.map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setScheduleType(st.id)}
                className={cn(
                  'rounded-md border p-3 text-left text-sm transition',
                  scheduleType === st.id
                    ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                    : 'border-border hover:bg-muted/50',
                )}
              >
                <span className="font-medium">{st.label}</span>
              </button>
            ))}
          </div>

          {scheduleType === 'weekly' && (
            <div className="flex gap-1">
              {DAYS.map((d, i) => (
                <Button
                  key={d}
                  size="sm"
                  variant={selectedDays.includes(i) ? 'default' : 'outline'}
                  className="w-10"
                  onClick={() => setSelectedDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}
                >
                  {d}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 7. Download Time + Timezone */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">7. Download Time &amp; Timezone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <Input
              type="time"
              value={execTime}
              onChange={(e) => setExecTime(e.target.value)}
              className="w-36"
            />
            <span className="flex items-center gap-1.5">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger className="w-[240px]"><SelectValue placeholder="Select timezone" /></SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz.id} value={tz.id}>{tz.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 8. Destination */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">8. Destination</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {DESTINATIONS.map(({ id, name, desc, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setDestination(id)}
                className={cn(
                  'flex items-start gap-2.5 rounded-xl border p-3 text-left transition',
                  destination === id
                    ? 'border-primary/60 bg-primary/[0.08] ring-1 ring-primary/30'
                    : 'border-border hover:bg-muted/50',
                )}
              >
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', destination === id ? 'text-primary' : 'text-muted-foreground')} />
                <span>
                  <span className="block text-sm font-medium">{name}</span>
                  <span className="block text-[11px] text-muted-foreground">{desc}</span>
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 10. Summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">10. Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-muted-foreground">Schedule:</span> {formName || '\u2014'}</div>
            <div><span className="text-muted-foreground">Stocks:</span> {effectiveStockCount > 0 ? `${effectiveStockCount} (${stockMode.replace('_', ' ')})` : 'None'}</div>
            <div><span className="text-muted-foreground">Formats:</span> {selectedFormats.size > 0 ? Array.from(selectedFormats).map((f) => f.toUpperCase()).join(', ') : 'None'}</div>
            <div><span className="text-muted-foreground">Fields:</span> {fieldMode === 'all' ? 'All' : `${selectedFields.size} selected`}</div>
            <div><span className="text-muted-foreground">Data Range:</span> {DATE_RANGE_PRESETS.find((p) => p.id === dateRangeType)?.label || dateRangeType}</div>
            <div><span className="text-muted-foreground">Frequency:</span> {SCHEDULE_TYPES.find((s) => s.id === scheduleType)?.label || scheduleType}{scheduleType === 'weekly' ? ` (${selectedDays.map((d) => DAYS[d]).join(', ')})` : ''}</div>
            <div><span className="text-muted-foreground">Time:</span> {execTime} ({TIMEZONES.find((tz) => tz.id === timezone)?.id ?? timezone})</div>
            <div><span className="text-muted-foreground">Destination:</span> {DESTINATIONS.find((d) => d.id === destination)?.name || destination}</div>
          </div>

          {outputPreview && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Expected Output Structure</Label>
              <pre className="rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap">{outputPreview}</pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 11+12. Save + Cancel */}
      <div className="flex justify-end gap-3 pb-8">
        <Link href="/downloads">
          <Button size="lg" variant="ghost">Cancel</Button>
        </Link>
        <Button
          size="lg"
          onClick={handleSave}
          disabled={saving || !canSave}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          Save Schedule
        </Button>
      </div>
    </div>
  );
}
