// ---- Theme scope independence test ----
//
// Simulates the browser localStorage contract exercised by the canonical
// theme store to PROVE that each phase/terminal keeps an independent theme
// and that applying a theme to one scope never leaks into another.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage mock (in-memory Map).
const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

// Mock browser globals before importing the engine.
(globalThis as any).window = {
  localStorage: storage,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  addEventListener: () => {},
};
(globalThis as any).document = {
  documentElement: {
    setAttribute: () => {},
    removeAttribute: () => {},
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
  },
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: () => {} },
};

import { getPhase2ThemeStore, storageKeyForApp } from '../lib/phase2-theme.ts';

function snapshot(key: string) {
  const raw = storage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

test('each scope has an isolated persisted theme snapshot', () => {
  const storeNS = getPhase2ThemeStore();

  // Context 1: Data Saver -> Forest Whisper
  storeNS.setCurrentApp('data-saver', null);
  storeNS.setTheme('data-saver', 'forest-whisper');
  storeNS.setBrightness('data-saver', 'light');

  // Context 2: Trading Dummy -> Cyberpunk (dark)
  storeNS.setCurrentApp('trading', 'dummy');
  storeNS.setTheme('trading', 'cyberpunk');
  storeNS.setBrightness('trading', 'dark');

  // Context 3: Trading Kotak -> Golden Hour (light, saffron accent)
  storeNS.setCurrentApp('trading', 'kotak-neo');
  storeNS.setTheme('trading', 'golden-hour');
  storeNS.setBrightness('trading', 'light');

  // Context 4: Trading Shoonya -> Oceanic Wave (dark)
  storeNS.setCurrentApp('trading', 'shoonya');
  storeNS.setTheme('trading', 'oceanic-wave');
  storeNS.setBrightness('trading', 'dark');

  const dsKey = storageKeyForApp('data-saver');
  const dummyKey = storageKeyForApp('trading', 'dummy');
  const kotakKey = storageKeyForApp('trading', 'kotak-neo');
  const shoonyaKey = storageKeyForApp('trading', 'shoonya');

  // Each must have its own persisted value...
  const ds = snapshot(dsKey);
  const dummy = snapshot(dummyKey);
  const kotak = snapshot(kotakKey);
  const shoonya = snapshot(shoonyaKey);
  assert.ok(ds, 'data-saver should be persisted');
  assert.ok(dummy, 'dummy should be persisted');
  assert.ok(kotak, 'kotak should be persisted');
  assert.ok(shoonya, 'shoonya should be persisted');

  // ...and the values must match exactly what each context chose.
  assert.equal(ds.themeId, 'forest-whisper');
  assert.equal(ds.brightness, 'light');
  assert.equal(dummy.themeId, 'cyberpunk');
  assert.equal(dummy.brightness, 'dark');
  assert.equal(kotak.themeId, 'golden-hour');
  assert.equal(kotak.brightness, 'light');
  assert.equal(shoonya.themeId, 'oceanic-wave');
  assert.equal(shoonya.brightness, 'dark');

  // No cross-contamination: reading one scope returns exactly its value.
  storeNS.setCurrentApp('trading', 'dummy');
  assert.equal(storeNS.getState().themeId, 'cyberpunk');
  storeNS.setCurrentApp('trading', 'kotak-neo');
  assert.equal(storeNS.getState().themeId, 'golden-hour');
  storeNS.setCurrentApp('trading', 'shoonya');
  assert.equal(storeNS.getState().themeId, 'oceanic-wave');
  storeNS.setCurrentApp('data-saver', null);
  assert.equal(storeNS.getState().themeId, 'forest-whisper');
});