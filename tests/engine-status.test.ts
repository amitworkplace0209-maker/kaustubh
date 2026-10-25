// Engine status payload normalisation — pure unit tests.
//
// The trade/status UI must show the same engine count from either source:
//   - WS#2 `engine.status` frames: `data.engines` keyed by engineId
//   - GET /api/services/engines:  { ok, data: [ { engineId, ... } ] }
// A malformed payload must stay unknown, never become a fake 0 or 4.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEngineStatusPayload } from '../lib/engine-status.ts';

test('REST list is keyed by engineId', () => {
  const map = normalizeEngineStatusPayload([
    { engineId: 'risk_engine', state: 'RUNNING', health: 'HEALTHY' },
    { engineId: 'order_engine', state: 'RUNNING', health: 'HEALTHY' },
  ]);
  assert.deepEqual(Object.keys(map ?? {}).sort(), ['order_engine', 'risk_engine']);
  assert.equal(map?.risk_engine.state, 'RUNNING');
});

test('engine_id and id fallbacks are accepted', () => {
  const map = normalizeEngineStatusPayload([
    { engine_id: 'storage_engine', state: 'RUNNING' },
    { id: 'search_engine', state: 'RUNNING' },
  ]);
  assert.equal(map?.storage_engine.state, 'RUNNING');
  assert.equal(map?.search_engine.state, 'RUNNING');
});

test('malformed rows and blank ids are skipped', () => {
  const map = normalizeEngineStatusPayload([
    null,
    'nope',
    { state: 'RUNNING' },
    { engineId: '   ' },
    { engineId: 'order_engine', state: 'RUNNING' },
  ]);
  assert.deepEqual(Object.keys(map ?? {}), ['order_engine']);
});

test('realtime map passes through', () => {
  const map = normalizeEngineStatusPayload({
    risk_engine: { state: 'REGISTERED', health: 'UNKNOWN' },
    order_engine: { state: 'RUNNING', health: 'HEALTHY' },
  });
  assert.equal(map?.risk_engine.health, 'UNKNOWN');
  assert.equal(Object.keys(map ?? {}).length, 2);
});

test('engine_snapshot envelope is unwrapped', () => {
  const map = normalizeEngineStatusPayload({
    type: 'engine_snapshot',
    count: 1,
    engines: { order_engine: { state: 'RUNNING', health: 'HEALTHY' } },
  });
  assert.deepEqual(Object.keys(map ?? {}), ['order_engine']);
});

test('unrelated envelopes stay unknown instead of becoming an empty map', () => {
  assert.equal(normalizeEngineStatusPayload({ ok: true, data: [] }), null);
  assert.equal(normalizeEngineStatusPayload({ ok: false, error: 'backend down' }), null);
});

test('non-object payloads stay unknown', () => {
  assert.equal(normalizeEngineStatusPayload(null), null);
  assert.equal(normalizeEngineStatusPayload(undefined), null);
  assert.equal(normalizeEngineStatusPayload('RUNNING'), null);
  assert.equal(normalizeEngineStatusPayload(42), null);
});

test('an explicitly empty list is a real zero, not unknown', () => {
  assert.deepEqual(normalizeEngineStatusPayload([]), {});
  assert.deepEqual(normalizeEngineStatusPayload({}), {});
});
