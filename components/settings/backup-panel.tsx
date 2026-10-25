'use client';

import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Download,
  FileJson,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Upload,
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
import { useToast } from '@/hooks/use-toast';
import {
  exportSettings,
  importSettings,
  resetAllSettings,
  type SettingsAuditEntry,
  type SettingsHealth,
  type SettingsImportResult,
} from '@/lib/api';
import {
  Callout,
  EmptyHint,
  Panel,
  Pill,
  SectionIntro,
  classifyAction,
  formatRelative,
  formatValue,
} from './settings-primitives';
import { cn } from '@/lib/utils';

type ImportPreview = {
  fileName: string;
  values: Record<string, any>;
  result: SettingsImportResult | null;
  error: string | null;
};

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function BackupPanel({
  health,
  audit,
  auditLoading,
  onRefresh,
  onResetAll,
}: {
  health: SettingsHealth | null;
  audit: SettingsAuditEntry[];
  auditLoading: boolean;
  onRefresh: () => Promise<void> | void;
  onResetAll: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [auditSearch, setAuditSearch] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetBusy, setResetBusy] = useState(false);

  const exportAll = async () => {
    setExporting(true);
    try {
      const snapshot = await exportSettings();
      downloadJson(`settings-backup-${new Date().toISOString().slice(0, 10)}.json`, snapshot);
      toast({ title: 'Backup exported', description: `${snapshot.count} non-sensitive settings written to JSON.` });
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  };

  const pickFile = () => fileRef.current?.click();

  const onFile = async (file: File) => {
    setPreviewing(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const source = parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object'
        ? parsed.settings
        : parsed;
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error('JSON must contain a settings object (or a backup with a "settings" field).');
      }
      const values = source as Record<string, any>;
      const result = await importSettings(values, true).catch((err) => {
        const message = err instanceof Error ? err.message : 'Validation failed';
        return { ok: false, dryRun: true, applied: [], rejected: { $: message } } as SettingsImportResult;
      });
      setPreview({
        fileName: file.name,
        values,
        result,
        error: result.ok ? null : 'The backend rejected this snapshot. Nothing will be written.',
      });
    } catch (err) {
      setPreview({
        fileName: file.name,
        values: {},
        result: null,
        error: err instanceof Error ? err.message : 'Could not read the file',
      });
    } finally {
      setPreviewing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const applyImport = async () => {
    if (!preview?.result?.ok) return;
    setImportBusy(true);
    try {
      const res = await importSettings(preview.values);
      if (!res.ok) throw new Error('Import was rejected');
      toast({
        title: 'Settings imported',
        description: `${res.applied.length} key${res.applied.length === 1 ? '' : 's'} applied.`,
      });
      setPreview(null);
      await onRefresh();
    } catch (err) {
      toast({
        title: 'Import failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setImportBusy(false);
    }
  };

  const doResetAll = async () => {
    setResetBusy(true);
    try {
      await resetAllSettings();
      toast({ title: 'All settings reset', description: 'Every key is back to its declared default.' });
      setResetOpen(false);
      setResetText('');
      await onResetAll();
    } catch (err) {
      toast({
        title: 'Reset failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setResetBusy(false);
    }
  };

  const filteredAudit = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return audit;
    return audit.filter((entry) =>
      [entry.action, entry.key ?? '', entry.source, entry.category ?? '', ...entry.keys]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [audit, auditSearch]);

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Data portability"
        title="Backup & Audit"
        description="Export a portable snapshot, validate and import it atomically, and inspect every settings mutation recorded by the backend."
        actions={
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void onRefresh()}
            disabled={auditLoading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', auditLoading && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Export snapshot"
          description="Portable JSON of every non-sensitive effective value."
          icon={Download}
        >
          <p className="text-[11px] leading-5 text-muted-foreground">
            Credentials, PINs, tokens and the MongoDB URI are stripped by the backend and can never
            leave through this export.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-8 text-xs" onClick={exportAll} disabled={exporting}>
              {exporting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
              Export JSON
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {health ? `${health.totalKeys} keys · ${health.customizedKeys} customized` : 'Loading catalogue…'}
            </span>
          </div>
        </Panel>

        <Panel
          title="Import snapshot"
          description="Dry-run validation first; the whole file is applied atomically."
          icon={Upload}
        >
          <p className="text-[11px] leading-5 text-muted-foreground">
            Unknown keys, type mismatches and sensitive keys are rejected before anything is written.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={pickFile} disabled={previewing}>
              {previewing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileJson className="mr-1.5 h-3.5 w-3.5" />}
              Choose JSON…
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
            <span className="text-[10px] text-muted-foreground">Nothing is written until you confirm.</span>
          </div>
        </Panel>
      </div>

      <Panel
        title="Change history"
        description="Newest first. Newest 500 events are retained; each write is attributed to its source."
        icon={History}
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              placeholder="Filter events…"
              className="h-7 w-44 pl-7 text-[11px]"
            />
          </div>
        }
        bodyClassName="p-0"
      >
        {auditLoading && audit.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading audit trail…
          </div>
        ) : filteredAudit.length === 0 ? (
          <div className="p-4">
            <EmptyHint
              icon={ShieldCheck}
              title={audit.length === 0 ? 'No settings changes recorded yet' : 'No events match this filter'}
              description={
                audit.length === 0
                  ? 'Edit any backend key or import a snapshot and the change will appear here with its previous value.'
                  : 'Try a different key, action or source.'
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {filteredAudit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start gap-2 px-4 py-2.5">
                <Pill tone={classifyAction(entry.action)} className="mt-0.5 uppercase">
                  {entry.action.replace(/-/g, ' ')}
                </Pill>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] font-medium">
                      {entry.key ?? `${entry.keys.length} key${entry.keys.length === 1 ? '' : 's'}`}
                    </span>
                    {entry.category && <Pill tone="neutral">{entry.category}</Pill>}
                    <Pill tone="neutral">{entry.source}</Pill>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="max-w-[220px] truncate font-mono">{formatValue(entry.oldValue)}</span>
                    <ArrowRight className="h-2.5 w-2.5 shrink-0" />
                    <span className="max-w-[260px] truncate font-mono text-foreground/80">{formatValue(entry.newValue)}</span>
                  </div>
                </div>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />
                  {formatRelative(entry.ts)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Danger zone"
        description="Restore every backend setting to its declared default."
        icon={AlertTriangle}
        tone="danger"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Callout tone="danger" className="flex-1">
            Reset-all clears every customization across all categories, refreshes the live runtime and
            records a single audit entry. Export a backup first if you may need the current values.
          </Callout>
          <Button variant="destructive" size="sm" className="h-8 shrink-0 text-xs" onClick={() => setResetOpen(true)}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset all settings
          </Button>
        </div>
      </Panel>

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <FileJson className="h-4 w-4" /> Import preview
            </DialogTitle>
            <DialogDescription className="text-xs">
              {preview?.fileName}
            </DialogDescription>
          </DialogHeader>

          {preview && (
            <div className="space-y-3">
              {preview.error && <Callout tone="danger">{preview.error}</Callout>}
              {preview.result?.ok ? (
                <Callout tone="success" title="Validation passed">
                  {preview.result.applied.length} key{preview.result.applied.length === 1 ? '' : 's'} will be written
                  atomically.
                </Callout>
              ) : (
                preview.result && (
                  <Callout tone="danger" title="Validation failed — nothing will be written">
                    <ul className="mt-1 space-y-0.5">
                      {Object.entries(preview.result.rejected).slice(0, 8).map(([key, message]) => (
                        <li key={key} className="font-mono text-[10px]">
                          <span className="font-semibold">{key}</span>: {message}
                        </li>
                      ))}
                    </ul>
                  </Callout>
                )
              )}
              {preview.result?.ok && preview.result.applied.length > 0 && (
                <div className="max-h-40 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-2">
                  <div className="flex flex-wrap gap-1">
                    {preview.result.applied.slice(0, 60).map((key) => (
                      <span key={key} className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[9px]">
                        {key}
                      </span>
                    ))}
                    {preview.result.applied.length > 60 && (
                      <span className="px-1 py-0.5 text-[9px] text-muted-foreground">
                        +{preview.result.applied.length - 60} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)} disabled={importBusy}>
              Cancel
            </Button>
            <Button onClick={applyImport} disabled={!preview?.result?.ok || importBusy}>
              {importBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Apply import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={(open) => !open && setResetOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-destructive" /> Reset all settings?
            </DialogTitle>
            <DialogDescription className="text-xs">
              Every key in every category is restored to its declared default. Live runtime values are
              refreshed immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Type <span className="font-mono font-bold text-foreground">RESET</span> to confirm.
            </p>
            <Input
              value={resetText}
              onChange={(e) => setResetText(e.target.value)}
              placeholder="RESET"
              className="h-9 font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)} disabled={resetBusy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={doResetAll} disabled={resetBusy || resetText !== 'RESET'}>
              {resetBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Reset everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
