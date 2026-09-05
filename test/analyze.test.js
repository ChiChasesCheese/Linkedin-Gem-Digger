import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, splitSentences, worstSeverity } from '../src/analyze.js';
import { DEFAULTS } from '../src/config.js';

const ids = (f) => f.map((x) => x.id);

test('splitSentences splits on period, semicolon, newline and bullets', () => {
  const s = splitSentences('Foo bar. Baz; qux\n• Item one\n- Item two');
  assert.deepEqual(s, ['Foo bar', 'Baz', 'qux', 'Item one', 'Item two']);
});

test('splitSentences protects two-letter dotted abbreviations but still splits real sentence boundaries', () => {
  assert.deepEqual(
    splitSentences('This is plan B. Next quarter we pivot.'),
    ['This is plan B', 'Next quarter we pivot'],
  );
  assert.deepEqual(
    splitSentences('e.g. Go or Rust. Also Python.'),
    ['e.g. Go or Rust', 'Also Python'],
  );
});

test('yoe: flags 3+ years at default threshold 2', () => {
  const f = analyze('Requirements: 3+ years of experience with Go.');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'yoe');
  assert.equal(f[0].severity, 'red');
  assert.equal(f[0].value, 3);
  assert.match(f[0].sentence, /3\+ years/);
});

test('yoe: range takes the minimum, number words map to digits', () => {
  assert.equal(analyze('2-5 years of Python')[0].value, 2);
  assert.equal(analyze('five years of Python')[0].value, 5);
  assert.equal(analyze('minimum of 4 yrs in ML')[0].value, 4);
  assert.equal(analyze('at least 3 years developing APIs')[0].value, 3);
});

test('yoe: below threshold is not reported', () => {
  assert.deepEqual(analyze('1+ years of experience'), []);
  assert.deepEqual(analyze('1-2 years of experience', { ...DEFAULTS, yoeThreshold: 3 }), []);
});

test('yoe: "to" ranges and bare "+" are parsed', () => {
  assert.equal(analyze('3 to 5 years of experience')[0].value, 3);
  assert.equal(analyze('10+ years of experience')[0].value, 10);
});

test('yoe: cap phrasing is not a minimum requirement', () => {
  assert.deepEqual(analyze('No more than 2 years of experience'), []);
  assert.deepEqual(analyze('Not more than 2 years of experience'), []);
  assert.deepEqual(analyze('Up to 2 years of experience'), []);
  assert.deepEqual(analyze('Less than 2 years of experience'), []);
  assert.deepEqual(analyze('Fewer than 2 years of experience'), []);
  assert.equal(analyze('At least 3 years of experience')[0].value, 3);
  assert.equal(analyze('Minimum of 4 years of experience')[0].value, 4);
});

test('yoe: a bare "max"/"Max" elsewhere in the sentence does not suppress a real requirement', () => {
  const f = analyze('Max salary is 150k, 5+ years of experience required.');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'yoe');
  assert.equal(f[0].value, 5);
  assert.deepEqual(analyze('maximum of 2 years'), []);
});

test('yoe: noise sentences are ignored', () => {
  assert.deepEqual(analyze('Founded 12 years ago. 4 weeks vacation and 5 years warranty.'), []);
  assert.deepEqual(analyze('We have a 10 year track record.'), []);
});

test('softener in the same sentence downgrades to yellow', () => {
  const f = analyze('5+ years of Kubernetes experience preferred.');
  assert.equal(f[0].severity, 'yellow');
  const g = analyze('Security clearance is a plus.');
  assert.equal(g[0].id, 'clearance');
  assert.equal(g[0].severity, 'yellow');
});

test('citizenship / clearance / sponsorship patterns', () => {
  assert.deepEqual(ids(analyze('Must be a U.S. citizen.')), ['citizenship']);
  assert.deepEqual(ids(analyze('US citizenship required due to contract.')), ['citizenship']);
  assert.deepEqual(ids(analyze('Open to US persons only.')), ['citizenship']);
  assert.deepEqual(ids(analyze('Active Top Secret clearance required.')), ['clearance']);
  assert.deepEqual(ids(analyze('Subject to ITAR regulations.')), ['clearance']);
  assert.deepEqual(ids(analyze('We are unable to sponsor visas at this time.')), ['sponsorship']);
  assert.deepEqual(ids(analyze('No visa sponsorship available.')), ['sponsorship']);
  assert.deepEqual(ids(analyze('Will not sponsor H-1B.')).sort(), ['sponsorship']);
});

