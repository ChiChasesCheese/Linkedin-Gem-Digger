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
