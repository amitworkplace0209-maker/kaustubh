// V5 — charge estimate probe: CASH (delivery) vs MIS (intraday).
//
//   node docs/opencode/008-trade-page-rebuild/charges-probe.mjs <cdpPort> <sessionCookie> [url]
//
// It reads the CHARGES tab of the inspector for the same order under both
// products and prints both breakdowns, so the STT segment can be compared:
//   CASH = full-payment DELIVERY on this platform (STT 0.1 % on both sides)
//   MIS  = INTRADAY equity            (STT 0.025 %, sell side only)
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
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  // A wide, tall viewport: the inspector tabs must be on screen for a real
  // mouse press to land on them.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
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
  const waitFor = async (expression, timeoutMs = 25000, stepMs = 500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await evalExpr(expression);
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  };

  /**
   * Radix activates a tab on MOUSEDOWN, so `element.click()` never switches
   * it. A real mouse press through CDP does.
   */
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  await evalExpr(`(() => {
    const input = document.querySelector('input[aria-label="Instrument search"]');
    if (!input) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'reliance');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'TYPED';
  })()`);
  if (!await waitFor(`document.querySelectorAll('[role="option"]').length > 0`)) {
    console.log(JSON.stringify({ error: 'NO_OPTIONS' }, null, 2));
    ws.close();
    return;
  }
  await evalExpr(`(() => { const o = document.querySelector('[role="option"]'); if (o) o.click(); return 'CLICKED'; })()`);
  if (!await waitFor(`Boolean(document.querySelector('input[aria-label="Quantity"]'))`)) {
    console.log(JSON.stringify({ error: 'NOT_SELECTED' }, null, 2));
    ws.close();
    return;
  }
  await sleep(2500);

  /** Click a product segment and read the CHARGES tab. */
  const chargesFor = async (product) => {
    await evalExpr(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').trim() === ${JSON.stringify(product)});
      if (btn) btn.click();
      return 'CLICKED';
    })()`);
    await sleep(1200);
    // Open the CHARGES tab (a real mouse press — Radix listens on mousedown).
    const box = await evalExpr(`(() => {
      const tab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => /Charges/i.test(b.innerText||''));
      if (!tab) return null;
      tab.scrollIntoView({ block: 'center' });
      const r = tab.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (box) await clickAt(box.x, box.y);
    await sleep(1200);
    return evalExpr(`(() => {
      const active = Array.from(document.querySelectorAll('button[role="tab"]')).find(t => t.getAttribute('aria-selected') === 'true');
      const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
      return {
        activeTab: active ? (active.innerText||'').replace(/\\s+/g,' ').trim() : null,
        text: panel ? (panel.innerText || '').replace(/\\s+/g,' ').trim() : null,
      };
    })()`);
  };

  const mis = await chargesFor('MIS');
  const cash = await chargesFor('CASH');

  const diag = await evalExpr(`(() => {
    const tabs = Array.from(document.querySelectorAll('button[role="tab"]')).map(t => ({
      label: (t.innerText||'').replace(/\\s+/g,' ').trim(),
      selected: t.getAttribute('aria-selected'),
    }));
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]')).map(p => ({
      state: p.getAttribute('data-state'),
      hidden: p.hasAttribute('hidden'),
      display: getComputedStyle(p).display,
      text: (p.innerText||'').replace(/\\s+/g,' ').slice(0,200),
    }));
    const section = Array.from(document.querySelectorAll('section')).find(s => /Charges/i.test((s.innerText||'').slice(0,40)));
    return { tabs, panels, chargesSection: section ? (section.innerText||'').replace(/\\s+/g,' ').slice(0,300) : 'NO_SECTION' };
  })()`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'charges-cash.png'), Buffer.from(shot.data, 'base64'));

  const sttOf = (text) => {
    const m = /STT\s+(-?[\d.,]+)/i.exec((text && text.text) || text || '');
    return m ? m[1] : null;
  };
  const totalOf = (text) => {
    const m = /Total charges\s+([\d.,]+)/i.exec((text && text.text) || text || '');
    return m ? m[1] : null;
  };
  const panelText = (r) => (r && r.text) || r || null;

  console.log(JSON.stringify({
    MIS: { raw: panelText(mis), stt: sttOf(mis), total: totalOf(mis) },
    CASH: { raw: panelText(cash), stt: sttOf(cash), total: totalOf(cash) },
    expected: 'CASH must use the DELIVERY STT (0.1 %) and MIS the INTRADAY STT (0.025 %)',
    distinct: sttOf(mis) !== sttOf(cash),
    diag,
  }, null, 2));

  ws.close();
}

main().catch((e) => {
  console.error('PROBE_ERROR', e && e.stack ? e.stack : e);
  process.exit(1);
});
