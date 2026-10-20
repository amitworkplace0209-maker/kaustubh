// ---- Trade page live-quote fallback — regression guard ----
//
// ROOT CAUSE (why a selected stock showed `STALE`, `LTP ₹-` and
// `ORDER VALUE ₹-` even though search returned a live price): the `quote` memo
// in `components/orders/trade/trade-page.tsx` resolved every field as
// `view ? view.x ?? snap?.x : snap?.x` — written specifically to serve the
// case where the WS#3 frame has not arrived yet but the REST market-watch
// snapshot already carries a real LTP. An `if (!view) return null;` line sat
// just above that block and short-circuited ahead of it, so the whole fallback
// was dead code and `quote` was always null until a WS frame landed.
//
// A freshly-selected instrument ALWAYS hits this: the subscribe + snapshot
// round-trip is async, so the REST snapshot is the only data available for the
// first render(s) after selection.
//
// The memo now resolves a FIVE-level chain — live tick stream (shared SSE) →
// fresh WS#3 view → on-demand BROKER/last-close quote → market-watch REST
// snapshot → search seed — and these guards pin that chain: the cheap sources
// may be absent, but the fallback must stay reachable and the memo must still
// refuse to invent a quote from nothing.
//
// Since a broker snapshot or a stored close is a REAL print but not a stream,
// the resolution also has to stay HONEST: a channel view older than two
// minutes is a snapshot (never "Live"), and a broker `close` that merely echoes
// the last price must never become a fabricated 0.00% change.
//
// There is no component-test runner in this repo (`node --test` only, no
// jsdom/testing-library), so the wiring is asserted at the source level and the
// field-resolution rules are pinned behaviourally below.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRADE_PAGE = readFileSync(
  join(process.cwd(), 'components/orders/trade/trade-page.tsx'),
  'utf8',
);
const STOCK_CARD = readFileSync(
  join(process.cwd(), 'components/orders/trade/selected-stock-card.tsx'),
  'utf8',
);
const ON_DEMAND_QUOTE = readFileSync(
  join(process.cwd(), 'hooks/use-on-demand-quote.ts'),
  'utf8',
);

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
const STOCK_CARD_CODE = stripComments(STOCK_CARD);
const ON_DEMAND_CODE = stripComments(ON_DEMAND_QUOTE);

test('the quote memo never short-circuits on a missing source', () => {
  // Any early return keyed on ONE source being absent kills the whole fallback
  // chain below it — this is the class of bug the file documents.
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
  assert.ok(!TRADE_CODE.includes('const quote = useMemo<LiveQuote | null>();'));
});

test('the quote memo resolves the stream → view → broker → snapshot → seed chain', () => {
  // Every cheap source is gated behind the stronger one, which is only visible
  // in the source: `rest` (on-demand broker quote) must be skipped while a
  // streamed tick exists, `snap` while any priced source exists, and `seed`
  // must stay the last resort — never an override.
  assert.match(
    TRADE_FLAT,
    /const rest = stream \|\| streamedView \? null : onDemandQuote/,
    'the on-demand broker quote must be used only when no streamed price exists',
  );
  assert.match(
    TRADE_FLAT,
    /const snap = stream \|\| streamedView \|\| rest\?\.ltp != null \? null : circuitSnap/,
    'the market-watch snapshot must be used only when no live price exists',
  );
  assert.match(
    TRADE_FLAT,
    /const seed = stream \|\| streamedView \|\| rest\?\.ltp != null \|\| snap\?\.ltp != null \? null : seedQuote/,
    'the search seed must be the last resort, not an override',
  );
  assert.match(
    TRADE_FLAT,
    /const ltp = stream\?\.ltp \?\? num\(view\?\.ltp\) \?\? rest\?\.ltp \?\? num\(snap\?\.ltp\) \?\? seed\?\.ltp \?\? null/,
    'LTP must resolve live-first and fall all the way back to the search seed',
  );
});

