// ─────────────────────────────────────────────────────────────────────────────
// 006 — Trade page PWA/web UI verification probe (headless Chrome over CDP).
//
// Proves, with a REAL browser, that:
//   A. PWA viewport  → (pointer:coarse) → slide-to-order track renders, and a
//      real touch drag on the knob fires the order through the SAME engine
//      endpoint the mode dictates (dummy → /api/trade/demo/order,
//      kotak-neo → /api/terminal/order with terminal:"kotak").
//   B. Web viewport  → (pointer:fine) → NO slider; a plain tap button that opens
//      the review modal.
//   C. No order is actually placed: every order endpoint is intercepted with
//      Fetch.requestPaused and failed on purpose. Routing is proven from the
//      request URL + POST body, nothing is sent to any engine.
//
// Usage:  node docs/opencode/006-trade-page-pwa-web-ui-verify.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const API = process.env.API_BASE || 'http://127.0.0.1:8000';
const PAGE = `${BASE}/trading/trade`;
const PORT = 9411;
// Screenshots are engineering evidence, not project documentation, so they go
// to docs/verification/evidence/ (NOT into docs/ as loose files).
const SHOTS = process.env.SHOT_DIR || join(process.cwd(), 'docs', 'verification', 'evidence');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── terminal-mode control (the app's OWN settings endpoint) ──────────────────
// `terminal_mode` is the backend's source of truth for which terminal the app
// boots into (lib/settings-store.ts adopts it on load). We read it, switch it
// for the scenario, and ALWAYS restore it in a finally block — the operator's
// environment is never left modified by this probe.
async function readTerminalMode() {
  const j = await (await fetch(`${API}/api/settings`)).json();
  return j?.settings?.terminal_mode?.value ?? 'dummy';
}
async function setTerminalMode(v) {
  // Two layers, both through the app's own endpoints:
  //  1. the persisted settings key the settings-store adopts on load, and
  //  2. /api/terminal/switch, which switches the LIVE backend session. Without
  //     (2) TerminalModeReconciler correctly converges the UI back to dummy,
  //     because there is no live Kotak session behind it.
  await fetch(`${API}/api/settings/terminal_mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: v }),
  });
  const res = await fetch(`${API}/api/terminal/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: v }),
  });
  if (!res.ok) throw new Error(`terminal/switch ${v} -> HTTP ${res.status}`);
  return res.json();
}
/** UI TradingMode -> backend terminal id (mirrors lib/settings-store.ts). */
const TERMINAL_OF = { dummy: 'dummy', 'kotak-neo': 'kotak', shoonya: 'shoonya' };

// Captured ONCE, before any scenario mutates anything, so the operator's
// environment is restored to exactly what it was — not to whatever the last
// scenario happened to leave behind.
const ORIGINAL_TERMINAL = await readTerminalMode();

// ── minimal CDP client ──────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) for (const h of this.handlers) h(msg);
    });
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}) {
    const mid = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(mid, { resolve, reject });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
}

async function cdpWaitFor(cdp, expression, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await cdp.eval(expression);
      if (last) return last;
    } catch { /* page may be mid-navigation */ }
    await sleep(intervalMs);
  }
  return last;
}

