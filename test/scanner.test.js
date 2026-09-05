import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScanner, createMemoryCache, MIN_BACKOFF_MS, LOCK_TTL_MS } from '../src/scanner.js';
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
  return { scanner, calls, sleeps, cache, tick: (ms) => { t += ms; }, now: () => t };
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
  assert.deepEqual(r, { scanned: 2, cached: 0, failed: 0, aborted: false, rateLimited: false, backoffUntil: 0, locked: false });
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

test('onResult throwing on a network result does not lose the summary or double-count', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const h = harness();
  let calls = 0;
  const r = await h.scanner.scan(cards('a', 'b'), {
    onResult: () => { calls++; if (calls === 1) throw new Error('boom'); },
  });
  assert.deepEqual(h.calls, ['a', 'b']);
  assert.equal(r.scanned, 2);
  assert.equal(r.failed, 0);
});

test('onResult throwing on a cache-hit card still resolves with the correct cached count', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const h = harness();
  await h.scanner.scan(cards('a'), {});
  h.calls.length = 0;
  const r = await h.scanner.scan(cards('a'), { onResult: () => { throw new Error('boom'); } });
  assert.deepEqual(h.calls, []);
  assert.equal(r.cached, 1);
});

test('onProgress throwing does not affect counters or loop continuation', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const h = harness();
  const r = await h.scanner.scan(cards('a', 'b'), { onProgress: () => { throw new Error('boom'); } });
  assert.deepEqual(h.calls, ['a', 'b']);
  assert.equal(r.scanned, 2);
  assert.equal(r.failed, 0);
});

test('a fresh lock held by another scanner blocks the scan with zero fetches', async () => {
  const cache = createMemoryCache();
  const calls2 = [];
  // scanner1 and scanner2 share the same cache (simulating two tabs) but use different
  // `random` values, so they would generate different lock tokens.
  createScanner({ fetchDetail: async () => ({ text: '', applies: 0, reposted: false }), cache, config: DEFAULTS,
    now: () => 1_000_000_000_000, sleep: async () => {}, random: () => 0.1 });
  const scanner2 = createScanner({ fetchDetail: async (id) => { calls2.push(id); return { text: '', applies: 0, reposted: false }; }, cache, config: DEFAULTS,
    now: () => 1_000_000_000_000, sleep: async () => {}, random: () => 0.9 });

  // Simulate scanner1 currently holding a fresh lock (e.g. mid-scan in another tab).
  await cache.setLock({ token: `${0.1}:1000000000000`, ts: 1_000_000_000_000 });

  const r2 = await scanner2.scan(cards('b'), {});
  assert.equal(r2.locked, true);
  assert.equal(r2.aborted, true);
  assert.deepEqual(calls2, []);
});

test('a stale lock (older than LOCK_TTL_MS) is overridden and the scan proceeds', async () => {
  const h = harness();
  await h.cache.setLock({ token: 'other-tab', ts: h.now() - (LOCK_TTL_MS + 1) });
  const r = await h.scanner.scan(cards('a'), {});
  assert.deepEqual(h.calls, ['a']);
  assert.equal(r.locked, false);
  assert.equal(r.aborted, false);
});

test('the lock is cleared after a normal scan completes', async () => {
  const h = harness();
  const r = await h.scanner.scan(cards('a'), {});
  assert.equal(r.locked, false);
  assert.equal(await h.cache.getLock(), undefined);
});

test('a lock stolen mid-scan (fetchDetail side effect) stops the scan before the next fetch', async () => {
  const cache = createMemoryCache();
  const calls = [];
  let t = 1_000_000_000_000;
  const fetchDetail = async (id) => {
    calls.push(id);
    if (id === 'a') await cache.setLock({ token: 'thief', ts: t });
    return { jobId: id, text: '', applies: 0, reposted: false };
  };
  const scanner = createScanner({
    fetchDetail, cache, config: DEFAULTS,
    now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0.5,
  });
  const r = await scanner.scan(cards('a', 'b'), {});
  assert.deepEqual(calls, ['a']);
  assert.equal(r.locked, true);
  assert.equal(r.aborted, true);
});
