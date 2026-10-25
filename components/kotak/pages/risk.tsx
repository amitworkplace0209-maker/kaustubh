'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Layers, RefreshCw, ShieldAlert, Wallet, Lock, Unlock, ShieldX, ShieldCheck, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, MetricCard, SectionCard, StatusBadge, PageHeader } from '@/components/design-system';
import { TradingService, type FundsResult } from '@/lib/trading-service';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { KotakPage } from '@/components/kotak/ui';
import { fmtRs, fmtPnl, fmtPct } from '@/lib/formatters';
import { pnlTone } from '@/lib/kotak';
import { cn } from '@/lib/utils';
import { getRiskConfig, validateRiskOrder, getTradingDashboard } from '@/lib/api';

const ENGINE_PATH = '/api/services/risk';

function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '\u2014';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function KotakRisk() {
  const { latest, connected } = useLatestTicks(true);
  const [positions, setPositions] = useState<any[]>([]);
  const [funds, setFunds] = useState<FundsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Risk Engine state
  const [riskConfig, setRiskConfig] = useState<any>(null);
  const [riskConfigLoading, setRiskConfigLoading] = useState(true);
  const [riskConfigError, setRiskConfigError] = useState<string | null>(null);

  // Validate sandbox
  const [validateResult, setValidateResult] = useState<any>(null);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [validateBusy, setValidateBusy] = useState(false);
  const [symbol, setSymbol] = useState('RELIANCE-EQ');
  const [tx, setTx] = useState('BUY');
  const [qty, setQty] = useState('10');
  const [price, setPrice] = useState('0');

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const pRes = await TradingService.getPositions().catch(() => null);
      const list = Array.isArray(pRes?.data) ? pRes.data : pRes?.data ? [pRes.data] : [];
      setPositions(list);
      const nextFunds = await TradingService.getFunds().catch(() => null);
      if (nextFunds) setFunds(nextFunds);
    } catch (e: any) {
      setError(e?.message ?? 'risk data unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRiskConfig = useCallback(async () => {
    setRiskConfigLoading(true);
    setRiskConfigError(null);
    try {
      const res = await getRiskConfig();
      setRiskConfig(res?.data ?? res);
    } catch (e: any) {
      setRiskConfigError(e?.message ?? String(e));
    } finally {
      setRiskConfigLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { void loadRiskConfig(); }, [loadRiskConfig]);

  const exposure = useMemo(
    () => positions.reduce((acc, p) => acc + (Number(p.net_qty) || 0) * (Number(p.ltp) || 0), 0),
    [positions],
  );

  const liveLtp = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of positions) {
      const sym = String(p.sym_clean || p.sym || p.trdSym_clean || p.trdSym || '').toUpperCase();
      const t = latest.get(sym);
      if (t && typeof t.ltp === 'number' && t.ltp > 0) map.set(sym, t.ltp);
    }
    return map;
  }, [positions, latest]);

  const rows = useMemo(() => positions.map((p) => {
    const sym = String(p.sym_clean || p.sym || p.trdSym_clean || p.trdSym || '').toUpperCase();
    const netQty = Number(p.net_qty) || 0;
    const avg = Number(p.avg_price || p.average_price) || 0;
    const ltp = liveLtp.get(sym) ?? (Number(p.ltp) || 0);
    const val = netQty * ltp;
    const pnl = netQty * (ltp - avg);
    return {
      key: `${sym}-${p.prod_clean || p.product || 'MIS'}`,
      symbol: sym,
      product: p.prod_clean || p.product || 'MIS',
      netQty, avg, ltp, val, pnl,
      pnlPct: avg > 0 ? (pnl / (Math.abs(netQty) * avg)) * 100 : 0,
    };
  }), [positions, liveLtp]);

  const totalPnl = useMemo(() => rows.reduce((a, r) => a + r.pnl, 0), [rows]);

  const runValidate = async () => {
    setValidateBusy(true); setValidateError(null); setValidateResult(null);
    try {
      const res = await validateRiskOrder({
        symbol, transactionType: tx, quantity: qty, price,
        product: 'MIS', orderType: 'LIMIT',
      });
      setValidateResult(res?.data ?? res);
    } catch (e: any) {
      setValidateError(e?.message ?? String(e));
    }
    setValidateBusy(false);
  };

  const decision = validateResult?.decision;
  const rules = validateResult?.rules ?? validateResult?.executedRules ?? [];
  const accepted = decision ?? validateResult?.accepted;

  const unrealizedPnl = totalPnl || null;

  if (error && !loading) {
    return (
      <KotakPage title="Risk">
        <ErrorState message={error} onRetry={() => void reload()} />
      </KotakPage>
    );
  }

  return (
    <KotakPage title="Risk">
      <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        Risk Engine: real backend policy from <code className="px-1 bg-amber-500/20">{ENGINE_PATH}</code> — every order passes through this gate.
      </div>

      <div className="space-y-6">
        {riskConfigError && (
          <div className="rounded bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            Risk config unavailable: {riskConfigError}
          </div>
        )}
        {riskConfigLoading && !riskConfig && (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Loading Risk policy…</CardContent></Card>
        )}

        {riskConfig && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Card className="shadow-soft">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><CardTitle className="text-sm">Per-order limits</CardTitle></div>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">Max qty / symbol</span><span className="font-mono">{fmtNum(riskConfig.maxQtyPerSymbol)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Max order value</span><span className="font-mono">₹{fmtNum(riskConfig.maxOrderValue)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Duplicate silo (s)</span><span className="font-mono">{fmtNum(riskConfig.duplicateOrderSiloSec)}</span></div>
                </CardContent>
              </Card>
              <Card className="shadow-soft">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <div className="flex items-center gap-2"><ShieldX className="h-4 w-4 text-primary" /><CardTitle className="text-sm">Exposure caps</CardTitle></div>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">Max daily loss %</span><span className="font-mono">{fmtNum(riskConfig.maxDailyLossPct)}%</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Max total exposure</span><span className="font-mono">₹{fmtNum(riskConfig.maxTotalExposure)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Merged daily P&amp;L</span><span className={`font-mono ${(unrealizedPnl ?? 0) < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{fmtNum(unrealizedPnl)}</span></div>
                </CardContent>
              </Card>
              <Card className="shadow-soft sm:col-span-2">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <div className="flex items-center gap-2"><Unlock className="h-4 w-4 text-primary" /><CardTitle className="text-sm">Allowed order types &amp; transactions</CardTitle></div>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1.5 text-xs">
                  {(riskConfig.orderTypeWhitelist ?? []).map((o: string) => <Badge key={`o-${o}`} variant="outline">{o}</Badge>)}
                  {(riskConfig.txWhitelist ?? []).map((t: string) => <Badge key={`t-${t}`} variant="outline" className="border-primary/40 text-primary">{t}</Badge>)}
                  {(riskConfig.blockedSymbols ?? []).length > 0 && (
                    <div className="mt-1 flex w-full flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground">Blocked:</span>
                      {(riskConfig.blockedSymbols ?? []).map((s: string) => <Badge key={`b-${s}`} className="bg-rose-500/15 text-rose-300 border border-rose-500/30">{s}</Badge>)}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="shadow-soft">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><CardTitle className="text-sm">Live decision sandbox</CardTitle></div>
                  <Badge variant="outline" className="border-primary/40 text-primary">{'POST ' + ENGINE_PATH + '/validate'}</Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1 text-xs"><span className="text-muted-foreground">Symbol</span>
                      <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-full rounded-md border border-white/10 bg-background px-2 py-1" />
                    </label>
                    <label className="space-y-1 text-xs"><span className="text-muted-foreground">Qty</span>
                      <input value={qty} onChange={(e) => setQty(e.target.value)} className="w-full rounded-md border border-white/10 bg-background px-2 py-1" />
                    </label>
                    <label className="space-y-1 text-xs"><span className="text-muted-foreground">Side</span>
                      <select value={tx} onChange={(e) => setTx(e.target.value)} className="w-full rounded-md border border-white/10 bg-background px-2 py-1">
                        <option>BUY</option><option>SELL</option>
                      </select>
                    </label>
                    <label className="space-y-1 text-xs"><span className="text-muted-foreground">Price</span>
                      <input value={price} onChange={(e) => setPrice(e.target.value)} className="w-full rounded-md border border-white/10 bg-background px-2 py-1" />
                    </label>
                  </div>
                  <Button size="sm" onClick={runValidate} disabled={validateBusy}>Validate against active policy</Button>
                  {validateError && <div className="rounded bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{validateError}</div>}
                  {validateResult && (
                    <div className="space-y-2 rounded border border-white/10 p-3 text-xs">
                      {typeof accepted === 'boolean' && (
                        <Badge className={accepted ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'}>
                          {accepted ? 'ALLOW' : 'BLOCK'}
                        </Badge>
                      )}
                      {Array.isArray(rules) && rules.length > 0 && (
                        <ul className="space-y-1">
                          {rules.map((r: any, i: number) => (
                            <li key={i} className="flex justify-between rounded bg-white/5 px-2 py-1">
                              <span>{r?.rule ?? r?.name ?? `rule ${i + 1}`}</span>
                              <span className="font-mono text-muted-foreground">{r?.value ?? r?.actual ?? ''} vs {fmtNum(r?.threshold) ?? ''} → <span className={r?.passed ? 'text-emerald-300' : 'text-rose-300'}>{r?.passed ? 'PASS' : r?.verdict ?? 'FAIL'}</span></span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <pre className="max-h-40 overflow-auto rounded bg-black/40 p-2 text-[10px] text-muted-foreground">{JSON.stringify(validateResult, null, 2)}</pre>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="shadow-soft">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><CardTitle className="text-sm">Positions (owned by Risk Engine)</CardTitle></div>
                  <Badge variant="outline">{positions.length || '0'}</Badge>
                </CardHeader>
                <CardContent>
                  {positions.length === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">No open positions (honest zero).</div>
                  ) : (
                    <div className="overflow-auto">
                      <table className="w-full text-xs">
                        <thead><tr className="text-left text-muted-foreground"><th className="pb-1">Symbol</th><th className="pb-1">Qty</th><th className="pb-1">Avg</th><th className="pb-1">LTP</th><th className="pb-1 text-right">P&amp;L</th></tr></thead>
                        <tbody>
                          {rows.map((p: any, i: number) => (
                            <tr key={i} className="border-t border-white/5"><td className="py-1">{p.symbol}</td><td className="font-mono">{fmtNum(p.netQty)}</td><td className="font-mono">{fmtNum(p.avg)}</td><td className="font-mono">{fmtNum(p.ltp)}</td><td className={`text-right font-mono ${(p.pnl ?? 0) < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{fmtNum(p.pnl)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <MetricCard
            icon={Wallet}
            title="Available margin"
            value={funds ? fmtRs(funds.availableMargin) : '—'}
            tone="neutral"
            loading={loading}
          />
          <MetricCard
            icon={Layers}
            title="Gross exposure"
            value={fmtRs(exposure)}
            tone="warning"
            loading={loading}
          />
          <MetricCard
            icon={AlertTriangle}
            title="Unrealised P&amp;L"
            value={fmtPnl(totalPnl)}
            tone={pnlTone(totalPnl)}
            loading={loading}
          />
        </div>

        <SectionCard
          title="Live Positions"
          icon={Layers}
          headerRight={
            <div className="flex items-center gap-2">
              <StatusBadge status={connected ? 'success' : 'neutral'} label={connected ? 'TICKS LIVE' : 'NEEDS LTP'} />
              <Button variant="ghost" size="sm" onClick={() => void reload()}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
            </div>
          }
        >
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-muted/60" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No open positions"
              description="When you hold a live position, its exposure, LTP and P&amp;L appear here from the real broker book."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg price</TableHead>
                  <TableHead className="text-right">LTP</TableHead>
                  <TableHead className="text-right">Exposure</TableHead>
                  <TableHead className="text-right">P&amp;L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell>
                      <span className="font-medium">{r.symbol}</span>
                      <span className="ml-2 text-[10px] text-muted-foreground">{r.product}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{r.netQty}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtRs(r.avg)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtRs(r.ltp)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtRs(r.val)}</TableCell>
                    <TableCell className={cn('text-right font-mono tabular-nums', r.pnl > 0 ? 'text-emerald-500' : r.pnl < 0 ? 'text-red-500' : '')}>
                      {fmtPnl(r.pnl)}
                      <span className="ml-1 text-[10px] text-muted-foreground">{fmtPct(r.pnlPct)}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>

        {funds && funds.usedMargin > 0 && (
          <SectionCard title="Margin Utilisation" icon={ShieldAlert}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Used</span>
                <span className="font-mono tabular-nums">{fmtRs(funds.usedMargin)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Total balance</span>
                <span className="font-mono tabular-nums">{fmtRs(funds.totalBalance)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Available</span>
                <span className="font-mono tabular-nums">{fmtRs(funds.availableMargin)}</span>
              </div>
            </div>
          </SectionCard>
        )}
      </div>
    </KotakPage>
  );
}