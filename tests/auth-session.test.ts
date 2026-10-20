// ---- App session token signing — pure unit tests ----
//
// The `kaustubh_session` cookie used to be a bare base64 JSON blob, so anyone
// could hand-craft `{"authenticated":true,"exp":<future>}` and pass every
// session check — including the realtime token proxy, which is the gate to the
// backend's authenticated WebSocket. The payload is now HMAC-signed with a
// server-only secret and MUST be checked through `verifySessionToken`.
//
// These tests pin the security property: only tokens this server minted verify.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minting and verification share one in-process secret (env `APP_SESSION_SECRET`
// if set, else the gitignored `.auth/session-secret`), so these tests are valid
// regardless of which source the running app uses.
import { createSessionToken, verifySessionToken, SESSION_TTL_MS } from '../lib/auth-crypto.ts';

/** Reproduce the old forgeable cookie: base64 JSON with no signature. */
function forgeCookie(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

test('a freshly minted session verifies', () => {
  const token = createSessionToken();
  const payload = verifySessionToken(token);
  assert.ok(payload);
  assert.equal(payload.authenticated, true);
  assert.ok(payload.exp > Date.now());
});

test('the forged base64-only cookie is rejected', () => {
  // Exactly the payload an attacker would hand-craft.
  const forged = forgeCookie({
    authenticated: true,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  });
  assert.equal(verifySessionToken(forged), null);
});

test('a tampered payload is rejected', () => {
  const token = createSessionToken();
  const [encoded, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  decoded.exp = decoded.exp + 10 * SESSION_TTL_MS; // extend the session
  const tampered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
  assert.equal(verifySessionToken(tampered), null);
});

test('a stripped signature is rejected', () => {
  const token = createSessionToken();
  assert.equal(verifySessionToken(token.split('.')[0]), null);
  assert.equal(verifySessionToken(`${token}.extra`), null);
});

test('an expired session is rejected', () => {
  const expired = forgeCookie({ authenticated: true, iat: 1, exp: Date.now() - 1000 });
  assert.equal(verifySessionToken(expired), null);
  assert.equal(verifySessionToken(createSessionToken().replace(/^[^.]+/, 'garbage')), null);
});

test('missing and malformed values are rejected', () => {
  for (const value of [undefined, null, '', 'not-a-token', 'a.b.c.d', '...']) {
    assert.equal(verifySessionToken(value), null);
  }
});

test('authenticated must be exactly true', () => {
  const token = createSessionToken();
  const [encoded, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  decoded.authenticated = 'true';
  const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
  assert.equal(verifySessionToken(forged), null);
});
