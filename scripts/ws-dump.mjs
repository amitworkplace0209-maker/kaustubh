/**
 * Dump one realtime frame (debugging aid).
 *   node scripts/ws-dump.mjs <channel> [wsUrl] [--type <exact frame type>]
 * Without --type it waits for the first `<channel>.snapshot`. With --type it
 * waits for a frame whose `type` equals the given value (e.g. broadcasts like
 * `market_watch.ui` that have no snapshot).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const argv = process.argv.slice(2);
const typeFlag = argv.indexOf('--type');
const wantType = typeFlag >= 0 ? String(argv.splice(typeFlag).slice(1)[0] || '') : '';
const channel = argv[0] || 'positions';
const base = argv[1] || 'http://127.0.0.1:8000';
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function getToken() {
  const anon = await fetch(`${base}/api/realtime/token`);
  const anonBody = await anon.json().catch(() => ({}));
  if (anon.ok && anonBody?.token) return anonBody.token;
  const env = {
    ...readEnvFile(resolve(root, 'python-service', '.env.local')),
    ...readEnvFile(resolve(root, 'python-service', '.env')),
  };
  const loginRes = await fetch(`${base}/api/user/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: env.APP_USERNAME || 'kaustubh', password: env.APP_PASSWORD || '' }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  const tokenRes = await fetch(`${base}/api/realtime/token`, {
    headers: { authorization: `Bearer ${loginBody.token}` },
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenBody?.token) {
    console.error('no token', tokenRes.status, tokenBody);
    process.exit(1);
  }
  return tokenBody.token;
}

const token = await getToken();
const ws = new WebSocket(`${wsBase}/ws/realtime?token=${encodeURIComponent(token)}`);

ws.onopen = () => {
  ws.send(JSON.stringify({ action: 'subscribe', request_id: 'r1', channels: [{ channel }] }));
};

ws.onmessage = (ev) => {
  const frame = JSON.parse(ev.data);
  const want = wantType.endsWith('.*') ? wantType.slice(0, -2) : wantType;
  const ok = wantType
    ? (wantType.endsWith('.*') ? String(frame.type || '').startsWith(want) : frame.type === wantType)
    : String(frame.type || '').endsWith('.snapshot');
  if (!ok) return;
  if (wantType.endsWith('.*')) {
    console.log(`seen: ${frame.type}`);
    return;
  }
  const raw = wantType ? JSON.stringify(frame.data, null, 2) : JSON.stringify(frame.data?.payload, null, 2);
  console.log(`frame type: ${frame.type} · bytes: ${ev.data.length}`);
  console.log(raw);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};

ws.onerror = (e) => {
  console.error('socket error', e?.message || e);
  process.exit(1);
};

setTimeout(() => {
  console.error(`timeout: no match for channel=${channel}${wantType ? ` type=${wantType}` : ' (snapshot)'}`);
  process.exit(1);
}, wantType ? 70000 : 20000);
