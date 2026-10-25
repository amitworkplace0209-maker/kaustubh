// Select a NON-live stock and watch whether the card ever fills in.
const port = process.argv[2] || '9333';
const token = process.argv[3] || '';
const optIndex = Number(process.argv[4] || '1');
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
  await send('Network.enable');
  await send('Network.setCookie', { name: 'kaustubh_session', value: token, url: 'http://127.0.0.1:3000/' });
  const evalExpr = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  await send('Page.navigate', { url });
  await sleep(5000);
  await evalExpr(`(() => {
    const input = document.querySelector('input[aria-label="Instrument search"]') || document.querySelector('input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'reliance');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'TYPED';
  })()`);
  await sleep(3000);
  const label = await evalExpr(`(() => { const o = document.querySelectorAll('[role="option"]')[${optIndex}]; return o ? o.innerText.replace(/\\s+/g,' ') : 'NO_OPTION'; })()`);
  await evalExpr(`(() => { const o = document.querySelectorAll('[role="option"]')[${optIndex}]; if (o) o.click(); return 'CLICKED'; })()`);
  console.log('SELECTED:', label);

  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    const dom = await evalExpr(`(() => {
      const main = document.querySelector('main') || document.body;
      const t = (main.innerText || '').replace(/\\s+/g,' ');
      return { t: t.slice(0, 400) };
    })()`);
    console.log(`t+${(i + 1) * 2}s:`, dom.t);
  }

  const reqs = events
    .filter((e) => e.method === 'Network.requestWillBeSent' && /\/api\//.test(e.params.request.url))
    .map((e) => e.params.request.method + ' ' + e.params.request.url.replace('http://127.0.0.1:3000', ''));
  const resps = events
    .filter((e) => e.method === 'Network.responseReceived' && /\/api\//.test(e.params.response.url))
    .map((e) => e.params.response.status + ' ' + e.params.response.url.replace('http://127.0.0.1:3000', ''));
  const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description?.slice(0, 300));
  console.log('API REQUESTS:', JSON.stringify([...new Set(reqs)], null, 2));
  console.log('API RESPONSES:', JSON.stringify([...new Set(resps)], null, 2));
  console.log('EXCEPTIONS:', JSON.stringify(exceptions));
  ws.close();
}
main().catch((e) => { console.error('PROBE3_ERROR', e && e.stack ? e.stack : e); process.exit(1); });