test('the quote memo still resolves null when there is no data at all', () => {
  // The chain must not fabricate a quote: with nothing live, no snapshot LTP,
  // no seed and no circuits the guard has to return null.
  assert.match(
    TRADE_CODE,
    /if\s*\(\s*ltp == null && upperCircuit == null && lowerCircuit == null\s*\)\s*return null/,
    'the no-LTP / no-circuits guard must remain',
  );
});

test('a stale channel view is labelled a snapshot, never "live"', () => {
  // After the close (or with a snapshot-hydrated view) the very same tick is
  // STALE. `viewFresh` keeps the LIVE badge for a genuinely streaming frame and
  // `stale: !streamed` is what flips the card to "Last" + a source line.
  assert.match(
    TRADE_FLAT,
    /const viewTs = view\?\.receivedAt \? Date\.parse\(String\(view\.receivedAt\)\) : NaN/,
    'the view timestamp must be parsed for a freshness check',
  );
  assert.match(
    TRADE_FLAT,
    /const viewFresh = Number\.isFinite\(viewTs\) && Date\.now\(\) - viewTs < 120_000/,
    'a view older than two minutes is not live',
  );
  assert.match(
    TRADE_FLAT,
    /const streamedView = view && viewFresh \? view : null/,
    'only a fresh view may count as streamed',
  );
  assert.match(TRADE_FLAT, /stale: !streamed/);
  for (const label of [
    'last stored close',
    'last trade (broker)',
    'channel snapshot (last tick)',
  ]) {
    assert.ok(TRADE_PAGE.includes(label), `expected an honest source label: ${label}`);
  }
});

