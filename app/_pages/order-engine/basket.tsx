'use client';

import { useState } from 'react';
import { Boxes, RefreshCw, Play, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useBackend } from '@/lib/use-backend';
import { getBaskets } from '@/lib/api';

/**
 * SERVICES -> Trading -> Order Engine -> Basket
 *
 * Basket orders are NOT a separate engine — they live inside Order Engine.
 * CRUD + sequential OCO execution behind GET/POST/PUT/DELETE /api/baskets and
 * POST /api/baskets/{id}/push. All legs pass through the single order choke
 * point. Shows the stored baskets with their legs.
 */
const API = '/api/baskets';

function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '\u2014';
  return Number(n).toLocaleString('en-IN');
}

export default function OrderEngineBasketPage() {
  const { data, error, loading, refresh } = useBackend(async () => (await getBaskets())?.data ?? []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const baskets = Array.isArray(data) ? data : [];

  const push = async (basketId: string) => {
    setBusyId(basketId); setNotice(null);
    try {
      const res = await fetch(`${API}/${basketId}/push`, { method: 'POST', cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.detail ?? `HTTP ${res.status}`);
      setNotice({ kind: 'ok', text: 'Basket pushed through Order Engine.' });
      refresh();
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message ?? String(e) });
    }
    setBusyId(null);
  };

  const del = async (basketId: string) => {
    setBusyId(basketId); setNotice(null);
    try {
      const res = await fetch(`${API}/${basketId}`, { method: 'DELETE', cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.detail ?? `HTTP ${res.status}`);
      setNotice({ kind: 'ok', text: 'Basket deleted.' });
      refresh();
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message ?? String(e) });
    }
    setBusyId(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Order Engine · Basket</h1>
            <p className="text-xs text-muted-foreground">Basket CRUD + sequential execution (part of Order Engine)</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {notice && <Badge className={notice.kind === 'ok' ? 'bg-success text-success-foreground' : 'bg-destructive text-destructive-foreground'}>{notice.text}</Badge>}
          <Button size="sm" variant="outline" onClick={refresh}><RefreshCw className="mr-1 h-3 w-3" /> Refresh</Button>
        </div>
      </div>

      {error && <div className="rounded bg-rose-500/10 px-3 py-2 text-sm text-rose-300">Baskets unavailable: {error}</div>}
      {loading && !data && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Loading baskets…</CardContent></Card>}
      {data && baskets.length === 0 && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No baskets stored (honest zero).</CardContent></Card>}

      <div className="grid gap-3 md:grid-cols-2">
        {baskets.map((b: any) => {
          const id = b?._id ?? b?.id ?? '';
          const orders = b?.orders ?? [];
          const open = openId === id;
          return (
            <Card key={id} className="shadow-soft">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex items-center gap-2">
                  <Boxes className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm">{b?.name ?? '\u2014'}</CardTitle>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline">{orders.length} legs</Badge>
                  <Badge variant="outline" className={b?.cancelOnFill ? 'border-emerald-500/30 text-emerald-300' : ''}>{b?.cancelOnFill ? 'OCO' : 'parallel'}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Created</span><span className="font-mono">{b?.createdAt ? new Date(b.createdAt).toLocaleString() : '\u2014'}</span></div>
                <button onClick={() => setOpenId(open ? null : id)} className="text-xs text-primary underline-offset-2 hover:underline">
                  {open ? 'Hide legs' : 'Show legs'}
                </button>
                {open && (
                  <div className="overflow-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="text-left text-muted-foreground"><th className="pb-1">Symbol</th><th className="pb-1">Side</th><th className="pb-1">Qty</th><th className="pb-1">Product</th></tr></thead>
                      <tbody>
                        {orders.map((o: any, i: number) => (
                          <tr key={i} className="border-t border-white/5">
                            <td className="py-1">{o?.symbol ?? '\u2014'}</td>
                            <td className={o?.transactionType === 'SELL' ? 'text-rose-300' : 'text-emerald-300'}>{o?.transactionType ?? '\u2014'}</td>
                            <td className="font-mono">{fmtNum(o?.quantity)}</td>
                            <td>{o?.product ?? '\u2014'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" className="flex-1" onClick={() => push(id)} disabled={busyId === id}><Play className="mr-1 h-3 w-3" /> Push to engine</Button>
                  <Button size="sm" variant="outline" onClick={() => del(id)} disabled={busyId === id} className="text-rose-300"><Trash2 className="h-3 w-3" /></Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}