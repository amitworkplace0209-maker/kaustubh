/**
 * Client request cache (lib/request-cache) — one in-flight per resource key,
 * fresh-cache reuse and stale-while-revalidate.
 */
import { strict as assert } from 'node:assert';
import { test, beforeEach } from 'node:test';
import { clearCache, getCached } from '../lib/request-cache.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let loads: Record<string, number> = {};

beforeEach(() => {
  clearCache();
  loads = {};
});

test('duplicate concurrent callers share ONE fetch (single in-flight per key)', async () => {
  const loader = async () => {
    loads.subs = (loads.subs ?? 0) + 1;
    await sleep(20);
    return { status: 200, data: { count: 42 } };
  };
  const [a, b, c] = await Promise.all([
    getCached('phase2/subscriptions', loader),
    getCached('phase2/subscriptions', loader),
    getCached('phase2/subscriptions', loader),
  ]);
  assert.equal(loads.subs, 1, 'loader must run exactly once for concurrent callers');
  for (const r of [a, b, c]) {
    assert.equal(r.fromCache, false);
    assert.equal(r.data?.count, 42);
  }
});

test('fresh cache is reused without touching the loader', async () => {
  const loader = async () => {
    loads.dash = (loads.dash ?? 0) + 1;
    return { status: 200, data: { updatedAt: Date.now() } };
  };
  const first = await getCached('dashboard', loader);
  const second = await getCached('dashboard', loader, { maxAgeMs: 60_000 });
  assert.equal(second.fromCache, true);
  assert.equal(second.stale, false);
  assert.equal(loads.dash, 1);
  assert.equal(first.data?.updatedAt, second.data?.updatedAt);
});

test('stale-while-revalidate: stale data served, refresh kicked in background', async () => {
  let value = 1;
  const loader = async () => {
    loads.stock = (loads.stock ?? 0) + 1;
    return { status: 200, data: { v: value } };
  };
  await getCached('stock-stats', loader, { maxAgeMs: 20, swrMs: 200 });
  await sleep(40); // now stale (20ms TTL passed)
  value = 2;
  const res = await getCached('stock-stats', loader, { maxAgeMs: 20, swrMs: 200 });
  assert.equal(res.stale, true, 'serves stale while revalidating');
  assert.equal(res.data?.v, 1, 'stale value returned immediately');
  await sleep(30); // background refresh completes
  assert.equal(loads.stock, 2, 'background revalidation ran');
});

test('too-stale: waits for a real refresh instead of serving', async () => {
  const loader = async () => {
    loads.k = (loads.k ?? 0) + 1;
    return { status: 200, data: { n: loads.k } };
  };
  await getCached('k', loader, { maxAgeMs: 10, swrMs: 30 });
  await sleep(60); // far past swrMs
  const res = await getCached('k', loader, { maxAgeMs: 10, swrMs: 30 });
  assert.equal(res.fromCache, false, 'too-stale waits on a fresh single-flight fetch');
  assert.equal(res.data?.n, 2);
});

test('HTTP failures are cached WITH their real status and auto-revalidated', async () => {
  let fails = 0;
  const loader = async () => {
    loads.f = (loads.f ?? 0) + 1;
    if (fails < 1) {
      fails += 1;
      return { status: 502, data: null };
    }
    return { status: 200, data: { ok: true } };
  };
  const bad = await getCached('f', loader);
  assert.equal(bad.data, null);
  assert.equal(bad.status, 502, 'real HTTP status must surface, not collapse to 0');
  assert.equal(bad.fromCache, false);
  // A genuine network failure (no HTTP status) still surfaces as status 0.
  const netFail = await loaderNetFail();
  assert.equal(netFail.status, 0);

  // Next read: the cached failure is served with its real status but a
  // background revalidation is kicked immediately (no waiting out maxAge).
  const retried = await getCached('f', loader);
  assert.equal(retried.status, 502, 'cached failure keeps real status');
  assert.equal(retried.data, null);
  await sleep(10); // let the background revalidation land
  assert.equal(loads.f >= 2, true, 'cached failure triggers immediate revalidation');
});

async function loaderNetFail() {
  const loader = async () => {
    loads.net = (loads.net ?? 0) + 1;
    return { status: 0, data: null }; // network-level error (no HTTP status)
  };
  return getCached('net', loader);
}

test('keys are isolated', async () => {
  const loaderA = async () => ({ status: 200, data: { tag: 'a' } });
  const loaderB = async () => ({ status: 200, data: { tag: 'b' } });
  await getCached('a', loaderA);
  const b = await getCached('b', loaderB);
  assert.equal(b.data?.tag, 'b');
  const a = await getCached('a', loaderA);
  assert.equal(a.fromCache, true);
  assert.equal(a.data?.tag, 'a');
});

test('shared single-flight abort propagates to every waiter (no false status=0)', async () => {
  const ac = new AbortController();
  const loader = async () => {
    loads.abort = (loads.abort ?? 0) + 1;
    await sleep(20);
    if (ac.signal.aborted) return { status: 0, data: null, aborted: true };
    return { status: 200, data: { ok: true } };
  };
  const a = getCached('abort-key', loader);
  const b = getCached('abort-key', loader);
  ac.abort(); // caller A aborts the SHARED fetch
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.aborted, true, 'owner sees aborted');
  assert.equal(rb.aborted, true, 'waiter must NOT see a genuine failure');
  assert.equal(rb.status, 0);
  assert.equal(rb.data, null);
  // The aborted outcome must not pollute the cache: the next read re-runs the
  // loader (fresh fetch) instead of serving a poisoned status=0 entry.
  const after = await getCached('abort-key', loader);
  assert.equal(loads.abort, 2, 'aborted outcome is never cached (only the shared run + fresh run)');
  assert.equal(after.aborted, true);
});