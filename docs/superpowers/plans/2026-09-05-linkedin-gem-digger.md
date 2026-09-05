# Linkedin-Gem-Digger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome MV3 extension that flags YOE / citizenship / clearance / sponsorship red flags on job-posting pages and greys out LinkedIn list cards by cheap signals, with an opt-in throttled deep scan.

**Architecture:** Pure rule engine (`analyze`, `analyzeCard`) with zero DOM dependency, tested under `node --test`. A thin DOM layer (`extract.js` reads, `render.js` writes) and a glue module (`main.js`). Deep scan (`scanner.js` + `linkedin-api.js`) uses dependency injection so throttle / cache / back-off are tested with fakes.

**Tech Stack:** Plain ES modules, no bundler, no dependencies. Node ≥ 20 `node:test` for unit tests. Chrome MV3 (`storage`, `activeTab`).

**Spec:** `docs/superpowers/specs/2026-09-05-linkedin-gem-digger-design.md`

## Global Constraints

- No build step; no npm dependencies. `package.json` exists only for `"type": "module"` and `npm test`.
- Every module under `src/` must be importable in Node: guard all `chrome.*` and `document` access behind `typeof chrome !== 'undefined'` / injected parameters.
- Network calls to LinkedIn happen **only** inside `scanner.scan()` which is triggered **only** by the popup "Scan" button. Never on page load, never on scroll.
- Scan throttle: serial, `intervalMs: 1500`, `jitterMs: 500`, abort on first 429/401/403, back-off min 5 min doubling, persisted.
- Cache TTL 7 days, keyed by LinkedIn job id, in `chrome.storage.local`.
- Config lives in `chrome.storage.sync` under key `config`; defaults in `src/config.js` are the single source of truth.
- **Subagents do not commit.** Tasks run in parallel in one worktree; the orchestrator commits after each wave using the commands shown in each task's final step (with `/usr/bin/git`, because the `git` alias is rewritten by a hook and blocked in this worktree). Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MQNbQVRt4CzNv2VE3iUZkA
  ```
- Run tests with `node --test test/` from the repo root.

## File map

| File | Responsibility | Task |
|---|---|---|
| `package.json` | `type: module`, `npm test` | 1 |
| `src/config.js` | `DEFAULTS`, `mergeConfig`, `loadConfig`, `saveConfig` | 1 |
| `src/rules.js` | rule tables and shared regexes (data only) | 2 |
| `src/analyze.js` | `analyze(text, config)`, `splitSentences`, `worstSeverity` | 2 |
| `src/cards.js` | `parseSalary`, `parseCardText`, `analyzeCard` | 3 |
| `src/extract.js` | DOM reads: `getJobText`, `getJobId`, `getCards`, `isLinkedInList` | 4 |
| `src/render.js` | DOM writes: `renderPanel`, `removePanel`, `markCard`, `unmarkCard` | 4 |
| `src/main.js` | glue + message handling | 4, 7 |
| `content.js`, `manifest.json` | loader + manifest | 4 |
| `src/linkedin-api.js` | `fetchJobDetail`, parsers, `RateLimitError` | 5 |
| `src/scanner.js` | `createScanner`, `createMemoryCache`, `createStorageCache` | 6 |
| `popup/popup.html`, `popup/popup.js` | settings UI + scan button | 7 |
| `README.md` | install + usage | 7 |

Dependency waves (for parallel dispatch, ≤ 3 agents at once):

- **Wave A:** Task 1, Task 2, Task 3 (all pure, independent).
- **Wave B:** Task 4 (needs 1-3), Task 5 (independent), Task 6 (needs 2 for `analyze`).
- **Wave C:** Task 7 (needs everything).

---

### Task 1: Config module and package scaffold

**Files:**
- Create: `package.json`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `DEFAULTS` (object, shape below), `mergeConfig(stored) → config`, `async loadConfig() → config`, `async saveConfig(config) → void`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "linkedin-gem-digger",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/" }
}
```

- [ ] **Step 2: Write the failing test**

`test/config.test.js`:

