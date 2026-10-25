'use client';

/**
 * Filtered live tick stream from the shared SSE channel.
 *
 * Subscribes to the ONE shared browser SSE tick stream (shared-sse.ts) and
 * filters incoming ticks by instrument token. Provides:
 *   - Bounded in-memory buffer (latest N ticks for the selected instrument)
 *   - All-ticks buffer (unfiltered, for cross-instrument observation)
 *   - Connection state from the shared SSE channel
 *   - Tick count and throughput metrics
 *
 * NO fake data. NO fabricated timestamps. If the SSE channel is down,
 * `connected` is false and the tick buffers stay empty.
 */

import { useEffect, useRef, useState } from 'react';
import { subscribeTicks, subscribeSseState } from '@/lib/shared-sse';

const MAX_FILTERED_TICKS = 100;
const MAX_ALL_TICKS = 200;

export interface NormalizedTick {
  /** Backend wall-clock ms when the tick was received by the server (canonical). */
  receivedAt: number | null;
  /** Browser wall-clock ms when the tick frame arrived on this machine. */
  browserReceivedAt: number;
  /** Broker/exchange timestamp ms (raw.ts) — `null` when the feed omits it. */
  brokerTime: number | null;
  symbol?: string;
  instrumentToken?: string;
  ltp?: number | null;
  volume?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidQty?: number | null;
  askQty?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  previousClose?: number | null;
  change?: number | null;
  changePercent?: number | null;
  vwap?: number | null;
  totalBuyQty?: number | null;
  totalSellQty?: number | null;
  ts?: string;
  raw: Record<string, any>;
}

export interface TickStreamState {
  connected: boolean;
  filteredTicks: NormalizedTick[];
  allTicks: NormalizedTick[];
  totalReceived: number;
  filteredReceived: number;
  lastTickAt: number | null;
  ticksPerSecond: number;
}

function normalizeTick(raw: Record<string, any>): NormalizedTick {
  const ltp = num(raw.ltp);
  const prevClose = num(raw.previousClose ?? raw.prev_close ?? raw.close);
  const change = ltp != null && prevClose != null && prevClose > 0 ? ltp - prevClose : null;
  const changePercent = change != null && prevClose != null && prevClose > 0
    ? (change / prevClose) * 100
    : null;
  const receivedMs = toMs(raw.receivedAt ?? raw.received_at);
  const brokerMs = toMs(raw.ts ?? raw.last_trade_time ?? raw.last_update_time);

  return {
    // Backend receive time is the canonical sentinel — the displayed tick
    // time MUST NOT be the browser clock (it would mask backend staleness).
    receivedAt: receivedMs,
    browserReceivedAt: Date.now(),
    brokerTime: brokerMs,
    symbol: str(raw.symbol ?? raw.sym ?? raw.tradingSymbol),
    instrumentToken: str(raw.instrumentToken ?? raw.tk ?? raw.token ?? raw.instrument_token),
    ltp,
    volume: num(raw.volume ?? raw.vol),
    bid: num(raw.bp ?? raw.bid ?? raw.bestBidPrice),
    ask: num(raw.sp ?? raw.ask ?? raw.bestAskPrice),
    bidQty: num(raw.bq ?? raw.bidQty ?? raw.bestBidQty),
    askQty: num(raw.bs ?? raw.askQty ?? raw.bestAskQty),
    open: num(raw.open ?? raw.openPrice),
    high: num(raw.high ?? raw.highPrice),
    low: num(raw.low ?? raw.lowPrice),
    close: num(raw.close ?? raw.closePrice),
    previousClose: prevClose,
    change,
    changePercent,
    vwap: num(raw.vwap ?? raw.averagePrice),
    totalBuyQty: num(raw.totalBuyQuantity ?? raw.total_buy_qty),
    totalSellQty: num(raw.totalSellQuantity ?? raw.total_sell_qty),
    ts: str(raw.ts ?? raw.timestamp),
    raw,
  };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ISO-8601 string or epoch seconds/ms → epoch ms. Null when unparseable. */
function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | undefined {
  if (v == null || v === '') return undefined;
  return String(v);
}

export function useTickStream(filterToken?: string | null): TickStreamState {
  const [connected, setConnected] = useState(false);
  const filteredRef = useRef<NormalizedTick[]>([]);
  const allRef = useRef<NormalizedTick[]>([]);
  const [filteredTicks, setFilteredTicks] = useState<NormalizedTick[]>([]);
  const [allTicks, setAllTicks] = useState<NormalizedTick[]>([]);
  const [totalReceived, setTotalReceived] = useState(0);
  const [filteredReceived, setFilteredReceived] = useState(0);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [ticksPerSecond, setTicksPerSecond] = useState(0);
  const tickTimesRef = useRef<number[]>([]);
  const filterTokenRef = useRef(filterToken);
  filterTokenRef.current = filterToken;

  useEffect(() => {
    const unsubSseState = subscribeSseState((s) => setConnected(s.connected));

    const unsubTicks = subscribeTicks((raw: Record<string, any>) => {
      const tick = normalizeTick(raw);
      const now = Date.now();

      // All-ticks buffer (unfiltered)
      allRef.current = [tick, ...allRef.current].slice(0, MAX_ALL_TICKS);

      // Filtered buffer (by instrument token)
      const token = filterTokenRef.current;
      if (token && tick.instrumentToken === token) {
        filteredRef.current = [tick, ...filteredRef.current].slice(0, MAX_FILTERED_TICKS);
        setFilteredTicks([...filteredRef.current]);
        setFilteredReceived((c) => c + 1);
      }

      // Throughput calculation (1-second rolling window)
      tickTimesRef.current.push(now);
      const cutoff = now - 1000;
      while (tickTimesRef.current.length > 0 && tickTimesRef.current[0] < cutoff) {
        tickTimesRef.current.shift();
      }

      setAllTicks([...allRef.current]);
      setTotalReceived((c) => c + 1);
      // lastTickAt = backend receive time (falls back to browser only when the
      // backend timestamp is missing — the browser flag stays observable).
      setLastTickAt(tick.receivedAt ?? tick.browserReceivedAt);
      setTicksPerSecond(tickTimesRef.current.length);
    });

    return () => {
      unsubSseState();
      unsubTicks();
    };
  }, []);

  // Reset filtered state when filter changes
  useEffect(() => {
    filteredRef.current = [];
    setFilteredTicks([]);
    setFilteredReceived(0);
  }, [filterToken]);

  return {
    connected,
    filteredTicks,
    allTicks,
    totalReceived,
    filteredReceived,
    lastTickAt,
    ticksPerSecond,
  };
}
