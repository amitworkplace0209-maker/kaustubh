// ---- Trading session hydration — regression guard ----
//
// ROOT CAUSE (why a real terminal could never place an order):
//   * the broker surface (`/api/terminal/connect|order|modify|cancel`) is
//     JWT-gated;
//   * `lib/terminal-service` holds that JWT in memory only;
//   * the ONLY code path that minted it was `loginWithPassword`, called from
//     `components/orders/trade/auth-gate.tsx` — a card that was never mounted;
//   * so after every reload a non-Dummy terminal rendered "No session" and
//     RISK LOCKED, the ticket had no session to submit with, and the history
//     row actions were disabled forever.
//
// The fix hands the browser the backend operator JWT through a cookie-gated
// same-origin route (`app/api/auth/trading-token`), reusing the exact operator
// login the Next layer already performs server-side for the realtime gateway
// token. These guards pin the security-relevant invariants of that handoff.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

const ROUTE = read('app/api/auth/trading-token/route.ts');
const OPERATOR = read('lib/backend-operator.ts');
const REALTIME_ROUTE = read('app/api/realtime/token/route.ts');
const SERVICE = read('lib/terminal-service.ts');
const TRADE = read('components/trading/trade-page.tsx');
const HISTORY = read('components/orders/history/history-page.tsx');

test('the JWT handoff is cookie-gated before it mints anything', () => {
  // Same HMAC cookie check as the proxy gate — an unauthenticated caller must
  // never reach the operator login.
  const gateIdx = ROUTE.indexOf('verifySessionToken');
  const loginIdx = ROUTE.indexOf('acquireOperatorJwt()');
  assert.ok(gateIdx >= 0, 'the route must verify the session cookie');
  assert.ok(loginIdx > gateIdx, 'the session cookie must be verified BEFORE the operator login');
  assert.match(ROUTE, /status: 401/, 'a missing/invalid session must answer 401');
});

/** Structural assertions run against code with comments removed (the file's
 *  own documentation legitimately mentions the password it must never ship). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

test('the handoff never ships the configured password to the browser', () => {
  const code = stripComments(ROUTE);
  // The route may NAME the env vars in an operator-facing error string, but it
  // must never read them — the credentials stay inside lib/backend-operator.
  assert.doesNotMatch(code, /process\.env\./, 'the route must not read env secrets directly');
  assert.doesNotMatch(code, /env\.APP_PASSWORD/, 'the route must not read the password env');
  assert.doesNotMatch(code, /\.password/, 'no password value may be read or returned by the route');
  // The helper that DOES read it lives server-side and returns only the JWT.
  const op = stripComments(OPERATOR);
  assert.match(op, /export function operatorCredentials/);
  assert.match(op, /export async function acquireOperatorJwt/);
  assert.doesNotMatch(op, /localStorage|sessionStorage/);
});

test('the operator JWT cache is shared, not duplicated per route', () => {
  for (const src of [ROUTE, REALTIME_ROUTE]) {
    assert.ok(src.includes('acquireOperatorJwt'), 'both routes must use the shared operator login');
    assert.ok(!src.includes('let cachedOperatorJwt'), 'only lib/backend-operator may cache the operator JWT');
  }
  assert.match(OPERATOR, /export async function acquireOperatorJwt/);
  assert.match(OPERATOR, /let cachedOperatorJwt/);
});

test('the browser keeps the token in memory only', () => {
  assert.match(SERVICE, /export async function ensureTerminalAuth\(\): Promise<boolean>/);
  assert.match(SERVICE, /fetch\('\/api\/auth\/trading-token'/);
  assert.match(SERVICE, /setAuthToken\(token\)/, 'the hydrated token goes through the in-memory setter');
  assert.doesNotMatch(SERVICE, /localStorage|sessionStorage/, 'the JWT must never be persisted to storage');
});

test('both session-gated pages hydrate and fall back honestly', () => {
  // Trade: hydrate, and when the app layer cannot mint a JWT the explicit
  // sign-in card is shown instead of a ticket that cannot submit.
  assert.match(TRADE, /ensureTerminalAuth\(\)/);
  assert.match(TRADE, /<AuthGate terminal=\{terminal\} onAuthenticated=\{\(\) => setLoggedIn\(true\)\} \/>/);
  // While the hydration is in flight the precheck says so, instead of
  // flashing a LOCKED verdict on every load.
  assert.match(TRADE, /Connecting trading session/);
  // History: cancel/modify re-enable themselves once the session is hydrated.
  assert.match(HISTORY, /ensureTerminalAuth\(\)/);
  assert.match(HISTORY, /disabled=\{!loggedIn \|\| Boolean\(busy\[r\.orderId\]\?\.cancelling/);
});
