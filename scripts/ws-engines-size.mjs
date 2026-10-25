/**
 * Measure the size of the `engine.status` frame the backend pushes on the
 * `engines` channel (debugging aid).
 *   node scripts/ws-engines-size.mjs [wsUrl]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const base = process.argv[2] || 'http://127.0.0.1:8000';
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
  ws.send(JSON.stringify({ action: 'subscribe', request_id: 'r1', channels: [{ channel: 'engines' }] }));
};

ws.onmessage = (ev) => {
  const frame = JSON.parse(ev.data);
  if (frame.type === 'engine.status') {
    const payload = frame.data?.payload ?? frame.data;
    console.log('engine.status frame bytes:', String(ev.data).length);
    console.log('engine count:', payload?.count, Object.keys(payload?.engines ?? {}).length);
    console.log('summary present:', payload?.summary != null, 'overall:', JSON.stringify(payload?.summary?.overall ?? null));
    console.log('brokers present:', payload?.brokers != null, 'list:', (payload?.brokers?.list ?? []).length);
    const per = Object.entries(payload?.engines ?? {}).map(([id, r]) => [id, String(JSON.stringify(r)).length]);
    per.sort((a, b) => b[1] - a[1]);
    console.log('largest engines:', per.slice(0, 8));
    process.exit(0);
  }
};

ws.onerror = (e) => {
  console.error('socket error', e?.message || e);
  process.exit(1);
};

setTimeout(() => {
  console.error('timeout: no engine.status frame');
  process.exit(1);
}, 25000);