```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL, cannot find module `../src/config.js`.

- [ ] **Step 4: Write the implementation**

`src/config.js`:

```js
// Single source of truth for user-configurable behaviour.
export const DEFAULTS = Object.freeze({
  yoeThreshold: 2,
  salaryFloor: 130000,
  applicantsMax: 100,
  titleGreylist: ['Senior', 'Sr.', 'Staff', 'Principal', 'Lead', 'Manager', 'Director', 'Architect', 'Head of'],
  rules: {
    yoe: true, citizenship: true, clearance: true, sponsorship: true, degree: false,
    reposted: true, 'title-seniority': true, 'salary-max': true, viewed: true,
    promoted: false, applicants: true,
  },
  repostedIsRed: false,
  hideInsteadOfGrey: false,
  scan: { intervalMs: 1500, jitterMs: 500, cacheTtlDays: 7 },
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const out = {};
  for (const k of Object.keys(base)) {
    const b = base[k];
    const o = over?.[k];
    if (isPlainObject(b)) out[k] = deepMerge(b, isPlainObject(o) ? o : {});
    else out[k] = o === undefined ? (Array.isArray(b) ? [...b] : b) : o;
  }
  return out;
}

/** Overlay a stored (possibly partial / stale) config onto DEFAULTS. Never mutates DEFAULTS. */
export function mergeConfig(stored) {
  return deepMerge(DEFAULTS, isPlainObject(stored) ? stored : {});
}

const hasSync = () => typeof chrome !== 'undefined' && chrome.storage?.sync;

export async function loadConfig() {
  if (!hasSync()) return mergeConfig();
  const { config } = await chrome.storage.sync.get('config');
  return mergeConfig(config);
}

export async function saveConfig(config) {
  if (!hasSync()) return;
  await chrome.storage.sync.set({ config: mergeConfig(config) });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add package.json src/config.js test/config.test.js
/usr/bin/git commit -m "feat: config defaults and merge" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MQNbQVRt4CzNv2VE3iUZkA"
```

---

### Task 2: Rule table and text analyzer

**Files:**
- Create: `src/rules.js`
- Create: `src/analyze.js`
- Test: `test/analyze.test.js`

**Interfaces:**
- Consumes: `DEFAULTS` from `src/config.js` (Task 1). If Task 1 is not merged yet, use the literal defaults shown in Task 1; the import must still be `../src/config.js`.
- Produces:
  - `TEXT_RULES: Rule[]`, `NUMBER_WORDS`, `YOE_NOISE`, `SOFTENERS`, `TITLE_EXEMPT` from `rules.js`.
  - `analyze(text: string, config = DEFAULTS) → Finding[]` where `Finding = { id, category, severity: 'red'|'yellow', value?: number, sentence: string }`, sorted red-first then by `value` desc.
  - `splitSentences(text) → string[]`.
  - `worstSeverity(findings) → 'red'|'yellow'|'green'`.

- [ ] **Step 1: Write the failing tests**

`test/analyze.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, splitSentences, worstSeverity } from '../src/analyze.js';
import { DEFAULTS } from '../src/config.js';

const ids = (f) => f.map((x) => x.id);

test('splitSentences splits on period, semicolon, newline and bullets', () => {
  const s = splitSentences('Foo bar. Baz; qux\n• Item one\n- Item two');
  assert.deepEqual(s, ['Foo bar', 'Baz', 'qux', 'Item one', 'Item two']);
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

test('worstSeverity', () => {
  assert.equal(worstSeverity([]), 'green');
  assert.equal(worstSeverity([{ severity: 'yellow' }]), 'yellow');
  assert.equal(worstSeverity([{ severity: 'yellow' }, { severity: 'red' }]), 'red');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/analyze.test.js`
Expected: FAIL, cannot find module `../src/analyze.js`.

- [ ] **Step 3: Write `src/rules.js`**

```js
// Pure data. Adding a rule = adding one entry here.
export const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';

/** Sentences containing these are never YOE requirements. */
export const YOE_NOISE = /\b(benefits?|vacation|pto|founded|history|ago|track record|years? old|warranty|anniversary)\b/i;

/** A softener in the same sentence downgrades red → yellow. */
export const SOFTENERS = /\b(preferred|nice to have|a plus|bonus|ideally|plus but not required)\b/i;

/** Titles that must never be greyed by the seniority greylist. */
export const TITLE_EXEMPT = /\b(intern(ship)?|new grad(uate)?|entry[- ]level|junior|early[- ]career|university grad(uate)?)\b/i;

/**
 * Rule = { id, category, severity, scope, pattern, extract?, defaultOn }
 * pattern must carry the g flag; analyze() clones it per use.
 */
export const TEXT_RULES = [
  {
    id: 'yoe', category: 'experience', severity: 'red', scope: 'text', defaultOn: true,
    pattern: new RegExp(`\\b${NUM}\\s*(?:\\+|(?:-|–|to)\\s*\\d{1,2})?\\s*\\+?\\s*(?:years?|yrs?)\\b`, 'gi'),
    extract: (m) => {
      const raw = m[1].toLowerCase();
      return NUMBER_WORDS[raw] ?? parseInt(raw, 10);
    },
  },
  {
    id: 'citizenship', category: 'citizenship', severity: 'red', scope: 'text', defaultOn: true,
    pattern: /\b(?:u\.?s\.?\s+citizen(?:ship)?\s+(?:is\s+)?(?:required|only|mandatory)|must\s+be\s+(?:a\s+)?u\.?s\.?\s+citizen|u\.?s\.?\s+persons?\s+only|citizenship\s+(?:is\s+)?required)\b/gi,
  },
  {
    id: 'clearance', category: 'clearance', severity: 'red', scope: 'text', defaultOn: true,
    pattern: /\b(?:security\s+clearance|(?:top\s+secret|secret|ts\/sci|public\s+trust)(?:\s+security)?\s+clearance|\bitar\b|export[- ]control(?:led)?)\b/gi,
  },
  {
    id: 'sponsorship', category: 'sponsorship', severity: 'red', scope: 'text', defaultOn: true,
    pattern: /\b(?:no\s+(?:visa\s+)?sponsorship|(?:unable|not\s+able|will\s+not|cannot|can't|do(?:es)?\s+not)\s+(?:to\s+)?(?:provide\s+|offer\s+)?sponsor(?:ship)?|h-?1b)\b/gi,
  },
  {
    id: 'degree', category: 'degree', severity: 'yellow', scope: 'text', defaultOn: false,
    pattern: /\b(?:ph\.?d\.?|master'?s|m\.?s\.?|doctorate)\s+(?:degree\s+)?(?:is\s+)?required\b/gi,
  },
  {
    id: 'reposted', category: 'freshness', severity: 'yellow', scope: 'text', defaultOn: true,
    pattern: /\breposted\s+\d+\s+(?:minute|hour|day|week|month)s?\s+ago\b/gi,
  },
];
```

- [ ] **Step 4: Write `src/analyze.js`**

```js
import { TEXT_RULES, YOE_NOISE, SOFTENERS } from './rules.js';
import { DEFAULTS } from './config.js';

const SEVERITY_RANK = { red: 2, yellow: 1 };

/** Split JD text into trimmed, non-empty sentence-like chunks. */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.;!?])\s+|\n+|\r+|[•·▪◦]|(?:^|\n)\s*[-*]\s+/)
    .map((s) => s.replace(/^[\s\-*•·]+/, '').replace(/[.;!?]+\s*$/, '').trim())
    .filter(Boolean);
}

function clone(re) { return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); }

/**
 * Run every enabled text rule over `text`.
 * Returns Finding[] sorted red-first, then by numeric value descending.
 */
export function analyze(text, config = DEFAULTS) {
  const rules = TEXT_RULES.filter((r) => config.rules?.[r.id] ?? r.defaultOn);
  const seen = new Set();
  const out = [];

  for (const sentence of splitSentences(text)) {
    const soft = SOFTENERS.test(sentence);
    for (const rule of rules) {
      const re = clone(rule.pattern);
      let m;
      while ((m = re.exec(sentence))) {
        let value;
        if (rule.id === 'yoe') {
          if (YOE_NOISE.test(sentence)) continue;
          value = rule.extract(m);
          if (!(value >= config.yoeThreshold)) continue;
        }
        let severity = rule.severity;
        if (rule.id === 'reposted' && config.repostedIsRed) severity = 'red';
        if (soft && severity === 'red') severity = 'yellow';

        const key = `${rule.id}|${value ?? ''}|${sentence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: rule.id, category: rule.category, severity, ...(value !== undefined && { value }), sentence: sentence.slice(0, 240) });
      }
    }
  }

  return out.sort((a, b) =>
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || ((b.value ?? -1) - (a.value ?? -1)));
}

export function worstSeverity(findings) {
  let worst = 'green';
  for (const f of findings ?? []) {
    if (f.severity === 'red') return 'red';
    if (f.severity === 'yellow') worst = 'yellow';
  }
  return worst;
}
```

- [ ] **Step 5: Run tests; fix regexes until green**

Run: `node --test test/analyze.test.js`
Expected: PASS (12 tests). Likely first failures: `splitSentences` bullet handling and the `H-1B` case (`\bh-?1b\b`). Adjust the regex in `rules.js`, not the tests, unless a test contradicts the spec.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add src/rules.js src/analyze.js test/analyze.test.js
/usr/bin/git commit -m "feat: text rule table and analyzer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MQNbQVRt4CzNv2VE3iUZkA"
```

---

### Task 3: Card analyzer and salary parser

**Files:**
- Create: `src/cards.js`
- Test: `test/cards.test.js`

**Interfaces:**
- Consumes: `DEFAULTS` (Task 1), `TITLE_EXEMPT` from `src/rules.js` (Task 2). If Task 2 is not merged yet, define `TITLE_EXEMPT` locally with the same regex and switch to the import later.
- Produces:
  - `parseSalary(text) → { min: number, max: number } | null` (annualised USD).
  - `parseCardText(text) → { salaryMin, salaryMax, viewed, promoted, reposted, easyApply }`.
  - `analyzeCard(meta, config = DEFAULTS) → Finding[]` where `meta = { title, salaryMin?, salaryMax?, viewed?, promoted?, reposted?, applies? }` and Finding is the same shape as Task 2 (`{ id, category, severity, value?, sentence }`; `sentence` here is a short human label used in the reason strip).

- [ ] **Step 1: Write the failing tests**

`test/cards.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cards.test.js`
Expected: FAIL, cannot find module `../src/cards.js`.

- [ ] **Step 3: Write `src/cards.js`**

```js
import { DEFAULTS } from './config.js';
import { TITLE_EXEMPT } from './rules.js';

const MONEY = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?(?:\s*(?:\/|per|a)\s*(yr|year|hr|hour|mo|month))?/g;

/** Annualised salary range from free text, or null when nothing plausible is found. */
export function parseSalary(text) {
  const amounts = [];
  for (const m of String(text ?? '').matchAll(MONEY)) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    const unit = (m[2] ?? '').toLowerCase();
    if (unit === 'k') n *= 1e3;
    if (unit === 'm') n *= 1e6;
    const per = (m[3] ?? '').toLowerCase();
    if (per === 'hr' || per === 'hour') n *= 2080;
    if (per === 'mo' || per === 'month') n *= 12;
    if (n >= 1000) amounts.push(Math.round(n));
  }
  if (!amounts.length) return null;
  return { min: Math.min(...amounts), max: Math.max(...amounts) };
}

/** Cheap signals readable from a LinkedIn card's own innerText. */
export function parseCardText(text) {
  const t = String(text ?? '');
  const salary = parseSalary(t);
  return {
    salaryMin: salary?.min, salaryMax: salary?.max,
    viewed: /\bViewed\b/.test(t),
    promoted: /\bPromoted\b/.test(t),
    reposted: /\bReposted\b/i.test(t),
    easyApply: /\bEasy Apply\b/.test(t),
  };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtK = (n) => `${Math.round(n / 1000)}K`;
const RANK = { red: 2, yellow: 1 };

/**
 * Evaluate card-level rules. `meta` fields are all optional except title.
 * Returns Finding[] (same shape as analyze()); `sentence` is a short label.
 */
export function analyzeCard(meta, config = DEFAULTS) {
  const on = (id) => config.rules?.[id] ?? DEFAULTS.rules[id];
  const out = [];
  const title = String(meta.title ?? '');

  if (on('title-seniority') && config.titleGreylist?.length && !TITLE_EXEMPT.test(title)) {
    const re = new RegExp(`(?:^|[^A-Za-z])(?:${config.titleGreylist.map(esc).join('|')})(?![A-Za-z])`, 'i');
    const m = title.match(re);
    if (m) out.push({ id: 'title-seniority', category: 'title', severity: 'red', sentence: m[0].trim() });
  }
  if (on('salary-max') && typeof meta.salaryMax === 'number' && meta.salaryMax < config.salaryFloor) {
    out.push({ id: 'salary-max', category: 'salary', severity: 'red', value: meta.salaryMax, sentence: `$ < ${fmtK(config.salaryFloor)}` });
  }
  if (on('viewed') && meta.viewed) out.push({ id: 'viewed', category: 'seen', severity: 'red', sentence: 'Viewed' });
  if (on('promoted') && meta.promoted) out.push({ id: 'promoted', category: 'promoted', severity: 'red', sentence: 'Promoted' });
  if (on('reposted') && meta.reposted) {
    out.push({ id: 'reposted', category: 'freshness', severity: config.repostedIsRed ? 'red' : 'yellow', sentence: 'Reposted' });
  }
  if (on('applicants') && typeof meta.applies === 'number' && meta.applies >= config.applicantsMax) {
    out.push({ id: 'applicants', category: 'competition', severity: 'red', value: meta.applies, sentence: `${meta.applies} applicants` });
  }
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}
```

- [ ] **Step 4: Run tests; iterate until green**

Run: `node --test test/cards.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/cards.js test/cards.test.js
/usr/bin/git commit -m "feat: card analyzer and salary parser" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MQNbQVRt4CzNv2VE3iUZkA"
```

---

### Task 4: DOM layer, glue, manifest (v0.1 + v0.2 usable extension)

**Files:**
- Create: `manifest.json`, `content.js`, `src/extract.js`, `src/render.js`, `src/main.js`
- Test: none automated (DOM). Verification is `node --test test/` still green + loading unpacked in Chrome and checking on a non-LinkedIn ATS page (e.g. any public `jobs.lever.co` posting) that the panel appears. **Do not open LinkedIn during this task.**

**Interfaces:**
- Consumes: `analyze`, `worstSeverity` (Task 2); `analyzeCard`, `parseCardText` (Task 3); `loadConfig` (Task 1).
- Produces:
  - `extract.js`: `isLinkedIn() → boolean`, `isLinkedInList() → boolean`, `getJobId() → string|null`, `getJobText() → string`, `getCards() → Array<{ el: Element, jobId: string|null, title: string, text: string }>`.
  - `render.js`: `renderPanel(findings, { key }) → void`, `removePanel() → void`, `markCard(el, findings, config) → void`, `unmarkCard(el) → void`, `setCardStatus(el, text) → void`.
  - `main.js`: `init()`; internal `runDetail()`, `runCards()`; a message listener stub that Task 7 extends. Exposes `window.__gemDigger = { rerun }` for manual debugging.

- [ ] **Step 1: `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Linkedin Gem Digger",
  "version": "0.1.0",
  "description": "Flags years-of-experience, citizenship/clearance, sponsorship and other red flags on job postings. Not affiliated with LinkedIn.",
  "permissions": ["storage", "activeTab"],
  "action": { "default_popup": "popup/popup.html", "default_title": "Gem Digger" },
  "content_scripts": [
    {
      "matches": [
        "https://www.linkedin.com/jobs/*",
        "https://jobs.ashbyhq.com/*",
        "https://*.ashbyhq.com/*",
        "https://boards.greenhouse.io/*",
        "https://job-boards.greenhouse.io/*",
        "https://jobs.lever.co/*",
        "https://*.myworkdayjobs.com/*",
        "https://jobs.smartrecruiters.com/*",
        "https://wellfound.com/*",
        "https://apply.workable.com/*",
        "https://jobs.jobvite.com/*",
        "https://*.icims.com/*",
        "https://ats.rippling.com/*"
      ],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    { "resources": ["src/*"], "matches": ["<all_urls>"] }
  ]
}
```

Also create a placeholder `popup/popup.html` so the manifest validates (Task 7 replaces it):

```html
<!doctype html><meta charset="utf-8"><title>Gem Digger</title><body style="min-width:240px;padding:12px;font:13px system-ui">Settings coming in Task 7.</body>
```

- [ ] **Step 2: `content.js`**

```js
// Classic content script: MV3 content_scripts cannot be modules, so bootstrap the module graph here.
import(chrome.runtime.getURL('src/main.js'))
  .then((m) => m.init())
  .catch((e) => console.error('[gem-digger] failed to start', e));
```

- [ ] **Step 3: `src/extract.js`**

```js
// All DOM *reads* live here. Nothing in this file writes to the page.

export const isLinkedIn = () => location.hostname.endsWith('linkedin.com');

/** True on LinkedIn search / collections pages that render a card list. */
export const isLinkedInList = () =>
  isLinkedIn() && /^\/jobs\/(search|collections|search-results)/.test(location.pathname);

/** Current job id from URL (?currentJobId= or /jobs/view/123) or null. */
export function getJobId() {
  const u = new URL(location.href);
  return u.searchParams.get('currentJobId') || (u.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] ?? null);
}

const LI_DETAIL_SELECTORS = [
  '.jobs-search__job-details--container',
  '.jobs-details',
  '.job-view-layout',
  '[class*="jobs-details__main-content"]',
  '[class*="job-details-module"]',
];

function firstText(selectors, root = document) {
  for (const s of selectors) {
    const el = root.querySelector(s);
    const t = el?.innerText?.trim();
    if (t && t.length > 80) return t;
  }
  return '';
}

/** JD text for the posting the user is looking at. Empty string if nothing usable. */
export function getJobText() {
  if (isLinkedIn()) {
    const t = firstText(LI_DETAIL_SELECTORS);
    if (t) return t;
    if (isLinkedInList()) return ''; // never fall back to body on list pages: it would scan every card
  }
  const t = firstText(['main', 'article', '[role="main"]']);
  return t || document.body?.innerText?.trim() || '';
}

const CARD_SELECTORS = [
  'li[data-occludable-job-id]',
  'div[data-job-id]',
  'li.jobs-search-results__list-item',
  'li.scaffold-layout__list-item',
];

/** LinkedIn cards currently in the DOM (LinkedIn virtualises, so this is roughly the visible page). */
export function getCards() {
  if (!isLinkedInList()) return [];
  const seen = new Set();
  const out = [];
  for (const sel of CARD_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      const jobId =
        el.getAttribute('data-occludable-job-id') ||
        el.getAttribute('data-job-id') ||
        el.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
        el.querySelector('a[href*="/jobs/view/"]')?.href.match(/\/jobs\/view\/(\d+)/)?.[1] ||
        null;
      const key = jobId ?? el;
      if (seen.has(key)) continue;
      seen.add(key);
      const link = el.querySelector('a[href*="/jobs/view/"], a.job-card-list__title--link, a.job-card-container__link');
      const title = (link?.innerText || el.querySelector('strong')?.innerText || '').split('\n')[0].trim();
      if (!title) continue;
      out.push({ el, jobId, title, text: el.innerText ?? '' });
    }
    if (out.length) break;
  }
  return out;
}
```

- [ ] **Step 4: `src/render.js`**

```js
// All DOM *writes* live here. Panel uses a shadow root so host CSS cannot leak in.
const PANEL_ID = 'gem-digger-panel';
const COLORS = { red: '#c62828', yellow: '#ef6c00', green: '#2e7d32' };
const LABELS = {
  yoe: 'YOE', citizenship: 'Citizenship', clearance: 'Clearance', sponsorship: 'Sponsorship',
  degree: 'Degree', reposted: 'Reposted', 'title-seniority': 'Title', 'salary-max': 'Salary',
  viewed: 'Viewed', promoted: 'Promoted', applicants: 'Applicants',
};

const dismissed = new Set();

function worst(findings) {
  if (findings.some((f) => f.severity === 'red')) return 'red';
  if (findings.some((f) => f.severity === 'yellow')) return 'yellow';
  return 'green';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function valueLabel(f) {
  if (f.id === 'yoe') return `${f.value}+ yrs`;
  if (f.id === 'applicants') return `${f.value}`;
  return '';
}

/** Draw or update the bottom-right panel. `key` identifies the posting so a dismissed panel stays dismissed. */
export function renderPanel(findings, { key = location.href } = {}) {
  if (dismissed.has(key)) return;
  let host = document.getElementById(PANEL_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = PANEL_ID;
    host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
  }
  const sev = worst(findings);
  const rows = findings.length
    ? findings.map((f) => `
        <div class="row ${f.severity}">
          <span class="badge">${esc(LABELS[f.id] ?? f.id)}</span>
          <span class="val">${esc(valueLabel(f))}</span>
          <div class="sent">${esc(f.sentence)}</div>
        </div>`).join('')
    : '<div class="row green"><div class="sent">No red flags found</div></div>';

  host.shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; right: 16px; bottom: 16px; width: 280px; max-height: 50vh; overflow: auto;
             background: #fff; color: #222; font: 12px/1.4 system-ui, sans-serif; border-radius: 8px;
             box-shadow: 0 4px 16px rgba(0,0,0,.25); z-index: 2147483647; }
      .hd { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px;
            color: #fff; font-weight: 600; background: ${COLORS[sev]}; cursor: pointer; }
      .hd button { all: unset; cursor: pointer; padding: 0 4px; font-size: 14px; }
      .row { padding: 6px 10px; border-top: 1px solid #eee; }
      .row.red .badge { background: ${COLORS.red}; }
      .row.yellow .badge { background: ${COLORS.yellow}; }
      .row.green .sent { color: ${COLORS.green}; }
      .badge { display: inline-block; color: #fff; border-radius: 3px; padding: 1px 5px; font-size: 11px; }
      .val { margin-left: 6px; font-weight: 600; }
      .sent { color: #555; margin-top: 2px; }
      .collapsed .row { display: none; }
    </style>
    <div class="box">
      <div class="hd"><span>Gem Digger · ${findings.length ? findings.length + ' flag' + (findings.length > 1 ? 's' : '') : 'clean'}</span><button title="Close">✕</button></div>
      ${rows}
    </div>`;
  const box = host.shadowRoot.querySelector('.box');
  host.shadowRoot.querySelector('.hd').addEventListener('click', () => box.classList.toggle('collapsed'));
  host.shadowRoot.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); dismissed.add(key); removePanel(); });
}

export function removePanel() {
  document.getElementById(PANEL_ID)?.remove();
}

const STRIP_CLASS = 'gem-digger-strip';

/** Grey out (or hide) a LinkedIn card and add a one-line reason strip. Idempotent. */
export function markCard(el, findings, config) {
  unmarkCard(el);
  if (!findings.length) return;
  const sev = worst(findings);
  el.dataset.gemSeverity = sev;
  if (sev === 'red' && config?.hideInsteadOfGrey) { el.style.display = 'none'; return; }
  el.style.opacity = sev === 'red' ? '0.45' : '1';
  el.style.borderLeft = `4px solid ${COLORS[sev]}`;
  const strip = document.createElement('div');
  strip.className = STRIP_CLASS;
  strip.style.cssText = `font: 11px system-ui; color: ${COLORS[sev]}; padding: 2px 8px 4px 12px;`;
  strip.textContent = findings.map((f) => f.sentence).join(' · ');
  el.appendChild(strip);
}

export function unmarkCard(el) {
  delete el.dataset.gemSeverity;
  el.style.opacity = '';
  el.style.borderLeft = '';
  el.style.display = '';
  el.querySelector(`.${STRIP_CLASS}`)?.remove();
  el.querySelector('.gem-digger-status')?.remove();
}

/** Small grey status text on a card (used by the scanner: "scanning…", "scan failed"). */
export function setCardStatus(el, text) {
  let s = el.querySelector('.gem-digger-status');
  if (!text) { s?.remove(); return; }
  if (!s) { s = document.createElement('div'); s.className = 'gem-digger-status'; s.style.cssText = 'font:11px system-ui;color:#888;padding:0 8px 4px 12px;'; el.appendChild(s); }
  s.textContent = text;
}
```

- [ ] **Step 5: `src/main.js`**

```js
import { loadConfig } from './config.js';
import { analyze } from './analyze.js';
import { analyzeCard, parseCardText } from './cards.js';
import { getJobText, getJobId, getCards, isLinkedInList } from './extract.js';
import { renderPanel, removePanel, markCard } from './render.js';

let config;
let timer = null;
let lastUrl = location.href;

function runDetail() {
  const text = getJobText();
  if (!text) { removePanel(); return; }
  renderPanel(analyze(text, config), { key: getJobId() ?? location.href });
}

function runCards() {
  if (!isLinkedInList()) return;
  for (const card of getCards()) {
    if (card.el.dataset.gemDeep) continue; // deep-scan result already applied (Task 7)
    const meta = { title: card.title, ...parseCardText(card.text) };
    markCard(card.el, analyzeCard(meta, config), config);
  }
}

export function rerun() {
  runCards();
  runDetail();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rerun, 500);
}

export async function init() {
  config = await loadConfig();

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync' && changes.config) { config = await loadConfig(); rerun(); }
    });
  }

  const mo = new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; removePanel(); }
    schedule();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.__gemDigger = { rerun, get config() { return config; } };
  schedule();
}
```

- [ ] **Step 6: Verify**

Run: `node --test test/` — still PASS (no new tests, nothing broken; all `src/` files must import cleanly under Node: run `node -e "import('./src/main.js')"` and confirm no exception — `document`/`location` are only touched inside functions).

Manual: `chrome://extensions` → Developer mode → Load unpacked → repo root. Open `https://jobs.lever.co/` any posting: panel appears bottom-right. Do **not** open LinkedIn in this task.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add manifest.json content.js popup/popup.html src/extract.js src/render.js src/main.js
/usr/bin/git commit -m "feat: DOM layer, panel, card marking, manifest" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MQNbQVRt4CzNv2VE3iUZkA"
```

---

### Task 5: LinkedIn detail fetcher

**Files:**
- Create: `src/linkedin-api.js`
- Test: `test/linkedin-api.test.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `class RateLimitError extends Error { status: number }`
  - `getCsrfToken(cookieString) → string|null`
  - `parseVoyager(json) → { text, applies, reposted }`
  - `parseGuestHtml(html) → { text, applies, reposted }`
  - `async fetchJobDetail(jobId, { fetch, cookie } = {}) → { jobId, text, applies, reposted, source: 'voyager'|'guest' }`; throws `RateLimitError` on 401/403/429 from Voyager **or** guest; throws plain `Error` when both fail otherwise.

- [ ] **Step 1: Write the failing tests**

`test/linkedin-api.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCsrfToken, parseVoyager, parseGuestHtml, fetchJobDetail, RateLimitError } from '../src/linkedin-api.js';

const VOYAGER = {
  description: { text: 'We need 5+ years of Go.\nMust be a U.S. citizen.' },
  applies: 142, listedAt: 1756000000000, originalListedAt: 1750000000000,
};
const GUEST = `<div class="show-more-less-html__markup">3+ years of <b>Rust</b>.<br>No sponsorship.</div>
<span class="posted-time-ago__text">Reposted 2 days ago</span>
<figcaption class="num-applicants__caption">Over 200 applicants</figcaption>`;

const res = (status, body, json = true) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => body,
});

test('getCsrfToken strips quotes from JSESSIONID', () => {
  assert.equal(getCsrfToken('li_at=abc; JSESSIONID="ajax:123456"; other=1'), 'ajax:123456');
  assert.equal(getCsrfToken('li_at=abc'), null);
});

test('parseVoyager reads text, applies, reposted', () => {
  assert.deepEqual(parseVoyager(VOYAGER), { text: 'We need 5+ years of Go.\nMust be a U.S. citizen.', applies: 142, reposted: true });
  assert.equal(parseVoyager({ ...VOYAGER, originalListedAt: VOYAGER.listedAt }).reposted, false);
  assert.equal(parseVoyager({ description: { text: 'x' } }).applies, null);
});

test('parseGuestHtml strips tags and reads capped applicants + reposted', () => {
  const r = parseGuestHtml(GUEST);
  assert.equal(r.text, '3+ years of Rust.\nNo sponsorship.');
  assert.equal(r.applies, 200);
  assert.equal(r.reposted, true);
});

test('fetchJobDetail uses Voyager with csrf header', async () => {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return res(200, VOYAGER); };
  const r = await fetchJobDetail('4242', { fetch, cookie: () => 'JSESSIONID="ajax:9"' });
  assert.equal(r.source, 'voyager');
  assert.equal(r.applies, 142);
  assert.equal(r.jobId, '4242');
  assert.equal(calls[0].url, 'https://www.linkedin.com/voyager/api/jobs/jobPostings/4242');
  assert.equal(calls[0].opts.headers['csrf-token'], 'ajax:9');
  assert.equal(calls[0].opts.credentials, 'include');
});

test('fetchJobDetail throws RateLimitError on 429/403/401 and does NOT fall back', async () => {
  for (const status of [429, 403, 401]) {
    let n = 0;
    const fetch = async () => { n++; return res(status, {}); };
    await assert.rejects(fetchJobDetail('1', { fetch, cookie: () => 'JSESSIONID="ajax:9"' }), (e) => e instanceof RateLimitError && e.status === status);
    assert.equal(n, 1);
  }
});

test('fetchJobDetail falls back to guest on other Voyager failure', async () => {
  const urls = [];
  const fetch = async (url) => { urls.push(url); return url.includes('voyager') ? res(500, {}) : res(200, GUEST, false); };
  const r = await fetchJobDetail('7', { fetch, cookie: () => 'JSESSIONID="ajax:9"' });
  assert.equal(r.source, 'guest');
  assert.equal(r.applies, 200);
  assert.equal(urls[1], 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/7');
});

test('fetchJobDetail goes straight to guest when no csrf token', async () => {
  const urls = [];
  const fetch = async (url) => { urls.push(url); return res(200, GUEST, false); };
  const r = await fetchJobDetail('7', { fetch, cookie: () => '' });
  assert.equal(r.source, 'guest');
  assert.equal(urls.length, 1);
});

test('fetchJobDetail throws plain Error when both fail', async () => {
  const fetch = async () => res(500, {});
  await assert.rejects(fetchJobDetail('7', { fetch, cookie: () => 'JSESSIONID="ajax:9"' }), (e) => !(e instanceof RateLimitError));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/linkedin-api.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/linkedin-api.js`**

```js
// Fetches one LinkedIn job posting. Called ONLY from scanner.scan() (user-initiated).
export class RateLimitError extends Error {
  constructor(status, source) { super(`LinkedIn ${source} responded ${status}`); this.name = 'RateLimitError'; this.status = status; this.source = source; }
}

const VOYAGER = (id) => `https://www.linkedin.com/voyager/api/jobs/jobPostings/${id}`;
const GUEST = (id) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;
const BLOCKED = new Set([401, 403, 429]);

export function getCsrfToken(cookieString) {
  const m = String(cookieString ?? '').match(/(?:^|;\s*)JSESSIONID=("?)([^;"]+)\1/);
  return m ? m[2] : null;
}

export function parseVoyager(json) {
  const text = json?.description?.text ?? '';
  const applies = typeof json?.applies === 'number' ? json.applies : null;
  const reposted = !!(json?.listedAt && json?.originalListedAt && json.listedAt !== json.originalListedAt);
  return { text, applies, reposted };
}

function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

export function parseGuestHtml(html) {
  const h = String(html ?? '');
  const desc = h.match(/<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
  const applicants = h.match(/num-applicants__caption[^>]*>([\s\S]*?)</i)?.[1] ?? '';
  const posted = h.match(/posted-time-ago__text[^>]*>([\s\S]*?)</i)?.[1] ?? '';
  const n = applicants.match(/\d+/);
  return {
    text: stripHtml(desc),
    applies: n ? parseInt(n[0], 10) : null,
    reposted: /reposted/i.test(posted),
  };
}

async function viaVoyager(jobId, fetchFn, token) {
  const r = await fetchFn(VOYAGER(jobId), {
    credentials: 'include',
    headers: {
      'csrf-token': token, accept: 'application/json',
      'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US',
    },
  });
  if (BLOCKED.has(r.status)) throw new RateLimitError(r.status, 'voyager');
  if (!r.ok) throw new Error(`voyager ${r.status}`);
  return { ...parseVoyager(await r.json()), source: 'voyager' };
}

async function viaGuest(jobId, fetchFn) {
  const r = await fetchFn(GUEST(jobId), { credentials: 'omit' });
  if (BLOCKED.has(r.status)) throw new RateLimitError(r.status, 'guest');
  if (!r.ok) throw new Error(`guest ${r.status}`);
  return { ...parseGuestHtml(await r.text()), source: 'guest' };
}

/**
 * Fetch description / applicant count / reposted flag for one job id.
 * Voyager first (logged-in, exact numbers); guest endpoint as fallback.
 * RateLimitError propagates immediately and never triggers the fallback.
 */
export async function fetchJobDetail(jobId, { fetch = globalThis.fetch, cookie = () => (typeof document !== 'undefined' ? document.cookie : '') } = {}) {
  const token = getCsrfToken(cookie());
  let firstError = null;
  if (token) {
    try {
      return { jobId, ...(await viaVoyager(jobId, fetch, token)) };
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      firstError = e;
    }
  }
  try {
    return { jobId, ...(await viaGuest(jobId, fetch)) };
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    throw new Error(`fetchJobDetail(${jobId}) failed: ${firstError?.message ?? ''} / ${e.message}`);
  }
}
```

- [ ] **Step 4: Run tests until green**

Run: `node --test test/linkedin-api.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/linkedin-api.js test/linkedin-api.test.js
/usr/bin/git commit -m "feat: LinkedIn job detail fetcher with guest fallback" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MQNbQVRt4CzNv2VE3iUZkA"
```

---

### Task 6: Scanner (throttle, cache, back-off)

**Files:**
- Create: `src/scanner.js`
- Test: `test/scanner.test.js`

**Interfaces:**
- Consumes: `analyze` (Task 2), `RateLimitError` (Task 5), `DEFAULTS` (Task 1).
- Produces:
  - `createMemoryCache() → Cache`, `createStorageCache() → Cache` where `Cache = { async get(id), async set(id, entry), async getBackoff() → { backoffMs, backoffUntil }, async setBackoff({ backoffMs, backoffUntil }), async clear(), async count() }`.
  - `createScanner({ fetchDetail, cache, analyzeText = analyze, config = DEFAULTS, now = Date.now, sleep, random = Math.random }) → { scan(cards, hooks) }`.
  - `scan(cards: Array<{ jobId, el? }>, { onResult(card, entry, fromCache), onProgress({ done, total }), signal? }) → Promise<{ scanned, cached, failed, aborted, rateLimited, backoffUntil }>`.
  - Cache entry shape: `{ ts, applies, reposted, findings }` where `findings` is the `analyze()` output for the description text.
  - `MIN_BACKOFF_MS = 5 * 60 * 1000`.

- [ ] **Step 1: Write the failing tests**

`test/scanner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScanner, createMemoryCache, MIN_BACKOFF_MS } from '../src/scanner.js';
import { RateLimitError } from '../src/linkedin-api.js';
import { DEFAULTS } from '../src/config.js';

const DAY = 86400000;

function harness({ detail = {}, clock = 1_000_000_000_000 } = {}) {
  const calls = [];
  const sleeps = [];
  let t = clock;
  const fetchDetail = async (id) => {
    calls.push(id);
    const d = detail[id];
    if (d instanceof Error) throw d;
    return { jobId: id, text: 'x', applies: 10, reposted: false, ...d };
  };
  const cache = createMemoryCache();
  const scanner = createScanner({
    fetchDetail, cache, config: DEFAULTS,
    analyzeText: (text) => (text.includes('5+') ? [{ id: 'yoe', severity: 'red', value: 5, sentence: text }] : []),
    now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, random: () => 0.5,
  });
  return { scanner, calls, sleeps, cache, tick: (ms) => { t += ms; } };
}

const cards = (...ids) => ids.map((jobId) => ({ jobId }));

test('scans serially, sleeps between network calls, reports progress and results', async () => {
  const h = harness({ detail: { a: { text: '5+ years' }, b: { applies: 150 } } });
  const results = []; const progress = [];
  const r = await h.scanner.scan(cards('a', 'b'), {
    onResult: (c, e, fromCache) => results.push([c.jobId, e.findings.length, e.applies, fromCache]),
    onProgress: (p) => progress.push(p.done),
  });
  assert.deepEqual(h.calls, ['a', 'b']);
  assert.deepEqual(results, [['a', 1, 10, false], ['b', 0, 150, false]]);
  assert.deepEqual(progress, [1, 2]);
  assert.deepEqual(h.sleeps, [1500]);            // one gap between two calls; jitter 0 at random()=0.5
  assert.deepEqual(r, { scanned: 2, cached: 0, failed: 0, aborted: false, rateLimited: false, backoffUntil: 0 });
});

test('jitter uses random()', async () => {
  const h = harness();
  const s = createScanner({ fetchDetail: async (id) => ({ jobId: id, text: '', applies: 0, reposted: false }), cache: createMemoryCache(),
    now: () => 0, sleep: async (ms) => h.sleeps.push(ms), random: () => 1 });
  await s.scan(cards('a', 'b'), {});
  assert.deepEqual(h.sleeps, [2000]);            // 1500 + (1*2-1)*500
});

test('cache hits skip the network and do not sleep', async () => {
  const h = harness();
  await h.scanner.scan(cards('a'), {});
  h.calls.length = 0; h.sleeps.length = 0;
  const results = [];
  const r = await h.scanner.scan(cards('a', 'b'), { onResult: (c, e, fromCache) => results.push([c.jobId, fromCache]) });
  assert.deepEqual(h.calls, ['b']);
  assert.deepEqual(results, [['a', true], ['b', false]]);
  assert.deepEqual(h.sleeps, []);
  assert.equal(r.cached, 1); assert.equal(r.scanned, 1);
});

test('cache entries expire after cacheTtlDays', async () => {
  const h = harness();
  await h.scanner.scan(cards('a'), {});
  h.tick(8 * DAY);
  await h.scanner.scan(cards('a'), {});
  assert.deepEqual(h.calls, ['a', 'a']);
});

test('non-rate-limit errors are counted as failed and scanning continues', async () => {
  const h = harness({ detail: { a: new Error('boom') } });
  const r = await h.scanner.scan(cards('a', 'b'), {});
  assert.deepEqual(h.calls, ['a', 'b']);
  assert.equal(r.failed, 1); assert.equal(r.scanned, 1);
});

test('RateLimitError aborts, sets back-off ≥ 5 min, doubles on repeat, blocks next scan', async () => {
  const h = harness({ detail: { a: new RateLimitError(429, 'voyager') } });
  const r1 = await h.scanner.scan(cards('a', 'b'), {});
  assert.deepEqual(h.calls, ['a']);
  assert.equal(r1.rateLimited, true); assert.equal(r1.aborted, true);
  assert.equal(r1.backoffUntil, 1_000_000_000_000 + MIN_BACKOFF_MS);

  const r2 = await h.scanner.scan(cards('b'), {});   // still inside back-off window
  assert.equal(r2.rateLimited, true); assert.deepEqual(h.calls, ['a']);

  h.tick(MIN_BACKOFF_MS + 1);
  const r3 = await h.scanner.scan(cards('a'), {});   // limited again → doubled
  assert.equal(r3.backoffUntil - (1_000_000_000_000 + MIN_BACKOFF_MS + 1), 2 * MIN_BACKOFF_MS);
});

test('a successful call resets the back-off multiplier', async () => {
  const h = harness();
  await h.cache.setBackoff({ backoffMs: 4 * MIN_BACKOFF_MS, backoffUntil: 0 });
  await h.scanner.scan(cards('a'), {});
  assert.deepEqual(await h.cache.getBackoff(), { backoffMs: 0, backoffUntil: 0 });
});

test('abort signal stops between cards', async () => {
  const h = harness();
  const ac = new AbortController();
  const r = await h.scanner.scan(cards('a', 'b', 'c'), { onResult: () => ac.abort(), signal: ac.signal });
  assert.deepEqual(h.calls, ['a']);
  assert.equal(r.aborted, true); assert.equal(r.rateLimited, false);
});

test('cards without jobId are skipped', async () => {
  const h = harness();
  const r = await h.scanner.scan([{ jobId: null }, { jobId: 'a' }], {});
  assert.deepEqual(h.calls, ['a']); assert.equal(r.scanned, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scanner.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/scanner.js`**

```js
import { analyze } from './analyze.js';
import { RateLimitError } from './linkedin-api.js';
import { DEFAULTS } from './config.js';

export const MIN_BACKOFF_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;
const STORE_PREFIX = 'job:';
const BACKOFF_KEY = 'backoff';

export function createMemoryCache() {
  const m = new Map();
  let backoff = { backoffMs: 0, backoffUntil: 0 };
  return {
    async get(id) { return m.get(id); },
    async set(id, entry) { m.set(id, entry); },
    async getBackoff() { return { ...backoff }; },
    async setBackoff(b) { backoff = { ...b }; },
    async clear() { m.clear(); backoff = { backoffMs: 0, backoffUntil: 0 }; },
    async count() { return m.size; },
  };
}

/** chrome.storage.local-backed cache. Only used in the extension; never imported by tests. */
export function createStorageCache(area = chrome.storage.local) {
  return {
    async get(id) { return (await area.get(STORE_PREFIX + id))[STORE_PREFIX + id]; },
    async set(id, entry) { await area.set({ [STORE_PREFIX + id]: entry }); },
    async getBackoff() { return (await area.get(BACKOFF_KEY))[BACKOFF_KEY] ?? { backoffMs: 0, backoffUntil: 0 }; },
    async setBackoff(b) { await area.set({ [BACKOFF_KEY]: b }); },
    async clear() {
      const all = await area.get(null);
      await area.remove(Object.keys(all).filter((k) => k.startsWith(STORE_PREFIX) || k === BACKOFF_KEY));
    },
    async count() { return Object.keys(await area.get(null)).filter((k) => k.startsWith(STORE_PREFIX)).length; },
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serial, jittered, cached scanner. The ONLY code path that fetches job details.
 */
export function createScanner({
  fetchDetail, cache, analyzeText = analyze, config = DEFAULTS,
  now = Date.now, sleep = defaultSleep, random = Math.random,
}) {
  const ttl = () => (config.scan?.cacheTtlDays ?? 7) * DAY_MS;
  const gap = () => (config.scan?.intervalMs ?? 1500) + (random() * 2 - 1) * (config.scan?.jitterMs ?? 500);

  async function scan(cards, { onResult = () => {}, onProgress = () => {}, signal } = {}) {
    const list = cards.filter((c) => c.jobId);
    const total = list.length;
    const summary = { scanned: 0, cached: 0, failed: 0, aborted: false, rateLimited: false, backoffUntil: 0 };

    const bo = await cache.getBackoff();
    if (bo.backoffUntil > now()) return { ...summary, rateLimited: true, aborted: true, backoffUntil: bo.backoffUntil };

    let done = 0;
    let networkCalls = 0;
    for (const card of list) {
      if (signal?.aborted) { summary.aborted = true; break; }

      const hit = await cache.get(card.jobId);
      if (hit && now() - hit.ts < ttl()) {
        summary.cached++; done++;
        await onResult(card, hit, true);
        onProgress({ done, total });
        continue;
      }

      if (networkCalls > 0) await sleep(gap());
      networkCalls++;
      try {
        const d = await fetchDetail(card.jobId);
        const entry = { ts: now(), applies: d.applies ?? null, reposted: !!d.reposted, findings: analyzeText(d.text ?? '', config) };
        await cache.set(card.jobId, entry);
        await cache.setBackoff({ backoffMs: 0, backoffUntil: 0 });
        summary.scanned++; done++;
        await onResult(card, entry, false);
        onProgress({ done, total });
      } catch (e) {
        if (e instanceof RateLimitError) {
          const prev = (await cache.getBackoff()).backoffMs;
          const backoffMs = Math.max(MIN_BACKOFF_MS, prev * 2);
          const backoffUntil = now() + backoffMs;
          await cache.setBackoff({ backoffMs, backoffUntil });
          return { ...summary, rateLimited: true, aborted: true, backoffUntil };
        }
        summary.failed++; done++;
        onProgress({ done, total });
      }
    }
    return summary;
  }

  return { scan };
}
```

- [ ] **Step 4: Run tests until green**

Run: `node --test test/scanner.test.js`
Expected: PASS (9 tests). Watch the doubling test: after the first limit `backoffMs = MIN`, second limit `backoffMs = 2·MIN`.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/scanner.js test/scanner.test.js
/usr/bin/git commit -m "feat: throttled cached scanner with back-off" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MQNbQVRt4CzNv2VE3iUZkA"
```

---

### Task 7: Popup, scan wiring, README

**Files:**
- Create: `popup/popup.html`, `popup/popup.js` (replace the Task 4 placeholder)
- Modify: `src/main.js` (add message handling + deep-scan application)
- Create: `README.md`
- Test: `node --test test/` stays green; `node -e "import('./src/main.js')"` still loads. Manual: popup opens, thresholds persist across reopen, on a Lever page the panel updates when YOE threshold changes. **Do not run a real scan on LinkedIn in this task**; that is the orchestrator's single supervised e2e.

**Interfaces:**
- Consumes: everything above.
- Produces: message protocol between popup and content script (all via `chrome.tabs.sendMessage` to the active tab / `chrome.runtime.onMessage` in `main.js`):
  - `{ type: 'gem:status' }` → `{ isList, cards, backoffUntil, cacheCount }`
  - `{ type: 'gem:scan' }` → starts scan; replies `{ started: true }` or `{ started: false, reason }`; progress is pushed with `chrome.runtime.sendMessage({ type: 'gem:progress', done, total })` and completion with `{ type: 'gem:done', summary }`.
  - `{ type: 'gem:cancel' }` → aborts the running scan.
  - `{ type: 'gem:clear-cache' }` → `{ ok: true }`.

- [ ] **Step 1: `popup/popup.html`**

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Gem Digger</title>
<style>
  body { width: 300px; margin: 0; padding: 12px; font: 13px/1.4 system-ui, sans-serif; color: #222; }
  h1 { font-size: 14px; margin: 0 0 8px; }
  fieldset { border: 1px solid #ddd; border-radius: 6px; margin: 0 0 10px; padding: 8px 10px; }
  legend { font-weight: 600; font-size: 12px; color: #555; }
  label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 4px 0; }
  input[type=number] { width: 90px; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; }
  .row { display: flex; gap: 6px; }
  button { flex: 1; padding: 6px; border-radius: 6px; border: 1px solid #bbb; background: #f7f7f7; cursor: pointer; }
  button.primary { background: #0a66c2; color: #fff; border-color: #0a66c2; }
  button:disabled { opacity: .5; cursor: default; }
  progress { width: 100%; }
  #status { font-size: 12px; color: #555; min-height: 16px; }
  .muted { color: #888; font-size: 11px; }
</style></head>
<body>
<h1>Linkedin Gem Digger</h1>

<fieldset><legend>Thresholds</legend>
  <label>Grey if YOE ≥ <input type="number" id="yoeThreshold" min="0" max="30"></label>
  <label>Grey if max salary &lt; $ <input type="number" id="salaryFloor" min="0" step="1000"></label>
  <label>Grey if applicants ≥ <input type="number" id="applicantsMax" min="0"></label>
</fieldset>

<fieldset><legend>Posting text rules</legend>
  <label>Years of experience <input type="checkbox" data-rule="yoe"></label>
  <label>US citizenship <input type="checkbox" data-rule="citizenship"></label>
  <label>Security clearance / ITAR <input type="checkbox" data-rule="clearance"></label>
  <label>No sponsorship / H-1B <input type="checkbox" data-rule="sponsorship"></label>
  <label>Degree required (info) <input type="checkbox" data-rule="degree"></label>
  <label>Reposted <input type="checkbox" data-rule="reposted"></label>
  <label>&nbsp;&nbsp;treat Reposted as red <input type="checkbox" id="repostedIsRed"></label>
</fieldset>

<fieldset><legend>LinkedIn card rules</legend>
  <label>Seniority in title <input type="checkbox" data-rule="title-seniority"></label>
  <textarea id="titleGreylist" rows="2" placeholder="Senior, Staff, ..."></textarea>
  <label>Low salary <input type="checkbox" data-rule="salary-max"></label>
  <label>Already viewed <input type="checkbox" data-rule="viewed"></label>
  <label>Promoted <input type="checkbox" data-rule="promoted"></label>
  <label>100+ applicants (needs scan) <input type="checkbox" data-rule="applicants"></label>
  <label>Hide instead of grey <input type="checkbox" id="hideInsteadOfGrey"></label>
</fieldset>

<fieldset><legend>Deep scan (LinkedIn list)</legend>
  <div class="muted">Fetches each visible card's posting, one at a time, ~1.5 s apart. Cached 7 days.</div>
  <div class="row" style="margin-top:6px">
    <button id="scan" class="primary">Scan visible cards</button>
    <button id="cancel" disabled>Cancel</button>
  </div>
  <progress id="progress" value="0" max="1" hidden></progress>
  <div id="status"></div>
  <div class="row" style="margin-top:6px"><button id="clear">Clear cache</button></div>
</fieldset>
<script type="module" src="popup.js"></script>
</body></html>
```

- [ ] **Step 2: `popup/popup.js`**

```js
import { loadConfig, saveConfig, DEFAULTS } from '../src/config.js';

const $ = (id) => document.getElementById(id);
let config;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function send(msg) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch { return null; }
}

function fill() {
  $('yoeThreshold').value = config.yoeThreshold;
  $('salaryFloor').value = config.salaryFloor;
  $('applicantsMax').value = config.applicantsMax;
  $('repostedIsRed').checked = config.repostedIsRed;
  $('hideInsteadOfGrey').checked = config.hideInsteadOfGrey;
  $('titleGreylist').value = config.titleGreylist.join(', ');
  for (const el of document.querySelectorAll('[data-rule]')) el.checked = !!config.rules[el.dataset.rule];
}

function read() {
  const num = (id, fallback) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : fallback; };
  const rules = { ...config.rules };
  for (const el of document.querySelectorAll('[data-rule]')) rules[el.dataset.rule] = el.checked;
  return {
    ...config,
    yoeThreshold: num('yoeThreshold', DEFAULTS.yoeThreshold),
    salaryFloor: num('salaryFloor', DEFAULTS.salaryFloor),
    applicantsMax: num('applicantsMax', DEFAULTS.applicantsMax),
    repostedIsRed: $('repostedIsRed').checked,
    hideInsteadOfGrey: $('hideInsteadOfGrey').checked,
    titleGreylist: $('titleGreylist').value.split(',').map((s) => s.trim()).filter(Boolean),
    rules,
  };
}

function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

async function refreshStatus() {
  const s = await send({ type: 'gem:status' });
  const scan = $('scan');
  if (!s) { $('status').textContent = 'Open a LinkedIn jobs search to scan.'; scan.disabled = true; return; }
  if (!s.isList) { $('status').textContent = `Not a list page. Cache: ${s.cacheCount} jobs.`; scan.disabled = true; return; }
  if (s.backoffUntil > Date.now()) { $('status').textContent = `Rate-limited by LinkedIn. Try after ${fmtTime(s.backoffUntil)}.`; scan.disabled = true; return; }
  $('status').textContent = `${s.cards} cards on page · cache: ${s.cacheCount} jobs.`;
  scan.disabled = s.cards === 0;
}

function setScanning(on) {
  $('scan').disabled = on; $('cancel').disabled = !on; $('progress').hidden = !on;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'gem:progress') { $('progress').max = msg.total; $('progress').value = msg.done; $('status').textContent = `Scanning ${msg.done} / ${msg.total}…`; }
  if (msg?.type === 'gem:done') {
    setScanning(false);
    const s = msg.summary;
    $('status').textContent = s.rateLimited
      ? `Rate-limited. Stopped. Try after ${fmtTime(s.backoffUntil)}.`
      : `Done: ${s.scanned} fetched, ${s.cached} cached, ${s.failed} failed${s.aborted ? ', cancelled' : ''}.`;
  }
});

(async function main() {
  config = await loadConfig();
  fill();
  document.body.addEventListener('change', async () => { config = read(); await saveConfig(config); });
  $('scan').addEventListener('click', async () => {
    setScanning(true);
    const r = await send({ type: 'gem:scan' });
    if (!r?.started) { setScanning(false); $('status').textContent = r?.reason ?? 'Could not start scan.'; }
  });
  $('cancel').addEventListener('click', () => send({ type: 'gem:cancel' }));
  $('clear').addEventListener('click', async () => { await send({ type: 'gem:clear-cache' }); refreshStatus(); });
  refreshStatus();
})();
```

- [ ] **Step 3: Extend `src/main.js`**

Replace the whole file with:

```js
import { loadConfig } from './config.js';
import { analyze } from './analyze.js';
import { analyzeCard, parseCardText } from './cards.js';
import { getJobText, getJobId, getCards, isLinkedInList } from './extract.js';
import { renderPanel, removePanel, markCard, setCardStatus } from './render.js';
import { fetchJobDetail } from './linkedin-api.js';
import { createScanner, createStorageCache } from './scanner.js';

let config;
let timer = null;
let lastUrl = location.href;
let cache = null;
let abort = null;
const deep = new Map(); // jobId → cache entry applied to a card this page-life

function cardFindings(card) {
  const meta = { title: card.title, ...parseCardText(card.text) };
  const d = card.jobId ? deep.get(card.jobId) : null;
  if (d) {
    if (d.applies != null) meta.applies = d.applies;
    if (d.reposted) meta.reposted = true;
  }
  const findings = analyzeCard(meta, config);
  if (d?.findings?.length) {
    for (const f of d.findings) if (config.rules?.[f.id] ?? true) findings.push({ ...f, sentence: f.id === 'yoe' ? `${f.value}+ yrs` : (f.category ?? f.id) });
  }
  return findings;
}

function runDetail() {
  const text = getJobText();
  if (!text) { removePanel(); return; }
  renderPanel(analyze(text, config), { key: getJobId() ?? location.href });
}

function runCards() {
  if (!isLinkedInList()) return;
  for (const card of getCards()) markCard(card.el, cardFindings(card), config);
}

export function rerun() { runCards(); runDetail(); }

function schedule() { clearTimeout(timer); timer = setTimeout(rerun, 500); }

async function startScan() {
  if (!isLinkedInList()) return { started: false, reason: 'Not a LinkedIn list page.' };
  if (abort) return { started: false, reason: 'Scan already running.' };
  const cards = getCards();
  if (!cards.length) return { started: false, reason: 'No cards found on page.' };

  abort = new AbortController();
  const scanner = createScanner({ fetchDetail: fetchJobDetail, cache, config });
  for (const c of cards) if (c.jobId && !deep.has(c.jobId)) setCardStatus(c.el, 'queued…');

  scanner.scan(cards, {
    signal: abort.signal,
    onProgress: (p) => chrome.runtime.sendMessage({ type: 'gem:progress', ...p }).catch(() => {}),
    onResult: (card, entry) => {
      deep.set(card.jobId, entry);
      setCardStatus(card.el, '');
      markCard(card.el, cardFindings(card), config);
    },
  }).then((summary) => {
    for (const c of cards) setCardStatus(c.el, '');
    chrome.runtime.sendMessage({ type: 'gem:done', summary }).catch(() => {});
  }).finally(() => { abort = null; });

  return { started: true };
}

function onMessage(msg, _sender, reply) {
  (async () => {
    switch (msg?.type) {
      case 'gem:status': {
        const bo = await cache.getBackoff();
        return { isList: isLinkedInList(), cards: getCards().length, backoffUntil: bo.backoffUntil, cacheCount: await cache.count() };
      }
      case 'gem:scan': return startScan();
      case 'gem:cancel': abort?.abort(); return { ok: true };
      case 'gem:clear-cache': await cache.clear(); deep.clear(); rerun(); return { ok: true };
      default: return undefined;
    }
  })().then(reply, (e) => reply({ error: String(e) }));
  return true; // keep the channel open for the async reply
}

export async function init() {
  config = await loadConfig();
  cache = createStorageCache();

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync' && changes.config) { config = await loadConfig(); rerun(); }
  });
  chrome.runtime.onMessage.addListener(onMessage);

  const mo = new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; removePanel(); }
    schedule();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.__gemDigger = { rerun, get config() { return config; } };
  schedule();
}
```

Note: `markCard` from Task 4 clears any strip; `setCardStatus` adds a separate status line so "queued…" and the reason strip coexist. Task 4's `unmarkCard` also removes `.gem-digger-status`, so `markCard` after a result wipes the status — that is intended.

- [ ] **Step 4: `README.md`**

```markdown
# Linkedin Gem Digger

Chrome extension that flags the deal-breakers in a job posting before you read it:
years-of-experience above your threshold, US-citizenship / security-clearance
requirements, "no sponsorship", and (on LinkedIn search results) seniority in the title,
low salary, already-viewed, reposted and 100+ applicants.

Works on LinkedIn Jobs and on Ashby, Greenhouse, Lever, Workday, SmartRecruiters,
Wellfound, Workable, Jobvite, iCIMS and Rippling posting pages. Everything runs locally;
nothing leaves your browser.

## Install (unpacked)

1. `git clone https://github.com/ChiChasesCheese/Linkedin-Gem-Digger`
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the repo folder.
3. Open any job posting. A panel appears bottom-right with the flags it found (green = clean).

## LinkedIn list pages

Cards are greyed automatically from what the card itself shows (title, salary, Viewed…).
Click the extension icon → **Scan visible cards** to also fetch each visible posting
(one at a time, ~1.5 s apart, cached for 7 days) for YOE / citizenship / applicant count.
If LinkedIn ever answers 429/403 the scan stops and backs off for at least 5 minutes.

## Configure

Extension icon → thresholds, rule toggles, title greylist, grey-vs-hide.

## Develop

- `npm test` — pure logic (`analyze`, `analyzeCard`, salary parser, scanner throttle/cache/back-off).
- Add a rule: one entry in `src/rules.js`. Change where text comes from: `src/extract.js`. Change how it looks: `src/render.js`.
- Design: `docs/superpowers/specs/`, plan: `docs/superpowers/plans/`.

Not affiliated with LinkedIn. MIT.
```

- [ ] **Step 5: Verify**

Run: `node --test test/` → PASS. Run: `node -e "import('./src/main.js').then(()=>console.log('ok'))"` → prints `ok`.
Manual (no LinkedIn): reload unpacked extension, open popup, change YOE threshold to 10, open a Lever posting with "3+ years" → panel shows clean; set back to 2 → panel shows YOE flag.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add popup/ src/main.js README.md
/usr/bin/git commit -m "feat: popup settings, deep-scan wiring, README" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MQNbQVRt4CzNv2VE3iUZkA"
```

---

## Orchestrator-only: supervised LinkedIn e2e (after Task 7)

Not a subagent task. Performed once by the orchestrator with the user's Chrome profile:

1. Reload the unpacked extension.
2. Open one LinkedIn jobs search page. Confirm cards are greyed with reason strips (title / salary / viewed). Take a screenshot.
3. Click one card. Confirm the panel shows YOE / other flags for that posting. Screenshot.
4. Open the popup. Confirm status shows N cards. Click **Scan visible cards** exactly once. Watch progress. Confirm applicants / YOE strips appear. Screenshot. Do not scan again.
5. If any 429/403 appears: stop, record, do not retry.
