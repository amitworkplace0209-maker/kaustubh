'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, Calendar, Check, Clock, Download, FileText, Filter,
  RefreshCw, Search, Trash2, X, AlertCircle, ChevronDown, ChevronRight,
  Eye, BarChart3, HardDrive, Loader2, RotateCcw, Archive,
  Braces, FileSpreadsheet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  PageHeader, StatusBadge, EmptyState,
} from '@/components/design-system';
import {
  getDownloadHistory, deleteHistoryEntry, fetchHistoryFile,
  bulkDeleteHistory, retryExportJob, getExportJob,
} from '@/lib/api';
import { cn } from '@/lib/utils';

type HistoryJob = {
  id: string;
  createdAt: string;
  completedAt: string;
  user: string;
  dataset: string;
  stocks: string[];
  missingStocks: string[];
  stockCount: number;
  timeRange: string;
  dateStart: string;
  dateEnd: string;
  format: string;
  compression: string;
  size: string;
  sizeBytes: number | null;
  status: string;
  records: number | null;
  durationMs: number | null;
  fileName: string | null;
  fileId: string | null;
  jobId: string | null;
  fields: string[];
  fieldCount: number;
  dataType: string;
  source: string;
  scheduleId: string | null;
  scheduleName: string | null;
};

type Summary = {
  totalJobs: number;
  totalSize: number;
  totalSizeFormatted: string;
  totalRecords: number;
  statusCounts: Record<string, number>;
};

const IST_TZ = 'Asia/Kolkata';

function fmtIST(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Not available';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Not available';
    return d.toLocaleString('en-IN', {
      timeZone: IST_TZ,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' IST';
  } catch {
    return 'Not available';
  }
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'Not available';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'Not available';
  return n.toLocaleString('en-IN');
}

const STATUS_COLORS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  completed: 'success', processing: 'warning', queued: 'info',
  failed: 'danger', cancelled: 'neutral', success: 'success',
};

const STATUS_ICONS: Record<string, React.ElementType> = {
  completed: Check, processing: Loader2, queued: Clock,
  failed: AlertCircle, cancelled: X,
};

