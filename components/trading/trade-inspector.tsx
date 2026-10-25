'use client';

import { memo, useMemo, useState } from 'react';
import {
  Boxes,
  CircleDollarSign,
  ShieldCheck,
  Target,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';
import type { InstrumentSelection, LiveQuote, PrecheckSummary, TicketState } from '@/components/orders/trade/types';
import { RiskPanel } from './risk-panel';
import { ChargesPanel } from './charges-panel';
import { TargetsPanel } from './targets-panel';
import { BasketPanel } from './basket-panel';
import { PositionPanel } from './position-panel';
import type { ArmedTrigger } from '@/lib/trigger-store';

export interface TradeInspectorProps {
  caps: TradeCapabilities;
  mode: string;
  terminal: string;
  selection: InstrumentSelection;
  ticket: TicketState;
  quote: LiveQuote | null;
  precheck: PrecheckSummary;
  checking: boolean;
  marginMessage: string | null;
  position: { symbol: string; netQty: number | null; avg: number | null; ltp: number | null; pnl: number | null } | null;
  basketLegs: Array<{ id: string; selection: InstrumentSelection; ticket: TicketState; addedAt: number }>;
  basketName: string;
  onBasketName: (name: string) => void;
  onAddToBasket: () => void;
  onRemoveLeg: (id: string) => void;
  onClearBasket: () => void;
  armedTrigger: ArmedTrigger | null;
  currency: string;
  sessionActive: boolean;
}

type TabId = 'risk' | 'charges' | 'targets' | 'basket' | 'position';

/**
 * The inspector — everything about the order that is not the order itself.
 *
 * Risk verdict, charges, targets, basket and the current position. The tabs
 * are always visible: a verdict that is hidden behind a toggle is a verdict
 * nobody reads.
 */
export const TradeInspector = memo(function TradeInspector(props: TradeInspectorProps) {
  const [tab, setTab] = useState<TabId>('risk');
  const { precheck, checking, basketLegs, quote } = props;

  const riskValue = useMemo(() => {
    if (checking) return 'checking';
    if (precheck.kind === 'PASS') return 'pass';
    if (precheck.kind === 'WARNING') return 'warn';
    if (precheck.kind === 'BLOCK') return 'block';
    if (precheck.kind === 'EMERGENCY_BLOCK') return 'locked';
    return 'unknown';
  }, [checking, precheck.kind]);

  const riskTone =
    riskValue === 'pass'
      ? 'success'
      : riskValue === 'warn'
        ? 'warning'
        : riskValue === 'block' || riskValue === 'locked'
          ? 'danger'
          : 'neutral';

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="w-full">
      <div className="sticky top-0 z-10 rounded-t-xl border border-border/70 bg-card/95 backdrop-blur">
        <TabsList className="h-auto w-full justify-start gap-0 rounded-t-xl bg-transparent p-1">
          <Tab value="risk" icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Risk" badge={riskValue} tone={riskTone} />
          <Tab value="charges" icon={<CircleDollarSign className="h-3.5 w-3.5" />} label="Charges" />
          <Tab value="targets" icon={<Target className="h-3.5 w-3.5" />} label="Targets" />
          <Tab value="basket" icon={<Boxes className="h-3.5 w-3.5" />} label="Basket" badge={String(basketLegs.length)} />
          <Tab value="position" icon={<TrendingUp className="h-3.5 w-3.5" />} label="Position" />
        </TabsList>
      </div>

      <TabsContent value="risk" className="mt-2">
        <RiskPanel
          precheck={precheck}
          checking={checking}
          supportsMargin={props.caps.supportsMarginPreview}
          marginMessage={props.marginMessage}
          sessionActive={props.sessionActive}
        />
      </TabsContent>

      <TabsContent value="charges" className="mt-2">
        <ChargesPanel ticket={props.ticket} quote={quote} selection={props.selection} currency={props.currency} />
      </TabsContent>

      <TabsContent value="targets" className="mt-2">
        <TargetsPanel
          terminal={props.terminal}
          symbol={props.selection.symbol}
          sessionActive={props.sessionActive}
          armedTrigger={props.armedTrigger}
          currency={props.currency}
        />
      </TabsContent>

      <TabsContent value="basket" className="mt-2">
        <BasketPanel
          legs={props.basketLegs}
          name={props.basketName}
          onName={props.onBasketName}
          onAdd={props.onAddToBasket}
          onRemove={props.onRemoveLeg}
          onClear={props.onClearBasket}
          currency={props.currency}
        />
      </TabsContent>

      <TabsContent value="position" className="mt-2">
        <PositionPanel position={props.position} quote={quote} currency={props.currency} />
      </TabsContent>
    </Tabs>
  );
});

function Tab({
  value,
  icon,
  label,
  badge,
  tone,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  tone?: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const badgeClass =
    tone === 'success'
      ? 'border-success/40 bg-success/15 text-success'
      : tone === 'warning'
        ? 'border-warning/40 bg-warning/15 text-warning'
        : tone === 'danger'
          ? 'border-destructive/40 bg-destructive/15 text-destructive'
          : 'border-border bg-muted/60 text-muted-foreground';
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[12px] font-semibold text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-muted/60 data-[state=active]:text-foreground',
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
      {badge && (
        <span className={cn('rounded border px-1 py-px text-[10px] font-bold uppercase', badgeClass)}>
          {badge}
        </span>
      )}
    </TabsTrigger>
  );
}