test('every quote field falls back through the chain, never live-only', () => {
  // The snapshot-only path is the whole point of the block; spot-check the
  // fields the order ticket and the selected-stock card actually read.
  // (change / changePct additionally recompute from prevClose as a last resort.)
  for (const fragment of [
    '?? (view ? num(view.prevClose) : null) ?? rest?.prevClose ?? num(snap?.prevClose) ?? seed?.prevClose ?? null',
    '?? num(view?.ltp) ?? rest?.ltp ?? num(snap?.ltp) ?? seed?.ltp ?? null',
    '?? rest?.change ?? num(snap?.change) ?? seed?.change',
    '?? rest?.changePct ?? num(snap?.changePercent) ?? seed?.changePct',
  ]) {
    assert.ok(
      squash(TRADE_PAGE).includes(fragment),
      `expected a fallback chain fragment: ${fragment}`,
    );
  }
  assert.match(
    TRADE_FLAT,
    /stream\?\.ts \?\? rest\?\.fetchedAt \?\? \(view\?\.receivedAt \? Date\.parse\(String\(view\.receivedAt\)\)/,
    'the quote timestamp must fall back with the quote itself',
  );
  assert.match(
    TRADE_FLAT,
    /sourceId: stream \? 'websocket' : streamedView \? 'websocket' : rest\?\.ltp != null \? rest\.source : view \? 'channel_snapshot'/,
    'the source id must follow the value that actually won',
  );
  assert.ok(
    TRADE_PAGE.includes('getMarketWatchTickSnapshot([selection.token])') ||
    TRADE_PAGE.includes('getMarketWatchTickSnapshot([tok])'),
    'the market-watch snapshot must still be fetched on selection',
  );
  // The snapshot is the only source of the real LC/UC + volume context, so the
  // FIRST pull must run even when a price is already on screen; only the repeat
  // poll may be gated on "no streamed price".
  assert.match(
    TRADE_FLAT,
    /if \(cancelled \|\| \(!initial && liveRef\.current\)\) return/,
    'the initial snapshot pull must not be skipped when a price already exists',
  );
  // Polling fallback: while no live tick owns the quote, the snapshot re-pulls
  // every 15s so the LTP keeps moving with a dead socket, plus one quick retry
  // right after selection so the card fills without waiting a full tick.
  assert.match(
    TRADE_CODE,
    /setInterval\(\(\) => pull\(false\), 15000\)/,
    'the snapshot must re-pull on a 15s fallback poll until a live tick arrives',
  );
  assert.match(
    TRADE_CODE,
    /setTimeout\(\(\) => pull\(false\), 2500\)/,
    'a quick post-selection re-pull must fill the card while the first response settles',
  );
  assert.ok(
    TRADE_PAGE.includes('setCircuitSnap('),
    'the snapshot must still be stored in state',
  );
});

test('circuits are passed through only when the backend actually ships them', () => {
  assert.match(TRADE_CODE, /raw\.upper_circuit \?\? raw\.upperCircuit \?\? raw\.priceband_upper/);
  assert.match(TRADE_CODE, /raw\.lower_circuit \?\? raw\.lowerCircuit \?\? raw\.priceband_lower/);
  assert.doesNotMatch(
    TRADE_CODE,
    /upperCircuit:\s*ltp\s*\*\s*1\./,
    'circuits must never be derived from LTP',
  );
});

test('a market order waits for its price instead of reporting a false BLOCK', () => {
  // A MKT/SL-M order cannot be validated before a reference price exists;
  // reporting BLOCK read as "order rejected" while the quote was in flight.
  assert.match(
    TRADE_FLAT,
    /if \(!needsPrice && effLtp == null\) \{ setPrecheck\(\{ kind: 'UNKNOWN', label: 'Waiting for the market price…'/,
    'the precheck must say it is waiting when no price has arrived',
  );
});

test('the on-demand quote never fabricates a previous close or a live tag', () => {
  // The broker echoes the last price into `ohlc.close` after hours; a "change"
  // computed against that echo is a fabricated 0.00%.
  assert.match(
    ON_DEMAND_CODE,
    /const prevClose = rawClose != null && Math\.abs\(rawClose - ltp\) > 1e-9 \? rawClose : null/,
    'a close identical to the LTP must not become a previous close',
  );
  // Only a streaming tick may be tagged live; every REST snapshot is stale.
  assert.match(
    ON_DEMAND_CODE,
    /const stale = source !== 'websocket'/,
    'a REST quote is a snapshot, not a stream',
  );
});

test('the selected-stock card never renders an unknown margin as ₹0.00', () => {
  // `1 × — = ₹0.00` read as a real zero margin. This card version has no
  // qty × margin arithmetic line at all: the metric tiles go through `money()`,
  // which renders an unknown value as `—`.
  assert.doesNotMatch(
    STOCK_CARD_CODE,
    /× *\$\{fmtRs\(oneQtyMargin\)\}/,
    'no arithmetic line may interpolate a possibly-null margin',
  );
  assert.match(
    STOCK_CARD_CODE,
    /const money = \(v: number \| null \| undefined\) =>\s*v == null \|\| !Number\.isFinite\(v\) \? '—' : `\$\{unit\}\$\{fmtBare\(v\)\}`/,
    'an unknown margin must render as —, never as a number',
  );
  assert.match(
    STOCK_CARD_CODE,
    /value: marginRequired/,
    'the margin tile must read the server/estimated margin it was given',
  );
  // `caps` was previously destructured as `_caps` and thrown away, so the
  // terminal's currency never reached the card.
  assert.doesNotMatch(
    STOCK_CARD_CODE,
    /caps:\s*_caps/,
    'caps must not be discarded',
  );
  assert.match(STOCK_CARD_CODE, /caps\.virtualCurrency/);
});

// --- behavioural pin of the field-resolution rules -----------------------

/** Mirrors the memo's per-field `view?.x ?? snap?.x` nullish coalescing. */
const pick = <T,>(viewField: T | null | undefined, snapField: T | null | undefined): T | null =>
  (viewField ?? snapField ?? null) as T | null;

test('a snapshot-only quote is fully resolvable', () => {
  // The exact case that used to return null: no WS view, real snapshot row.
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

test('the live WS view wins over the snapshot', () => {
  assert.equal(pick<number>(153.0, 152.58), 153.0);
  assert.equal(pick<number>(14.29, 13.87), 14.29);
});

test('a missing view field still falls through to the snapshot', () => {
  assert.equal(pick<number>(null, 152.58), 152.58);
  assert.equal(pick<number>(undefined, 152.58), 152.58);
  assert.equal(pick<number>(null, null), null);
  assert.equal(pick<number>(undefined, undefined), null);
});
