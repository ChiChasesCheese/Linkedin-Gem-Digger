import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, mergeConfig } from '../src/config.js';

test('DEFAULTS has documented thresholds', () => {
  assert.equal(DEFAULTS.yoeThreshold, 2);
  assert.equal(DEFAULTS.salaryFloor, 130000);
  assert.equal(DEFAULTS.applicantsMax, 100);
  assert.equal(DEFAULTS.rules.degree, false);
  assert.equal(DEFAULTS.rules.promoted, false);
  assert.equal(DEFAULTS.scan.intervalMs, 1500);
});

test('mergeConfig overlays stored values and keeps unknown-free defaults', () => {
  const cfg = mergeConfig({ yoeThreshold: 3, rules: { degree: true } });
  assert.equal(cfg.yoeThreshold, 3);
  assert.equal(cfg.rules.degree, true);
  assert.equal(cfg.rules.yoe, true);            // untouched default survives
  assert.equal(cfg.scan.intervalMs, 1500);
  assert.deepEqual(DEFAULTS.rules.degree, false); // DEFAULTS not mutated
});

test('mergeConfig tolerates undefined / null', () => {
  assert.deepEqual(mergeConfig(undefined), DEFAULTS);
  assert.deepEqual(mergeConfig(null), DEFAULTS);
});

test('mergeConfig replaces arrays wholesale', () => {
  const cfg = mergeConfig({ titleGreylist: ['VP'] });
  assert.deepEqual(cfg.titleGreylist, ['VP']);
});
