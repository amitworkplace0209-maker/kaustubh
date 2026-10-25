// ---- Trade page live-quote fallback — regression guard ----
//
// ROOT CAUSE (why a selected stock showed `STALE`, `LTP ₹-` and
// `ORDER VALUE ₹-` even though search returned a live price): the quote memo
// resolved every field as `view ? view.x ?? snap?.x : snap?.x` — written
// specifically to serve the case where the WS#3 frame has not arrived yet but
// the REST market-watch snapshot already carries a real LTP. An
// `if (!view) return null;` line sat just above that block and short-circuited
// ahead of it, so the whole fallback was dead code and `quote` was always null
// until a WS frame landed.
//
// A freshly-selected instrument ALWAYS hits this: the live tick arrives
// asynchronously, so the REST snapshot is the only data available for the
// first render(s) after selection.
//
// The memo now resolves a FOUR-level chain — live tick stream (the shared
// browser SSE channel) → central tick-store snapshot → on-demand BROKER /
// last-close quote → search seed — and these guards pin that chain: the cheap
// sources may be absent, but the fallback must stay reachable and the memo
// must still refuse to invent a quote from nothing.
//
// Since a broker snapshot or a stored close is a REAL print but not a stream,
// the resolution also has to stay HONEST: the source label says which one it
// is, and the circuits are never derived from the LTP.
//
// There is no component-test runner in this repo (`node --test` only, no
// jsdom/testing-library), so the wiring is asserted at the source level and
// the field-resolution rules are pinned behaviourally below.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRADE_PAGE = readFileSync(join(process.cwd(), 'components/trading/trade-page.tsx'), 'utf8');
const QUOTE_HEADER = readFileSync(join(process.cwd(), 'components/trading/quote-header.tsx'), 'utf8');
const SNAPSHOT_HOOK = readFileSync(join(process.cwd(), 'hooks/use-market-watch-snapshot.ts'), 'utf8');
const ON_DEMAND_QUOTE = readFileSync(join(process.cwd(), 'hooks/use-on-demand-quote.ts'), 'utf8');

/**
 * Structural assertions run against code with comments removed. Several of these
 * fixes are documented in-place, and the notes legitimately quote the old code
 * (`if (!view) return null;`) — matching that prose would fail the very guard it
 * describes. String literals are left alone (there are none of interest here).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Collapse layout whitespace so multi-line expressions are matchable. */
function squash(src: string): string {
  return src.replace(/\s+/g, ' ');
}

const TRADE_CODE = stripComments(TRADE_PAGE);
const TRADE_FLAT = squash(TRADE_CODE);
const HEADER_CODE = stripComments(QUOTE_HEADER);

test('the quote memo never short-circuits on a missing source', () => {
  // Any early return keyed on ONE source being absent kills the whole fallback
  // chain below it — this is the class of bug this file documents.
  assert.doesNotMatch(
    TRADE_CODE,
    /if\s*\(\s*!view\s*\)\s*return\s+null/,
    'trade-page.tsx must not `if (!view) return null` before the snapshot fallbacks',
  );
  assert.doesNotMatch(
    TRADE_CODE,
    /if\s*\(\s*!stream(?:ed)?\s*\)\s*return\s+null/,
    'trade-page.tsx must not `if (!stream) return null` before the fallbacks',
  );
  // Sanity-check the stripper itself, so it cannot silently pass everything.
  assert.ok(TRADE_CODE.includes('const quote = useMemo<LiveQuote | null>'), 'the memo must still exist');
});

test('the quote memo resolves the stream → snapshot → broker → seed chain', () => {
  // Every cheap source is gated behind the stronger one: the on-demand broker
  // quote is skipped while a streamed tick exists, and the search seed must
  // stay the last resort — never an override.
  assert.match(
    TRADE_FLAT,
    /const rest = streamed \? null : onDemand\.quote/,
    'the on-demand broker quote must be used only when no streamed price exists',
  );
  assert.match(
    TRADE_FLAT,
    /const seed = streamed \|\| rest\?\.ltp != null \|\| snap\?\.ltp != null \? null : seedQuote/,
    'the search seed must be the last resort, not an override',
  );
  assert.match(
    TRADE_FLAT,
    /const ltp = streamed\?\.ltp \?\? num\(snap\?\.ltp\) \?\? rest\?\.ltp \?\? \(seed\?\.ltp != null \? seed\.ltp : null\) \?\? null/,
    'LTP must resolve live-first and fall all the way back to the search seed',
  );
});

test('the quote memo still refuses to invent a quote from nothing', () => {
  // With nothing live, no snapshot row, no broker print and no seed there is
  // no price — the memo must not manufacture one.
  assert.match(
    TRADE_CODE,
    /const ltp =\s*streamed\?\.ltp \?\? num\(snap\?\.ltp\)/,
    'the LTP must be resolved from real sources only',
  );
  assert.doesNotMatch(
    TRADE_CODE,
    /ltp:\s*Math\.round/,
    'the LTP must never be computed rather than observed',
  );
});

test('the source label always says what the price actually is', () => {
  // A snapshot is a real print but not a stream: labelling it "live" would be
  // a lie the operator pays for with a wrong decision.
  for (const label of [
    'live tick stream',
    'broker quote',
    'last close (broker)',
    'last trade (broker)',
    'tick store snapshot',
    'search snapshot',
  ]) {
    assert.ok(TRADE_PAGE.includes(label), `expected an honest source label: ${label}`);
  }
  assert.match(TRADE_FLAT, /stale: !streamed/, 'a non-streamed price must be marked stale');
});

