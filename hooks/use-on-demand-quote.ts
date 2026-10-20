'use client';

/**
 * On-demand REAL quote for ONE instrument, by token.
 *
 * Why this exists
 * ---------------
 * The Search Engine (`/api/search`) can only ship an LTP for tokens that are
 * currently in the central tick store — i.e. the small set the broker feed is
 * subscribed to. Searching anything else returned `ltp: null`, so the order
 * card opened with no price, margin could not be sized, `refPrice` stayed 0 and
 * the Place button stayed permanently disabled ("search kiya, LTP nahi aaya,
 * order form nahi khula").
 *
 * `POST /api/trading/quote` prices ANY token on demand through the broker
 * (`kotak_session.async_quote`), same-origin via the Next proxy. This hook calls
 * it once per selection and then re-polls ONLY while no streamed tick owns the
 * price, so it never competes with the live socket.
 *
 * Honesty contract: every field comes from the broker response. A failed call
 * returns `null` and keeps the last good quote — nothing is ever invented.
 */

import { useEffect, useRef, useState } from 'react';
import { getQuote } from '@/lib/api';
import { dedupFetch } from '@/lib/request-dedup';

/** Re-poll cadence while the socket is NOT streaming this token. */
const POLL_MS = 5000;

export interface OnDemandQuote {
  token: string;
  symbol: string;
  ltp: number | null;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  changePct: number | null;
  /** Canonical source id the price came from ('broker' | 'last_close' | …). */
  source: string | null;
  /** True when the price is a snapshot (broker last trade / stored close). */
  stale: boolean;
  /** ISO timestamp the price belongs to, when the backend reports one. */
  asOf: string | null;
  fetchedAt: number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function useOnDemandQuote(
  identity: { token?: string | number | null; symbol?: string | null; exchange?: string | null } | null,
  enabled = true,
  /**
   * True when a streamed tick already owns the price. Read through a ref, NOT
   * an effect dependency — otherwise every first tick would tear the poller
   * down and immediately rebuild it, firing a broker call on each transition.
   */
  paused = false,
): { quote: OnDemandQuote | null; loading: boolean; error: string | null } {
  const [quote, setQuote] = useState<OnDemandQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = identity?.token != null && String(identity.token).trim() !== '' ? String(identity.token) : '';
  const symbol = identity?.symbol ? String(identity.symbol) : '';
  const segment = String(identity?.exchange ?? 'nse_cm').toLowerCase();

  // Identity is read through a ref so the poller is installed ONCE per token
  // and reads the current instrument — no teardown/rebuild churn.
  const idRef = useRef({ token, symbol, segment });
  idRef.current = { token, symbol, segment };
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Drop the previous instrument's price the instant a new one is chosen so a
  // stale LTP is never shown under a different symbol.
  useEffect(() => {
    setQuote(null);
    setError(null);
  }, [token]);

  useEffect(() => {
    if (!enabled || !token) return;
    let cancelled = false;
    let timer: number | null = null;
    let inflight = false;

    const pull = async () => {
      const { token: tok, segment: seg } = idRef.current;
      // A streamed tick is already authoritative — do not spend a broker call.
      if (!tok || inflight || pausedRef.current) return;
      inflight = true;
      setLoading(true);
      try {
        const res = await dedupFetch(`quote:${seg}|${tok}`, () =>
          getQuote([{ exchange_segment: seg, instrument_token: tok }], 'ltp'),
        );
        if (cancelled) return;
        const raw = Array.isArray(res?.data) ? res.data[0] : res?.data;
        const ltp = num(raw?.ltp ?? raw?.last_price);
        if (!ltp) {
          // Honest "no price": keep the last good quote rather than blanking it.
          setError('No live price for this token yet.');
          return;
        }
        const o = (raw?.ohlc ?? {}) as Record<string, unknown>;
        const rawClose = num(o.close);
        // After hours the broker echoes the last price into `close`; that is not
        // a previous close, and using it would paint a fake 0.00% change.
        const prevClose = rawClose != null && Math.abs(rawClose - ltp) > 1e-9 ? rawClose : null;
        const change = prevClose != null ? ltp - prevClose : null;
        const source = raw?.source != null ? String(raw.source) : 'broker';
        // The broker/last-close fallback is a real print, but it is a SNAPSHOT
        // (after hours / feed down) — the card labels it as such, never "live".
        const stale = source !== 'websocket';
        setError(null);
        setQuote({
          token: tok,
          symbol: String(raw?.display_symbol ?? idRef.current.symbol ?? ''),
          ltp,
          prevClose,
          open: num(o.open),
          high: num(o.high),
          low: num(o.low),
          change,
          changePct: prevClose ? (change! / prevClose) * 100 : null,
          source,
          stale,
          asOf: raw?.asOf != null ? String(raw.asOf) : null,
          fetchedAt: Date.now(),
        });
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Quote unavailable');
      } finally {
        inflight = false;
        if (!cancelled) setLoading(false);
      }
    };

    void pull();
    timer = window.setInterval(() => {
      // Skip while the tab is hidden — no point burning a broker call nobody
      // is looking at.
      if (typeof document !== 'undefined' && document.hidden) return;
      void pull();
    }, POLL_MS);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [enabled, token]);

  return { quote, loading, error };
}