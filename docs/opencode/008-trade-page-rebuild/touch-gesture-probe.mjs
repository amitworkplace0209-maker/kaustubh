// V1 — touch-gesture probe for the rebuilt order bar.
//
//   node docs/opencode/008-trade-page-rebuild/touch-gesture-probe.mjs <cdpPort> <sessionCookie> [url]
//
// It drives the SLIDE-to-confirm control with REAL CDP touch events on an
// emulated 390x844 touch device and proves the two halves of the gesture:
//
//   A) a drag that stops short of the commit line must SPRING BACK and place
//      NOTHING (no order request may leave the browser);
//   B) a drag past the commit line must COMMIT and place the order.
//
// SAFETY: every request whose URL contains "order" is intercepted and FAILED,
// so this probe can never reach an engine. Use the Dummy (paper) terminal.
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
      if (msg.method === 'Fetch.requestPaused') {
        send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'Aborted' }).catch(() => {});
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const r = msg.params.request;
        if (/\/api\/(trade\/demo\/order|terminal\/order)/.test(r.url)) {
          orderRequests.push({ url: r.url, body: r.postData ? r.postData.slice(0, 400) : null });
        }
      }
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*order*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  try {
    await send('Network.setCookie', {
      name: 'kaustubh_session', value: cookie, url: 'http://127.0.0.1:3000/',
    });
  } catch {}

  await send('Page.navigate', { url });
  await sleep(7000);

  const evalExpr = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  /** Poll a JS expression until it returns a truthy value (or the timeout). */
  const waitFor = async (expression, timeoutMs = 20000, stepMs = 500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await evalExpr(expression);
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  };

  // --- select an instrument -------------------------------------------------
  await evalExpr(`(() => {
    const input = document.querySelector('input[aria-label="Instrument search"]');
    if (!input) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'reliance');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'TYPED';
  })()`);
  const gotOptions = await waitFor(`document.querySelectorAll('[role="option"]').length > 0`, 25000);
  if (!gotOptions) {
    console.log(JSON.stringify({ error: 'NO_OPTIONS (the search never returned rows)' }, null, 2));
    ws.close();
    return;
  }
  await evalExpr(`(() => { const o = document.querySelector('[role="option"]'); if (o) o.click(); return 'CLICKED'; })()`);
  const selected = await waitFor(`Boolean(document.querySelector('[role="slider"]')) || Array.from(document.querySelectorAll('button')).some(b => /^(BUY|SELL) /i.test((b.innerText||'').trim()))`, 15000);
  if (!selected) {
    console.log(JSON.stringify({ error: 'NOT_SELECTED (the option click did not open the ticket)' }, null, 2));
    ws.close();
    return;
  }
  await sleep(2000);

  const knob = await evalExpr(`(() => {
    const el = document.querySelector('[role="slider"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: Math.round(r.left), width: Math.round(r.width) };
  })()`);

  if (!knob) {
    const diag = await evalExpr(`(() => {
      const t = (document.querySelector('main') || document.body).innerText || '';
      return {
        pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
        maxTouchPoints: navigator.maxTouchPoints,
        hasOrderButton: Array.from(document.querySelectorAll('button')).some(b => /^(BUY|SELL) /i.test((b.innerText||'').trim())),
        options: Array.from(document.querySelectorAll('[role="option"]')).length,
        text: t.replace(/\\s+/g,' ').slice(0, 700),
      };
    })()`);
    console.log(JSON.stringify({ error: 'NO_SLIDER', diag }, null, 2));
    ws.close();
    return;
  }

  const track = await evalExpr(`(() => {
    const el = document.querySelector('[role="slider"]')?.parentElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  })()`);

  /** Drag the knob from its current x to `targetRatio` of the track. */
  const dragTo = async (ratio) => {
    const startX = knob.x;
    const startY = knob.y;
    const endX = Math.round(track.left + (track.width - knob.width) * ratio + knob.width / 2);
    const steps = 12;
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y: startY, id: 1 }],
    });
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(startX + ((endX - startX) * i) / steps);
      await send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: startY, id: 1 }],
      });
      await sleep(35);
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return endX;
  };

  const knobLeft = async () =>
    evalExpr(`(() => {
      const el = document.querySelector('[role="slider"]');
      if (!el) return null;
      return Math.round(el.getBoundingClientRect().left);
    })()`);

  // --- A) a drag that stops short of the commit line -----------------------
  const beforeA = orderRequests.length;
  await dragTo(0.45);
  await sleep(2500);
  const afterShort = {
    knobLeft: await knobLeft(),
    ordersPlaced: orderRequests.length - beforeA,
  };
  const shortShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'touch-gesture-short-drag.png'), Buffer.from(shortShot.data, 'base64'));

  // --- B) a drag past the commit line ---------------------------------------
  const beforeB = orderRequests.length;
  await dragTo(0.92);
  await sleep(3500);
  const afterCommit = {
    knobLeft: await knobLeft(),
    ordersPlaced: orderRequests.length - beforeB,
  };
  const execText = await evalExpr(`(() => {
    const t = (document.querySelector('main') || document.body).innerText || '';
    const at = Math.max(t.indexOf('Filled'), t.indexOf('Working'), t.indexOf('Order not placed'));
    return at >= 0 ? t.slice(at, at + 200) : 'NO_EXEC_STATE';
  })()`);
  const commitShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'touch-gesture-commit.png'), Buffer.from(commitShot.data, 'base64'));

  const exceptions = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => String(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text).slice(0, 300));

  console.log(JSON.stringify({
    knob,
    track,
    commitRatioInCode: 0.82,
    A_shortDrag: { ...afterShort, expected: 'knob springs back to its start and NO order is placed' },
    B_fullDrag: { ...afterCommit, expected: 'the order request leaves the browser' },
    orderRequests,
    execText,
    exceptions,
  }, null, 2));

  ws.close();
}

main().catch((e) => {
  console.error('PROBE_ERROR', e && e.stack ? e.stack : e);
  process.exit(1);
});
