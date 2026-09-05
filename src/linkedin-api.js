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

// Extracts the inner HTML of the show-more-less-html__markup container by
// counting nested <div>/</div> tokens, since the description commonly nests
// <div>/<ul>/<p> blocks and a lazy regex to the first </div> truncates it.
function extractMarkupDiv(html) {
  const openRe = /<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>/i;
  const openMatch = openRe.exec(html);
  if (!openMatch) return '';
  const start = openMatch.index + openMatch[0].length;
  const tagRe = /<div\b[^>]*>|<\/div\s*>/gi;
  tagRe.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].toLowerCase().startsWith('</div')) {
      depth--;
      if (depth === 0) return html.slice(start, m.index);
    } else {
      depth++;
    }
  }
  // Depth never closed: fall back to everything to end of string.
  return html.slice(start);
}

export function parseGuestHtml(html) {
  const h = String(html ?? '');
  const desc = extractMarkupDiv(h);
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
