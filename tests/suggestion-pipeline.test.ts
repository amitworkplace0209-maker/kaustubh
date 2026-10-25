// ---- Suggestion pipeline stage derivation unit tests ----
//
// Covers components/orders/suggestion/types.ts pure logic: terminal-state
// handling, visited/active/pending/skipped derivation from the server's live
// pipeline record. The pipeline must never simulate stages the engine hasn't
// recorded on the suggestion document.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestionStageState, TERMINAL_STAGES } from '../components/orders/suggestion/types.ts';

test('TERMINAL_STAGES holds every dead-end status the engine can emit', () => {
  for (const s of ['REJECTED', 'DUPLICATE', 'EXPIRED', 'RISK_REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED']) {
    assert.ok(TERMINAL_STAGES.has(s), `${s} must be a terminal stage`);
  }
  assert.equal(TERMINAL_STAGES.size, 7);
});

test('EXECUTED keeps only the RESULT stage active, everything else skipped', () => {
  assert.equal(suggestionStageState('RESULT', 'EXECUTED', ['RECEIVED', 'VALIDATED', 'RISK_CHECK', 'EXECUTING']), 'active');
  assert.equal(suggestionStageState('RECEIVED', 'EXECUTED', ['RECEIVED']), 'skipped');
  assert.equal(suggestionStageState('DUMMY_BROKER', 'EXECUTED', ['RECEIVED']), 'skipped');
});

test('other terminal statuses skip every canonical stage (no timeline invented)', () => {
  for (const status of ['REJECTED', 'DUPLICATE', 'EXPIRED', 'RISK_REJECTED']) {
    assert.equal(suggestionStageState('RECEIVED', status, ['RECEIVED']), 'skipped', `${status} must not mark RECEIVED visited`);
  }
});

test('RECEIVED row marks RECEIVED active, rest pending', () => {
  assert.equal(suggestionStageState('RECEIVED', 'RECEIVED', []), 'active');
  assert.equal(suggestionStageState('VALIDATING', 'RECEIVED', []), 'pending');
});

test('VALIDATING and EXECUTING mark their own stage active', () => {
  assert.equal(suggestionStageState('VALIDATING', 'VALIDATING', ['RECEIVED']), 'active');
  assert.equal(suggestionStageState('EXECUTING', 'EXECUTING', ['RECEIVED', 'VALIDATED', 'RISK_CHECK']), 'active');
});

test('VALIDATED marks VALIDATED active and reports prior stages from the real pipeline', () => {
  assert.equal(suggestionStageState('RECEIVED', 'VALIDATED', ['RECEIVED', 'VALIDATED']), 'visited');
  assert.equal(suggestionStageState('VALIDATED', 'VALIDATED', ['RECEIVED', 'VALIDATED']), 'active');
  assert.equal(suggestionStageState('RISK_CHECK', 'VALIDATED', ['RECEIVED', 'VALIDATED']), 'pending');
});

test('pipeline visits are case-insensitive and only ever reflect server state', () => {
  assert.equal(suggestionStageState('DUPLICATE_CHECK', 'VALIDATING', ['received', 'validating']), 'pending');
  assert.equal(suggestionStageState('VALIDATING', 'VALIDATING', ['received', 'validating']), 'active');
  // Stages absent from the pipeline are never reported visited and never active.
  assert.equal(suggestionStageState('AUDIT', 'RECEIVED', []), 'pending');
});