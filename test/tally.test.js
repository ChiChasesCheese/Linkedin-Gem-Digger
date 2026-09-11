import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyFindings } from '../src/tally.js';

test('tallyFindings on an empty page is all zero', () => {
  assert.deepEqual(tallyFindings([]), { byRule: {}, greyed: 0, total: 0 });
});

test('tallyFindings counts each rule once per card and greys cards with a red finding', () => {
  const cardA = [
    { id: 'yoe', severity: 'red', sentence: '5+ yrs' },
    { id: 'reposted', severity: 'yellow', sentence: 'Reposted' },
  ];
  const cardB = [
    { id: 'yoe', severity: 'red', sentence: '5+ yrs' },
    { id: 'yoe', severity: 'red', sentence: '5+ yrs' }, // duplicate within the same card
    { id: 'easy-apply', severity: 'red', sentence: 'Easy Apply' },
  ];
  assert.deepEqual(tallyFindings([cardA, cardB]), {
    byRule: { yoe: 2, reposted: 1, 'easy-apply': 1 },
    greyed: 2,
    total: 2,
  });
});

test('a card with only a yellow finding is not greyed', () => {
  const cardA = [{ id: 'reposted', severity: 'yellow', sentence: 'Reposted' }];
  const tally = tallyFindings([cardA]);
  assert.equal(tally.greyed, 0);
  assert.deepEqual(tally.byRule, { reposted: 1 });
  assert.equal(tally.total, 1);
});
