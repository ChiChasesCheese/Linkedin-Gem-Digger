// All DOM *reads* live here. Nothing in this file writes to the page.
import { META_RE, extractMetaPhrases } from './analyze.js';

// getDoc() is called many times per rerun pass (once per DOM read in this file); memoize its
// result for a short window so repeated calls within one synchronous pass don't repeat the
// querySelector + document probe. A rerun pass finishes well under 250ms; the next debounced
// rerun (500ms later, see main.js's schedule()) recomputes.
let cachedDoc = null;
let cachedDocTs = -Infinity;

const ABOUT_RE = /^\s*about the job\s*$/i;

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


/**
 * Score how populated a document is with real job UI (job cards, an "About the job" heading, a
 * link into a job view), vs. an empty shell. Cheap: a handful of querySelector calls, no
 * innerText read; checkVisibility runs only on the one or two headings whose text matches, so a
 * hidden leftover "About the job" (previous SPA route) does not earn the point.
 */
function jobUiScore(doc) {
  if (!doc?.body) return -1;
  let s = 0;
  if (doc.querySelector(CARD_SELECTOR)) s += 2;
  const visible = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
  if ([...doc.querySelectorAll('h1, h2, h3, h4')].some((e) => ABOUT_RE.test(e.textContent || '') && visible(e))) s += 2;
  if (doc.querySelector('a[href*="/jobs/view/"]')) s += 1;
  return s;
}

/**
 * The document that actually holds the job UI: LinkedIn's SPA shell ("interop" mode) hosts the
 * classic Ember pages inside a same-origin `<iframe src=".../preload/...">` (itself inside a
 * shadow host), while the top document renders nothing. But the shell keeps that iframe around
 * (with just the global nav in it, ~3k chars of text) even when a page — e.g. the newer SDUI
 * `/jobs/search-results/` split view — renders in the top document, so "populated" is not enough:
 * prefer the iframe's document only when it actually holds job UI (a card list or a posting),
 * otherwise fall back to the top document (classic layout, SDUI layout, or a hard-reloaded page).
 * Both documents are scored on the job UI they contain; the iframe wins only with a strictly
 * higher score, so an empty nav-only shell never beats a top document holding the posting.
 */
export function getDoc() {
  const now = performance.now();
  if (cachedDoc && now - cachedDocTs < 250) return cachedDoc;
  let result = document;
  try {
    const f = document.querySelector('iframe[src*="/preload/"]');
    const d = f?.contentDocument;
    if (d && d.body && d.readyState !== 'loading' && jobUiScore(d) > jobUiScore(document)) {
      result = d;
    }
  } catch { /* cross-origin or detached */ }
  cachedDoc = result;
  cachedDocTs = now;
  return result;
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

function firstText(selectors, root = getDoc()) {
  for (const s of selectors) {
    const el = root.querySelector(s);
    const t = el?.innerText?.trim();
    if (t && t.length > 80) return t;
  }
  return '';
}

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

/**
 * Meta phrases ("Reposted 23 hours ago", "Over 100 people clicked apply") from the posting
 * header, which on some layouts sits outside headingAnchoredContainer()'s climb. Anchored on the
 * visible job-title <h1> rather than scanning the whole body: walk up a few levels looking for
 * the first ancestor that isn't the card list and whose text matches META_RE.
 */
function postingMetaLines(container) {
  // The posting header ("Reposted 1 day ago · Over 100 people clicked apply") sits OUTSIDE the
  // "About the job" container and its title is not always an <h1>. Walk up from the container to
  // the nearest ancestor that carries meta phrases; stop before anything that holds job cards
  // (similar-jobs lists) so we never pick up another posting's numbers.
  if (!container) return [];
  const metaRe = new RegExp(META_RE.source, META_RE.flags);
  const baseLen = Math.max(1, (container.innerText || '').length);
  let el = container.parentElement ?? null;
  for (let steps = 0; el && steps < 6; steps++, el = el.parentElement) {
    if (el.querySelector(CARD_SELECTOR)) break;
    const text = el.innerText || '';
    // Similar-jobs blocks may lack our card selectors; once an ancestor is several times the
    // posting's size we have left the posting and would pick up other listings' numbers.
    if (text.length > 3 * baseLen) break;
    metaRe.lastIndex = 0;
    if (metaRe.test(text)) return extractMetaPhrases(text);
  }
  return [];
}

/** JD text for the posting the user is looking at. Empty string if nothing usable. */
export function getJobText() {
  if (isLinkedIn()) {
    const container = headingAnchoredContainer();
    const anchored = container?.innerText?.trim();
    if (anchored && anchored.length > 80) {
      const meta = postingMetaLines(container);
      return meta.length ? `${anchored}\n${meta.join('\n')}` : anchored;
    }
    const t = firstText(LI_DETAIL_SELECTORS);
    if (t) return t;
    if (isLinkedInList()) return ''; // never fall back to body on list pages: it would scan every card
  }
  const t = firstText(['main', 'article', '[role="main"]']);
  return t || getDoc().body?.innerText?.trim() || '';
}

/** Title from an SDUI card's innerText: line 1 is an a11y label ("Selected, <title>", "<title> (Verified job)"), line 2 the plain title. */
export function sduiTitleFromText(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[1] || lines[0] || '';
}

function sduiTitle(el) {
  return el.hasAttribute('componentkey') ? sduiTitleFromText(el.innerText) : '';
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
