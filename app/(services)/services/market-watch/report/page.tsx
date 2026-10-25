'use client';
import OriginalPage from '@/app/_pages/market-watch/page';

/**
 * /services/market-watch/report — the stored end-of-day report reader.
 * docs/engines/MARKET_WATCH.md §8, §26, §30.
 */

export default function MarketWatchReportPage() {
  return <OriginalPage initialTab="report" />;
}