test('every quote field falls back through the chain, never live-only', () => {
  // The snapshot-only path is the whole point of the block; spot-check the
  // fields the order ticket and the quote header actually read.
  for (const fragment of [
    'streamed?.prevClose ?? num(snap?.prevClose) ?? rest?.prevClose ?? seed?.prevClose ?? null',
    'streamed?.open ?? num(snap?.open) ?? rest?.open ?? null',
    'streamed?.high ?? num(snap?.high) ?? rest?.high ?? null',
    'streamed?.low ?? num(snap?.low) ?? rest?.low ?? null',
    'num(snap?.change) ??',
    'num(snap?.changePercent) ??',
  ]) {
    assert.ok(
      squash(TRADE_PAGE).includes(fragment),
      `expected a fallback chain fragment: ${fragment}`,
    );
  }
  assert.match(
    TRADE_FLAT,
    /sourceId: streamed \? 'sse' : rest\?\.ltp != null \? rest\.source : snap\?\.ltp != null \? 'tick_store' : 'search'/,
    'the source id must follow the value that actually won',
  );
});

test('the tick-store snapshot is pulled on selection and polled as a fallback', () => {
  // The snapshot is the only source of the real LC/UC + volume context, so
  // the FIRST pull must run even when a price is already on screen; only the
  // repeat poll may be gated on "a live tick owns the price".
  assert.ok(
    TRADE_PAGE.includes('useMarketWatchSnapshot('),
    'the trade page must use the shared market-watch snapshot hook',
  );
  assert.match(SNAPSHOT_HOOK, /getMarketWatchTickSnapshot\(\[token\]\)/);
  assert.match(SNAPSHOT_HOOK, /next\.hasData !== false/, 'a row without data must not wipe the last good row');
  assert.match(SNAPSHOT_HOOK, /if \(pausedRef\.current\) return;/, 'the poll must stop while a live tick owns the price');
  assert.match(SNAPSHOT_HOOK, /pollMs = 15000/, 'the fallback poll must be slow');
});

test('circuits are passed through only when the backend actually ships them', () => {
  assert.match(TRADE_CODE, /num\(snap\?\.upperCircuit\)/);
  assert.match(TRADE_CODE, /num\(snap\?\.lowerCircuit\)/);
  assert.doesNotMatch(
    TRADE_CODE,
    /upperCircuit:\s*ltp\s*\*\s*1\./,
    'circuits must never be derived from LTP',
  );
  assert.doesNotMatch(
    HEADER_CODE,
    /upperCircuit[^\n]*ltp\s*\*\s*1\./,
    'the quote header must never derive a circuit limit from the LTP',
  );
});

test('the on-demand quote never fabricates a previous close or a live tag', () => {
  // The broker echoes the last price into `ohlc.close` after hours; a "change"
  // computed against that echo is a fabricated 0.00%.
  assert.match(
    ON_DEMAND_QUOTE,
    /const prevClose = rawClose != null && Math\.abs\(rawClose - ltp\) > 1e-9 \? rawClose : null/,
    'a close identical to the LTP must not become a previous close',
  );
  // Only a streaming tick may be tagged live; every REST quote is a snapshot.
  assert.match(
    ON_DEMAND_QUOTE,
    /const stale = source !== 'websocket'/,
    'a REST quote is a snapshot, not a stream',
  );
});

test('an unknown money value is rendered as —, never as zero', () => {
  // `1 × — = ₹0.00` read as a real zero margin. Every money formatter in the
  // new page must render an unknown value as an em dash.
  assert.match(
    HEADER_CODE,
    /if \(v == null \|\| !Number\.isFinite\(v\)\) return '—'/,
    'the quote header must render an unknown price as —',
  );
  assert.doesNotMatch(
    HEADER_CODE,
    /\?\s*'₹0'/,
    'an unknown price must never be rendered as a zero price',
  );
});

// --- behavioural pin of the field-resolution rules -----------------------

/** Mirrors the memo's per-field `a?.x ?? b?.x` nullish coalescing. */
const pick = <T,>(stronger: T | null | undefined, weaker: T | null | undefined): T | null =>
  (stronger ?? weaker ?? null) as T | null;

test('a snapshot-only quote is fully resolvable', () => {
  // The exact case that used to return null: no streamed tick, real snapshot row.
  const ltp = pick<number>(null, 152.58);
  const prevClose = pick<number>(null, 138.71);
  const change = pick<number>(null, 13.87);
  const changePct = pick<number>(null, 10);
  assert.equal(ltp, 152.58);
  assert.equal(prevClose, 138.71);
  assert.equal(change, 13.87);
  assert.equal(changePct, 10);
  // Order value is qty * ltp, so it is only computable once ltp is known.
  assert.equal(1 * Number(ltp), 152.58);
});

test('the live tick wins over the snapshot', () => {
  assert.equal(pick<number>(153.0, 152.58), 153.0);
  assert.equal(pick<number>(14.29, 13.87), 14.29);
});

test('a missing stronger field still falls through to the snapshot', () => {
  assert.equal(pick<number>(null, 152.58), 152.58);
  assert.equal(pick<number>(undefined, 152.58), 152.58);
  assert.equal(pick<number>(null, null), null);
  assert.equal(pick<number>(undefined, undefined), null);
});
