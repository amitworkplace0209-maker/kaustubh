'use client';

/**
 * Live ticks for HOLDINGS — position + P&L websocket wiring.
 *
 * How the live price reaches a holding (Kotak SDK pipeline, nothing invented):
 *   1. This hook subscribes every holding token to the broker feed
 *      (`POST /subscribe` → `ws_manager.subscribe` → Kotak Neo SDK WS
 *      subscribe). Without this the backend never feeds the token and no
 *      tick can exist — the classic "LTP frozen" report.
 *   2. Ticks land in the canonical tick store and fan out over the ONE
 *      shared SSE stream (`/api/ticks/stream`, `lib/shared-sse`).
 *   3. Frames are matched token-first (exact), symbol second, and exposed
 *      as live LTP maps. Callers recompute value + P&L from the live LTP —
 *      the broker streams prices, not per-tick P&L, so local recompute from
 *      the real LTP is the honest live P&L.
 *
 * Backend subscriptions are intentionally never removed here: tokens are
 * shared with the Positions/Trade pages and the backend dedups them.
 * Detaching only drops this hook's listeners.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeInstruments } from '@/lib/api';
import { subscribeTicks, subscribeSseState } from '@/lib/shared-sse';

export interface HoldingLiveIdentity {
  token?: string | number | null;
  exchangeSegment?: string | null;
  symbol?: string | null;
}

export interface HoldingLiveTick {
  token: string;
  symbol: string;
  ltp: number;
  change: number | null;
  changePct: number | null;
  ts: number | null;
}

/** Canonical instrument seed from the Search Engine (token + live LTP). */
export interface HoldingSeed {
  token: string;
  segment: string;
  ltp: number | null;
}

export interface UseHoldingsLiveResult {
  /** Exact token → tick (best match). */
  byToken: Map<string, HoldingLiveTick>;
  /** Upper-cased symbol / trading-symbol → tick (fallback). */
  bySymbol: Map<string, HoldingLiveTick>;
  /** Upper-cased symbol → canonical seed (Search Engine token + LTP). */
  seeds: Map<string, HoldingSeed>;
  connected: boolean;
  lastTickAt: number | null;
}

const FLUSH_MS = 500;

function upper(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function frameTs(t: Record<string, any>): number | null {
  const raw = (t.raw ?? {}) as Record<string, any>;
  const cand =
    t.ts ?? t.timestamp ?? t.last_update_time ?? raw.ts ?? raw.last_update_time ?? null;
  if (typeof cand === 'string') {
    const ms = Date.parse(cand);
    return Number.isFinite(ms) ? ms : null;
  }
  const n = num(cand);
  if (n == null) return null;
  return n > 1e11 ? Math.round(n) : Math.round(n * 1000);
}

/** NSE → nse_cm, BSE → bse_cm; the SDK only feeds canonical segments. */
function normSegment(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'nse' || s === 'nse_cm' || s === 'nsecm') return 'nse_cm';
  if (s === 'bse' || s === 'bse_cm' || s === 'bsecm') return 'bse_cm';
  if (s === 'nfo' || s === 'nse_fo') return 'nse_fo';
  if (s === 'bfo' || s === 'bse_fo') return 'bse_fo';
  if (s === 'mcx' || s === 'mcx_fo') return 'mcx_fo';
  return s || 'nse_cm';
}

// Canonical token cache: broker rows sometimes carry a WRONG token for the
// segment (e.g. SWSOLAR row said 21475, the live feed token is 12489), and a
// wrong token subscribes to silence. The Search Engine is the canonical
// instrument master — resolve once per symbol (5-min TTL).
const SEED_TTL_MS = 5 * 60_000;
const seedCache = new Map<string, { at: number; seed: HoldingSeed | null }>();

