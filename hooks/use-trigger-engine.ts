'use client';

// ---- Trigger execution engine ----
//
// ONE evaluator used by every live surface (positions page, order form).
// Given the latest LTP per instrument it:
//   1. finds ARMED triggers whose price condition is met,
//   2. ATOMICALLY claims each hit (store persists TRIGGERED before any
//      network call) so duplicate evaluation can never double-fire,
//   3. places exactly one opposite-side market square-off order.
//
// On placement failure the trigger stays TRIGGERED + FAILED (visible, never
// silently retried, never duplicated).

import { useCallback, useRef } from 'react';
import {
  getTriggerStore, triggerHit, type ArmedTrigger,
} from '@/lib/trigger-store';
import { TradingService } from '@/lib/trading-service';

export type TriggerOutcome = {
  id: string;
  kind: ArmedTrigger['kind'];
  ok: boolean;
  detail: string;
  squareOffOrderId?: string | null;
};

export function useTriggerEngine() {
  const inFlightRef = useRef<Set<string>>(new Set());

  /**
   * @param ltpFor resolve the latest LTP for a trigger; return null/0 when
   *               unknown (unknown prices NEVER fire triggers).
   */
  const evaluateTriggers = useCallback(async (
    ltpFor: (t: ArmedTrigger) => number | null,
  ): Promise<TriggerOutcome[]> => {
    const store = getTriggerStore();
    const armed = store.getArmed();
    if (armed.length === 0) return [];

    const outcomes: TriggerOutcome[] = [];
    for (const t of armed) {
      // Never start a second placement for the same trigger.
      if (inFlightRef.current.has(t.id)) continue;

      const ltp = ltpFor(t);
      if (!triggerHit(t, ltp ?? 0)) continue;

      inFlightRef.current.add(t.id);
      try {
        // Atomic single-fire gate: persisted TRIGGERED before network I/O.
        const claimed = store.claimTrigger(t.id);
        if (!claimed) continue;

        const exitSide = t.side === 'BUY' ? 'SELL' : 'BUY';
        try {
          const res = await TradingService.squareOffPosition({
            exchange: t.exchangeSegment || t.exchange,
            symbol: t.symbol,
            tradingSymbol: t.tradingSymbol,
            token: t.token,
            product: t.product,
            quantity: String(t.quantity),
            position_type: exitSide,
          });
          const orderId =
            res?.data?.n_ord_no ?? res?.data?.order_id ?? res?.demoOrder?.orderId ?? null;
          store.recordSquareOffOrder(t.id, orderId ? String(orderId) : 'placed');
          outcomes.push({
            id: t.id, kind: t.kind, ok: true,
            detail: `${exitSide} ${t.quantity} x ${t.tradingSymbol || t.symbol} @ market`,
            squareOffOrderId: orderId ? String(orderId) : null,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Square-off order failed';
          store.markFailed(t.id, msg);
          outcomes.push({ id: t.id, kind: t.kind, ok: false, detail: msg });
        }
      } finally {
        inFlightRef.current.delete(t.id);
      }
    }
    return outcomes;
  }, []);

  /** Manual re-arm after a FAILED attempt (explicit user action only). */
  const rearmFailed = useCallback((id: string) => {
    const store = getTriggerStore();
    const t = store.get(id);
    if (t && t.status === 'FAILED') {
      // Re-arm through `arm` so dedupe rules stay in one place.
      store.arm({
        kind: t.kind, positionId: t.positionId, orderId: t.orderId,
        symbol: t.symbol, tradingSymbol: t.tradingSymbol, companyName: t.companyName,
        token: t.token, exchange: t.exchange, exchangeSegment: t.exchangeSegment,
        product: t.product, side: t.side, quantity: t.quantity,
        triggerPrice: t.triggerPrice,
      });
    }
  }, []);

  return { evaluateTriggers, rearmFailed };
}
