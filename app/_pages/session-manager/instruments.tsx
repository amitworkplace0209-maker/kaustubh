'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2, ChevronLeft, ChevronRight, Database, PinIcon, Play, RefreshCw, Search, Terminal, Timer, Trash2, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import {
  SM, TONE, fmtNum, fmtTs, tierBadge, useCadenceRefresh, SmPageHeader,
} from '@/app/_pages/session-manager/sm-shared';

/**
 * SERVICES → Session Manager → Instruments.
 *
 * GET /api/phase3/session-manager/instruments?limit=2000 — canonical instrument
 * records with lifecycle actions (subscribe / unsubscribe / pin / expire /
 * archive) that mutate REAL backend state. No fabricated rows.
 */

function InstrumentDetailSheet({ row, open, onClose, onAction }: {
  row: any;
  open: boolean;
  onClose: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
}) {
  const iid = row ? `${row.broker ?? 'kotak'}|${row.exchange_segment}|${row.instrument_token}` : '';
  const { data: events, refresh: refreshEvents } = useOneShot<any[]>(
    open && iid ? `${SM}/events?instrument_id=${encodeURIComponent(iid)}&limit=50` : null,
  );
  if (!row) return null;
  const detailRows: Array<[string, any]> = [
    ['Symbol', row.symbol], ['Token', row.instrument_token], ['Key', row.instrument_key],
    ['Segment', row.exchange_segment], ['Broker', row.broker], ['Status', row.status],
    ['Desired', row.desired], ['Subscribed', row.subscribed], ['Active', row.active],
    ['Feed level', row.feed_level ?? row.market_data], ['isIndex', row.is_index], ['isDepth', row.is_depth],
    ['Expiry type', row.expiry_type], ['Expiry label', row.expiry_label], ['Expires at', fmtTs(row.expires_at)],
    ['Routing', row.routing?.state], ['Subscribers', fmtNum(row.subscribers?.length)],
    ['Sources', (row.sources ?? []).join(', ')],
    ['Required fields', (row.required_fields ?? []).join(', ')],
    ['Consumers', (row.consumers ?? []).join(', ')],
    ['Error', row.error], ['Last tick', fmtTs(row.last_tick_at)],
    ['Last update', fmtTs(row.last_update_at)],
    ['Revision', fmtNum(row.revision)],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== '—') as Array<[string, any]>;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{row.symbol ?? 'Instrument'} <span className="font-mono text-sm text-muted-foreground">{row.instrument_token}</span></SheetTitle>
          <SheetDescription>Full canonical record — every field is real backend state.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => onAction('subscribe')}><Play className="h-3.5 w-3.5" /> Subscribe</Button>
          <Button size="sm" variant="outline" onClick={() => onAction('unsubscribe')}><X className="h-3.5 w-3.5" /> Unsubscribe</Button>
          <Button size="sm" variant="outline" onClick={() => onAction('pin', { profile_id: 'PINNED_HIGH', priority: 1 })}><PinIcon className="h-3.5 w-3.5" /> Pin</Button>
          <Button size="sm" variant="outline" onClick={() => onAction('expire', {})}><Timer className="h-3.5 w-3.5" /> Expire now</Button>
          <Button size="sm" variant="outline" onClick={() => onAction('remove', { purge: false })}><Trash2 className="h-3.5 w-3.5" /> Archive</Button>
        </div>
        <div className="mt-4 space-y-1.5 text-xs">
          {detailRows.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between border-b border-black/[0.06] py-1 gap-3">
              <span className="text-muted-foreground shrink-0">{k}</span>
              <span className="font-mono text-right break-all">{String(v)}</span>
            </div>
          ))}
          {!detailRows.length && <div className="text-muted-foreground">No detail fields.</div>}
        </div>
        <div className="mt-5 flex items-center gap-2">
          <h4 className="text-xs font-medium flex items-center gap-1.5"><Terminal className="h-3.5 w-3.5" /> Recent lifecycle events</h4>
          <Button size="sm" variant="ghost" onClick={refreshEvents}><RefreshCw className="h-3 w-3" /> Refresh</Button>
        </div>
        <div className="max-h-72 overflow-auto rounded border border-black/[0.08] mt-2">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/60 text-muted-foreground text-left">
              <tr>
                <th className="px-2 py-1.5">Time</th><th className="px-2 py-1.5">Event</th><th className="px-2 py-1.5">Rev</th><th className="px-2 py-1.5">Details</th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).map((e: any, i: number) => (
                <tr key={e._id ?? i} className="border-t border-black/[0.06]">
                  <td className="px-2 py-1.5 font-mono">{fmtTs(e.ts ?? e.timestamp ?? e.created_at)}</td>
                  <td className="px-2 py-1.5"><Badge variant="outline" className={TONE[e.severity ?? ''] ?? ''}>{String(e.event ?? 'event').toUpperCase()}</Badge></td>
                  <td className="px-2 py-1.5 font-mono">{fmtNum(e.revision)}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{e.message ?? e.details ?? '—'}</td>
                </tr>
              ))}
              {!(events ?? []).length && <tr><td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">No lifecycle events recorded for this instrument.</td></tr>}
            </tbody>
          </table>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function SessionManagerInstrumentsPage() {
  // Default = Market Watch list stocks hi (source market_watch_daily_universe);
  // poora instrument master opt-in rehta hai 'All instruments' se.
  const [scope, setScope] = useState<'market_watch' | 'all'>('market_watch');
  const scoped = scope === 'market_watch';
  const { data, error, refresh } = useOneShot<any[]>(scoped ? `${SM}/instruments?scope=market_watch&limit=2000` : `${SM}/instruments?limit=2000`);
  useCadenceRefresh(refresh);
  // Market Watch sync: jab Market Watch apni list update kare
  // (status/ranking/pins frames), ye registry list bhi auto-refresh ho.
  const { subscribe, onFrame } = useFrontendRealtime();
  const [mwSyncAt, setMwSyncAt] = useState<number | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void subscribe([{ channel: 'market_watch' }]).catch(() => {});
    let last = 0;
    const MIN_MS = 8000; // frame-burst guard: max 1 refetch per 8s
    return onFrame((frame) => {
      const t = frame?.type ?? '';
      if (t !== 'market_watch.status' && t !== 'market_watch.ranking' && t !== 'market_watch.pins') return;
      const now = Date.now();
      if (now - last < MIN_MS) return;
      last = now;
      refreshRef.current();
      setMwSyncAt(now);
    });
  }, [subscribe, onFrame]);
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const rows = (data ?? []) as any[];
  useEffect(() => { setPage(0); }, [q, scope]);

  const act = async (iid: string, action: string, extra: Record<string, unknown> = {}) => {
    try {
      const res = await fetch(`${SM}/instruments/${encodeURIComponent(iid)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extra),
      });
      const json = await res.json();
      setNotice(json.ok ? { kind: 'ok', text: `${action} ok (${json.data?.applied ?? 1})` } : { kind: 'err', text: json.error ?? `HTTP ${res.status}` });
      refresh();
    } catch (e: any) {
      setNotice({ kind: 'err', text: String(e?.message ?? e) });
    }
  };

  const filtered = q
    ? rows.filter((r) => (r.symbol ?? '').toLowerCase().includes(q.toLowerCase())
        || String(r.instrument_token ?? '').includes(q)
        || (r.status ?? '').toLowerCase().includes(q.toLowerCase())
        || (r.is_depth ? 'depth' : '').includes(q.toLowerCase()))
    : rows;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  if (error) return (
    <div className="space-y-4">
      <SmPageHeader icon={Database} title="Instruments" caption="GET /api/phase3/session-manager/instruments?limit=2000 — canonical instrument records." onRefresh={refresh} />
      <div className="text-rose-400 text-sm">Failed to load: {error}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <SmPageHeader
        icon={Database}
        title="Instruments"
        caption={scoped
          ? 'GET /api/phase3/session-manager/instruments?scope=market_watch — sirf Market Watch list stocks, real lifecycle actions, WS#2 cadence refresh.'
          : 'GET /api/phase3/session-manager/instruments?limit=2000 — full instrument master. Row actions mutate real lifecycle state; refreshes on the WS#2 engine cadence.'}
        badges={
          <>
            <Badge variant="outline" className={scoped ? 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-800' : 'border-sky-500/30 bg-sky-500/10 text-sky-800'}>
              {scoped ? 'Market Watch list' : 'All instruments'}
            </Badge>
            <Badge variant="outline">{filtered.length}{scoped && rows.length ? ` / ${rows.length} MW` : ` / ${rows.length}`}</Badge>
            <Badge variant="outline" className="tabular-nums" title="Market Watch list update par auto-refresh">
              MW sync {mwSyncAt ? new Date(mwSyncAt).toLocaleTimeString('en-IN', { hour12: false }) : '—'}
            </Badge>
          </>
        }
        onRefresh={refresh}
      />

      {notice && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${notice.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800' : 'border-rose-500/30 bg-rose-500/10 text-rose-800'}`}>
          {notice.kind === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="dismiss" className="opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div aria-label="registry scope" className="flex items-center rounded-full border border-border bg-muted/40 p-0.5 shadow-inner">
          <button
            type="button"
            onClick={() => setScope('market_watch')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-all duration-200 ${scoped ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/30' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Market Watch list
          </button>
          <button
            type="button"
            onClick={() => setScope('all')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-all duration-200 ${!scoped ? 'bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-md shadow-sky-500/30' : 'text-muted-foreground hover:text-foreground'}`}
          >
            All instruments
          </button>
        </div>
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by symbol / token / status / depth… (click a row for detail)" className="pl-8" />
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="previous page"><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-xs text-muted-foreground font-mono">{safePage + 1} / {totalPages}</span>
          <Button size="sm" variant="ghost" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)} aria-label="next page"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>
      <Card className="shadow-soft transition-all duration-200 hover:shadow-soft-lg">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground border-b">
                <tr>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Token</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Feed</th>
                  <th className="px-3 py-2">Sub / Pin</th>
                  <th className="px-3 py-2">Sources</th>
                  <th className="px-3 py-2">Last tick</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r: any) => {
                  const iid = `${r.broker ?? 'kotak'}|${r.exchange_segment}|${r.instrument_token}`;
                  return (
                    <tr key={iid} className="border-b border-black/[0.06] hover:bg-fuchsia-500/[0.06] cursor-pointer transition-colors" onClick={() => setSelected(r)}>
                      <td className="px-3 py-2 font-medium">
                        {r.symbol || '—'}
                        {r.is_depth && <Badge variant="outline" className="ml-1.5 bg-fuchsia-500/15 text-fuchsia-800 border-fuchsia-500/30 text-[10px]">D8</Badge>}
                        {r.is_index && <Badge variant="outline" className="ml-1.5 bg-sky-500/15 text-sky-800 border-sky-500/30 text-[10px]">IDX</Badge>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.instrument_token || '—'}</td>
                      <td className="px-3 py-2 text-xs uppercase">{r.exchange_segment || '—'}</td>
                      <td className="px-3 py-2"><Badge variant="outline" className={TONE[r.status] ?? ''}>{r.status ?? '—'}</Badge></td>
                      <td className="px-3 py-2">{tierBadge(r.feed_level, r.market_data)}</td>
                      <td className="px-3 py-2 text-xs">
                        <span className={r.desired ? 'text-emerald-800' : ''}>{r.desired ? 'desired' : 'idle'}</span>
                        {r.pin ? <span className="ml-1.5 text-amber-800">· pinned</span> : null}
                      </td>
                      <td className="px-3 py-2 text-xs">{(r.sources ?? []).slice(0, 3).join(', ') || '—'}</td>
                      <td className="px-3 py-2 text-xs font-mono">{fmtTs(r.last_tick_at)}</td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" title="subscribe" onClick={() => act(iid, 'subscribe')}><Play className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="ghost" title="unsubscribe" onClick={() => act(iid, 'unsubscribe')}><X className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="ghost" title="pin" onClick={() => act(iid, 'pin', { profile_id: 'PINNED_HIGH', priority: 1 })}><PinIcon className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="ghost" title="expire now (real)" onClick={() => act(iid, 'expire', {})}><Timer className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="ghost" title="remove (archive, ticks kept)" onClick={() => act(iid, 'remove', { purge: false })}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!pageRows.length && (
                  <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground text-sm">No instruments match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <InstrumentDetailSheet
        row={selected}
        open={!!selected}
        onClose={() => setSelected(null)}
        onAction={(a, extra) => {
          if (!selected) return;
          const iid = `${selected.broker ?? 'kotak'}|${selected.exchange_segment}|${selected.instrument_token}`;
          void act(iid, a, extra ?? {});
          if (a === 'remove') setSelected(null);
        }}
      />
    </div>
  );
}