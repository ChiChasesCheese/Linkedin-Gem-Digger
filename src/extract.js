// All DOM *reads* live here. Nothing in this file writes to the page.

// getDoc() is called many times per rerun pass (once per DOM read in this file); memoize its
// result for a short window so repeated calls within one synchronous pass don't repeat the
// querySelector + document probe. A rerun pass finishes well under 250ms; the next debounced
// rerun (500ms later, see main.js's schedule()) recomputes.
let cachedDoc = null;
let cachedDocTs = -Infinity;

/**
 * The document that actually holds the job UI: LinkedIn's SPA shell ("interop" mode) hosts the
 * classic Ember pages inside a same-origin `<iframe src=".../preload/...">` (itself inside a
 * shadow host), while the top document renders nothing. But the shell keeps that iframe around
 * (with just the global nav in it, ~3k chars of text) even when a page — e.g. the newer SDUI
 * `/jobs/search-results/` split view — renders in the top document, so "populated" is not enough:
 * prefer the iframe's document only when it actually holds job UI (a card list or a posting),
 * otherwise fall back to the top document (classic layout, SDUI layout, or a hard-reloaded page).
 */
export function getDoc() {
  const now = performance.now();
  if (cachedDoc && now - cachedDocTs < 250) return cachedDoc;
  let result = document;
  try {
    const f = document.querySelector('iframe[src*="/preload/"]');
    const d = f?.contentDocument;
    if (d && d.body && d.readyState !== 'loading' && hasJobUi(d)) result = d;
  } catch { /* cross-origin or detached */ }
  cachedDoc = result;
  cachedDocTs = now;
  return result;
}

/** True when `root` contains a job card list or a job posting (no layout forced: querySelector only). */
function hasJobUi(root) {
  if (root.querySelector(CARD_SELECTOR) || root.querySelector(LI_DETAIL_SELECTOR)) return true;
  for (const h of root.querySelectorAll('h1, h2, h3, h4')) if (ABOUT_RE.test(h.textContent || '')) return true;
  return false;
}

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
const LI_DETAIL_SELECTOR = LI_DETAIL_SELECTORS.join(', ');

// The newer server-driven ("SDUI") search UI has hashed class names and no data-job-id; its card
// wrapper carries `componentkey="job-card-component-ref-<jobId>"` instead (on two nested divs —
// getCards() de-dupes by job id, so the outer one wins).
const SDUI_CARD_KEY = 'job-card-component-ref-';
const CARD_SELECTORS = [
  'li[data-occludable-job-id]',
  'div[data-job-id]',
  `[componentkey^="${SDUI_CARD_KEY}"]`,
  'li.jobs-search-results__list-item',
  'li.scaffold-layout__list-item',
];
const CARD_SELECTOR = CARD_SELECTORS.join(', ');

function firstText(selectors, root = getDoc()) {
  for (const s of selectors) {
    const el = root.querySelector(s);
    const t = el?.innerText?.trim();
    if (t && t.length > 80) return t;
  }
  return '';
}

const ABOUT_RE = /^\s*about the job\s*$/i;

/**
 * Container of the posting anchored on an "About the job" heading, or null.
 * LinkedIn's newer /jobs/view/<id>/ layout uses hashed class names that don't match
 * LI_DETAIL_SELECTORS, so we climb from that heading looking for an ancestor whose
 * innerText is long enough to be the whole posting (title, meta, salary, description)
 * without also picking up unrelated page chrome.
 *
 * Two guards:
 *  - A page can render more than one matching heading (e.g. a "Similar jobs" card
 *    also headed "About the job"); if the first heading's ancestor chain never
 *    reaches the length threshold, try the next heading rather than giving up.
 *  - On the search-results split view, walking up from the detail-pane heading can
 *    escape into an ancestor that also contains the card list. If a candidate
 *    ancestor contains a job card, abandon this heading's chain (don't keep
 *    climbing past the card list) and try the next heading instead.
 */
function headingAnchoredContainer() {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
  const headings = [...getDoc().querySelectorAll('h1, h2, h3, h4')].filter(
    (e) => ABOUT_RE.test(e.textContent || '') && visible(e)
  );
  for (const h of headings) {
    let el = h.parentElement ?? null;
    let steps = 0;
    while (el && steps < 6) {
      if (el.querySelector(CARD_SELECTOR)) break; // escaped into the card list; try the next heading
      if (!visible(el)) { el = el.parentElement; continue; } // doesn't count against the climb budget
      steps++;
      const len = (el.innerText || '').trim().length;
      if (len >= 300) return el;
      el = el.parentElement;
    }
  }
  return null;
}

/** JD text for the posting the user is looking at. Empty string if nothing usable. */
export function getJobText() {
  if (isLinkedIn()) {
    const anchored = headingAnchoredContainer()?.innerText?.trim();
    if (anchored && anchored.length > 80) return anchored;
    const t = firstText(LI_DETAIL_SELECTORS);
    if (t) return t;
    if (isLinkedInList()) return ''; // never fall back to body on list pages: it would scan every card
  }
  const t = firstText(['main', 'article', '[role="main"]']);
  return t || getDoc().body?.innerText?.trim() || '';
}

function sduiTitle(el) {
  if (!el.hasAttribute('componentkey')) return '';
  const lines = (el.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[1] || lines[0] || '';
}

/** LinkedIn cards currently in the DOM (LinkedIn virtualises, so this is roughly the visible page). */
export function getCards() {
  if (!isLinkedInList()) return [];
  const seen = new Set();
  const out = [];
  for (const sel of CARD_SELECTORS) {
    for (const el of getDoc().querySelectorAll(sel)) {
      const jobId =
        el.getAttribute('data-occludable-job-id') ||
        el.getAttribute('data-job-id') ||
        el.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
        el.getAttribute('componentkey')?.slice(SDUI_CARD_KEY.length).match(/^\d+/)?.[0] ||
        el.querySelector('a[href*="/jobs/view/"]')?.href.match(/\/jobs\/view\/(\d+)/)?.[1] ||
        null;
      const key = jobId ?? el;
      if (seen.has(key)) continue;
      seen.add(key);
      const link = el.querySelector('a[href*="/jobs/view/"], a.job-card-list__title--link, a.job-card-container__link');
      // SDUI cards have no anchor/strong: the first text line is an a11y label ("Selected, <title>",
      // "<title> (Verified job)"); the second is the plain title.
      const title = (link?.innerText || el.querySelector('strong')?.innerText || sduiTitle(el) || '').split('\n')[0].trim();
      if (!title) continue;
      out.push({ el, jobId, title, text: el.innerText ?? '' });
    }
    if (out.length) break;
  }
  return out;
}
