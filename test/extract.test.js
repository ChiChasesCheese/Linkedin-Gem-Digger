import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sduiTitleFromText, planScroll } from '../src/extract.js';

test('sduiTitleFromText prefers the plain-title line over the a11y label', () => {
  assert.equal(sduiTitleFromText('Selected, Senior Software Engineer\nSenior Software Engineer\n\nBluJuniper'), 'Senior Software Engineer');
  assert.equal(sduiTitleFromText('Senior Software Engineer | API (Verified job)\nSenior Software Engineer | API \n\nDeepL'), 'Senior Software Engineer | API');
  assert.equal(sduiTitleFromText('Only line'), 'Only line');
  assert.equal(sduiTitleFromText(''), '');
});

test('planScroll: already at the bottom just visits top then the original position', () => {
  // scrollTop is already scrollHeight - clientHeight: nothing to step through.
  assert.deepEqual(
    planScroll({ scrollTop: 1500, clientHeight: 500, scrollHeight: 2000, stepPx: 700 }),
    [0, 1500]
  );
  // Content shorter than the viewport: also nothing to step through.
  assert.deepEqual(
    planScroll({ scrollTop: 0, clientHeight: 2000, scrollHeight: 1500, stepPx: 700 }),
    [0, 0]
  );
});

test('planScroll: two incremental steps then the true bottom, then top, then original', () => {
  assert.deepEqual(
    planScroll({ scrollTop: 0, clientHeight: 500, scrollHeight: 2000, stepPx: 700 }),
    [700, 1400, 1500, 0, 0]
  );
});

test('planScroll: non-zero original scrollTop is preserved as the final position', () => {
  assert.deepEqual(
    planScroll({ scrollTop: 300, clientHeight: 500, scrollHeight: 2000, stepPx: 700 }),
    [1000, 1500, 0, 300]
  );
});
