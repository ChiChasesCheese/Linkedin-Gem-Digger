import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalary, parseCardText, analyzeCard } from '../src/cards.js';
import { DEFAULTS } from '../src/config.js';

test('parseSalary handles K/yr ranges, plain dollars, hourly, monthly', () => {
  assert.deepEqual(parseSalary('$100K/yr - $120K/yr · 4 benefits'), { min: 100000, max: 120000 });
  assert.deepEqual(parseSalary('$140,000 - $160,000 a year'), { min: 140000, max: 160000 });
  assert.deepEqual(parseSalary('$50/hr'), { min: 104000, max: 104000 });
  assert.deepEqual(parseSalary('$8K/month'), { min: 96000, max: 96000 });
  assert.equal(parseSalary('Actively reviewing applicants'), null);
  assert.equal(parseSalary('Save $5 on parking'), null); // < 1000/yr is not a salary
});

test('parseCardText reads badges', () => {
  const t = 'Golang Software Engineer\nSourceFuse\nApex, NC (Hybrid)\n$100K/yr - $120K/yr · 4 benefits\nViewed · Promoted · Easy Apply';
  assert.deepEqual(parseCardText(t), {
    salaryMin: 100000, salaryMax: 120000, viewed: true, promoted: true, reposted: false, easyApply: true,
  });
  assert.equal(parseCardText('Reposted 2 days ago').reposted, true);
});

test('title-seniority greys Senior/Staff/etc but exempts intern/new grad', () => {
  const f = analyzeCard({ title: 'Senior Staff Software Engineer' });
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'title-seniority');
  assert.equal(f[0].severity, 'red');
  assert.deepEqual(analyzeCard({ title: 'Software Engineer Intern' }), []);
  assert.deepEqual(analyzeCard({ title: 'Senior Engineer Intern' }), []);
  assert.deepEqual(analyzeCard({ title: 'Software Engineer (Ray Core)' }), []);
});

test('title-seniority ignores neutral phrases like Member of Technical Staff', () => {
  assert.deepEqual(analyzeCard({ title: 'Member of Technical Staff (Software Engineer, Infrastructure)' }), []);
  assert.deepEqual(analyzeCard({ title: 'MTS, Backend' }), []);
  const f = analyzeCard({ title: 'Senior Member of Technical Staff' });
  assert.equal(f.length, 1);
  assert.equal(f[0].sentence, 'Senior');
  assert.equal(analyzeCard({ title: 'Staff Software Engineer' })[0].sentence, 'Staff');
  const cfg = { ...DEFAULTS, titleIgnorelist: [] };
  assert.equal(analyzeCard({ title: 'Member of Technical Staff' }, cfg)[0].sentence, 'Staff');
});

test('title-seniority uses word boundaries and the configured list', () => {
  assert.deepEqual(analyzeCard({ title: 'Leadership Platform Engineer' }), []); // "Lead" not a word here
  const cfg = { ...DEFAULTS, titleGreylist: ['VP'] };
  assert.equal(analyzeCard({ title: 'VP of Engineering' }, cfg)[0].id, 'title-seniority');
  assert.deepEqual(analyzeCard({ title: 'Senior Engineer' }, cfg), []);
});

test('salary-max greys when max below floor; missing salary is ignored', () => {
  assert.equal(analyzeCard({ title: 'SWE', salaryMax: 120000 })[0].id, 'salary-max');
  assert.deepEqual(analyzeCard({ title: 'SWE', salaryMax: 130000 }), []);
  assert.deepEqual(analyzeCard({ title: 'SWE' }), []);
});

test('viewed on by default, promoted off by default', () => {
  assert.equal(analyzeCard({ title: 'SWE', viewed: true })[0].id, 'viewed');
  assert.deepEqual(analyzeCard({ title: 'SWE', promoted: true }), []);
  const cfg = { ...DEFAULTS, rules: { ...DEFAULTS.rules, promoted: true } };
  assert.equal(analyzeCard({ title: 'SWE', promoted: true }, cfg)[0].id, 'promoted');
});

test('easy-apply greys by default and can be disabled', () => {
  const f = analyzeCard({ title: 'SWE', easyApply: true });
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'easy-apply');
  assert.equal(f[0].sentence, 'Easy Apply');
  assert.deepEqual(analyzeCard({ title: 'SWE', easyApply: false }), []);
  const cfg = { ...DEFAULTS, rules: { ...DEFAULTS.rules, 'easy-apply': false } };
  assert.deepEqual(analyzeCard({ title: 'SWE', easyApply: true }, cfg), []);
});

test('reposted yellow by default, red when repostedIsRed', () => {
  assert.equal(analyzeCard({ title: 'SWE', reposted: true })[0].severity, 'yellow');
  assert.equal(analyzeCard({ title: 'SWE', reposted: true }, { ...DEFAULTS, repostedIsRed: true })[0].severity, 'red');
});

test('applicants threshold', () => {
  const f = analyzeCard({ title: 'SWE', applies: 120 });
  assert.equal(f[0].id, 'applicants');
  assert.equal(f[0].value, 120);
  assert.deepEqual(analyzeCard({ title: 'SWE', applies: 99 }), []);
});

test('findings carry short labels and are red-first', () => {
  const f = analyzeCard({ title: 'Senior SWE', salaryMax: 90000, reposted: true });
  assert.deepEqual(f.map((x) => x.severity), ['red', 'red', 'yellow']);
  assert.match(f.find((x) => x.id === 'salary-max').sentence, /\$ < 130K/);
});
