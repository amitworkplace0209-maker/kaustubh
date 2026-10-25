/**
 * RealtimeClient (lib/realtime-ws) unit tests against a fake WebSocket + fetch.
 *
 * Proves the master-task guarantees WITHOUT any live socket:
 *   - no token spam: unauth 401 -> AUTH_FAILED, no socket, no retry timer;
 *   - misconfig 502 -> bounded RECONNECTING retries (throttled logs) then
 *     ERROR + cooldown, never an endless warn loop that freezes the page;
 *   - single global socket: concurrent connect() -> one token fetch, one WS;
 *   - auth flow: 401 -> login -> connect() re-issued token and opens;
 *   - bounded backoff + ERROR after MAX_CONsecutive failures, no endless loop;
 *   - server 4401 close -> AUTH_FAILED (no reconnect storm).
 *
 * All scenarios run INSIDE one parent test, awaited strictly in order, so they
 * never touch each other's global overrides (fetch/WebSocket/setTimeout).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RealtimeClient } from '../lib/realtime-ws.ts';
import type { RealtimeLiveState } from '../lib/realtime-ws.ts';

let fetchCalls: string[] = [];
let tokenMode: 'ok' | 'unauth' | 'network' | 'misconfig' = 'ok';
let fastTimers = false;
let sockets: FakeWebSocket[] = [];
let scheduled: number[] = [];
let originalFetch: typeof globalThis.fetch;
let originalWebSocket: unknown;
let originalSetTimeout: typeof globalThis.setTimeout;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string | Blob }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, _reason?: string) {
    this.readyState = FakeWebSocket.CLOSING;
    if (this.onclose) this.onclose({ code });
  }
  open() {
    if (this.readyState === FakeWebSocket.OPEN) return;
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }
  frame(obj: unknown) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
}

async function fakeFetch(_url: string, _init?: unknown) {
  fetchCalls.push(String(_url));
  if (tokenMode === 'unauth') {
    return { status: 401, ok: false, json: async () => ({ ok: false }) } as Response;
  }
  if (tokenMode === 'network') {
    throw new Error('backend unreachable');
  }
  if (tokenMode === 'misconfig') {
    return { status: 502, ok: false, json: async () => ({ ok: false }) } as Response;
  }
  return {
    status: 200,
    ok: true,
    json: async () => ({ ok: true, token: 'test.jwt.token' }),
  } as Response;
}

function installGlobals() {
  originalSetTimeout = globalThis.setTimeout;
  globalThis.fetch = fakeFetch as typeof globalThis.fetch;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    const delay = ms ?? 0;
    scheduled.push(delay);
    if (fastTimers) {
      return originalSetTimeout(() => fn(...rest), 1) as unknown as number;
    }
    return originalSetTimeout(fn, delay, ...rest) as unknown as number;
  }) as typeof globalThis.setTimeout;
}

function restoreGlobals() {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket as typeof WebSocket;
  globalThis.setTimeout = originalSetTimeout;
}

function makeClient() {
  const c = new RealtimeClient();
  void c.onStateChange(() => {});
  return c;
}

const lastSocket = () => sockets.at(-1) as FakeWebSocket;
const lastSent = () => JSON.parse((lastSocket() as FakeWebSocket).sent.at(-1) as string) as {
  action: string;
  request_id: string;
  channels?: { channel: string; instruments?: { exchange_segment: string; instrument_token: string }[] }[];
};
const ack = (ws: FakeWebSocket, requestId: string, ok = true) =>
  ws.frame({
    type: 'subscription.ack',
    request_id: requestId,
    data: { ok, errors: ok ? [] : [{ error: 'nope' }], results: [] },
  });
const tokenFetchCount = () => fetchCalls.filter((u) => u.endsWith('/api/realtime/token')).length;

test('RealtimeClient behaviors', async (t) => {
  async function run(name: string, body: () => Promise<void>) {
    await t.test(name, async () => {
      fetchCalls = [];
      sockets = [];
      scheduled = [];
      tokenMode = 'ok';
      fastTimers = false;
      originalFetch = globalThis.fetch;
      originalWebSocket = globalThis.WebSocket;
      installGlobals();
      try {
        await body();
      } finally {
        restoreGlobals();
      }
    });
  }

  await run('401 -> AUTH_FAILED, no socket, no retry timer (no token spam)', async () => {
    tokenMode = 'unauth';
    const c = makeClient();
    try {
      const ok = await c.connect();
      assert.equal(ok, false);
      assert.equal(c.getState(), 'AUTH_FAILED');
      assert.match(c.getFailureReason(), /log in first/i);
      assert.equal(sockets.length, 0, 'no WebSocket must be created');
      assert.equal(scheduled.length, 0, 'no reconnect timer may be scheduled');
      assert.equal(tokenFetchCount(), 1, 'exactly ONE token fetch for the attempt');
    } finally {
      c.close();
    }
  });

  await run('misconfig 502 -> bounded RECONNECTING retries then ERROR (no endless spam)', async () => {
    tokenMode = 'misconfig';
    fastTimers = true;
    const c = makeClient();
    try {
      await c.connect();
      // First 502 parks in RECONNECTING (self-heals when the backend/creds
      // recover) with exactly one bounded backoff timer — never a socket, and
      // never an unthrottled warn loop (the page-freeze spam in prod logs).
      assert.equal(c.getState(), 'RECONNECTING');
      assert.match(c.getFailureReason(), /credentials/i);
      assert.equal(sockets.length, 0, 'no WebSocket must be created');
      assert.equal(scheduled.length, 1, 'exactly one bounded backoff timer per attempt');
      // Bounded: after MAX_CONSECUTIVE attempts it gives up into ERROR with a
      // cooldown instead of retrying (and warn-spamming) forever.
      const deadline = Date.now() + 5000;
      while (c.getState() !== 'ERROR' && Date.now() < deadline) {
        await new Promise((r) => originalSetTimeout(r, 5));
      }
      assert.equal(c.getState(), 'ERROR');
      assert.match(c.getFailureReason(), /consecutive/i);
    } finally {
      fastTimers = false;
      c.close();
    }
  });

  await run('auth gate: 401 must NOT trigger follow-up fetches while stuck', async () => {
    tokenMode = 'unauth';
    const c = makeClient();
    try {
      await c.connect();
      assert.equal(c.getState(), 'AUTH_FAILED');
      await new Promise((r) => originalSetTimeout(r, 250));
      assert.equal(tokenFetchCount(), 1, 'no fetches while AUTH_FAILED');
    } finally {
      c.close();
    }
  });

  await run('single socket: concurrent connect() -> one token fetch, one WebSocket', async () => {
    const c = makeClient();
    try {
      const [a, b] = await Promise.all([c.connect(), c.connect()]);
      assert.equal(a, true);
      assert.equal(b, true);
      assert.equal(tokenFetchCount(), 1);
      lastSocket().open();
      assert.equal(c.getState(), 'CONNECTED');
      assert.equal(c.isOpen(), true);
      assert.equal(sockets.length, 1, 'exactly ONE WebSocket for the session');
    } finally {
      c.close();
    }
  });

  await run('login recovery: AUTH_FAILED -> connect() after auth change opens a socket', async () => {
    tokenMode = 'unauth';
    const c = makeClient();
    try {
      await c.connect();
      assert.equal(c.getState(), 'AUTH_FAILED');
      tokenMode = 'ok';
      const ok = await c.connect();
      assert.equal(ok, true);
      lastSocket().open();
      assert.equal(c.getState(), 'CONNECTED');
    } finally {
      c.close();
    }
  });

  await run('welcome frame populates connectionId/username', async () => {
    const c = makeClient();
    try {
      await c.connect();
      lastSocket().open();
      lastSocket().frame({
        type: 'welcome',
        data: {
          connectionId: 'abc123',
          username: 'kaustubh',
          heartbeatIntervalS: 12,
          channels: {},
        },
      });
      assert.equal(c.getConnectionId(), 'abc123');
      assert.equal(c.getUsername(), 'kaustubh');
      assert.equal(c.getState(), 'CONNECTED');
    } finally {
      c.close();
    }
  });

  await run('spontaneous close -> RECONNECTING with bounded, jittered backoff', async () => {
    const c = makeClient();
    try {
      await c.connect();
      const ws = lastSocket();
      ws.open();
      ws.close(1006);
      assert.equal(c.getState(), 'RECONNECTING');
      assert.equal(scheduled.length, 1);
      const [delay] = scheduled;
      assert.ok(delay >= 1000, `delay ${delay} must respect the base backoff`);
      assert.ok(delay <= 15250, `delay ${delay} must not exceed MAX + jitter`);
    } finally {
      c.close();
    }
  });

  await run('server 4401 close -> AUTH_FAILED, no reconnect storms', async () => {
    const c = makeClient();
    try {
      await c.connect();
      lastSocket().open();
      lastSocket().close(4401);
      assert.equal(c.getState(), 'AUTH_FAILED');
      assert.match(c.getFailureReason(), /revoked/i);
      assert.equal(scheduled.length, 0, 'auth-closed sockets never schedule retries');
    } finally {
      c.close();
    }
  });

  await run('transient network failures give up into ERROR after the bounded max', async () => {
    const c = makeClient();
    fastTimers = true;
    try {
      await c.connect();
      lastSocket().open();
      tokenMode = 'network';
      lastSocket().close(1006);
      const deadline = Date.now() + 3000;
      while (c.getState() !== 'ERROR' && Date.now() < deadline) {
        await new Promise((r) => originalSetTimeout(r, 5));
      }
      assert.equal(c.getState(), 'ERROR');
      assert.match(c.getFailureReason(), /consecutive/i);
      assert.ok(scheduled.length > 0, 'bounded backoff ran before giving up');
    } finally {
      fastTimers = false;
      c.close();
    }
  });

  await run('close() clears timers and lands DISCONNECTED', async () => {
    const c = makeClient();
    try {
      await c.connect();
      lastSocket().open();
      c.close();
      assert.equal(c.getState(), 'DISCONNECTED');
      assert.equal(c.isOpen(), false);
    } finally {
      c.close();
    }
  });

  await run('state-channel subscribe sends the instrument-less spec verbatim', async () => {
    const c = makeClient();
    try {
      await c.connect();
      lastSocket().open();
      const sub = c.subscribe([{ channel: 'market_watch' }], 'req-state');
      // delta computed synchronously -> one message, then ack it
      const msg = lastSent();
      assert.equal(msg.action, 'subscribe');
      assert.equal(msg.channels?.length, 1);
      assert.equal(msg.channels?.[0]?.channel, 'market_watch');
      assert.equal('instruments' in (msg.channels?.[0] ?? {}), false, 'state spec must carry no instruments');
      ack(lastSocket(), 'req-state');
      const res = await sub;
      assert.equal(res.ok, true);
      // Re-subscribing the same state channel must NOT re-send the spec.
      const sub2 = c.subscribe([{ channel: 'market_watch' }], 'req-state2');
      const sent2 = lastSent();
      assert.equal(sent2.request_id, 'req-state', 'no new message when already subscribed');
      ack(lastSocket(), 'req-state2');
      const res2 = await sub2;
      assert.equal(res2.ok, true);
    } finally {
      c.close();
    }
  });

  await run('instrument subscribe merges with the state subscription via one delta', async () => {
    const c = makeClient();
    try {
      await c.connect();
      lastSocket().open();
      const s1 = c.subscribe([{ channel: 'market_watch' }], 'r-s');
      ack(lastSocket(), 'r-s');
      await s1;

      const s2 = c.subscribe(
        [{ channel: 'market_watch', instruments: [{ exchange_segment: 'nse_cm', instrument_token: '1' }] }],
        'r-i',
      );
      const msg = lastSent();
      assert.equal(msg.channels?.length, 1, 'only the token delta is sent');
      assert.equal(msg.channels?.[0]?.channel, 'market_watch');
      assert.deepEqual(msg.channels?.[0]?.instruments, [
        { exchange_segment: 'nse_cm', instrument_token: '1' },
      ]);
      ack(lastSocket(), 'r-i');
      const res = await s2;
      assert.equal(res.ok, true);

      // Idempotent: re-subscribing the same token sends nothing new.
      const s3 = c.subscribe(
        [{ channel: 'market_watch', instruments: [{ exchange_segment: 'nse_cm', instrument_token: '1' }] }],
        'r-i2',
      );
      const msg3 = lastSent();
      assert.equal(msg3.request_id, 'r-i', 'no duplicate token request');
      ack(lastSocket(), 'r-i2');
      await s3;
    } finally {
      c.close();
    }
  });

  await run('unsubscribe removes the state channel but keeps market tokens independent', async () => {
    const c = makeClient();
    try {
      await c.connect();
      lastSocket().open();
      const s1 = c.subscribe([{ channel: 'market_watch' }], 'r-a');
      ack(lastSocket(), 'r-a');
      await s1;

      // Removing the state channel lets the next state subscribe re-send it.
      const u = c.unsubscribe([{ channel: 'market_watch' }], 'r-u');
      ack(lastSocket(), 'r-u');
      await u;
      const s2 = c.subscribe([{ channel: 'market_watch' }], 'r-b');
      const msg = lastSent();
      assert.equal(msg.channels?.length, 1);
      assert.equal(msg.channels?.[0]?.channel, 'market_watch');
      assert.equal('instruments' in (msg.channels?.[0] ?? {}), false);
      ack(lastSocket(), 'r-b');
      await s2;
    } finally {
      c.close();
    }
  });

  await run('destroy clears subscriptions so a fresh subscribe re-sends state', async () => {
    const c = makeClient();
    try {
      await c.connect();
      lastSocket().open();
      const s1 = c.subscribe([{ channel: 'market_watch' }], 'r-c');
      ack(lastSocket(), 'r-c');
      await s1;
      c.destroy();
      // destroy closes the socket; a new connect + subscribe must re-send state.
      const ok = await c.connect();
      assert.equal(ok, true);
      lastSocket().open();
      const s2 = c.subscribe([{ channel: 'market_watch' }], 'r-d');
      const msg = lastSent();
      assert.equal(msg.channels?.length, 1);
      assert.equal(msg.channels?.[0]?.channel, 'market_watch');
      ack(lastSocket(), 'r-d');
      await s2;
    } finally {
      c.close();
    }
  });

  await run('state names always belong to the canonical set', async () => {
    const allowed = new Set<RealtimeLiveState>([
      'DISCONNECTED',
      'CONNECTING',
      'CONNECTED',
      'RECONNECTING',
      'AUTHENTICATING',
      'AUTH_FAILED',
      'ERROR',
    ]);
    const c = makeClient();
    assert.ok(allowed.has(c.getState()), `unexpected initial state ${c.getState()}`);
    c.close();
  });
});