// ---- Public WebSocket URL contract ----
//
// Self-hosted deploys tunnel /ws/* through server.mjs (same-origin). Vercel
// cannot hold a socket, so it may point the browser at the public tunnel with
// NEXT_PUBLIC_WS_URL. That override must be a real ws(s) URL; anything else
// falls back honestly instead of producing a dead socket.

import assert from 'node:assert/strict';
import test from 'node:test';

import { realtimeSocketUrl } from '../lib/api-base.ts';

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('an explicit wss tunnel URL is used verbatim on serverless', () => {
  withEnv(
    {
      NEXT_PUBLIC_WS_URL: 'wss://kds-test.trycloudflare.com/ws/realtime',
      BACKEND_URL: 'http://127.0.0.1:8000',
      WS_BACKEND_URL: undefined,
    },
    () => {
      assert.equal(realtimeSocketUrl(), 'wss://kds-test.trycloudflare.com/ws/realtime');
    },
  );
});

test('an invalid or non-websocket override is ignored', () => {
  withEnv(
    {
      NEXT_PUBLIC_WS_URL: 'https://not-a-socket.example.com/ws/realtime',
      BACKEND_URL: 'https://backend.example.com',
      WS_BACKEND_URL: undefined,
    },
    () => {
      assert.equal(realtimeSocketUrl(), 'wss://backend.example.com/ws/realtime');
    },
  );
});

test('without an override the backend origin is converted to ws(s)', () => {
  withEnv(
    {
      NEXT_PUBLIC_WS_URL: undefined,
      BACKEND_URL: 'http://10.1.1.133:8000',
      WS_BACKEND_URL: undefined,
    },
    () => {
      assert.equal(realtimeSocketUrl(), 'ws://10.1.1.133:8000/ws/realtime');
    },
  );
});

test('WS_BACKEND_URL wins over BACKEND_URL when no public override exists', () => {
  withEnv(
    {
      NEXT_PUBLIC_WS_URL: undefined,
      BACKEND_URL: 'http://127.0.0.1:8000',
      WS_BACKEND_URL: 'https://ws.example.com',
    },
    () => {
      assert.equal(realtimeSocketUrl(), 'wss://ws.example.com/ws/realtime');
    },
  );
});
