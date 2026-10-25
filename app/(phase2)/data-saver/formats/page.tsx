'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, Code, Database, FileSpreadsheet, FileText,
  RefreshCw, Search, Settings2, Tag, PanelsTopLeft,
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  PageHeader, SectionCard, SectionHeading, StatusBadge, LoadingState,
  EmptyState, fmtNumber,
} from '@/components/design-system';

/* ------------------------------- Types ------------------------------- */

interface FormatInfo {
  id: string; displayName: string; extension: string; mimeType: string;
  available: boolean; description: string; category: string;
}
interface FieldDetail {
  name: string; type: string; source: string; description: string;
  isDefault: boolean; formatIds: string[];
}

interface FormatsPayload {
  ok?: boolean;
  reason?: string;
  updatedAt?: string;
  total?: number;
  availableCount?: number;
  categories?: string[];
  defaultFormat?: string | null;
  formats: FormatInfo[];
  fields: {
    ok?: boolean;
    reason?: string;
    names: string[];
    defaultFields: string[];
    details: FieldDetail[];
  };
  stats?: {
    ok?: boolean;
    reason?: string;
    totalDownloads?: number;
    todayDownloads?: number;
  };
}

/* ----------------------------- Helpers ------------------------------- */

const EXT_ICON: Record<string, React.ElementType> = {
  csv: FileSpreadsheet, tsv: FileSpreadsheet, xlsx: FileSpreadsheet, ods: FileSpreadsheet,
  json: FileSpreadsheet, jsonl: FileText, ndjson: FileText, parquet: FileSpreadsheet,
  yaml: FileText, xml: FileText, html: FileText, md: FileText,
  sql: Database, db: Database, avro: FileText, arrow: FileText,
};

function InlineError({ reason, onRetry }: { reason?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-3 text-xs">
      <div className="flex items-center gap-2">
        <StatusBadge status="danger" label="Unavailable" />
        <span className="text-foreground font-medium">Section data unavailable</span>
      </div>
      {reason && <p className="text-muted-foreground mt-1.5">Reason: {reason}</p>}
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px] gap-1" onClick={onRetry}>
          <RefreshCw className="h-3 w-3" /> Retry
        </Button>
      )}
    </div>
  );
}

