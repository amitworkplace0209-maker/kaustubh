'use client';

// Top Positions — the largest open positions by |Gross P&L|, real data.
// Rows come straight from the /api/trading/dashboard positions envelope.

import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { SectionHeading } from '@/components/design-system';
import { fmtPnl, fmtQty, fmtRs, pnlClr, toNum } from '@/lib/formatters';
import { Skeleton } from '@/components/ui/skeleton';

function symbolOf(r: Record<string, unknown>): string {
  const s = String(
    r.symbol ?? r.instrumentName ?? r.instrument_name ?? r.name ?? r.token ?? r.tradingSymbol ?? '',
  );
  return s || 'Unknown';
}

export function TopPositions({
  rows, down, loading, limit = 5,
}: {
  rows: any[]; down: boolean; loading: boolean; limit?: number;
}) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const row = r as Record<string, unknown>;
      const netSigned = toNum(row.netQuantity) ?? toNum(row.net_qty) ?? 0;
      const gross = toNum(row.grossPnl) ?? toNum(row.realizedPnl) ?? 0;
      return {
        symbol: symbolOf(row),
        side: String(row.positionType ?? '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG',
        qty: Math.abs(netSigned),
        avg: toNum(row.averagePrice) ?? 0,
        ltp: toNum(row.ltp) ?? 0,
        gross,
        net: gross - (toNum(row.estimatedCharges) ?? 0),
      };
    })
    .sort((a, b) => Math.abs(b.gross) - Math.abs(a.gross))
    .slice(0, limit);

  return (
    <section aria-label="Top positions" className="space-y-2" data-verify="top-positions">
      <SectionHeading>Top Positions</SectionHeading>
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : down ? (
        <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
          Positions feed unavailable
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
          No open positions today.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[420px] text-xs">
            <thead>
              <tr className="border-b border-border/50 bg-muted/30 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Instrument</th>
                <th className="px-3 py-2 text-right font-semibold">Side</th>
                <th className="px-3 py-2 text-right font-semibold">Qty</th>
                <th className="px-3 py-2 text-right font-semibold">LTP</th>
                <th className="px-3 py-2 text-right font-semibold">Gross P&L</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p, i) => (
                <tr key={`${p.symbol}-${i}`} className="border-b border-border/40 last:border-0">
                  <td className="px-3 py-2 font-medium text-foreground">{p.symbol}</td>
                  <td className="px-3 py-2 text-right">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                        p.side === 'SHORT'
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-success/10 text-success'
                      }`}
                    >
                      {p.side === 'SHORT' ? <ArrowDownRight className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                      {p.side === 'SHORT' ? 'Short' : 'Long'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmtQty(p.qty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {p.ltp > 0 ? fmtRs(p.ltp) : '\u2014'}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${pnlClr(p.gross)}`}>
                    {fmtPnl(p.gross)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}