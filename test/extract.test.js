import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sduiTitleFromText } from '../src/extract.js';

test('sduiTitleFromText prefers the plain-title line over the a11y label', () => {
  assert.equal(sduiTitleFromText('Selected, Senior Software Engineer\nSenior Software Engineer\n\nBluJuniper'), 'Senior Software Engineer');
  assert.equal(sduiTitleFromText('Senior Software Engineer | API (Verified job)\nSenior Software Engineer | API \n\nDeepL'), 'Senior Software Engineer | API');
  assert.equal(sduiTitleFromText('Only line'), 'Only line');
  assert.equal(sduiTitleFromText(''), '');
});