function Field({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right tabular-nums ${strong ? 'font-semibold text-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

function toFinite(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function SummaryCard({
  icon: Icon, title, status, children,
}: {
  icon: React.ElementType; title: string; status?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-background/80 ring-1 ring-border">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</p>
          <p className="text-sm font-bold">{status}</p>
        </div>
      </div>
      <div className="mt-3 space-y-1.5">{children}</div>
    </div>
  );
}

/* ------------------------------- Page -------------------------------- */

export default function Phase2FormatsPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<FormatsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const mountedRef = useRef(true);
  const dataRef = useRef<typeof data>(null);
  dataRef.current = data;

  // Per-format + per-field expand
  const [fmtOpen, setFmtOpen] = useState<Set<string>>(new Set());
  const [fldOpen, setFldOpen] = useState<Set<string>>(new Set());

  // Field list filters
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [requiredFilter, setRequiredFilter] = useState('all'); // all | default | optional
  const [formatFilter, setFormatFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/phase2/formats?t=${Date.now()}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const d: FormatsPayload = await res.json();
      if (!mountedRef.current) return;
      setData((prev) => ({ ...prev, ...d, updatedAt: new Date().toISOString() }));
      setLoadError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setLoadError(e instanceof Error ? e.message : 'Failed to load formats');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const retry = () => { setRefreshKey((k) => k + 1); };
  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const formats = useMemo(() => data?.formats ?? [], [data]);
  const fieldMeta = useMemo(() => data?.fields?.details ?? [], [data]);
  const defaultFormat = data?.defaultFormat ?? null;
  const totalFormats = data?.total ?? formats.length;
  const availableCount = data?.availableCount ?? formats.filter((f) => f.available !== false).length;
  const disabledCount = Math.max(totalFormats - availableCount, 0);

  const defaultFieldNames = useMemo(() => new Set(data?.fields?.defaultFields ?? []), [data]);
  const totalFields = fieldMeta.length || (data?.fields?.names?.length ?? 0);
  const defaultFieldCount = fieldMeta.length
    ? fieldMeta.filter((f) => f.isDefault).length
    : (data?.fields?.defaultFields?.length ?? 0);

  const typeOptions = useMemo(() => Array.from(new Set(fieldMeta.map((f) => f.type).filter((t) => t !== '—' && t !== 'null'))), [fieldMeta]);
  const sourceOptions = useMemo(() => Array.from(new Set(fieldMeta.map((f) => f.source).filter(Boolean))), [fieldMeta]);
  const formatOptions = useMemo(() => formats.map((f) => ({ id: f.id, name: f.displayName })), [formats]);

  const filteredFields = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fieldMeta.filter((f) => {
      if (q && !`${f.name} ${f.source} ${f.description} ${f.type}`.toLowerCase().includes(q)) return false;
      if (typeFilter !== 'all' && f.type !== typeFilter) return false;
      if (requiredFilter === 'default' && !f.isDefault) return false;
      if (requiredFilter === 'optional' && f.isDefault) return false;
      if (formatFilter !== 'all' && !f.formatIds?.includes(formatFilter)) return false;
      if (sourceFilter !== 'all' && f.source !== sourceFilter) return false;
      return true;
    });
  }, [fieldMeta, query, typeFilter, requiredFilter, formatFilter, sourceFilter]);

  if (loading && !data) return <LoadingState text="Loading formats & fields..." />;

  return (
    <div className="space-y-4 pb-2">
      <PageHeader title="Formats & Fields" subtitle="Export format registry and field definitions">
        <Button asChild size="sm" variant="outline">
          <Link href="/data-saver/formats/settings">
            <Settings2 className="h-3.5 w-3.5" /> Format Settings
          </Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={retry}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </PageHeader>

      {loadError && (
        <SectionCard title="Formats & Fields — showing last valid data" icon={Code}>
          <InlineError reason={loadError} onRetry={retry} />
        </SectionCard>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* FORMATS */}
        <SummaryCard icon={Code} title="Formats" status={`${fmtNumber(totalFormats)} serializers`}>
          <Field label="Total formats" value={<b>{fmtNumber(totalFormats)}</b>} strong />
          <Field label="Enabled (available)" value={fmtNumber(availableCount)} />
          <Field label="Disabled (missing dep)" value={fmtNumber(disabledCount)} />
          <Field label="Default format" value={defaultFormat ? defaultFormat.toUpperCase() : '—'} />
          <Field label="Categories" value={fmtNumber(data?.categories?.length ?? 0)} />
          <Field label="Exports (all time)" value={fmtNumber(toFinite(data?.stats?.totalDownloads) ?? 0)} />
        </SummaryCard>

        {/* FIELDS */}
        <SummaryCard icon={PanelsTopLeft} title="Fields" status={`${fmtNumber(totalFields)} fields`}>
          <Field label="Total fields" value={<b>{fmtNumber(totalFields)}</b>} strong />
          <Field label="Default in export" value={fmtNumber(defaultFieldCount)} />
          <Field label="Optional" value={fmtNumber(Math.max(totalFields - defaultFieldCount, 0))} />
          <Field label="Field types" value={fmtNumber(typeOptions.length)} />
          <Field label="Sources" value={fmtNumber(sourceOptions.length)} />
          <Field label="Exports today" value={fmtNumber(toFinite(data?.stats?.todayDownloads) ?? 0)} />
        </SummaryCard>
      </div>

      {data?.ok === false ? (
        <SectionCard title="Format Registry" icon={Code}>
          <InlineError reason={data.reason} onRetry={retry} />
        </SectionCard>
      ) : formats.length === 0 && !loading ? (
        <EmptyState icon={Code} title="No formats available" description="The format registry could not be reached from the backend." />
      ) : (
        <>
          {/* ===================== FORMATS ===================== */}
          <section aria-label="Formats" className="space-y-2">
            <SectionHeading>Formats ({formats.length})</SectionHeading>
            {data?.categories && data.categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-0.5">
                {data.categories.map((c) => (
                  <span key={c} className="rounded-full border border-border bg-card/50 px-2 py-0.5 text-[10px] text-muted-foreground">{c}</span>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {formats.map((f) => {
                const Icon = EXT_ICON[f.id] ?? FileText;
                const open = fmtOpen.has(f.id);
                const isDefault = defaultFormat === f.id;
                return (
                  <div key={f.id} className="rounded-xl border border-border bg-card/50">
                    <button
                      type="button"
                      onClick={() => toggleSet(setFmtOpen, f.id)}
                      className="flex w-full items-start justify-between gap-2 p-3 text-left"
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold leading-tight">{f.displayName}{isDefault ? ' ★' : ''}</h3>
                          <p className="truncate text-[10px] text-muted-foreground font-mono">.{f.extension} · {f.category}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <StatusBadge status={f.available ? 'success' : 'neutral'} label={f.available ? 'On' : 'Off'} />
                        {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                      </div>
                    </button>
                    {open && (
                      <div className="border-t border-border/60 px-3 py-2.5">
                        <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[11px] sm:grid-cols-3">
                          <Field label="Format ID" value={<span className="font-mono">{f.id}</span>} />
                          <Field label="Display name" value={f.displayName} />
                          <Field label="Extension" value={<span className="font-mono">.{f.extension}</span>} />
                          <Field label="MIME type" value={<span className="font-mono">{f.mimeType}</span>} />
                          <Field label="Category" value={f.category} />
                          <Field label="Status" value={f.available ? 'Enabled' : 'Unavailable'} />
                        </div>
                        <p className="mt-2 text-[11px] text-muted-foreground">{f.description}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* ===================== FIELDS ===================== */}
          <section aria-label="Fields" className="space-y-2">
            <SectionHeading>Fields ({fieldMeta.length})</SectionHeading>
            {data?.fields?.ok === false ? (
              <SectionCard title="Fields" icon={PanelsTopLeft}>
                <InlineError reason={data.fields.reason} onRetry={retry} />
              </SectionCard>
            ) : fieldMeta.length === 0 ? (
              <SectionCard title="Fields" icon={PanelsTopLeft}>
                <p className="text-xs text-muted-foreground">No field metadata reported by the backend.</p>
              </SectionCard>
            ) : (
              <>
                {/* Search + filters */}
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search fields by name, source, type, description..."
                      className="w-full rounded-lg border border-border bg-card/50 py-2 pl-8 pr-3 text-xs outline-none focus:border-primary/50"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="rounded-lg border border-border bg-card/50 px-2 py-1.5 text-[11px] outline-none">
                      <option value="all">Type: all</option>
                      {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select value={requiredFilter} onChange={(e) => setRequiredFilter(e.target.value)} className="rounded-lg border border-border bg-card/50 px-2 py-1.5 text-[11px] outline-none">
                      <option value="all">Required: all</option>
                      <option value="default">Default</option>
                      <option value="optional">Optional</option>
                    </select>
                    <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="rounded-lg border border-border bg-card/50 px-2 py-1.5 text-[11px] outline-none">
                      <option value="all">Source: all</option>
                      {sourceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select value={formatFilter} onChange={(e) => setFormatFilter(e.target.value)} className="rounded-lg border border-border bg-card/50 px-2 py-1.5 text-[11px] outline-none">
                      <option value="all">Format: all</option>
                      {formatOptions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </div>
                  <p className="text-[10px] text-muted-foreground px-0.5">{filteredFields.length} of {fieldMeta.length} fields</p>
                </div>

                <div className="space-y-2">
                  {filteredFields.length === 0 && (
                    <p className="py-6 text-center text-xs text-muted-foreground">No fields match the current filters.</p>
                  )}
                  {filteredFields.map((f) => {
                    const open = fldOpen.has(f.name);
                    const supported = f.formatIds?.length
                      ? formats.filter((x) => f.formatIds.includes(x.id))
                      : [];
                    return (
                      <div key={f.name} className="rounded-lg border border-border bg-card/40">
                        <button
                          type="button"
                          onClick={() => toggleSet(setFldOpen, f.name)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-xs truncate">{f.name}</span>
                            <StatusBadge status={defaultFieldNames.has(f.name) || f.isDefault ? 'success' : 'neutral'} label={f.isDefault ? 'default' : 'optional'} />
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{f.type}</span>
                            {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                          </div>
                        </button>
                        {open && (
                          <div className="border-t border-border/60 px-3 py-2.5">
                            <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[11px] sm:grid-cols-3">
                              <Field label="Type" value={<span className="font-mono">{f.type}</span>} />
                              <Field label="Source" value={f.source} />
                              <Field label="Default in export" value={f.isDefault ? 'Yes' : 'No'} />
                            </div>
                            {f.description && <p className="mt-1.5 text-[11px] text-muted-foreground">{f.description}</p>}
                            <div className="mt-2.5">
                              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Supported formats ({supported.length})</p>
                              <div className="flex flex-wrap gap-1.5">
                                {supported.length === 0 && <span className="text-[10px] text-muted-foreground">No format relations reported</span>}
                                {supported.map((x) => (
                                  <span key={x.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-card/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                                    <Tag className="h-2.5 w-2.5" />{x.displayName}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </>
      )}

      {data?.updatedAt && (
        <p className="text-[10px] text-muted-foreground px-0.5">Updated {new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} (IST)</p>
      )}
    </div>
  );
}
