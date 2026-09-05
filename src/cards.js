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
