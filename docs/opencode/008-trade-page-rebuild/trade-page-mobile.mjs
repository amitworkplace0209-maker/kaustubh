// Mobile (PWA) geometry probe for the rebuilt /trading/trade page.
//
//   node docs/opencode/008-trade-page-rebuild/trade-page-mobile.mjs <cdpPort> <sessionCookie> [url]
//
// It emulates a 390x844 handset (the PWA breakpoint), selects an instrument and
// measures the layout that the PWA depends on:
//   · the order bar must sit FLUSH above the app's bottom navigation;
//   · the order flow must fit one screen (no horizontal scroll);
//   · every control must stay inside the viewport.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const port = process.argv[2] || '9333';
const cookie = process.argv[3] || '';
const url = process.argv[4] || 'http://127.0.0.1:3000/trading/trade';
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
    if (msg.method) events.push(msg);
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  try {
    await send('Network.setCookie', {
      name: 'kaustubh_session',
      value: cookie,
      url: 'http://127.0.0.1:3000/',
    });
  } catch {}

  await send('Page.navigate', { url });
  await sleep(7000);

  const evalExpr = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  await evalExpr(`(() => {
    const input = document.querySelector('input[aria-label="Instrument search"]');
    if (!input) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'reliance');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'TYPED';
  })()`);
  await sleep(7000);
  await evalExpr(`(() => {
    const o = document.querySelector('[role="option"]');
    if (o) o.click();
    return 'CLICKED';
  })()`);
  await sleep(6000);

  const geometry = await evalExpr(`(() => {
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
    const bar = document.querySelector('[data-verify="trade-order-bar"]') || Array.from(document.querySelectorAll('div')).find(d => /Slide to|BUY |SELL /.test(d.innerText||'') && getComputedStyle(d).position === 'fixed');
    const nav = document.querySelector('[aria-label="Primary navigation"]');
    const main = document.querySelector('main');
    const orderButton = Array.from(document.querySelectorAll('button')).find(b => /^(BUY|SELL) /i.test((b.innerText||'').trim()));
    const overflow = main ? main.scrollWidth - main.clientWidth : null;
    const sliders = Array.from(document.querySelectorAll('[role="slider"]')).map(s => rect(s));
    return {
      viewport: { w: innerWidth, h: innerHeight },
      orderBar: rect(bar),
      bottomNav: rect(nav),
      orderButton: rect(orderButton),
      sliders,
      hasSlider: sliders.length > 0,
      horizontalOverflowPx: overflow,
      touchPoints: navigator.maxTouchPoints,
    };
  })()`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'trade-page-mobile.png'), Buffer.from(shot.data, 'base64'));

  const exceptions = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => String(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text).slice(0, 300));

  console.log(JSON.stringify({ geometry, exceptions }, null, 2));
  ws.close();
}

main().catch((e) => {
  console.error('PROBE_ERROR', e && e.stack ? e.stack : e);
  process.exit(1);
});
