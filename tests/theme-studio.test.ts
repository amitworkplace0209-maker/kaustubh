// ---- Universal Theme Studio engine tests ----
//
// Verifies the canonical theme engine:
//   - >50 polished presets across multi + single color families
//   - single-color themes for the 13 required colors
//   - per-scope storage keys keep each terminal/phase independent
//   - custom themes + favorites persist per scope (never shared)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  THEME_REGISTRY,
  MULTI_COLOR_THEMES,
  SINGLE_COLOR_THEMES,
  TOTAL_THEME_COUNT,
  storageKeyForApp,
  getThemeById,
  DEFAULT_ADVANCED,
  ACCENT_PRESETS,
  resolveSystemBrightness,
} from '../lib/phase2-theme.ts';

test('registry ships 50+ quality presets', () => {
  assert.ok(TOTAL_THEME_COUNT >= 50, `expected >=50 presets, got ${TOTAL_THEME_COUNT}`);
  assert.ok(MULTI_COLOR_THEMES.length >= 28, 'expected >=28 multi-color themes');
  assert.ok(SINGLE_COLOR_THEMES.length >= 22, 'expected >=22 single-color themes');
});

test('required single-color themes exist for the 13 mandated colors', () => {
  const required = ['saffron', 'blue', 'green', 'purple', 'red', 'teal', 'cyan', 'indigo', 'violet', 'emerald', 'amber', 'rose', 'orange'];
  const ids = new Set(THEME_REGISTRY.map((t) => t.id));
  for (const req of required) {
    assert.ok(ids.has(req), `missing single-color theme: ${req}`);
  }
});

test('requested multi-color pairings are present', () => {
  const required = ['saffron-blue', 'blue-cyan', 'purple-pink', 'green-teal', 'orange-red', 'blue-violet', 'teal-emerald', 'amber-purple', 'rose-orange', 'cyan-indigo'];
  const ids = new Set(THEME_REGISTRY.map((t) => t.id));
  for (const req of required) {
    assert.ok(ids.has(req), `missing multi-color theme: ${req}`);
  }
});

test('every requested flagship preset exists', () => {
  const ids = new Set(THEME_REGISTRY.map((t) => t.id));
  for (const req of ['aurora-dream', 'sunset-glow', 'oceanic-wave', 'royal-purple', 'cyberpunk', 'forest-whisper', 'candy-pop', 'warm-coffee', 'nordic-blue', 'crimson-edge', 'synthwave', 'golden-hour']) {
    assert.ok(ids.has(req), `missing flagship preset: ${req}`);
  }
});

test('every theme has a name, swatches and a type', () => {
  for (const t of THEME_REGISTRY) {
    assert.ok(t.name.length > 0, `theme ${t.id} missing name`);
    assert.ok(t.swatches.length > 0, `theme ${t.id} missing swatches`);
    assert.ok(t.type === 'multi' || t.type === 'single', `theme ${t.id} has invalid type`);
    assert.ok(getThemeById(t.id), `getThemeById("${t.id}") should return the theme`);
  }
});

test('storage keys are scoped independently per terminal and phase', () => {
  assert.equal(storageKeyForApp('trading', 'dummy'), 'kaustubh-theme.trading.dummy');
  assert.equal(storageKeyForApp('trading', 'kotak-neo'), 'kaustubh-theme.trading.kotak-neo');
  assert.equal(storageKeyForApp('trading', 'shoonya'), 'kaustubh-theme.trading.shoonya');
  assert.equal(storageKeyForApp('data-saver'), 'kaustubh-theme.data-saver');
  assert.equal(storageKeyForApp('services'), 'kaustubh-theme.services');
  assert.equal(storageKeyForApp('khumbha-ai'), 'kaustubh-theme.khumbha-ai');

  // Distinct scoped keys must never collide.
  const set = new Set([
    storageKeyForApp('trading', 'dummy'),
    storageKeyForApp('trading', 'kotak-neo'),
    storageKeyForApp('trading', 'shoonya'),
    storageKeyForApp('data-saver'),
  ]);
  assert.equal(set.size, 4, 'all four contexts must have distinct keys');
});

test('accent presets cover the required colors', () => {
  const names = new Set(ACCENT_PRESETS.map((a) => a.name.toLowerCase()));
  for (const n of ['saffron', 'blue', 'green', 'purple', 'red', 'teal']) {
    assert.ok(names.has(n), `accent preset missing: ${n}`);
  }
});

test('resolveSystemBrightness maps system + amoled correctly', () => {
  assert.equal(resolveSystemBrightness('light'), 'light');
  assert.equal(resolveSystemBrightness('dark'), 'dark');
  assert.equal(resolveSystemBrightness('amoled'), 'dark');
});

test('DEFAULT_ADVANCED contains all advanced settings', () => {
  assert.equal(typeof DEFAULT_ADVANCED.radius, 'number');
  assert.equal(typeof DEFAULT_ADVANCED.shadowIntensity, 'number');
  assert.equal(typeof DEFAULT_ADVANCED.cardTransparency, 'number');
  assert.equal(typeof DEFAULT_ADVANCED.sidebarWidth, 'number');
  assert.ok(['comfortable', 'compact', 'spacious'].includes(DEFAULT_ADVANCED.density));
  assert.equal(typeof DEFAULT_ADVANCED.reducedMotion, 'boolean');
});