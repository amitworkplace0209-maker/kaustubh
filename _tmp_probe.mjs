// Headless CDP probe: load /trading/trade, select a stock, capture real errors.
const port = process.argv[2] || '9333';
const token = process.argv[3] || '';
const url = process.argv[4] || 'http://127.0.0.1:3000/trading/trade';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break;
    } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target: ' + JSON.stringify(targets).slice(0, 500));

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
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  try {
    await send('Network.setCookie', { name: 'kaustubh_session', value: token, url: 'http://127.0.0.1:3000/' });
  } catch (e) {
    console.log('SETCOOKIE_ERR', String(e));
  }

  await send('Page.navigate', { url });
  await sleep(6000);

  const evalExpr = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  const typed = await evalExpr(`(() => {
    const input = document.querySelector('input[aria-label="Instrument search"]') || document.querySelector('input[type="search"]');
    if (!input) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'reliance');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'TYPED';
  })()`);
  await sleep(3000);

  const options = await evalExpr(`Array.from(document.querySelectorAll('[role="option"]')).map(o => (o.innerText||'').replace(/\\s+/g,' ').slice(0,80))`);

  const clicked = await evalExpr(`(() => {
    const o = document.querySelector('[role="option"]');
    if (!o) return 'NO_OPTION';
    o.click();
    return 'CLICKED';
  })()`);
  await sleep(4000);

  const dom = await evalExpr(`(() => {
    const main = document.querySelector('main') || document.body;
    const t = (main.innerText || '');
    return {
      url: location.href,
      hasPlaceholder: t.includes('Pick a stock to start'),
      hasBoundaryError: t.includes('could not render'),
      hasSearchUnavailable: t.includes('Search unavailable'),
      snippet: t.replace(/\\s+/g,' ').slice(0, 900),
    };
  })()`);

  const exceptions = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => ({ text: e.params.exceptionDetails.text, desc: e.params.exceptionDetails.exception?.description?.slice(0, 800) }));
  const consoleMsgs = events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type))
    .map((e) => ({ type: e.params.type, args: e.params.args.map((a) => String(a.value ?? a.description ?? a.type).slice(0, 500)) }));
  const logs = events
    .filter((e) => e.method === 'Log.entryAdded')
    .map((e) => ({ level: e.params.entry.level, text: String(e.params.entry.text).slice(0, 500) }));
  const failed = events.filter((e) => e.method === 'Network.loadingFailed').map((e) => e.params.errorText);
  const respBad = events
    .filter((e) => e.method === 'Network.responseReceived' && e.params.response.status >= 400)
    .map((e) => `${e.params.response.status} ${e.params.response.url}`);

  console.log('TYPED:', typed);
  console.log('OPTIONS:', JSON.stringify(options));
  console.log('CLICKED:', clicked);
  console.log('DOM:', JSON.stringify(dom, null, 2));
  console.log('EXCEPTIONS:', JSON.stringify(exceptions, null, 2));
  console.log('CONSOLE_ERR:', JSON.stringify(consoleMsgs, null, 2));
  console.log('LOG_ERR:', JSON.stringify(logs, null, 2));
  console.log('FAILED_REQS:', JSON.stringify(failed));
  console.log('BAD_RESPONSES:', JSON.stringify(respBad));
  ws.close();
}

main().catch((e) => {
  console.error('PROBE_ERROR', e && e.stack ? e.stack : e);
  process.exit(1);
});
