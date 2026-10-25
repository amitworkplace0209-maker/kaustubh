/**
 * The one instrument-search network call.
 *
 * Kept separate from `lib/instrument-search.ts` (the pure contract) so the
 * contract stays unit-testable without the API layer.
 *
 * Every caller must go through here. The browser path is the same-origin
 * `/api/search` Next proxy; the legacy `/api/stocks/search`,
 * `/api/trading/search{,‑local}` and `/api/market-watch/search` endpoints are
 * duplicates and are being retired onto this call.
 */

import { searchGlobal } from '@/lib/api';
import {
  SEARCH_SUGGESTION_LIMIT,
  normalizeSearchResponse,
  type CanonicalSearchResponse,
} from '@/lib/instrument-search';

export interface InstrumentSearchOptions {
  limit?: number;
  scope?: string;
  withMargin?: boolean;
  signal?: AbortSignal;
}

export async function searchInstruments(
  query: string,
  opts: InstrumentSearchOptions = {},
): Promise<CanonicalSearchResponse> {
  const raw = await searchGlobal(query, {
    scope: opts.scope ?? 'stocks',
    limit: opts.limit ?? SEARCH_SUGGESTION_LIMIT,
    withMargin: opts.withMargin ?? false,
    signal: opts.signal,
    priority: 'auto',
  });
  return normalizeSearchResponse(raw);
}
