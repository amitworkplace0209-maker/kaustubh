'use client';

/**
 * Real-time data provenance banner.
 *
 * Shown above every Order Engine surface. A paper order that cannot execute
 * because no live price is arriving must say so plainly — an order book that
 * looks healthy while the feed is dead is the single most misleading state this
 * page can render.
 */
import { Activity, Radio, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { MarketDataStatus } from '@/lib/api';
import { TONE_CLASS } from './status';

export function MarketDataBanner({
  marketData,
  isPaper,
}: {
  marketData: MarketDataStatus | null;
  isPaper: boolean;
}) {
  if (!marketData) return null;
  const live = marketData.liveFeedReceiving;
  const paper = marketData.paperFeed;

  return (
    <Card className={live ? 'border-emerald-500/20' : 'border-amber-500/30'}>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-xs">
        <div className="flex items-center gap-2">
          {live ? (
            <Radio className="h-4 w-4 text-emerald-400" />
          ) : (
            <TriangleAlert className="h-4 w-4 text-amber-400" />
          )}
          <span className={live ? 'text-emerald-300' : 'text-amber-300'}>
            {live ? 'Live market data flowing' : 'No live market data'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Activity className="h-3 w-3" />
          <span className="font-mono">{marketData.ticksPerSecond.toFixed(1)}</span>
          <span>ticks/s</span>
        </div>

        <div className="text-muted-foreground">
          Tracked instruments: <span className="font-mono">{marketData.latestTickCount}</span>
        </div>

        <Badge variant="outline" className={TONE_CLASS[live ? 'emerald' : 'amber']}>
          {marketData.feedState}
        </Badge>

        {isPaper && paper && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span>
              Paper feed{' '}
              <Badge
                variant="outline"
                className={TONE_CLASS[paper.running ? 'emerald' : 'rose']}
              >
                {paper.running ? 'ACTIVE' : 'STOPPED'}
              </Badge>
            </span>
            {/* The point of the server-side feed: execution no longer depends on
                whether this page (or any page) happens to be open. */}
            {paper.browserDependent === false && (
              <span className="text-muted-foreground/80">(server-side · no browser required)</span>
            )}
          </div>
        )}

        {!live && (
          <p className="w-full text-amber-300/90">
            Orders will stay <span className="font-semibold">pending</span> until a real market
            price arrives. Nothing is filled from an assumed or generated price.
          </p>
        )}
      </CardContent>
    </Card>
  );
}