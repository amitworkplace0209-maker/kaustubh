// Iterate: seed localStorage like a returning user, reload, select a stock, report.
const port = process.argv[2] || '9333';
const token = process.argv[3] || '';
const seedMode = process.argv[4] || 'kotak-neo';
const url = 'http://127.0.0.1:3000/trading/trade';
const ITER = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
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
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCookie', { name: 'kaustubh_session', value: token, url: 'http://127.0.0.1:3000/' });

  const evalExpr = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  // Seed state on the origin first.
  await send('Page.navigate', { url });
  await sleep(5000);
  await evalExpr(`(() => {
    localStorage.setItem('kaustubh_terminal_mode', ${JSON.stringify(seedMode)});
    localStorage.setItem('kaustubh_settings', JSON.stringify({ accountMode: ${JSON.stringify(seedMode === 'dummy' ? 'demo' : 'api')} }));
    localStorage.setItem('kaustubh_trigger_registry', JSON.stringify([
      { id:'T1', kind:'TARGET', positionId:'p1', orderId:null, squareOffOrderId:null, symbol:'RELIANCE', tradingSymbol:'RELIANCE-EQ', token:'2885', exchange:'NSE', product:'MIS', side:'BUY', quantity:'x', triggerPrice:'not-a-number', status:'ARMED', createdAt:'2026-01-01T00:00:00.000Z' }
    ]));
    return 'SEEDED';
  })()`);

  const results = [];
  for (let i = 0; i < ITER; i++) {
    events = [];
    await send('Page.navigate', { url });
    await sleep(4500);
    await evalExpr(`(() => {
      const input = document.querySelector('input[aria-label="Instrument search"]') || document.querySelector('input[type="search"]');
      if (!input) return 'NO_INPUT';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'reliance');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'TYPED';
    })()`);
    await sleep(2500);
    const optCount = await evalExpr(`document.querySelectorAll('[role="option"]').length`);
    await evalExpr(`(() => { const o = document.querySelector('[role="option"]'); if (o) o.click(); return o ? 'CLICKED' : 'NO_OPTION'; })()`);
    await sleep(3500);
    const dom = await evalExpr(`(() => {
      const main = document.querySelector('main') || document.body;
      const t = (main.innerText || '').replace(/\\s+/g,' ');
      return {
        modeLabel: (t.match(/Dummy Mode|Kotak|Shoonya/) || ['?'])[0],
        url: location.href,
        placeholder: t.includes('Pick a stock to start'),
        boundaryErr: t.includes('could not render'),
        searchUnavailable: t.includes('Search unavailable'),
        ltpShown: /LTP ₹/.test(t),
        size: t.length,
        head: t.slice(0, 200),
      };
    })()`);
    const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description?.slice(0, 300) || e.params.exceptionDetails.text);
    const consoleErr = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error').map((e) => e.params.args.map((a) => String(a.value ?? a.description ?? '').slice(0, 300)).join(' '));
    const bad = events.filter((e) => e.method === 'Network.responseReceived' && e.params.response.status >= 400).map((e) => `${e.params.response.status} ${e.params.response.url}`);
    const stored = await evalExpr(`(() => ({ mode: localStorage.getItem('kaustubh_terminal_mode'), settings: localStorage.getItem('kaustubh_settings') }))()`);
    results.push({ i, optCount, dom, exceptions, consoleErr, bad, stored });
    console.log(`--- iter ${i} ---`);
    console.log(JSON.stringify(results[results.length - 1], null, 2));
  }
  ws.close();
}
main().catch((e) => { console.error('PROBE2_ERROR', e && e.stack ? e.stack : e); process.exit(1); });