test('citizenship pattern accepts plural "citizens"', () => {
  assert.deepEqual(ids(analyze('Applicants must be U.S. citizens.')), ['citizenship']);
});

test('sponsorship: bare mention of H-1B without a negation is not a red flag', () => {
  assert.deepEqual(analyze('We are happy to sponsor H-1B visas.'), []);
});

test('sponsorship: "no"/"not available" phrasing next to H-1B is flagged', () => {
  const f1 = analyze('No H-1B sponsorship available.');
  assert.equal(f1.length, 1);
  assert.equal(f1[0].id, 'sponsorship');

  const f2 = analyze('H-1B transfer not available.');
  assert.equal(f2.length, 1);
  assert.equal(f2[0].id, 'sponsorship');
});

test('sponsorship: "authorized/eligible to work without sponsorship" phrasing is flagged', () => {
  const f1 = analyze('Must be authorized to work in the US without sponsorship now or in the future.');
  assert.equal(f1.length, 1);
  assert.equal(f1[0].id, 'sponsorship');

  const f2 = analyze('Candidates must be eligible to work in the United States without visa sponsorship.');
  assert.equal(f2.length, 1);
  assert.equal(f2[0].id, 'sponsorship');
});

test('degree rule is off by default and yellow when enabled', () => {
  assert.deepEqual(analyze('PhD required.'), []);
  const cfg = { ...DEFAULTS, rules: { ...DEFAULTS.rules, degree: true } };
  const f = analyze('PhD required.', cfg);
  assert.equal(f[0].id, 'degree');
  assert.equal(f[0].severity, 'yellow');
});

test('reposted is yellow by default, red when repostedIsRed', () => {
  assert.equal(analyze('Reposted 3 days ago · 88 applicants')[0].severity, 'yellow');
  assert.equal(analyze('Reposted 3 days ago', { ...DEFAULTS, repostedIsRed: true })[0].severity, 'red');
});

test('disabled rules are skipped', () => {
  const cfg = { ...DEFAULTS, rules: { ...DEFAULTS.rules, yoe: false } };
  assert.deepEqual(analyze('5+ years required', cfg), []);
});

test('ordering: red before yellow, higher yoe first; duplicates collapsed', () => {
  const f = analyze('2 years of Java. 5+ years of Go. 5+ years of Go. Security clearance is a plus.');
  assert.deepEqual(f.map((x) => [x.id, x.severity, x.value ?? null]), [
    ['yoe', 'red', 5], ['yoe', 'red', 2], ['clearance', 'yellow', null],
  ]);
});

test('salary: stated max below floor is flagged red, keyed off config.salaryFloor', () => {
  const text = 'The U.S. base salary range for this full-time position is $125,000 - $175,000. ' +
    'Salary ranges are determined by role, level, and location.';
  const f = analyze(text, { ...DEFAULTS, salaryFloor: 200000 });
  assert.equal(f.length, 1);
  assert.deepEqual({ id: f[0].id, severity: f[0].severity, value: f[0].value }, { id: 'salary', severity: 'red', value: 175000 });

  assert.deepEqual(analyze(text).filter((x) => x.id === 'salary'), []);
});

test('salary: hourly rate is annualised (×2080)', () => {
  const f = analyze('Pay: $45 - $55 per hour.');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'salary');
  assert.equal(f[0].value, 114400);
});

test('salary: a bonus/signing amount alone is not a stated salary', () => {
  assert.deepEqual(analyze('You will receive a $5,000 signing bonus.'), []);
});

test('salary: base salary sentence still counts even with a bonus mentioned in it', () => {
  const f = analyze('Compensation: $90K–$110K plus a $3,000 sign-on bonus.');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'salary');
  assert.equal(f[0].value, 110000);
});

test('salary: rule can be disabled via config.rules["salary-max"]', () => {
  const cfg = { ...DEFAULTS, rules: { ...DEFAULTS.rules, 'salary-max': false } };
  assert.deepEqual(analyze('Pay: $45 - $55 per hour.', cfg), []);
});

test('ordering: salary sorts after yoe at equal (red) severity', () => {
  const f = analyze('5+ years of Go. Salary: $100,000 - $120,000.');
  assert.deepEqual(ids(f), ['yoe', 'salary']);
});

test('worstSeverity', () => {
  assert.equal(worstSeverity([]), 'green');
  assert.equal(worstSeverity([{ severity: 'yellow' }]), 'yellow');
  assert.equal(worstSeverity([{ severity: 'yellow' }, { severity: 'red' }]), 'red');
});