// ── one page session ────────────────────────────────────────────────────────
async function scenario({ label, mode, mobile }) {
  const profile = mkdtempSync(join(tmpdir(), 'trade-ui-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=390,844',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  let switchResult = null;
  try {
    switchResult = await setTerminalMode(TERMINAL_OF[mode]);

    // wait for the CDP endpoint
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('chrome did not expose a page target');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new Cdp(ws);

    const paused = [];
    const exceptions = [];
    const consoleErrors = [];

    cdp.on((msg) => {
      if (msg.method === 'Fetch.requestPaused') {
        paused.push({ url: msg.params.request.url, postData: msg.params.request.postData || '' });
        cdp.send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'FailedByClient' }).catch(() => {});
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params.exceptionDetails.exception?.description?.slice(0, 400) || msg.params.exceptionDetails.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300));
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    // Intercept (and deliberately fail) every order-placement endpoint.
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*/api/trade/demo/order*', requestStage: 'Request' },
        { urlPattern: '*/api/terminal/order*', requestStage: 'Request' },
      ],
    });

    if (mobile) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    } else {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }

    // Seed the persisted trading mode, then load the page.
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(2500);
    await cdp.eval(`localStorage.setItem('kaustubh_terminal_mode', ${JSON.stringify(mode)}); true`);

    // Log in through the app's OWN Login button (no cookie injection, no bypass).
    await cdp.send('Page.navigate', { url: `${BASE}/login?from=%2Ftrading%2Ftrade` });
    // The login screen renders a Suspense fallback first — wait for the real
    // button instead of guessing a sleep.
    const loginBtn = await cdpWaitFor(
      cdp,
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').trim() === 'Login'); return !!b; })()`,
      { timeoutMs: 25000 },
    );
    const loginState = loginBtn
      ? await cdp.eval(`(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').trim() === 'Login');
          btn.click();
          return 'CLICKED';
        })()`)
      : 'NO_LOGIN_BUTTON:' + await cdp.eval(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120)`);
    // Wait for the session to actually land before continuing — otherwise the
    // next navigate bounces back to /login and the whole scenario is a no-op.
    const loggedIn = await cdpWaitFor(
      cdp,
      `(async () => (await (await fetch('/api/auth/session')).json()).authenticated === true)() `,
      { timeoutMs: 20000 },
    );
    await sleep(1500);

    await cdp.send('Page.navigate', { url: PAGE });
    await sleep(5000);
    // Wait for the trade page itself (its search box) to mount.
    const mounted = await cdpWaitFor(
      cdp,
      `!!(document.querySelector('input[aria-label="Instrument search"]') || document.querySelector('input[type="search"]'))`,
      { timeoutMs: 20000 },
    );
    await sleep(1000);

    const pointerCoarse = await cdp.eval(`matchMedia('(pointer: coarse)').matches`);

    // Search + pick the first suggestion.
    const picked = await cdp.eval(`(() => {
      const input = document.querySelector('input[aria-label="Instrument search"]') || document.querySelector('input[type="search"]');
      if (!input) return 'NO_INPUT';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'reliance');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'TYPED';
    })()`);
    await sleep(3500);
    await cdp.eval(`(() => { const o = document.querySelector('[role="option"]'); if (o) o.click(); return true; })()`);
    await sleep(3500);

    const ui = await cdp.eval(`(() => {
      const main = document.querySelector('main') || document.body;
      const t = (main.innerText || '');
      const slider = document.querySelector('[role="slider"]');
      const orderCard = main.querySelector('section');
      const chips = Array.from(main.querySelectorAll('button'))
        .map(b => (b.innerText||'').replace(/\\s+/g,' ').trim())
        // NOTE: the chip label is CSS-uppercased, and Chrome's innerText reports
        // the RENDERED text — so it arrives as "RISK PASS", not "Risk PASS".
        .filter(s => /^(risk|charges|targets|basket)\\b/i.test(s));
      const allButtons = Array.from(main.querySelectorAll('button'))
        .map(b => (b.innerText||'').replace(/\\s+/g,' ').trim()).slice(0, 40);
      const mainBox = main.getBoundingClientRect();
      const orderBar = slider ? slider.closest('.sticky') || slider.parentElement : null;
      const barBox = orderBar ? orderBar.getBoundingClientRect() : null;
      const nav = document.querySelector('nav[aria-label="Primary navigation"]');
      const navBox = nav ? nav.getBoundingClientRect() : null;
      const bar = document.querySelector('[role="slider"]');
      const slideRect = bar ? bar.getBoundingClientRect() : null;
      const actionBar = document.querySelector('[data-verify="trade-order-bar"]');
      const stickyRect = actionBar ? actionBar.getBoundingClientRect() : null;
      const safeArea = (() => {
        const p = document.createElement('div');
        p.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom);';
        document.body.appendChild(p);
        const h = p.getBoundingClientRect().height;
        p.remove();
        return Math.round(h);
      })();
      const shell = document.querySelector('.ws-phase2');
      const shellBox = shell ? shell.getBoundingClientRect() : null;
      const topbar = document.querySelector('header');
      const topbarBox = topbar ? topbar.getBoundingClientRect() : null;
      const geometry = {
        viewportH: window.innerHeight,
        shell: shellBox ? { top: Math.round(shellBox.top), h: Math.round(shellBox.height), bottom: Math.round(shellBox.bottom) } : null,
        topbar: topbarBox ? { top: Math.round(topbarBox.top), h: Math.round(topbarBox.height), bottom: Math.round(topbarBox.bottom) } : null,
        main: { top: Math.round(mainBox.top), h: Math.round(mainBox.height), bottom: Math.round(mainBox.bottom) },
        slide: slideRect ? { top: Math.round(slideRect.top), h: Math.round(slideRect.height), bottom: Math.round(slideRect.bottom) } : null,
        nav: navBox ? { top: Math.round(navBox.top), h: Math.round(navBox.height), bottom: Math.round(navBox.bottom) } : null,
        barStickyBottom: (() => { const el = bar ? bar.closest('.sticky') : null; return el ? getComputedStyle(el).bottom : null; })(),
        stickyBar: (() => { const el = document.querySelector('.dense-ui .sticky'); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; })(),
      };
      return {
        hasSlider: !!slider,
        sliderLabel: slider ? slider.getAttribute('aria-label') : null,
        orderButtonText: Array.from(main.querySelectorAll('button'))
          .map(b => (b.innerText||'').replace(/\\s+/g,' ').trim())
          .filter(s => /^(BUY|SELL)\\s+[A-Z]/i.test(s) || /^Confirm (BUY|SELL)/i.test(s))
          .slice(0,4),
        chips,
        allButtons,
        hasPlaceholder: t.includes('Pick a stock to start'),
        hasBoundaryError: t.includes('could not render'),
        hasReviewModal: t.includes('Review order'),
        pageHeight: main.scrollHeight,
        viewport: { w: mainBox.width, h: mainBox.height },
        // Is the order bar clear of the fixed bottom nav?
        orderBarBottom: barBox ? Math.round(barBox.bottom) : null,
        navTop: navBox ? Math.round(navBox.top) : null,
        orderBarVisible: barBox ? barBox.top < mainBox.bottom && barBox.bottom > mainBox.top : false,
        geometry,
        safeAreaInsetPx: safeArea,
        stickyCss: actionBar ? {
          position: getComputedStyle(actionBar).position,
          bottom: getComputedStyle(actionBar).bottom,
          rect: stickyRect ? { top: Math.round(stickyRect.top), bottom: Math.round(stickyRect.bottom), h: Math.round(stickyRect.height) } : null,
        } : null,
        text: t.replace(/\\s+/g,' ').slice(0, 2000),
      };
    })()`);

    // Visual evidence — CLEAN layout, before any interaction.
    mkdirSync(SHOTS, { recursive: true });
    const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const preShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const preFile = join(SHOTS, `006-${slug}-before.png`);
    writeFileSync(preFile, Buffer.from(preShot.data, 'base64'));

    // ── interaction ──
    let interaction = 'skipped';
    if (mobile && ui.hasSlider) {
      // REAL touch drag on the knob, through CDP, so setPointerCapture works.
      const box = await cdp.eval(`(() => {
        const r = document.querySelector('[role="slider"]').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      const endX = box.x + 400;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }],
      });
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x: box.x + ((endX - box.x) * i) / 6, y: box.y }],
        });
        await sleep(60);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      interaction = 'touched-slide';
      await sleep(2500);
    } else if (!mobile) {
      // Desktop: plain tap must open the review modal (confirm gate intact).
      const clicked = await cdp.eval(`(() => {
        const main = document.querySelector('main') || document.body;
        const btn = Array.from(main.querySelectorAll('button')).find(b => /^(BUY|SELL)\\s+[A-Z]/i.test((b.innerText||'').trim()));
        if (!btn) return 'NO_BUTTON';
        btn.click();
        return 'CLICKED';
      })()`);
      interaction = clicked;
      await sleep(2000);
      ui.hasReviewModal = await cdp.eval(`(document.body.innerText||'').includes('Review order')`);
    }

    const after = await cdp.eval(`(() => {
      const t = (document.body.innerText||'');
      return {
        hasRejectedBanner: /Rejected|nothing was placed|failed/i.test(t),
        hasSending: t.includes('Sending'),
        text: t.replace(/\\s+/g,' ').slice(0, 400),
      };
    })()`);

    // Visual evidence — result state after the interaction.
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOTS, `006-${slug}-after.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));

    return { label, mode, mobile, pointerCoarse, switchResult, loginState, loggedIn, mounted, picked, ui, interaction, after, paused, exceptions, consoleErrors, screenshot: file, screenshotBefore: preFile };
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
    await sleep(600);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    // ALWAYS put the operator's terminal mode back.
    await setTerminalMode(ORIGINAL_TERMINAL);
  }
}

const results = [];
results.push(await scenario({ label: 'PWA / dummy', mode: 'dummy', mobile: true }));
await sleep(800);
results.push(await scenario({ label: 'PWA / kotak-neo', mode: 'kotak-neo', mobile: true }));
await sleep(800);
results.push(await scenario({ label: 'WEB / kotak-neo', mode: 'kotak-neo', mobile: false }));

for (const r of results) {
  console.log('\n================ ' + r.label + ' ================');
  console.log('pointer:coarse      :', r.pointerCoarse);
  console.log('terminal switch     :', JSON.stringify(r.switchResult));
  console.log('login               :', r.loginState, '| session:', r.loggedIn, '| page mounted:', r.mounted);
  console.log('search              :', r.picked);
  console.log('has slider          :', r.ui.hasSlider, '|', r.ui.sliderLabel);
  console.log('order button text   :', JSON.stringify(r.ui.orderButtonText));
  console.log('insight chips       :', JSON.stringify(r.ui.chips));
  console.log('all main buttons    :', JSON.stringify(r.ui.allButtons));
  console.log('main text           :', r.ui.text);
  console.log('screenshots         :', r.screenshotBefore, '|', r.screenshot);
  console.log('boundary error      :', r.ui.hasBoundaryError);
  console.log('page/viewport h     :', r.ui.pageHeight, '/', r.ui.viewport.h);
  console.log('orderBarBottom/navTop:', r.ui.orderBarBottom, '/', r.ui.navTop, '=> visible:', r.ui.orderBarVisible);
  console.log('geometry            :', JSON.stringify(r.ui.geometry));
  console.log('safe-area inset     :', r.ui.safeAreaInsetPx, 'px');
  console.log('sticky css          :', JSON.stringify(r.ui.stickyCss));
  console.log('review modal        :', r.ui.hasReviewModal);
  console.log('interaction         :', r.interaction);
  console.log('ORDER REQUESTS (intercepted, never sent):');
  for (const p of r.paused) console.log('   ->', p.url.replace(BASE, ''), '|', p.postData.slice(0, 260));
  if (!r.paused.length) console.log('   (none)');
  console.log('exceptions          :', JSON.stringify(r.exceptions));
  console.log('console errors      :', JSON.stringify(r.consoleErrors.slice(0, 6)));
  console.log('after interaction   :', JSON.stringify(r.after.text.slice(0, 260)));
}

console.log('\nterminal_mode restored to:', await readTerminalMode());