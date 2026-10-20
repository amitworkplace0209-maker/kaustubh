'use client';

/**
 * SERVICES -> Trading -> Broker Terminal -> Terminals
 *
 * Terminal inventory + per-terminal audit trail (real: GET /api/terminal/list,
 * GET /api/terminal/audit). The audit rows come from the permanent
 * audit_engine collection via the terminal gateway.
 *
 * FIELD-NAME FIX (the important one): the previous revision read `t.mode`,
 * `t.terminal`, `t.enabled_first`, `t.adapter` and `t.broker`. `GET
 * /api/terminal/list` emits none of those — it returns
 * `{ id, name, active, enabled, isLoggedIn, capabilities: {...}, status }`.
 * So every row rendered `—` for Mode and Adapter. This page reads the keys the
 * gateway actually sends, keeps a tolerant alias list for forward-compat, and
 * renders the `capabilities` block (products / order types / exchanges /
 * search support) that was previously ignored entirely.
 *
 * Timestamps use `fmtTimestampIST` (IST-pinned) rather than the browser's own
 * locale, so the audit trail matches every other broker surface.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Building2,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileSearch,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, StatusBadge } from '@/components/design-system';
import {
  AUDIT_KIND_CLS,
  TERMINAL_META,
  auditKindName,
  productHint,
  sessionStateName,
  terminalHue,
} from '@/components/broker-terminal/broker-shared';
import { BrokerHero, StatTile, heroAccent } from '@/components/broker-terminal/broker-visual';
import { useBackend } from '@/lib/use-backend';
import { getTerminalAudit, getTerminalList } from '@/lib/api';
import { fmtTimestampIST } from '@/lib/formatters';
import { cn } from '@/lib/utils';

/** Audit-kind filter options, plus `all`. */
type KindFilter = 'all' | 'decision' | 'action' | 'system' | 'security';

