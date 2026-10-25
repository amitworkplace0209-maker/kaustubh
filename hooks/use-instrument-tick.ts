'use client';

/**
 * Live LTP for ONE instrument, fed by the app's SINGLE shared tick stream.
 *
 * The Trade page needs a continuously-updating price for the selected symbol.
 * It used to depend solely on the WS#3 `trading` channel, so when that socket
 * was down (or slow to ack a fresh subscription) the LTP froze at whatever the
 * one-shot market-watch snapshot had — the classic "price not updating" report.
 *
 * This hook closes that gap:
 *   · it consumes the SAME shared SSE fanout every other live surface uses
 *     (`lib/shared-sse`) — no second socket, no new backend endpoint;
 *   · it matches the selected instrument by token first (exact) and symbol
 *     second (fallback for feeds that omit the token);
 *   · it flushes at most once per FLUSH_MS so a fast market cannot re-render
 *     the order ticket per message;
 *   · it reports `live` so callers can tell a streaming price from a REST seed.
 *
 * Nothing is invented here: `null` means "no tick has arrived for this
 * instrument yet", and every field comes from a real feed frame.
 */

import { useEffect, useRef, useState } from 'react';
import { subscribeTicks, subscribeSseState } from '@/lib/shared-sse';

/** Flush cadence — fast enough to look live, slow enough not to thrash React. */
const FLUSH_MS = 250;

export interface InstrumentTickQuote {
  ltp: number | null;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  change: number | null;
  changePct: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
  /** Backend receive time (ms) of the last tick — the canonical freshness clock. */
  ts: number | null;
}

export interface UseInstrumentTickResult {
  quote: InstrumentTickQuote | null;
  /** True once a real tick for this instrument has been streamed. */
  live: boolean;
  /** Shared SSE connection state (diagnostics only). */
  connected: boolean;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Event time in epoch MILLISECONDS.
 *
 * A feed may report seconds (Kotak's `last_update_time` is epoch seconds),
 * while an ISO string parses straight to milliseconds. Mixing the two makes
 * every age computation wrong — a seconds value reads as "1970" and every
 * price looks stale. Anything below 2001-09-09 (≈1e12 ms) is treated as
 * seconds and scaled.
 */
function toEpochMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function toQuote(t: Record<string, any>): InstrumentTickQuote {
  const raw = (t.raw ?? {}) as Record<string, any>;
  const ltp = num(t.ltp) ?? num(raw.last_traded_price);
  const prevClose =
    num(t.close) ?? num(t.prevClose) ?? num(raw.close_price) ?? num(raw.last_traded_price_close);
  return {
    ltp,
    prevClose,
    open: num(t.open) ?? num(raw.open_price),
    high: num(t.high) ?? num(raw.high_price),
    low: num(t.low) ?? num(raw.low_price),
    volume: num(t.volume) ?? num(raw.volume_traded_today),
    change: num(t.change) ?? num(raw.net_change),
    changePct: num(t.changePercent) ?? num(t.changePct) ?? num(raw.net_change_percent),
    upperCircuit: num(t.upper_circuit_limit) ?? num(t.upperCircuit) ?? num(raw.upper_circuit_limit),
    lowerCircuit: num(t.lower_circuit_limit) ?? num(t.lowerCircuit) ?? num(raw.lower_circuit_limit),
    // Freshness is measured from the BACKEND receive time (`receivedAt`),
    // not from the broker's feed event time (`ts`): the Kotak SFeed stamps
    // `ts` with the exchange's event clock, which lags the receive time by
    // minutes. Using it made every streaming price look STALE.
    ts: toEpochMs(t.receivedAt ?? t.received_at ?? t.last_update_time ?? t.ts),
  };
}

/** Does this frame belong to the selected instrument? */
function matches(t: Record<string, any>, token: string, symbol: string): boolean {
  if (token) {
    const frameToken = t.instrumentToken ?? t.token ?? t.instrument_token;
    if (frameToken != null && String(frameToken) === token) return true;
  }
  if (symbol) {
    const frameSymbol = String(t.symbol ?? t.tradingSymbol ?? '').toUpperCase();
    if (frameSymbol && (frameSymbol === symbol || frameSymbol === `${symbol}-EQ`)) return true;
  }
  return false;
}

export function useInstrumentTick(
  identity: { token?: string | number | null; symbol?: string | null } | null,
  enabled = true,
): UseInstrumentTickResult {
  const [quote, setQuote] = useState<InstrumentTickQuote | null>(null);
  const [connected, setConnected] = useState(false);

  const token = identity?.token != null ? String(identity.token) : '';
  const symbol = identity?.symbol ? String(identity.symbol).toUpperCase() : '';

  const pending = useRef<Record<string, any> | null>(null);
  // Keep the current identity in a ref so the SSE listener never needs to be
  // torn down and re-attached on every selection change.
  const idRef = useRef({ token, symbol });
  idRef.current = { token, symbol };

  // A new instrument starts with no streamed quote; drop the previous one so a
  // stale price is never shown under the newly selected symbol.
  useEffect(() => {
    pending.current = null;
    setQuote(null);
  }, [token, symbol]);

  useEffect(() => {
    if (!enabled || (!token && !symbol)) return;

    const offTicks = subscribeTicks((t) => {
      const { token: tk, symbol: sym } = idRef.current;
      if (!tk && !sym) return;
      if (!matches(t, tk, sym)) return;
      pending.current = t;
    });

    const offState = subscribeSseState((s) => setConnected(s.connected));

    const flush = setInterval(() => {
      const t = pending.current;
      if (!t) return;
      pending.current = null;
      setQuote(toQuote(t));
    }, FLUSH_MS);

    return () => {
      clearInterval(flush);
      offTicks();
      offState();
    };
  }, [enabled, token, symbol]);

  return { quote, live: quote?.ltp != null, connected };
}