export default function Phase2DownloadHistoryPage() {
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterFormat, setFilterFormat] = useState('all');
  const [detailJob, setDetailJob] = useState<HistoryJob | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<HistoryJob | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expandedMobile, setExpandedMobile] = useState<Set<string>>(new Set());

  const mountedRef = useRef(true);
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (search.trim()) params.search = search.trim();
      if (filterStatus !== 'all') params.status = filterStatus;
      if (filterFormat !== 'all') params.format = filterFormat;

      const qs = new URLSearchParams(params).toString();
      const res = await fetch(`/api/phase2/download-history${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      if (!mountedRef.current) return;
      setJobs(data.jobs ?? []);
      setSummary(data.summary ?? null);
      setLastUpdated(new Date());
      setLoading(false);
      setError(null);
    } catch {
      if (!mountedRef.current) return;
      setError('Unable to load download history');
      setLoading(false);
    }
  }, [search, filterStatus, filterFormat]);

  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current);
    searchRef.current = setTimeout(fetchData, 300);
    return () => { if (searchRef.current) clearTimeout(searchRef.current); };
  }, [fetchData]);

  useEffect(() => {
    const timer = setInterval(fetchData, 15000);
    return () => clearInterval(timer);
  }, [fetchData]);

  const handleDownload = useCallback(async (job: HistoryJob) => {
    if (downloadingId) return;
    setDownloadingId(job.id);
    try {
      if (job.fileId) {
        const { blob, filename } = await fetchHistoryFile(job.id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else if (job.jobId) {
        const a = document.createElement('a');
        a.href = `/api/phase2/download-history/${encodeURIComponent(job.id)}/file`;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch {
      setError('Download failed — file may no longer be available');
    }
    setDownloadingId(null);
  }, [downloadingId]);

  const handleDelete = useCallback(async (job: HistoryJob) => {
    if (deletingId) return;
    setDeletingId(job.id);
    setDeleteConfirm(null);
    try {
      await deleteHistoryEntry(job.id);
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      setDetailJob((prev) => prev?.id === job.id ? null : prev);
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(job.id); return n; });
    } catch {
      setError('Failed to delete history entry');
    }
    setDeletingId(null);
  }, [deletingId]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkDeleteConfirm(false);
    for (const id of ids) {
      try {
        await deleteHistoryEntry(id);
      } catch { /* continue */ }
    }
    setSelectedIds(new Set());
    fetchData();
  }, [selectedIds, fetchData]);

  const handleRetry = useCallback(async (job: HistoryJob) => {
    if (retryingId || !job.jobId) return;
    setRetryingId(job.id);
    try {
      const result = await retryExportJob(job.jobId);
      if (result?.jobId) {
        window.location.href = '/data-saver/downloads';
      }
    } catch {
      setError('Failed to retry — the original job parameters may no longer be available');
    }
    setRetryingId(null);
  }, [retryingId]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const filtered = useMemo(() => jobs, [jobs]);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((j) => j.id)));
    }
  }, [selectedIds, filtered]);

  const toggleMobile = useCallback((id: string) => {
    setExpandedMobile((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const uniqueFormats = useMemo(() => {
    const set = new Set(jobs.map((j) => j.format.split(',')[0]));
    return Array.from(set);
  }, [jobs]);

  const allSelected = filtered.length > 0 && selectedIds.size === filtered.length;

  return (
    <div className="space-y-4 pb-6">
      <PageHeader
        title="Download History"
        subtitle={`${summary?.totalJobs ?? jobs.length} total export jobs`}
      >
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              Updated {lastUpdated.toLocaleTimeString('en-IN', { hour12: false, timeZone: IST_TZ })}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={fetchData}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </PageHeader>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <SummaryCard
            icon={BarChart3}
            title="Total Jobs"
            value={fmtNumber(summary.totalJobs)}
            tone="cyan"
          />
          <SummaryCard
            icon={Check}
            title="Completed"
            value={fmtNumber(summary.statusCounts.completed ?? 0)}
            tone="success"
          />
          <SummaryCard
            icon={Loader2}
            title="Processing"
            value={fmtNumber((summary.statusCounts.processing ?? 0) + (summary.statusCounts.queued ?? 0))}
            tone="blue"
          />
          <SummaryCard
            icon={AlertCircle}
            title="Failed"
            value={fmtNumber(summary.statusCounts.failed ?? 0)}
            tone="danger"
          />
          <SummaryCard
            icon={FileText}
            title="Total Records"
            value={fmtNumber(summary.totalRecords)}
            tone="orange"
          />
          <SummaryCard
            icon={HardDrive}
            title="Exported Size"
            value={summary.totalSizeFormatted}
            tone="purple"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by stock, format, job ID, or date..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-10 pr-8 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(['all', 'completed', 'processing', 'queued', 'failed', 'cancelled'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                filterStatus === s
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="capitalize">{s}</span>
              <span className="text-[10px] tabular-nums opacity-60">
                {s === 'all' ? (summary?.totalJobs ?? jobs.length) : (summary?.statusCounts?.[s] ?? jobs.filter((j) => j.status === s).length)}
              </span>
            </button>
          ))}
        </div>

        {uniqueFormats.length > 1 && (
          <select
            value={filterFormat}
            onChange={(e) => setFilterFormat(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="all">All formats</option>
            {uniqueFormats.map((f) => (
              <option key={f} value={f}>{f.toUpperCase()}</option>
            ))}
          </select>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2">
          <span className="text-xs font-medium">{selectedIds.size} job{selectedIds.size !== 1 ? 's' : ''} selected</span>
          <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => setBulkDeleteConfirm(true)}>
            <Trash2 className="h-3 w-3 mr-1" /> Delete Selected
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelectedIds(new Set())}>
            Clear Selection
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading export history...
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ArrowDownToLine}
          title={search ? 'No matching export jobs' : 'No export jobs yet'}
          description={search ? 'Try clearing your search or filters' : 'Start an export from Downloads'}
          action={
            search ? (
              <Button size="sm" variant="outline" onClick={() => { setSearch(''); setFilterStatus('all'); setFilterFormat('all'); }}>
                Clear filters
              </Button>
            ) : (
              <Button size="sm" onClick={() => window.location.href = '/data-saver/downloads'}>
                Go to Downloads
              </Button>
            )
          }
        />
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden md:block overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="w-8 p-2.5">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="h-3.5 w-3.5 rounded border-border"
                    />
                  </th>
                  <th className="p-2.5">Status</th>
                  <th className="p-2.5">Job</th>
                  <th className="p-2.5">Created</th>
                  <th className="p-2.5">Stocks</th>
                  <th className="p-2.5">Records</th>
                  <th className="p-2.5">Format</th>
                  <th className="p-2.5">Size</th>
                  <th className="p-2.5">Duration</th>
                  <th className="p-2.5" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((job) => {
                  const StatusIcon = STATUS_ICONS[job.status] || Check;
                  const isSelected = selectedIds.has(job.id);
                  return (
                    <tr
                      key={job.id}
                      className={cn(
                        'border-b border-border/30 transition-colors hover:bg-muted/20',
                        isSelected && 'bg-primary/5',
                      )}
                    >
                      <td className="p-2.5">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(job.id)}
                          className="h-3.5 w-3.5 rounded border-border"
                        />
                      </td>
                      <td className="p-2.5">
                        <StatusBadge
                          status={STATUS_COLORS[job.status] || 'neutral'}
                          label={job.status}
                        />
                      </td>
                      <td className="p-2.5 font-mono text-[10px] text-muted-foreground">
                        {job.id.slice(0, 10)}...
                      </td>
                      <td className="p-2.5 tabular-nums text-muted-foreground">
                        {fmtIST(job.createdAt)}
                      </td>
                      <td className="p-2.5">
                        <div className="flex flex-wrap gap-0.5">
                          {job.stocks.slice(0, 3).map((s) => (
                            <Badge key={s} variant="outline" className="text-[9px] font-mono">{s}</Badge>
                          ))}
                          {job.stocks.length > 3 && (
                            <Badge variant="secondary" className="text-[9px]">+{job.stocks.length - 3}</Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-2.5 tabular-nums">{fmtNumber(job.records)}</td>
                      <td className="p-2.5">
                        <Badge variant="secondary" className="text-[10px] uppercase">{job.format.split(',')[0]}</Badge>
                      </td>
                      <td className="p-2.5 tabular-nums">{job.size}</td>
                      <td className="p-2.5 tabular-nums text-muted-foreground">{fmtDuration(job.durationMs)}</td>
                      <td className="p-2.5">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setDetailJob(job)}
                            className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
                            title="View details"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          {job.status === 'completed' && (
                            <button
                              onClick={() => handleDownload(job)}
                              disabled={downloadingId === job.id}
                              className="rounded p-1 text-muted-foreground hover:text-primary transition-colors"
                              title="Download"
                            >
                              {downloadingId === job.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Download className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                          {(job.status === 'failed' || job.status === 'cancelled') && job.jobId && (
                            <button
                              onClick={() => handleRetry(job)}
                              disabled={retryingId === job.id}
                              className="rounded p-1 text-muted-foreground hover:text-warning transition-colors"
                              title="Retry"
                            >
                              {retryingId === job.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => setDeleteConfirm(job)}
                            disabled={deletingId === job.id}
                            className="rounded p-1 text-muted-foreground hover:text-destructive transition-colors"
                            title="Delete"
                          >
                            {deletingId === job.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Cards */}
          <div className="space-y-2 md:hidden">
            {filtered.map((job) => {
              const isExpanded = expandedMobile.has(job.id);
              return (
                <Card key={job.id} className={cn(selectedIds.has(job.id) && 'ring-1 ring-primary/30')}>
                  <CardContent className="p-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(job.id)}
                        onChange={() => toggleSelect(job.id)}
                        className="h-4 w-4 shrink-0 rounded border-border"
                      />
                      <StatusBadge
                        status={STATUS_COLORS[job.status] || 'neutral'}
                        label={job.status}
                      />
                      <span className="text-[10px] text-muted-foreground ml-auto font-mono">
                        {job.id.slice(0, 8)}...
                      </span>
                      <button
                        onClick={() => toggleMobile(job.id)}
                        className="shrink-0 p-1 text-muted-foreground"
                      >
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-0.5">
                      {job.stocks.slice(0, 4).map((s) => (
                        <Badge key={s} variant="outline" className="text-[9px] font-mono">{s}</Badge>
                      ))}
                      {job.stocks.length > 4 && (
                        <Badge variant="secondary" className="text-[9px]">+{job.stocks.length - 4}</Badge>
                      )}
                    </div>

                    <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
                      <Badge variant="secondary" className="text-[9px] uppercase">{job.format.split(',')[0]}</Badge>
                      <span>{job.size}</span>
                      <span>{fmtNumber(job.records)} records</span>
                    </div>

                    {isExpanded && (
                      <div className="mt-3 space-y-2 border-t border-border/50 pt-3 text-[11px]">
                        <DetailRow label="Created" value={fmtIST(job.createdAt)} />
                        <DetailRow label="Stocks" value={`${job.stockCount} instruments`} />
                        <DetailRow label="Records" value={fmtNumber(job.records)} />
                        <DetailRow label="Format" value={job.format} />
                        <DetailRow label="Compression" value={job.compression} />
                        <DetailRow label="Size" value={job.size} />
                        <DetailRow label="Duration" value={fmtDuration(job.durationMs)} />
                        <DetailRow label="Package" value={job.fileName || 'Not available'} />
                        <DetailRow label="Fields" value={`${job.fieldCount} fields`} />
                        <DetailRow label="Source" value={job.source} />

                        <div className="flex items-center gap-2 pt-2">
                          <button
                            onClick={() => setDetailJob(job)}
                            className="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <Eye className="h-3 w-3" /> Details
                          </button>
                          {job.status === 'completed' && (
                            <button
                              onClick={() => handleDownload(job)}
                              disabled={downloadingId === job.id}
                              className="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/5 transition-colors"
                            >
                              {downloadingId === job.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Download className="h-3 w-3" />
                              )} Download
                            </button>
                          )}
                          {(job.status === 'failed' || job.status === 'cancelled') && job.jobId && (
                            <button
                              onClick={() => handleRetry(job)}
                              disabled={retryingId === job.id}
                              className="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium text-warning hover:bg-warning/5 transition-colors"
                            >
                              {retryingId === job.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3 w-3" />
                              )} Retry
                            </button>
                          )}
                          <button
                            onClick={() => setDeleteConfirm(job)}
                            disabled={deletingId === job.id}
                            className="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/5 transition-colors"
                          >
                            <Trash2 className="h-3 w-3" /> Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* Details Drawer */}
      {detailJob && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setDetailJob(null)}>
          <div className="fixed inset-0 bg-black/50" />
          <div
            className="relative ml-auto flex h-full w-full max-w-lg flex-col overflow-y-auto bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">Export Job Details</h2>
              <button onClick={() => setDetailJob(null)} className="rounded p-1 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              <DetailSection title="Job">
                <DetailRow label="Job ID" value={detailJob.id} mono />
                <DetailRow label="Status">
                  <StatusBadge status={STATUS_COLORS[detailJob.status] || 'neutral'} label={detailJob.status} />
                </DetailRow>
                <DetailRow label="Created" value={fmtIST(detailJob.createdAt)} />
                <DetailRow label="Completed" value={fmtIST(detailJob.completedAt)} />
                <DetailRow label="Duration" value={fmtDuration(detailJob.durationMs)} />
                <DetailRow label="User" value={detailJob.user} />
                <DetailRow label="Source" value={detailJob.source} />
              </DetailSection>

              <DetailSection title="Data">
                <DetailRow label="Dataset" value={detailJob.dataset} />
                <DetailRow label="Stocks" value={`${detailJob.stockCount} instruments`} />
                {detailJob.stocks.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {detailJob.stocks.map((s) => (
                      <Badge key={s} variant="outline" className="text-[10px] font-mono">{s}</Badge>
                    ))}
                  </div>
                )}
                {detailJob.missingStocks.length > 0 && (
                  <>
                    <DetailRow label="Missing" value={`${detailJob.missingStocks.length} stocks`} />
                    <div className="mt-1 flex flex-wrap gap-1">
                      {detailJob.missingStocks.map((s) => (
                        <Badge key={s} variant="secondary" className="text-[10px] font-mono line-through">{s}</Badge>
                      ))}
                    </div>
                  </>
                )}
                <DetailRow label="Records" value={fmtNumber(detailJob.records)} />
                <DetailRow label="Date Range" value={detailJob.timeRange} />
                <DetailRow label="Fields" value={`${detailJob.fieldCount} fields`} />
                {detailJob.fields.length > 0 && detailJob.fields.length <= 20 && (
                  <div className="mt-1 flex flex-wrap gap-0.5">
                    {detailJob.fields.map((f) => (
                      <Badge key={f} variant="secondary" className="text-[9px] font-mono">{f}</Badge>
                    ))}
                  </div>
                )}
                <DetailRow label="Data Type" value={detailJob.dataType} />
              </DetailSection>

              <DetailSection title="Format">
                <DetailRow label="Format" value={detailJob.format} />
                <DetailRow label="Compression" value={detailJob.compression} />
              </DetailSection>

              <DetailSection title="Package">
                <DetailRow label="Filename" value={detailJob.fileName || 'Not available'} mono />
                <DetailRow label="Size" value={detailJob.size} />
                <DetailRow label="File ID" value={detailJob.fileId || 'Not available'} mono />
                {detailJob.scheduleId && (
                  <DetailRow label="Schedule" value={detailJob.scheduleName || detailJob.scheduleId} />
                )}
              </DetailSection>

              <DetailSection title="Download">
                <DetailRow label="Package Ready" value={detailJob.status === 'completed' ? 'Yes' : 'No'} />
                <DetailRow label="Status" value={detailJob.status} />
              </DetailSection>
            </div>

            <div className="border-t border-border px-5 py-3 flex items-center gap-2">
              {detailJob.status === 'completed' && (
                <Button size="sm" onClick={() => handleDownload(detailJob)} disabled={downloadingId === detailJob.id} className="gap-1.5">
                  {downloadingId === detailJob.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )} Download
                </Button>
              )}
              {(detailJob.status === 'failed' || detailJob.status === 'cancelled') && detailJob.jobId && (
                <Button size="sm" variant="outline" onClick={() => handleRetry(detailJob)} disabled={retryingId === detailJob.id} className="gap-1.5">
                  {retryingId === detailJob.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )} Retry
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={() => { setDetailJob(null); setDeleteConfirm(detailJob); }} className="gap-1.5 ml-auto">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setDeleteConfirm(null)}>
          <div className="fixed inset-0 bg-black/50" />
          <Card className="relative z-10 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <CardContent className="p-5">
              <h3 className="text-sm font-semibold mb-2">Delete History Record?</h3>
              <p className="text-xs text-muted-foreground mb-1">
                This will delete the history record{deleteConfirm.fileId ? ' and the stored package file' : ''}.
              </p>
              {deleteConfirm.fileName && (
                <div className="rounded-md bg-muted/50 p-2 text-[11px] font-mono mb-1">
                  {deleteConfirm.fileName}
                  {deleteConfirm.size !== 'Not available' && ` · ${deleteConfirm.size}`}
                </div>
              )}
              <p className="text-[11px] text-destructive mb-4">This cannot be undone.</p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
                <Button size="sm" variant="destructive" onClick={() => handleDelete(deleteConfirm)}>
                  Delete{deleteConfirm.fileId ? ' Record + File' : ' Record'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Bulk Delete Confirmation Modal */}
      {bulkDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setBulkDeleteConfirm(false)}>
          <div className="fixed inset-0 bg-black/50" />
          <Card className="relative z-10 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <CardContent className="p-5">
              <h3 className="text-sm font-semibold mb-2">Delete {selectedIds.size} History Records?</h3>
              <p className="text-xs text-muted-foreground mb-1">
                This will delete {selectedIds.size} history records and their stored package files.
              </p>
              <p className="text-[11px] text-destructive mb-4">This cannot be undone.</p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setBulkDeleteConfirm(false)}>Cancel</Button>
                <Button size="sm" variant="destructive" onClick={handleBulkDelete}>
                  Delete {selectedIds.size} Records
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  icon: Icon, title, value, tone,
}: {
  icon: React.ElementType; title: string; value: string; tone: string;
}) {
  const toneMap: Record<string, string> = {
    cyan: 'border-cyan-500/30 text-cyan-600 dark:text-cyan-400',
    success: 'border-success/30 text-success',
    blue: 'border-blue-500/30 text-blue-600 dark:text-blue-400',
    danger: 'border-destructive/30 text-destructive',
    orange: 'border-orange-500/30 text-orange-600 dark:text-orange-400',
    purple: 'border-purple/30 text-purple',
  };
  return (
    <Card className={cn('overflow-hidden', toneMap[tone]?.split(' ')[0])}>
      <CardContent className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Icon className={cn('h-4 w-4', toneMap[tone]?.split(' ').slice(1).join(' '))} />
          <p className="text-[10px] font-medium text-muted-foreground truncate">{title}</p>
        </div>
        <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, mono, children }: {
  label: string; value?: string; mono?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground shrink-0">{label}</span>
      {children ?? (
        <span className={cn('text-right', mono ? 'font-mono text-[10px]' : '')}>
          {value || 'Not available'}
        </span>
      )}
    </div>
  );
}
