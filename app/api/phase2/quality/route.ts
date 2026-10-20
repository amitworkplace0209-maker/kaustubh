import { NextRequest } from 'next/server';
import { backendFetch } from '@/lib/backend';
import { istDateKey } from '@/lib/ist';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Data Quality.
 *
 * All metrics come from the REAL backend /api/system/quality-metrics
 * aggregation over stored tick documents plus real save/write counters.
 * Nothing is faked to 100. When there is no data, overallScore is null and
 * the UI renders "—" instead of inventing a pass mark.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const hours = Math.max(1, Math.min(720, Number(url.searchParams.get('hours')) || 24));
  const limit = Math.max(100, Math.min(500000, Number(url.searchParams.get('limit')) || 200000));

  const [qsRes, sysRes, statsRes, stocksRes] = await Promise.all([
    backendFetch(`/api/system/quality-metrics?hours=${hours}&limit=${limit}`, { timeoutMs: 10000 }),
    backendFetch('/api/system', { timeoutMs: 6000 }),
    backendFetch('/api/statistics', { timeoutMs: 6000 }),
    backendFetch('/api/stocks?active=true', { timeoutMs: 6000 }),
  ]);

  const q: any = qsRes.data || {};
  const sys: any = sysRes.data || {};
  const stats: any = statsRes.data || {};
  const stocks: any[] = stocksRes.data?.data ?? [];

  const total = typeof q.total === 'number' ? q.total : 0;
  const duplicates = typeof q.duplicates === 'number' ? q.duplicates : 0;
  const outOfOrder = typeof q.outOfOrder === 'number' ? q.outOfOrder : 0;
  const timestampErrors = typeof q.timestampErrors === 'number' ? q.timestampErrors : 0;
  const schemaErrors = typeof q.schemaErrors === 'number' ? q.schemaErrors : 0;
  const invalidLtp = typeof q.invalidLtp === 'number' ? q.invalidLtp : 0;
  const saveFailures = typeof q.saveFailures === 'number' ? q.saveFailures : 0;
  const attemptedSaves = typeof q.attemptedSaves === 'number' ? q.attemptedSaves : 0;

  const dupRate = total > 0 ? (duplicates / total) * 100 : null;
  const oooRate = total > 0 ? (outOfOrder / total) * 100 : null;
  const tsRate = total > 0 ? (timestampErrors / total) * 100 : null;
  const saveFailRate = attemptedSaves > 0 ? (saveFailures / attemptedSaves) * 100 : null;

  // Real formula (same as the dashboard route so they always agree).
  let overallScore: number | null = null;
  if (total > 0 || attemptedSaves > 0) {
    const score = 100 - ((dupRate ?? 0) * 2 + (oooRate ?? 0) * 3 + (tsRate ?? 0) * 2 + (saveFailRate ?? 0) * 5);
    overallScore = Math.max(0, Math.min(100, Math.round(score)));
  }

  const errorDistribution: { type: string; count: number; pct: number }[] = [];
  const allErrorKinds = [
    { type: 'Duplicate ticks', count: duplicates },
    { type: 'Out-of-order ticks', count: outOfOrder },
    { type: 'Timestamp errors', count: timestampErrors },
    { type: 'Schema errors', count: schemaErrors },
    { type: 'Invalid LTP', count: invalidLtp },
    { type: 'Save failures', count: saveFailures },
  ];
  const errTotal = allErrorKinds.reduce((s, e) => s + e.count, 0);
  for (const kind of allErrorKinds) {
    if (kind.count > 0) {
      errorDistribution.push({
        type: kind.type,
        count: kind.count,
        pct: Number(((kind.count / errTotal) * 100).toFixed(2)),
      });
    }
  }

  // Per-symbol quality from the real tick collection — count ticks and
  // duplicates per symbol in the inspected window. Runs CONCURRENTLY (no
  // sequential N+1) and caps the inspected set to guard the backend.
  const perSymbol: { symbol: string; ticks: number; duplicates: number; score: number | null }[] = [];
  if (stocks.length > 0) {
    const symbols = stocks.map((s) => String(s.symbol || '')).filter(Boolean).slice(0, 20);
    const rows = await Promise.all(
      symbols.map(async (sym) => {
        let ticks = 0;
        let dupForSym = 0;
        try {
          const bySymRes = await backendFetch(`/api/system/quality-metrics?hours=${hours}&limit=${limit}&symbol=${encodeURIComponent(sym)}`, { timeoutMs: 10000 });
          const bq: any = bySymRes.data || {};
          ticks = typeof bq.total === 'number' ? bq.total : 0;
          dupForSym = typeof bq.duplicates === 'number' ? bq.duplicates : 0;
        } catch { /* keep zeros only if the endpoint really cannot answer */ }
        let score: number | null = null;
        if (ticks > 0) {
          const d = ticks > 0 ? (dupForSym / ticks) * 100 : 0;
          score = Math.max(0, Math.min(100, Math.round(100 - d * 2)));
        }
        return { symbol: sym, ticks, duplicates: dupForSym, score };
      }),
    );
    perSymbol.push(...rows);
  }

  const perExchange = ['NSE', 'BSE'].map((exchange) => ({
    exchange,
    score: null,
    ticks: 0,
    errors: errTotal === 0 ? null : errTotal,
  }));

  const dailyTrend = canBuildTrend(sys)
    ? [{
        date: istDateKey(),
        score: overallScore,
        missing: 0,
        duplicates,
        outOfOrder,
        saveFailures,
      }]
    : [];

  return Response.json({
    overallScore,
    formula: 'score = 100 − (duplicateRate×2 + outOfOrderRate×3 + timestampErrorRate×2 + saveFailureRate×5), scored only when real data exists.',
    range: q.range ?? null,
    total,
    missingTicks: q.missing ?? null,
    duplicateTicks: duplicates,
    outOfOrder,
    invalidTimestamps: timestampErrors,
    invalidLtp,
    invalidVolume: null,
    invalidOhlc: null,
    missingBidAsk: null,
    malformedPayloads: null,
    schemaErrors,
    dbWriteFailures: saveFailures,
    attemptedSaves,
    wsPacketLoss: null,
    dailyTrend,
    perSymbol,
    perExchange,
    errorDistribution,
    totals: {
      totalTicks: total,
      effectiveInserts: Math.max(0, total - errTotal),
      attemptedSaves,
      saveFailures,
    },
    note:
      total === 0 && attemptedSaves === 0
        ? 'No tick or save data in the inspected window — metrics not measured.'
        : dbWriteFailuresWarning(),
  });
}

function canBuildTrend(sys: any): boolean {
  return typeof sys.todayRecords === 'number' || typeof sys.todayInserts === 'number';
}

function dbWriteFailuresWarning(): string {
  return 'Metrics are computed from real stored tick records and persistence counters.';
}