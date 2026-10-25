// Headless-Chrome (CDP) verification for the rebuilt /trading/trade page.
//
//   node docs/opencode/008-trade-page-rebuild/trade-page-verify.mjs <cdpPort> <sessionCookie> [url] [--allow-order]
//
// What it proves, on the LIVE page:
//   1. the page renders the new layout (rail / search / quote header / ticket /
//      money strip / inspector / action bar);
//   2. searching and selecting an instrument fills a REAL price and the page
//      says WHERE that price came from;
//   3. the risk verdict is rendered from the server verdict (never invented);
//   4. the live price is served by the shared SSE tick stream (the same-origin
//      channel that works on a phone) — not by a dead socket;
//   5. the confirm dialog opens and the request that leaves the browser carries
//      the expected payload.
//
// SAFETY: by default EVERY request whose URL contains "order" is intercepted
// and FAILED, so this probe can never reach an engine. `--allow-order` lifts
// that guard and is only used against the DUMMY (paper) terminal.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const port = process.argv[2] || '9333';
const cookie = process.argv[3] || '';
const url = process.argv[4] || 'http://127.0.0.1:3000/trading/trade';
const ALLOW_ORDER = process.argv.includes('--allow-order');
const OUT = join(process.cwd(), 'docs', 'opencode', '008-trade-page-rebuild', 'evidence');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });

  let targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break;
    } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  const orderRequests = [];
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      events.push(msg);
      // Intercepted order requests are FAILED — the probe never reaches an engine.
      if (msg.method === 'Fetch.requestPaused') {
        send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'Aborted' }).catch(() => {});
      }
    }
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  if (!ALLOW_ORDER) {
    await send('Fetch.enable', { patterns: [{ urlPattern: '*order*', requestStage: 'Request' }] });
  }
  try {
    await send('Network.setCookie', {
      name: 'kaustubh_session',
      value: cookie,
      url: 'http://127.0.0.1:3000/',
    });
  } catch (e) {
    console.log('SETCOOKIE_ERR', String(e));
  }

  await send('Page.navigate', { url });
  await sleep(6000);

  const evalExpr = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  /** Poll a JS expression until it returns a truthy value (or the timeout). */
  const waitFor = async (expression, timeoutMs = 25000, stepMs = 500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await evalExpr(expression);
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  };

  const typed = await evalExpr(`(() => {
    const input = document.querySelector('input[aria-label="Instrument search"]');
    if (!input) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'reliance');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'TYPED';
  })()`);
  await sleep(2000);
  await waitFor(`document.querySelectorAll('[role="option"]').length > 0`, 25000);

  const options = await evalExpr(
    `Array.from(document.querySelectorAll('[role="option"]')).map(o => (o.innerText||'').replace(/\\s+/g,' ').slice(0,80))`,
  );

  const clicked = await evalExpr(`(() => {
    const o = document.querySelector('[role="option"]');
    if (!o) return 'NO_OPTION';
    o.click();
    return 'CLICKED';
  })()`);
  await sleep(2000);
  await waitFor(`Boolean(document.querySelector('input[aria-label="Quantity"]'))`, 20000);
  await sleep(4000);

  const layout = await evalExpr(`(() => {
    const text = (document.querySelector('main') || document.body).innerText || '';
    const q = (sel) => Boolean(document.querySelector(sel));
    return {
      url: location.href,
      hasSearch: q('input[aria-label="Instrument search"]'),
      hasQuantity: q('input[aria-label="Quantity"]'),
      hasOrderButton: Array.from(document.querySelectorAll('button')).some(b => /^(BUY|SELL) /i.test((b.innerText||'').trim())),
      hasRail: /Dummy Mode|Kotak Neo|Shoonya/.test(text),
      hasInspectorTabs: /Risk/i.test(text) && /Charges/i.test(text) && /Targets/i.test(text) && /Basket/i.test(text),
      hasMarginStrip: /Margin/i.test(text) && /Available/i.test(text),
      text: text.replace(/\\s+/g,' ').slice(0, 1400),
    };
  })()`);

  // --- the live price must come from the shared SSE tick stream -------------
  const tickStreamResponses = events.filter(
    (e) => e.method === 'Network.responseReceived' && e.params?.response?.url?.includes('/api/ticks/stream'),
  ).length;
  const riskCalls = events.filter(
    (e) => e.method === 'Network.requestWillBeSent' && e.params?.request?.url?.includes('/api/services/risk/validate'),
  ).length;
  const marginCalls = events.filter(
    (e) => e.method === 'Network.requestWillBeSent' && e.params?.request?.url?.includes('/api/terminal/margin'),
  ).length;

  // --- open the confirm dialog ---------------------------------------------
  await evalExpr(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /^(BUY|SELL) /i.test((x.innerText||'').trim()));
    if (!b) return 'NO_BUTTON';
    b.click();
    return 'CLICKED';
  })()`);
  await sleep(1500);
  const dialog = await evalExpr(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return { open: false };
    return { open: true, text: (d.innerText||'').replace(/\\s+/g,' ').slice(0,400) };
  })()`);

  // --- confirm --------------------------------------------------------------
  await evalExpr(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = Array.from(d?.querySelectorAll('button') || []).find(x => /Confirm/i.test(x.innerText||''));
    if (!b) return 'NO_CONFIRM';
    b.click();
    return 'CONFIRMED';
  })()`);
  await sleep(4000);

  const execText = await evalExpr(`(() => {
    const t = (document.querySelector('main') || document.body).innerText || '';
    const at = Math.max(t.indexOf('Filled'), t.indexOf('Working'), t.indexOf('Order not placed'));
    return at >= 0 ? t.slice(at, at + 260) : 'NO_EXEC_STATE';
  })()`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, ALLOW_ORDER ? 'trade-page-dummy-filled.png' : 'trade-page-desktop.png'), Buffer.from(shot.data, 'base64'));

  for (const e of events) {
    if (e.method !== 'Network.requestWillBeSent') continue;
    const r = e.params.request;
    if (!/order/i.test(r.url)) continue;
    if (!/\/api\/(trade\/demo\/order|terminal\/order)/.test(r.url)) continue;
    orderRequests.push({ url: r.url, method: r.method, body: r.postData ? r.postData.slice(0, 700) : null });
  }

  const exceptions = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => ({
      text: e.params.exceptionDetails.text,
      desc: String(e.params.exceptionDetails.exception?.description ?? '').slice(0, 400),
    }));
  const consoleErrs = events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => e.params.args.map((a) => String(a.value ?? a.description ?? a.type).slice(0, 260)));
  const badResponses = events
    .filter((e) => e.method === 'Network.responseReceived' && e.params.response.status >= 400)
    .map((e) => `${e.params.response.status} ${e.params.response.url}`);

  console.log(JSON.stringify({
    allowOrder: ALLOW_ORDER,
    typed,
    options,
    clicked,
    layout,
    tickStreamResponses,
    riskCalls,
    marginCalls,
    dialog,
    execText,
    orderRequests,
    badResponses,
    exceptions,
    consoleErrs,
  }, null, 2));

  ws.close();
}

main().catch((e) => {
  console.error('PROBE_ERROR', e && e.stack ? e.stack : e);
  process.exit(1);
});
