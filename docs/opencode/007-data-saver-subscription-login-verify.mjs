// ─────────────────────────────────────────────────────────────────────────────
// 007 — /data-saver/subscription manual login verification probe.
//
// Proves, with a REAL browser, that the page's "Manual Login" button:
//   1. exists and is reachable when the broker session is inactive,
//   2. issues a POST to the BACKEND login endpoint (not the Next /login page),
//   3. shows the backend's REAL verdict (never a green toast for a failed login).
//
// The request is observed, never satisfied by a stub — the backend is allowed to
// do exactly what it would do in production. Login/logout are reversible and
// are restored to the original state in a `finally` block.
//
// Usage:  node docs/opencode/007-data-saver-subscription-login-verify.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const API = process.env.API_BASE || 'http://127.0.0.1:8000';
const PAGE = `${BASE}/data-saver/subscription`;
const PORT = 9412;
const SHOTS = process.env.SHOT_DIR || join(process.cwd(), 'docs', 'verification', 'evidence');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
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
    try { last = await cdp.eval(expression); if (last) return last; } catch { /* mid-navigation */ }
    await sleep(intervalMs);
  }
  return last;
}

async function readState() {
  const s = await (await fetch(`${API}/api/session/status`)).json();
  return s;
}

async function main() {
  const original = await readState();
  console.log('ORIGINAL SESSION STATE:', JSON.stringify(original));

  const profile = mkdtempSync(join(tmpdir(), 'ds-login-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('no chrome page target');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);

    const loginRequests = [];
    const exceptions = [];
    const consoleErrors = [];

    cdp.on((msg) => {
      if (msg.method === 'Network.requestWillBeSent' && msg.params.request.method === 'POST') {
        const u = msg.params.request.url;
        if (/\/login|\/logout/.test(u)) loginRequests.push({ url: u, postData: msg.params.request.postData });
      }
      if (msg.method === 'Network.responseReceived' && /\/login|\/logout/.test(msg.params.response.url)) {
        loginRequests.push({ response: `${msg.params.response.status} ${msg.params.response.url}` });
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // Log in to the APP through its own button (not the broker login we test).
    await cdp.send('Page.navigate', { url: `${BASE}/login?from=%2Fdata-saver%2Fsubscription` });
    const hasLoginBtn = await cdpWaitFor(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').trim() === 'Login'); return !!b; })()`, { timeoutMs: 25000 });
    if (hasLoginBtn) {
      await cdp.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').trim() === 'Login'); b.click(); return true; })()`);
    }
    await cdpWaitFor(cdp, `(async () => (await (await fetch('/api/auth/session')).json()).authenticated === true)()`, { timeoutMs: 20000 });
    await sleep(1500);

    await cdp.send('Page.navigate', { url: PAGE });
    const mounted = await cdpWaitFor(cdp, `(document.body.innerText||'').includes('Stock Subscription')`, { timeoutMs: 25000 });
    await sleep(3500);

    const before = await cdp.eval(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').trim() === 'Manual Login');
      return {
        pageLoaded: (document.body.innerText||'').includes('Stock Subscription'),
        hasManualLoginButton: !!btn,
        bannerVisible: (document.body.innerText||'').includes('Broker session is inactive'),
        buttonInBanner: !!btn && !!btn.closest('.rounded-2xl'),
      };
    })()`);

    mkdirSync(SHOTS, { recursive: true });
    const pre = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, '007-subscription-before.png'), Buffer.from(pre.data, 'base64'));

    // ── click the page's own Manual Login button ──
    let clicked = 'NOT_FOUND';
    if (before.hasManualLoginButton) {
      clicked = await cdp.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').trim() === 'Manual Login');
        if (!btn) return 'NOT_FOUND';
        btn.click();
        return 'CLICKED';
      })()`);
    }
    const clickedAt = Date.now();
    await sleep(500);
    await sleep(6000);

    // The backend's own `/api/system/dashboard` aggregates through a 15s cache,
    // so give the banner a fair chance to clear rather than sampling at 6s.
    const bannerClearedAt = await cdpWaitFor(
      cdp,
      `!(document.body.innerText||'').includes('Broker session is inactive') ? Date.now() : false`,
      { timeoutMs: 35000, intervalMs: 1000 },
    );
    const elapsedMs = bannerClearedAt ? Date.now() - clickedAt : null;

    const after = await cdp.eval(`(() => {
      const t = document.body.innerText || '';
      const toast = Array.from(document.querySelectorAll('div'))
        .map(d => (d.innerText||'').trim())
        .filter(s => s && s.length < 120 && /Login|login|rejected|failed/i.test(s))
        .slice(-3);
      return {
        toastTexts: toast,
        bannerStillVisible: t.includes('Broker session is inactive'),
        bodySnippet: t.replace(/\\s+/g,' ').slice(0, 260),
      };
    })()`);

    const post = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, '007-subscription-after.png'), Buffer.from(post.data, 'base64'));

    const stateAfter = await readState();

    console.log('\n================ RESULT ================');
    console.log('page mounted            :', mounted);
    console.log('banner visible (before) :', before.bannerVisible);
    console.log('Manual Login button     :', before.hasManualLoginButton, '| in banner:', before.buttonInBanner);
    console.log('clicked                 :', clicked);
    console.log('\nPOST /login requests observed by the browser:');
    for (const r of loginRequests) console.log('   ', JSON.stringify(r));
    console.log('\nvisible toasts          :', JSON.stringify(after.toastTexts));
    console.log('banner still visible    :', after.bannerStillVisible, '| cleared after:', elapsedMs != null ? `${elapsedMs}ms` : 'NEVER (within 35s)');
    console.log('\nBACKEND SESSION AFTER   :', JSON.stringify(stateAfter));
    console.log('exceptions              :', JSON.stringify(exceptions));
    console.log('console errors          :', JSON.stringify(consoleErrors.slice(0, 5)));
    console.log('body snippet            :', JSON.stringify(after.bodySnippet));
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
    await sleep(600);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    // Restore: if we turned a session on, turn it back off.
    const now = await readState().catch(() => null);
    const wasActive = Boolean(original?.active ?? original?.status === 'ACTIVE');
    const isActive = Boolean(now?.active ?? now?.status === 'ACTIVE');
    if (!wasActive && isActive) {
      console.log('\nRESTORING: session was inactive before, active now -> logging out');
      await fetch(`${API}/api/logout`, { method: 'POST' }).catch(() => {});
    } else {
      console.log('\nRESTORING: session state unchanged (nothing to undo)');
    }
    console.log('SESSION AFTER RESTORE  :', JSON.stringify(await readState().catch(() => null)));
  }
}

main().catch((e) => { console.error('PROBE_ERROR', e?.stack ?? e); process.exit(1); });