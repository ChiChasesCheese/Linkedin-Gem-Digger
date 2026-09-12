import { analyze } from './analyze.js';
import { RateLimitError } from './linkedin-api.js';
import { DEFAULTS } from './config.js';

export const MIN_BACKOFF_MS = 5 * 60 * 1000;
/** How long a scan lock is honored before it's considered abandoned (e.g. a tab crashed mid-scan). */
export const LOCK_TTL_MS = 2 * 60 * 1000;
const DAY_MS = 86_400_000;
const STORE_PREFIX = 'job:';
const BACKOFF_KEY = 'backoff';
const LOCK_KEY = 'lock';

export function createMemoryCache() {
  const m = new Map();
  let backoff = { backoffMs: 0, backoffUntil: 0 };
  let lock;
  return {
    async get(id) { return m.get(id); },
    async set(id, entry) { m.set(id, entry); },
    async getBackoff() { return { ...backoff }; },
    async setBackoff(b) { backoff = { ...b }; },
    async getLock() { return lock ? { ...lock } : undefined; },
    async setLock(l) { lock = { ...l }; },
    async clearLock() { lock = undefined; },
    async clear() { m.clear(); backoff = { backoffMs: 0, backoffUntil: 0 }; lock = undefined; },
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
    async getLock() { return (await area.get(LOCK_KEY))[LOCK_KEY]; },
    async setLock(l) { await area.set({ [LOCK_KEY]: l }); },
    async clearLock() { await area.remove(LOCK_KEY); },
    async clear() {
      const all = await area.get(null);
      await area.remove(Object.keys(all).filter((k) => k.startsWith(STORE_PREFIX) || k === BACKOFF_KEY || k === LOCK_KEY));
    },
    async count() { return Object.keys(await area.get(null)).filter((k) => k.startsWith(STORE_PREFIX)).length; },
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a caller-supplied hook (onResult/onProgress) without letting it affect the scan. */
async function safeCall(fn, ...args) {
  try { await fn(...args); } catch (e) { console.warn('[gem-digger] scan hook failed', e); }
}

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
    const summary = { scanned: 0, cached: 0, failed: 0, aborted: false, rateLimited: false, backoffUntil: 0, locked: false };

    const bo = await cache.getBackoff();
    if (bo.backoffUntil > now()) return { ...summary, rateLimited: true, aborted: true, backoffUntil: bo.backoffUntil };

    // A shared lock prevents two tabs from scanning the same account concurrently
    // (which would double the request rate against LinkedIn).
    const token = String(random()) + ':' + now();
    const existingLock = await cache.getLock();
    if (existingLock && existingLock.token !== token && now() - existingLock.ts < LOCK_TTL_MS) {
      return { ...summary, aborted: true, locked: true };
    }
    await cache.setLock({ token, ts: now() });

    let done = 0;
    let networkCalls = 0;
    try {
      for (const card of list) {
        if (signal?.aborted) { summary.aborted = true; break; }

        const hit = await cache.get(card.jobId);
        if (hit && now() - hit.ts < ttl()) {
          summary.cached++; done++;
          await safeCall(onResult, card, hit, true);
          await safeCall(onProgress, { done, total });
          continue;
        }

        if (networkCalls > 0) await sleep(gap());

        // Re-check the lock right before every network call: if another tab has taken
        // it (its token no longer matches ours), stop immediately without fetching.
        const currentLock = await cache.getLock();
        if (!currentLock || currentLock.token !== token) {
          summary.locked = true; summary.aborted = true; break;
        }

        networkCalls++;
        let entry;
        try {
          const d = await fetchDetail(card.jobId);
          entry = { ts: now(), applies: d.applies ?? null, reposted: !!d.reposted, findings: analyzeText(d.text ?? '', config) };
          await cache.set(card.jobId, entry);
          // Reset the back-off multiplier on success. A concurrent-tab race that could
          // otherwise double the request rate is now prevented by the lock above.
          await cache.setBackoff({ backoffMs: 0, backoffUntil: 0 });
          // Heartbeat: refresh the lock's timestamp, but only if we still hold it.
          const stillOurs = await cache.getLock();
          if (stillOurs?.token === token) await cache.setLock({ token, ts: now() });
        } catch (e) {
          if (e instanceof RateLimitError) {
            const prev = (await cache.getBackoff()).backoffMs;
            const backoffMs = Math.max(MIN_BACKOFF_MS, prev * 2);
            const backoffUntil = now() + backoffMs;
            await cache.setBackoff({ backoffMs, backoffUntil });
            return { ...summary, rateLimited: true, aborted: true, backoffUntil };
          }
          summary.failed++; done++;
          await safeCall(onProgress, { done, total });
          continue;
        }
        summary.scanned++; done++;
        await safeCall(onResult, card, entry, false);
        await safeCall(onProgress, { done, total });
      }
    } finally {
      const finalLock = await cache.getLock();
      if (finalLock?.token === token) await cache.clearLock();
    }
    return summary;
  }

  return { scan };
}
