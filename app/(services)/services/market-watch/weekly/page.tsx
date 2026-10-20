'use client';
import OriginalPage from '@/app/_pages/market-watch/page';

/**
 * /services/market-watch/weekly — the Saturday review surface.
 * docs/engines/MARKET_WATCH.md §4, §5, §6, §32, §33.
 *
 * Engine control belongs on the Services phase, and weekly membership is an
 * operator decision, so the review/lock flow is reachable here as well as from
 * the trading/data-saver Market Watch pages.
 */

export default function MarketWatchWeeklyPage() {
  return <OriginalPage initialTab="weekly" />;
}