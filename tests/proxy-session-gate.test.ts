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

test('proxy verifies the session through verifySessionToken', () => {
  assert.match(
    PROXY_SOURCE,
    /import\s*\{\s*verifySessionToken\s*\}\s*from\s*'@\/lib\/auth-crypto'/,
    'proxy.ts must import verifySessionToken from @/lib/auth-crypto',
  );
  assert.match(
    PROXY_SOURCE,
    /verifySessionToken\(\s*request\.cookies\.get\(SESSION_COOKIE\)\?\.value\s*\)/,
    'isAuthenticated must delegate to verifySessionToken with the raw cookie',
  );
});

test('proxy no longer base64-decodes the cookie itself', () => {
  // The exact anti-pattern that caused the outage. Base64url decoding must only
  // ever happen inside auth-crypto, never on the raw cookie in the proxy.
  assert.doesNotMatch(
    PROXY_SOURCE,
    /Buffer\.from\(\s*sessionCookie\.value/,
    'proxy.ts must not base64-decode the raw session cookie',
  );
  assert.doesNotMatch(
    PROXY_SOURCE,
    /JSON\.parse\(\s*Buffer\.from\(/,
    'proxy.ts must not hand-parse the session payload',
  );
  assert.doesNotMatch(
    PROXY_SOURCE,
    /\.toString\('base64'\)/,
    "proxy.ts must not use standard 'base64' (the payload is base64url)",
  );
  assert.doesNotMatch(
    PROXY_SOURCE,
    /Date\.now\(\)\s*>\s*payload\.exp/,
    'proxy.ts must not re-implement expiry checking; verifySessionToken does it',
  );
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