async function resolveSeeds(symbols: string[]): Promise<Map<string, HoldingSeed>> {
  const out = new Map<string, HoldingSeed>();
  const missing = symbols.filter((s) => {
    const hit = seedCache.get(s);
    if (hit && Date.now() - hit.at < SEED_TTL_MS) {
      if (hit.seed) out.set(s, hit.seed);
      return false;
    }
    return true;
  });
  if (missing.length === 0) {
    for (const [k, v] of seedCache) {
      if (v.seed && symbols.includes(k)) out.set(k, v.seed);
    }
    return out;
  }
  const jobs = missing.map(async (sym) => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(sym)}&scope=stocks&limit=8`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      const rows = Array.isArray(body?.results) ? body.results : [];
      const exact = rows.find((r: any) => upper(r.symbol ?? r.tradingSymbol) === sym || upper(r.tradingSymbol) === `${sym}-EQ`)
        ?? rows.find((r: any) => upper(r.symbol ?? '') === sym)
        ?? rows[0];
      if (!exact || !exact.token) return;
      const seed: HoldingSeed = {
        token: String(exact.token),
        segment: normSegment(exact.exchangeSegment ?? exact.exchange),
        ltp: typeof exact.ltp === 'number' && exact.ltp > 0 ? exact.ltp : null,
      };
      seedCache.set(sym, { at: Date.now(), seed });
      out.set(sym, seed);
    } catch {
      /* offline — page falls back to snapshot */
    }
  });
  await Promise.all(jobs);
  return out;
}

export function useHoldingsLive(
  identities: HoldingLiveIdentity[],
  enabled = true,
): UseHoldingsLiveResult {
  const [byToken, setByToken] = useState<Map<string, HoldingLiveTick>>(new Map());
  const [bySymbol, setBySymbol] = useState<Map<string, HoldingLiveTick>>(new Map());
  const [seeds, setSeeds] = useState<Map<string, HoldingSeed>>(new Map());
  const [connected, setConnected] = useState(false);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);

  const pending = useRef<HoldingLiveTick[]>([]);
  const identitiesRef = useRef(identities);
  identitiesRef.current = identities;

  // Stable subscribe key — resubscribes only when the holding SET changes.
  const subKey = useMemo(
    () =>
      identities
        .map((i) => `${String(i.exchangeSegment || 'nse_cm').toLowerCase()}|${String(i.token ?? '')}|${upper(i.symbol)}`)
        .sort()
        .join(';'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(identities.map((i) => [i.token, i.exchangeSegment, i.symbol]))],
  );

  // 1 — Canonical seeds + broker feed subscribe. The broker row's own token
  // is subscribed AND the Search Engine's canonical token for the symbol
  // (they differ when the broker row is stale — subscribing only the stale
  // token feeds silence). Best-effort: dummy/logged-out backends answer 403
  // and ticks then come from the shared feed / snapshots instead.
  useEffect(() => {
    if (!enabled || identitiesRef.current.length === 0) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      const current = identitiesRef.current;
      const symbols = [...new Set(current.map((i) => upper(i.symbol)).filter(Boolean))];
      void resolveSeeds(symbols).then((resolved) => {
        if (cancelled) return;
        setSeeds(new Map(resolved));
        const batch: { instrument_token: string; exchange_segment: string; symbol: string }[] = [];
        const seen = new Set<string>();
        const push = (token: string, segment: string, symbol: string) => {
          const key = `${segment}|${token}`;
          if (!token || seen.has(key)) return;
          seen.add(key);
          batch.push({ instrument_token: token, exchange_segment: segment, symbol });
        };
        for (const i of current) {
          const sym = upper(i.symbol);
          const seed = resolved.get(sym);
          push(String(i.token ?? '').trim(), normSegment(i.exchangeSegment), String(i.symbol || ''));
          // Canonical token wins when the broker token disagrees with it.
          if (seed && seed.token !== String(i.token ?? '').trim()) {
            push(seed.token, seed.segment, String(i.symbol || ''));
          }
        }
        if (batch.length > 0) subscribeInstruments(batch).catch(() => {});
      });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, subKey]);

  // 2 — Consume the shared SSE fanout into token/symbol maps (batched).
  useEffect(() => {
    if (!enabled) return;
    const offTicks = subscribeTicks((t) => {
      const ltp = num(t.ltp ?? t.last_price);
      if (ltp == null || ltp <= 0) return;
      const token = String(t.instrumentToken ?? t.instrument_token ?? t.token ?? '').trim();
      const symbol = upper(t.symbol ?? t.tradingSymbol ?? t.trading_symbol ?? '');
      if (!token && !symbol) return;
      pending.current.push({
        token,
        symbol,
        ltp,
        change: num(t.change ?? t.netChange),
        changePct: num(t.changePercent ?? t.changePct ?? t.netChangePercent),
        ts: frameTs(t),
      });
    });
    const offState = subscribeSseState((s) => {
      setConnected(s.connected);
      if (s.lastMessageAt != null) setLastTickAt(s.lastMessageAt);
    });
    const flush = window.setInterval(() => {
      const batch = pending.current;
      if (batch.length === 0) return;
      pending.current = [];
      setByToken((prev) => {
        const next = new Map(prev);
        for (const tick of batch) {
          if (tick.token) next.set(tick.token, tick);
        }
        return next;
      });
      setBySymbol((prev) => {
        const next = new Map(prev);
        for (const tick of batch) {
          if (tick.symbol) next.set(tick.symbol, tick);
        }
        return next;
      });
      setLastTickAt(Date.now());
    }, FLUSH_MS);
    return () => {
      window.clearInterval(flush);
      pending.current = [];
      offTicks();
      offState();
    };
  }, [enabled]);

  return { byToken, bySymbol, seeds, connected, lastTickAt };
}

/** Seed lookup for one holding (canonical token + LTP from the Search Engine). */
export function seedFor(
  maps: Pick<UseHoldingsLiveResult, 'seeds'>,
  symbol: string | null | undefined,
): HoldingSeed | null {
  const key = upper(symbol);
  if (!key) return null;
  return maps.seeds.get(key) ?? maps.seeds.get(key.split('-')[0]) ?? null;
}

/** Resolve the live tick for one holding: token-exact first, symbol fallback. */
export function liveTickFor(
  maps: Pick<UseHoldingsLiveResult, 'byToken' | 'bySymbol'>,
  token: string | number | null | undefined,
  symbol: string | null | undefined,
  tradingSymbol?: string | null | undefined,
): HoldingLiveTick | null {
  const tk = token != null ? String(token).trim() : '';
  if (tk) {
    const hit = maps.byToken.get(tk);
    if (hit) return hit;
  }
  for (const cand of [tradingSymbol, symbol]) {
    const key = upper(cand);
    if (!key) continue;
    const hit = maps.bySymbol.get(key) ?? maps.bySymbol.get(key.split('-')[0]);
    if (hit) return hit;
  }
  return null;
}
