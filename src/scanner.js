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