export default function BrokerTerminalTerminalsPage() {
  const { data, error, refresh } = useBackend(getTerminalList);
  // Memoised loader: an inline arrow would re-fire the effect on every render.
  const auditLoader = useMemo(() => async () => (await getTerminalAudit(100))?.data ?? [], []);
  const { data: audit, refresh: refreshAudit } = useBackend(auditLoader);

  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const raw = data?.terminals ?? [];
  const active = data?.active ?? null;

  // `terminals` is normally an array; the gateway can also emit a CSV string.
  const terminals: Record<string, any>[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').filter(Boolean).map((t: string) => ({ id: t.trim(), name: t.trim() }))
      : [];

  const entries = useMemo<Record<string, any>[]>(
    () => (Array.isArray(audit) ? audit : []),
    [audit],
  );

  const filteredAudit = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (kindFilter !== 'all' && String(e?.kind ?? '').toLowerCase() !== kindFilter) return false;
      if (!q) return true;
      const hay = [e?.ts, e?.kind, e?.terminal, e?.action, e?.reason, e?.error, e?.event_id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [entries, query, kindFilter]);

  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) {
      const k = String(e?.kind ?? 'unknown').toLowerCase();
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const online = terminals.filter((t) => t?.enabled && t?.isLoggedIn).length;
  const configured = terminals.filter((t) => t?.enabled !== false).length;

  const copyAudit = async () => {
    try {
      if (!navigator?.clipboard?.writeText) return;
      await navigator.clipboard.writeText(JSON.stringify(entries, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard denied — stay silent */
    }
  };

  const hasFilters = Boolean(query.trim()) || kindFilter !== 'all';

  return (
    <div className="space-y-5">
      {/* ============================ HERO ============================ */}
      <BrokerHero accent={heroAccent(online > 0 ? 'success' : 'warning')}>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/30">
                <Building2 className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-display sm:text-2xl">Terminals</h1>
                <p className="text-xs text-muted-foreground">
                  Terminal registry &amp; audit trail · {active ? `${TERMINAL_META[active]?.name ?? active} is active` : 'no active terminal'}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => { refresh(); refreshAudit(); }}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Registered" value={terminals.length} icon={Building2} />
          <StatTile label="Configured" value={`${configured}/${terminals.length}`} tone={configured ? 'text-info' : 'text-warning'} icon={ShieldCheck} />
          <StatTile label="Online" value={online} tone={online ? 'text-success' : 'text-muted-foreground'} icon={CheckCircle2} />
          <StatTile label="Audit rows" value={entries.length} icon={FileSearch} />
        </div>
      </BrokerHero>

      {error ? <ErrorState message={error} onRetry={refresh} /> : null}

      {/* ============================ TERMINAL CARDS ============================ */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Terminal registry
        </h2>
        {terminals.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {terminals.map((t, i) => (
              <TerminalCard key={t?.id ?? i} term={t} isActive={t?.id === active} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Building2}
            title="No terminals registered"
            description="GET /api/terminal/list returned no rows. Nothing is substituted for it."
          />
        )}
      </section>

      {/* ============================ AUDIT TRAIL ============================ */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <FileSearch className="h-3.5 w-3.5 text-primary" aria-hidden />
            Audit trail
            <span className="rounded-full border border-border/60 px-1.5 py-px font-mono text-[9px] tabular-nums">
              {entries.length}
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]" onClick={copyAudit}>
              {copied ? <CheckCircle2 className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
              {copied ? 'Copied' : 'Copy JSON'}
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/50 p-2.5 backdrop-blur">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search time, terminal, action or reason…"
              aria-label="Search audit entries"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border/60 p-0.5">
            {(['all', 'decision', 'action', 'system', 'security'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={cn(
                  'rounded px-2 py-1 text-[11px] font-medium capitalize transition-colors',
                  kindFilter === k ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {k}
                {k !== 'all' ? (
                  <span className="ml-1 font-mono text-[9px] tabular-nums opacity-70">
                    {entries.filter((e) => String(e?.kind ?? '').toLowerCase() === k).length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 gap-1.5 text-[11px]"
              onClick={() => { setQuery(''); setKindFilter('all'); }}
            >
              <X className="h-3 w-3" aria-hidden />
              Clear
            </Button>
          ) : (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {filteredAudit.length === entries.length
                ? `${entries.length} entries`
                : `${filteredAudit.length} of ${entries.length}`}
            </span>
          )}
        </div>

        {/* Kind chips */}
        {kindCounts.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {kindCounts.map(([kind, n]) => {
              const p = auditKindName(kind);
              const isActive = kindFilter === kind.toLowerCase();
              return (
                <button
                  key={kind}
                  onClick={() => setKindFilter(isActive ? 'all' : kind.toLowerCase() as KindFilter)}
                  title={p?.blurb}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize transition-all',
                    AUDIT_KIND_CLS[kind.toLowerCase()] ?? 'border-border bg-muted text-muted-foreground',
                    isActive && 'ring-1 ring-primary/50',
                  )}
                >
                  {p?.label ?? kind} <span className="font-mono tabular-nums">{n}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Entries */}
        {filteredAudit.length ? (
          <div className="cm-scroll max-h-[40rem] space-y-1.5 overflow-auto pr-1">
            {filteredAudit.map((e, i) => {
              const kind = String(e?.kind ?? '').toLowerCase();
              const p = auditKindName(kind);
              const isOpen = expanded === i;
              const accepted = e?.accepted;
              return (
                <div
                  key={i}
                  className="cm-rise overflow-hidden rounded-lg border border-border/50 bg-card/50 transition-colors hover:border-border"
                  style={{ animationDelay: `${Math.min(i * 16, 240)}ms` }}
                >
                  <button
                    onClick={() => setExpanded(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/25"
                  >
                    <span className="w-28 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {fmtTimestampIST(e?.ts)}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium capitalize',
                        AUDIT_KIND_CLS[kind] ?? 'border-border bg-muted text-muted-foreground',
                      )}
                      title={p?.blurb}
                    >
                      {p?.label ?? e?.kind ?? '—'}
                    </span>
                    <span
                      className="hidden shrink-0 font-mono text-[10px] sm:block sm:w-24 sm:truncate"
                      style={{ color: terminalHue(e?.terminal) }}
                    >
                      {TERMINAL_META[e?.terminal]?.name ?? e?.terminal ?? '—'}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                      {e?.action ?? e?.reason ?? e?.error ?? e?.event_id ?? '—'}
                    </span>
                    <span className="shrink-0">
                      {accepted == null ? (
                        <span className="font-mono text-[10px] text-muted-foreground">—</span>
                      ) : accepted ? (
                        <StatusBadge status="success" label="accepted" />
                      ) : (
                        <StatusBadge status="danger" label="rejected" />
                      )}
                    </span>
                    <ChevronDown
                      className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200', isOpen && 'rotate-180')}
                      aria-hidden
                    />
                  </button>

                  {isOpen ? (
                    <div className="border-t border-border/40 bg-background/40 px-3 py-2.5">
                      <div className="grid gap-2 sm:grid-cols-4">
                        <Field label="Timestamp" value={fmtTimestampIST(e?.ts, '—')} />
                        <Field label="Kind" value={p?.label ?? e?.kind ?? '—'} />
                        <Field label="Terminal" value={TERMINAL_META[e?.terminal]?.name ?? e?.terminal ?? '—'} />
                        <Field label="Accepted" value={accepted == null ? '—' : accepted ? 'yes' : 'no'} />
                      </div>
                      <div className="mt-2">
                        <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">Detail</div>
                        <div className="break-words rounded-md border border-border/50 bg-card/50 px-2.5 py-1.5 font-mono text-[10px]">
                          {e?.action ?? e?.reason ?? e?.error ?? e?.event_id ?? '—'}
                        </div>
                      </div>
                      {p?.blurb ? (
                        <p className="mt-1.5 text-[10px] italic text-muted-foreground">{p.blurb}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : hasFilters ? (
          <EmptyState
            icon={Search}
            title="No audit entries match"
            description="Clear the search or switch the kind filter."
            action={
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setQuery(''); setKindFilter('all'); }}>
                <X className="h-3.5 w-3.5" aria-hidden />
                Reset filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={FileSearch}
            title="No audit entries"
            description="Honest zero — the gateway has not recorded any audit rows for this process."
          />
        )}
      </section>
    </div>
  );
}

// ===========================================================================
// TERMINAL CARD
// ===========================================================================

function TerminalCard({ term, isActive }: { term: Record<string, any>; isActive: boolean }) {
  const id = String(term?.id ?? '');
  const meta = TERMINAL_META[id];
  const Icon = meta?.icon ?? Building2;
  const enabled = term?.enabled !== false;
  const loggedIn = Boolean(term?.isLoggedIn);
  const caps = term?.capabilities ?? {};
  const proper = sessionStateName(term?.sessionState ?? term?.status);
  const [open, setOpen] = useState(isActive);

  const products = (caps.products ?? []).map((p: string) => productHint(p) ?? p);
  const orderTypes = caps.orderTypes ?? [];
  const exchanges = caps.exchangeTypes ?? [];

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-card/60 shadow-soft backdrop-blur transition-all hover:-translate-y-0.5',
        isActive ? 'border-primary/45' : 'border-border/60 hover:border-border',
      )}
    >
      <span aria-hidden className="block h-[2px]" style={{ background: terminalHue(id) }} />

      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ background: `${terminalHue(id)}22`, color: terminalHue(id) }}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{term?.name ?? meta?.name ?? id}</p>
              <p className="truncate font-mono text-[10px] text-muted-foreground">{id || '—'}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {isActive ? <Badge className="border-primary/40 bg-primary/15 text-primary">ACTIVE</Badge> : null}
            {!enabled ? <StatusBadge status="warning" label="Not configured" /> : null}
            {enabled ? (
              <StatusBadge status={loggedIn ? 'success' : 'danger'} label={loggedIn ? 'Connected' : 'Logged out'} />
            ) : null}
          </div>
        </div>

        <dl className="mt-3 space-y-0.5 border-t border-border/50 pt-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] uppercase tracking-wider text-muted-foreground">Kind</dt>
            <dd className="truncate text-[11px]">{meta?.kind ?? 'Broker terminal'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] uppercase tracking-wider text-muted-foreground">Configured</dt>
            <dd className="font-mono text-[11px]">{term?.enabled === false ? 'no' : 'yes'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] uppercase tracking-wider text-muted-foreground">Session</dt>
            <dd className="truncate text-[11px]" title={proper?.blurb}>
              {proper?.label ?? term?.status ?? '—'}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] uppercase tracking-wider text-muted-foreground">Search</dt>
            <dd className="font-mono text-[11px]">
              {caps.supportsSearch == null ? '—' : caps.supportsSearch ? 'supported' : 'not supported'}
            </dd>
          </div>
        </dl>

        {/* Capabilities — previously never rendered at all */}
        {products.length || orderTypes.length || exchanges.length ? (
          <div className="mt-3 space-y-1.5 border-t border-border/50 pt-2.5">
            {products.length ? (
              <CapRow label="Products" values={products} tone={terminalHue(id)} />
            ) : null}
            {exchanges.length ? <CapRow label="Exchanges" values={exchanges} tone="hsl(var(--info))" /> : null}
            {orderTypes.length ? <CapRow label="Order types" values={orderTypes} tone="hsl(var(--warning))" /> : null}
          </div>
        ) : (
          <p className="mt-3 border-t border-border/50 pt-2.5 text-[10px] text-muted-foreground">
            No capabilities reported for this terminal.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border/50 bg-background/30 px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
          {open ? 'Less' : 'Details'}
        </Button>
        <div className="ml-auto">
          {id ? (
            <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" asChild>
              <Link href={`/services/broker-terminal/profile/${id}`}>Open profile</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="border-t border-border/50 bg-background/25 px-4 py-2.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Terminal id" value={id || '—'} />
            <Field label="Raw status" value={term?.status ?? '—'} />
            <Field label="Capabilities" value={Object.keys(caps).length ? Object.keys(caps).join(', ') : 'none reported'} />
            <Field label="Gateway" value="terminal gateway" />
          </div>
          <p className="mt-2 text-[10px] italic leading-snug text-muted-foreground">
            Fields come straight from <span className="font-mono">GET /api/terminal/list</span>. Values the gateway
            does not send are shown as <span className="font-mono">—</span> rather than inferred.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function CapRow({ label, values, tone }: { label: string; values: string[]; tone: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-16 shrink-0 pt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap gap-1">
        {values.slice(0, 8).map((v) => (
          <span
            key={v}
            className="rounded border px-1.5 py-0.5 font-mono text-[9px]"
            style={{ borderColor: `${tone}55`, color: tone }}
          >
            {v}
          </span>
        ))}
        {values.length > 8 ? <span className="text-[9px] text-muted-foreground">+{values.length - 8}</span> : null}
      </span>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-[10px]" title={value}>{value}</div>
    </div>
  );
}