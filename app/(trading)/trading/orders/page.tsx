import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Trading has NO standalone page — it is a sidebar GROUP with nested pages
 * (Trade, Suggestion, History). This legacy /trading/orders URL
 * (bookmarks, old links, notifications) therefore resolves to the group's
 * default page instead of rendering a duplicate module shell.
 */
export default function TradingOrdersLegacyPage() {
  redirect('/trading/trade');
}
