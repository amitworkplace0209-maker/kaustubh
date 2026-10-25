// Mobile emulation + REAL touch tap on a search result (exercises the blur race).
const port = process.argv[2] || '9333';
const token = process.argv[3] || '';
const url = 'http://127.0.0.1:3000/trading/trade';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let events = [];
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Network.enable');
  await send('Network.setCookie', { name: 'kaustubh_session', value: token, url: 'http://127.0.0.1:3000/' });
  const evalExpr = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  await send('Page.navigate', { url });
  await sleep(5500);

  // Tap the search input, then type via Input.insertText (like a real keyboard).
  const inputRect = await evalExpr(`(() => {
    const i = document.querySelector('input[aria-label="Instrument search"]') || document.querySelector('input[type="search"]');
    if (!i) return null; i.focus();
    const r = i.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!inputRect) { console.log('NO_INPUT'); ws.close(); return; }
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: inputRect.x, y: inputRect.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await send('Input.insertText', { text: 'reliance' });
  await sleep(3000);

  const opts = await evalExpr(`Array.from(document.querySelectorAll('[role="option"]')).map((o,i) => {
    const r = o.getBoundingClientRect();
    return { i, label: (o.innerText||'').replace(/\\s+/g,' ').slice(0,50), x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
  })`);
  console.log('OPTIONS:', JSON.stringify(opts, null, 2));
  if (!opts || !opts.length) { console.log('NO_OPTIONS'); ws.close(); return; }

  const o = opts[0];
  events = [];
  // Real tap: touchStart then touchEnd at the option center.
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: o.x, y: o.y }] });
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(3500);

  const dom = await evalExpr(`(() => {
    const main = document.querySelector('main') || document.body;
    const t = (main.innerText || '').replace(/\\s+/g,' ');
    return { placeholder: t.includes('Pick a stock to start'), boundaryErr: t.includes('could not render'), size: t.length, head: t.slice(0,260) };
  })()`);
  const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description?.slice(0,300));
  console.log('AFTER_TAP_DOM:', JSON.stringify(dom, null, 2));
  console.log('EXCEPTIONS:', JSON.stringify(exceptions));
  ws.close();
}
main().catch((e) => { console.error('PROBE4_ERROR', e && e.stack ? e.stack : e); process.exit(1); });
