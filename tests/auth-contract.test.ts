// ---- Frontend <-> VM1 auth contract guard ----
//
// The Vercel routes are thin proxies over python-service/api/auth_app.py. A
// route/path or envelope mismatch is invisible to TypeScript (the payload is
// `unknown`), so these tests pin the three things that actually broke auth:
//   1. every browser route points at a REAL backend method+path,
//   2. cookies/IP headers survive the proxy (session + rate limiting), and
//   3. the backend's wrapped `{"detail": ...}` error is flattened so the login
//      page can render `message` / `code` / `database:false`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeAuthPayload } from '../lib/auth-payload.ts';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

const AUTH_PROXY = read('lib/auth-proxy.ts');
const LOGIN_PAGE = read('app/login/page.tsx');
const BACKEND = read('python-service/api/auth_app.py');

const BROWSER_ROUTES: Array<{
  file: string;
  method: 'GET' | 'POST';
  backend: string;
}> = [
  { file: 'app/api/auth/status/route.ts', method: 'GET', backend: '/api/auth/status' },
  { file: 'app/api/auth/session/route.ts', method: 'GET', backend: '/api/auth/session' },
  { file: 'app/api/auth/signup/route.ts', method: 'POST', backend: '/api/auth/signup' },
  { file: 'app/api/auth/login/route.ts', method: 'POST', backend: '/api/auth/login' },
  { file: 'app/api/auth/login/verify-otp/route.ts', method: 'POST', backend: '/api/auth/login/verify-otp' },
  { file: 'app/api/auth/logout/route.ts', method: 'POST', backend: '/api/auth/session/revoke' },
  { file: 'app/api/auth/mpin/setup/route.ts', method: 'POST', backend: '/api/auth/mpin/setup' },
  { file: 'app/api/auth/mpin/verify/route.ts', method: 'POST', backend: '/api/auth/mpin/verify' },
];

test('every browser auth route proxies to a real VM1 method + path', () => {
  for (const route of BROWSER_ROUTES) {
    const source = read(route.file);
    assert.match(
      source,
      new RegExp(`export async function ${route.method}\\b`),
      `${route.file} must export ${route.method}`,
    );
    assert.ok(
      source.includes(`'${route.backend}'`),
      `${route.file} must proxy to ${route.backend}`,
    );
  }

  // The backend decorators are the other half of the contract.
  for (const route of BROWSER_ROUTES) {
    const suffix = route.backend.replace('/api/auth', '');
    assert.match(
      BACKEND,
      new RegExp(`@router\\.${route.method.toLowerCase()}\\("${suffix}"\\)`),
      `auth_app.py must define ${route.method} ${route.backend}`,
    );
  }
});

test('trading/realtime tokens are minted from the VM1 app session', () => {
  // Vercel must not need a copy of APP_PASSWORD. Both token routes first ask
  // VM1 to exchange the validated app session for the operator JWT.
  assert.match(BACKEND, /@router\.post\("\/operator-token"\)/);
  assert.match(BACKEND, /await require_session\(request, require_mpin=True\)/);

  for (const file of [
    'app/api/auth/trading-token/route.ts',
    'app/api/realtime/token/route.ts',
  ]) {
    const source = read(file);
    assert.ok(
      source.includes("'/api/auth/operator-token'"),
      `${file} must mint from the VM1 session`,
    );
    assert.match(source, /requireBackendSession/);
  }

  const trading = read('app/api/auth/trading-token/route.ts');
  assert.match(trading, /requireBackendSession\(request, \{ requireMpin: true \}\)/);
});

test('the proxy forwards cookies, client IP and Set-Cookie', () => {
  assert.match(AUTH_PROXY, /headers\.set\('cookie', cookie\)/);
  for (const header of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'x-forwarded-proto']) {
    assert.ok(AUTH_PROXY.includes(`'${header}'`), `missing forwarded header ${header}`);
  }
  assert.match(AUTH_PROXY, /appendSetCookies\(out, response\)/);
  assert.match(AUTH_PROXY, /target\.headers\.append\('Set-Cookie', cookie\)/);
});

test('the proxy does not invent success when the backend is unreachable', () => {
  assert.match(AUTH_PROXY, /code: 'BACKEND_UNAVAILABLE'/);
  assert.match(AUTH_PROXY, /503/);
  assert.doesNotMatch(AUTH_PROXY, /authenticated:\s*true/);
});

test('the wrapped backend 503 is flattened to the shape the login page reads', () => {
  const wrapped = {
    ok: false,
    detail: {
      ok: false,
      message: 'The auth database is unavailable: Mongo is not configured.',
      error: 'The auth database is unavailable: Mongo is not configured.',
      database: false,
    },
  };
  const flat = normalizeAuthPayload(wrapped) as Record<string, unknown>;
  assert.equal(flat.ok, false);
  assert.equal(flat.database, false);
  assert.match(String(flat.message), /auth database is unavailable/i);
  assert.equal('detail' in flat, false);

  // The login page's retry state keys off these exact top-level fields.
  assert.match(LOGIN_PAGE, /payload\.database === false/);
  assert.match(LOGIN_PAGE, /data\.message/);
  assert.match(LOGIN_PAGE, /data\.code === 'OWNER_EXISTS'/);
});

test('success payloads and string validation details are not rewritten', () => {
  const ok = { ok: true, hasOwner: true, detail: 'owner exists' };
  assert.deepEqual(normalizeAuthPayload(ok), ok);

  const validation = { ok: false, detail: 'field required' };
  assert.deepEqual(normalizeAuthPayload(validation), validation);

  assert.deepEqual(normalizeAuthPayload(null), null);
  assert.deepEqual(normalizeAuthPayload([1, 2]), [1, 2]);
});
