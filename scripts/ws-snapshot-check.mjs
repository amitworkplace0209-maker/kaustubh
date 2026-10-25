/**
 * Manual smoke test for the realtime snapshot layer.
 *   node scripts/ws-snapshot-check.mjs [wsUrl] [durationMs]
 *
 * Auth: the backend runs in "secure" mode when APP_PASSWORD is configured, so
 * `/api/realtime/token` demands an operator JWT. We mint one by logging in with
 * the operator credentials from `python-service/.env.local`.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const base = process.argv[2] || 'http://127.0.0.1:8000';
const durationMs = Number(process.argv[3] || 25000);
const wsBase = base.replace(/^http/i, 'ws');

function readEnvFile(path) {
  const out = {};
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function getToken() {
  // 1) Anonymous token works when security is disabled.
  const anon = await fetch(`${base}/api/realtime/token`);
  const anonBody = await anon.json().catch(() => ({}));
  if (anon.ok && anonBody?.token) {
    console.log('token ok (anonymous), secure =', anonBody.secure);
    return anonBody.token;
  }

  // 2) Secure mode: log in as the operator to get a JWT, then exchange it.
  const env = {
    ...readEnvFile(resolve(root, 'python-service', '.env.local')),
    ...readEnvFile(resolve(root, 'python-service', '.env')),
  };
  const username = env.APP_USERNAME || 'kaustubh';
  const password = env.APP_PASSWORD || '';
  if (!password) {
    console.error('no token:', anon.status, anonBody);
    process.exit(1);
  }
  const loginRes = await fetch(`${base}/api/user/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginBody?.token) {
    console.error('operator login failed:', loginRes.status, loginBody);
    process.exit(1);
  }
  const tokenRes = await fetch(`${base}/api/realtime/token`, {
    headers: { authorization: `Bearer ${loginBody.token}` },
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenBody?.token) {
    console.error('no token:', tokenRes.status, tokenBody);
    process.exit(1);
  }
  console.log('token ok (operator), secure =', tokenBody.secure);
  return tokenBody.token;
}

const token = await getToken();

const ws = new WebSocket(`${wsBase}/ws/realtime?token=${encodeURIComponent(token)}`);
const seen = new Map();
const bytes = new Map();

ws.onopen = () => {
  console.log('socket open');
  ws.send(
    JSON.stringify({
      action: 'subscribe',
      request_id: 'r1',
      channels: [
        { channel: 'system' },
        { channel: 'orders' },
        { channel: 'positions' },
        { channel: 'notifications' },
        { channel: 'portfolio' },
      ],
    }),
  );
};

ws.onmessage = (ev) => {
  const frame = JSON.parse(ev.data);
  const type = String(frame.type || '');
  if (type === 'welcome') {
    console.log('welcome channels =', JSON.stringify(frame.data?.channels));
    return;
  }
  if (type === 'subscription.ack') {
    console.log('ack results =', JSON.stringify(frame.data?.results));
    console.log('ack errors  =', JSON.stringify(frame.data?.errors));
    return;
  }
  if (type.endsWith('.snapshot')) {
    const payload = frame.data?.payload;
    const size = JSON.stringify(payload || {}).length;
    seen.set(type, (seen.get(type) || 0) + 1);
    bytes.set(type, size);
    console.log(
      `SNAPSHOT ${type} channel=${frame.channel} bytes=${size} keys=${Object.keys(payload || {}).join(',')}`,
    );
    return;
  }
  console.log('frame', type, 'channel=', frame.channel);
};

ws.onerror = (e) => console.error('socket error', e?.message || e);
ws.onclose = (e) => {
  console.log('socket closed', e.code, e.reason);
  report();
};

function report() {
  console.log('snapshot counts:', JSON.stringify([...seen.entries()]));
  console.log('snapshot bytes:', JSON.stringify([...bytes.entries()]));
  const missing = ['system', 'orders', 'positions', 'notifications', 'portfolio'].filter(
    (c) => !seen.has(`${c}.snapshot`),
  );
  if (missing.length) {
    console.error('MISSING snapshot channels:', missing.join(', '));
    process.exitCode = 1;
  }
}

setTimeout(() => {
  console.log('timeout — snapshot counts:', JSON.stringify([...seen.entries()]));
  report();
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(process.exitCode || 0);
}, durationMs);
