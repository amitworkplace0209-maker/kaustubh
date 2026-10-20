'use client';

// ---- Data Center export history ----
// Real records persisted by the backend (download_history collection).
// • Download — streams the stored artifact (server keeps exports for 7 days).
// • Re-export — legacy rows without a stored file re-run recorded parameters.
// • Delete — removes the record + its generated file. Market data is never
//   touched; a confirmation dialog states this explicitly.

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, Download, History, Inbox, RefreshCw,
  RotateCcw, Search, Trash2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import {
  deleteHistoryEntry, downloadFile, fetchHistoryFile, getDownloadHistory,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

export type DcHistoryItem = {
  _id: string;
  symbols: string[];
  symbolCount: number;
  format: string;
  count: number;
  fields?: string[];
  source?: string;
  fileName?: string;
  fileId?: string;
  jobId?: string;
  fileSizeBytes?: number;
  durationMs?: number;
  status?: string;
  error?: string;
  dateStart?: string;
  dateEnd?: string;
  ts: string;
};

const PAGE_SIZE = 20;

function fmtSize(b?: number | null): string {
  if (b == null || b === 0) return '\u2014';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function fmtWhen(iso?: string | null): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? '\u2014'
    : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function statusBadge(status?: string) {
  const s = (status ?? 'success').toLowerCase();
  const cls =
    s === 'success' || s === 'completed' ? 'border-success/30 bg-success/10 text-success'
      : s === 'failed' || s === 'error' ? 'border-destructive/30 bg-destructive/10 text-destructive'
        : 'border-warning/40 bg-warning/10 text-warning';
  return (
    <Badge variant="outline" className={cn('h-5 px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider', cls)}>
      {s}
    </Badge>
  );
}

export default function DcHistory({ refreshKey }: { refreshKey?: number }) {
  const [items, setItems] = useState<DcHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [formatFilter, setFormatFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DcHistoryItem | null>(null);
  const [errorEntry, setErrorEntry] = useState<DcHistoryItem | null>(null);
  const { toast } = useToast();

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getDownloadHistory({
        limit: PAGE_SIZE, offset: page * PAGE_SIZE, search, format: formatFilter, source: sourceFilter,
      });
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch {
      /* keep previous list */
    } finally {
      setLoading(false);
    }
  }, [page, search, formatFilter, sourceFilter]);

  useEffect(() => { fetchHistory(); }, [fetchHistory, refreshKey]);
  // Light polling so scheduled-export rows appear without manual refresh.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && !document.hidden && !busyId && !pendingDelete) fetchHistory();
    }, 30_000);
    return () => clearInterval(t);
  }, [fetchHistory, busyId, pendingDelete]);

  const handleDownload = async (item: DcHistoryItem) => {
    setBusyId(item._id);
    try {
      const { blob, filename } =
        item.fileId
          ? await fetchHistoryFile(item._id)
          : await reexportBlob(item);
      saveBlob(blob, filename);
      toast({ title: 'Download complete', description: `${filename} (${fmtSize(blob.size)})` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      toast({
        title: /410/.test(message) ? 'File no longer stored' : 'Download failed',
        description: /410/.test(message)
          ? 'Server keeps exports for 7 days. Use Re-export to regenerate.'
          : message,
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  /** Re-run the exact recorded parameters against live tick data. */
  const reexportBlob = async (item: DcHistoryItem) => {
    const params: Record<string, string> = { source: 'manual' };
    if (item.symbols?.length) params.symbols = item.symbols.join(','); else params.all = 'true';
    if (item.dateStart) params.start = new Date(item.dateStart).toISOString();
    if (item.dateEnd) params.end = new Date(item.dateEnd).toISOString();
    if (item.fields?.length) params.fields = item.fields.join(',');
    return downloadFile(params);
  };

  const confirmDelete = async () => {
    const item = pendingDelete;
    if (!item) return;
    setPendingDelete(null);
    setBusyId(item._id);
    try {
      await deleteHistoryEntry(item._id);
      toast({ title: 'Deleted', description: 'Export record and file removed. Market data untouched.' });
      await fetchHistory();
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <Card className="shadow-soft">
      <CardContent className="px-4 py-3.5">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
            <History className="h-3.5 w-3.5" />
          </span>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Export History</h3>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={fetchHistory}>
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} /> Refresh
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search symbols…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="h-8 pl-10"
            />
          </div>
          <Select value={formatFilter || 'all'} onValueChange={(v) => { setFormatFilter(v === 'all' ? '' : v); setPage(0); }}>
            <SelectTrigger className="h-8 w-[120px]"><SelectValue placeholder="All formats" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All formats</SelectItem>
              {['csv', 'json', 'jsonl', 'ndjson', 'txt', 'xlsx', 'zip'].map((f) => (
                <SelectItem key={f} value={f}>{f.toUpperCase()}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sourceFilter || 'all'} onValueChange={(v) => { setSourceFilter(v === 'all' ? '' : v); setPage(0); }}>
            <SelectTrigger className="h-8 w-[130px]"><SelectValue placeholder="All sources" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* List */}
        {loading && items.length === 0 ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-11 animate-pulse rounded-lg bg-muted/50" />)}</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-8 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">No exports yet</p>
            <p className="text-xs text-muted-foreground">Completed downloads are recorded here automatically.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/40">
            <div className="hidden grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground lg:grid">
              <span>Format</span><span>Stocks</span><span className="text-right">Records</span>
              <span className="text-right">Size</span><span className="text-right">Created</span><span className="text-right">Actions</span>
            </div>
            <div className="divide-y divide-border/40">
              {items.map((item) => {
                const busy = busyId === item._id;
                const failed = ['failed', 'error'].includes((item.status ?? '').toLowerCase());
                const hasFile = Boolean(item.fileId);
                return (
                  <div key={item._id} className="grid grid-cols-1 gap-1.5 px-3 py-2.5 transition-colors hover:bg-muted/30 lg:grid-cols-[auto_1fr_auto_auto_auto_auto] lg:items-center lg:gap-2">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className="font-mono text-[10px]">{item.format.toUpperCase()}</Badge>
                      {statusBadge(item.status)}
                      {item.source === 'scheduled' && (
                        <Badge variant="outline" className="h-5 border-teal/30 bg-teal/10 px-1.5 py-0 text-[9px] tracking-wider text-teal-500">SCHED</Badge>
                      )}
                    </div>
                    <div className="min-w-0 truncate font-mono text-xs" title={item.symbols?.join(', ')}>
                      {item.symbolCount > 3
                        ? `${item.symbols?.slice(0, 2).join(', ')} +${item.symbolCount - 2}`
                        : item.symbols?.join(', ') || '\u2014'}
                    </div>
                    <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {(item.count ?? 0).toLocaleString('en-IN')} rows
                    </div>
                    <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">{fmtSize(item.fileSizeBytes)}</div>
                    <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">{fmtWhen(item.ts)}</div>
                    {/* Actions: Download / Re-export · View Error · Delete */}
                    <div className="flex justify-end gap-1">
                      {!failed && hasFile && (
                        <Button
                          size="sm" variant="outline" className="h-7 gap-1.5 rounded-lg text-xs"
                          disabled={busyId != null}
                          onClick={() => handleDownload(item)}
                          title="Download the stored export file"
                        >
                          {busy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <><Download className="h-3 w-3" /> Download</>}
                        </Button>
                      )}
                      {!failed && !hasFile && (
                        <Button
                          size="sm" variant="outline" className="h-7 gap-1.5 rounded-lg text-xs"
                          disabled={busyId != null}
                          onClick={() => handleDownload(item)}
                          title="Re-run this export with the same parameters"
                        >
                          {busy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <><RotateCcw className="h-3 w-3" /> Re-export</>}
                        </Button>
                      )}
                      {failed && (
                        <Button
                          size="sm" variant="outline"
                          className="h-7 gap-1.5 rounded-lg text-xs text-destructive hover:text-destructive"
                          onClick={() => setErrorEntry(item)}
                          title="View error details"
                        >
                          <AlertCircle className="h-3 w-3" /> Error
                        </Button>
                      )}
                      <Button
                        size="sm" variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        disabled={busyId != null}
                        onClick={() => setPendingDelete(item)}
                        title="Delete record and file"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pagination footer — always visible when there are entries */}
        {items.length > 0 && (
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {showingFrom.toLocaleString('en-IN')}\u2013{showingTo.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}</span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-7" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</Button>
              <span className="px-2 tabular-nums">{page + 1}/{totalPages}</span>
              <Button size="sm" variant="outline" className="h-7" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        )}
      </CardContent>

      {/* Delete confirmation — explicit about what is (not) touched */}
      <AlertDialog open={pendingDelete != null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this export?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5">
                <p>
                  Removes the history entry{pendingDelete?.fileId ? ' and its generated file from server storage' : ''}
                  {' '}({fmtSize(pendingDelete?.fileSizeBytes)}).
                </p>
                <p className="font-medium text-foreground">
                  Market data in MongoDB is never affected.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); void confirmDelete(); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Failure details dialog */}
      <AlertDialog open={errorEntry != null} onOpenChange={(open) => { if (!open) setErrorEntry(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">Export failed</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p className="font-mono text-xs">
                  {errorEntry?.symbols?.join(', ') || 'All stocks'} · {errorEntry?.format?.toUpperCase()}
                  {' '}· {fmtWhen(errorEntry?.ts)}
                </p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2.5 text-left font-mono text-[11px] text-destructive">
                  {errorEntry?.error || 'Unknown error'}
                </pre>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
