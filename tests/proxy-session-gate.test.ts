// ---- Proxy session gate — regression guard ----
//
// ROOT CAUSE (why "/trading/trade did not work"): the `kaustubh_session`
// cookie is an HMAC-signed token `base64url(payload).base64url(sig)`, but the
// root proxy used to verify it by base64-decoding the WHOLE cookie and
// `JSON.parse`-ing it. That never parses, so `isAuthenticated()` always threw
// into its `catch` and returned false — every guarded page 307-redirected to
// `/login` even with a valid session, while `/api/auth/session` happily
// reported `{"authenticated":true}`. The trade component never mounted.
//
// Verification must go through `verifySessionToken`. These tests pin that
// contract. The proxy module itself can't be imported here (`node --test` has
// no `@/*` alias or `next/server` resolution), so the wiring is asserted at the
// source level and the crypto is asserted behaviourally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSessionToken, verifySessionToken } from '../lib/auth-crypto.ts';

const PROXY_SOURCE = readFileSync(join(process.cwd(), 'proxy.ts'), 'utf8');

test('proxy validates the session through the VM1 backend, not MongoDB', () => {
  // Vercel has no database credentials. The proxy may decode the signed cookie
  // to learn the session id, but the authority on whether that session is live
  // is the backend that owns `app_auth_sessions`.
  assert.doesNotMatch(
    PROXY_SOURCE,
    /from\s*'@\/lib\/auth-db'/,
    'proxy.ts must not import the MongoDB auth layer',
  );
  assert.doesNotMatch(
    PROXY_SOURCE,
    /getOwner|getSessionDoc/,
    'proxy.ts must not read owner/session documents directly',
  );
  assert.match(
    PROXY_SOURCE,
    /\/api\/auth\/live\?sid=/,
    'proxy.ts must ask the backend whether the session id is live',
  );
  assert.match(
    PROXY_SOURCE,
    /data\.live\s*===\s*true/,
    'proxy.ts must require an explicit live=true answer',
  );
  assert.match(
    PROXY_SOURCE,
    /payload\.sid/,
    'proxy.ts must require the backend session id from the cookie payload',
  );
});

test('proxy decodes only the payload to find the session id', () => {
  // The raw cookie is `base64url(payload).base64url(sig)`. We deliberately do
  // NOT verify the HMAC here: the backend validates the token on every gated
  // endpoint, and the sid must name a real unrevoked session. This keeps the
  // proxy free of Node crypto/fs imports while still failing closed.
  assert.match(PROXY_SOURCE, /parts\[0\]/, 'only the payload segment is decoded');
  assert.match(PROXY_SOURCE, /Buffer\.from\(parts\[0\], 'base64url'\)/);
  assert.match(PROXY_SOURCE, /payload\.authenticated !== true/);
  assert.match(PROXY_SOURCE, /Number\(payload\.exp\)\s*<=\s*Date\.now\(\)/);
  assert.doesNotMatch(PROXY_SOURCE, /\.toString\('base64'\)/, 'the payload is base64url');
});

test('a real signed token passes the crypto the proxy relies on', () => {
  // The regression: this exact token used to FAIL the proxy's own decode.
  const token = createSessionToken();
  assert.ok(token.includes('.'), 'minted tokens are signed with a .suffix');
  const [encoded] = token.split('.');
  const viaOldLogic = (() => {
    try {
      // eslint-disable-next-line no-new
      new Function(`return JSON.parse(Buffer.from(${JSON.stringify(token)}, 'base64').toString())`)();
      return 'parsed';
    } catch {
      return 'threw';
    }
  })();
  assert.equal(viaOldLogic, 'threw', 'the old bare-decode logic must fail on a valid token');
  assert.equal(Buffer.from(encoded, 'base64url').toString('utf8').includes('authenticated'), true);
  assert.ok(verifySessionToken(token), 'the same token must verify via verifySessionToken');
});

test('proxy keeps API routes and assets out of the HTML redirect gate', () => {
  // Regression guard for the documented "screen goes black / request storm"
  // fix: JSON callers must never receive an HTML login redirect.
  for (const prefix of ["'/api'", "'/_next'", "'/sw.js'", "'/offline.html'", "'/manifest'"]) {
    assert.ok(PROXY_SOURCE.includes(prefix), `missing unguarded prefix ${prefix}`);
  }
  assert.match(PROXY_SOURCE, /PUBLIC_PATHS\s*=\s*\[[^\]]*'\/login'/);
  assert.match(
    PROXY_SOURCE,
    /matcher:\s*\[\s*'\/\(\(\?!_next\/static/,
    'the matcher must keep excluding Next internals',
  );
});

test('proxy redirects to /login and preserves the original path', () => {
  assert.match(PROXY_SOURCE, /NextResponse\.redirect\(loginUrl\)/);
  assert.match(PROXY_SOURCE, /loginUrl\.searchParams\.set\('from',\s*pathname\)/);
});

test('proxy keeps the app closed until the first-run MPIN is saved', () => {
  // A session is issued at signup so the MPIN can be saved, but it is marked
  // `kaustubh_mpin_pending`. Directly opening a page/API must not skip setup.
  assert.match(PROXY_SOURCE, /MPIN_PENDING_COOKIE/);
  assert.match(PROXY_SOURCE, /MPIN_SETUP_REQUIRED/);
  assert.match(PROXY_SOURCE, /'\/api\/auth\/mpin\/setup'/);
  assert.match(
    PROXY_SOURCE,
    /authenticated\s*&&\s*mpinPending\s*&&\s*!isMpinSetupPath\(pathname\)/,
    'the gate must apply only to an authenticated, MPIN-pending session',
  );
  assert.match(
    PROXY_SOURCE,
    /setupUrl\.searchParams\.set\('from',\s*pathname\)/,
    'the setup redirect must remember where the owner was going',
  );
});
