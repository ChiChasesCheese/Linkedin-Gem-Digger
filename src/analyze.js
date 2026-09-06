import {
  TEXT_RULES, YOE_NOISE, YOE_CAP, YOE_COMPANY_RE, YOE_AFTER_CTX, YOE_BEFORE_CTX,
  SOFTENERS, PAY_KEYWORD_RE, APPLICANTS_RE,
} from './rules.js';
import { DEFAULTS } from './config.js';
import { parseSalary } from './cards.js';

const SEVERITY_RANK = { red: 2, yellow: 1 };
// Tie-break within equal severity: lower sorts first. Everything not listed is 0,
// so 'salary' (1) and 'applicants' (2) always sort after 'yoe' (and every other rule)
// at equal severity, in that order.
const ID_ORDER = { salary: 1, applicants: 2 };

/**
 * Posting-header "meta" phrases: freshness ("Reposted 23 hours ago") and competition
 * ("Over 100 people clicked apply"). Pure text match, no DOM — extract.js locates the
 * header text and hands it here.
 */
export const META_RE = /\b(?:re)?posted\s+\d+\s+(?:minute|hour|day|week|month)s?\s+ago\b|\b(?:over\s+)?\d{1,5}\+?\s+(?:applicants|people\s+clicked\s+apply)\b/gi;

/** Distinct meta phrases ("Reposted 23 hours ago", "Over 100 people clicked apply") found in text. */
export function extractMetaPhrases(text) {
  const re = new RegExp(META_RE.source, META_RE.flags);
  const seen = new Set();
  const out = [];
  for (const m of String(text ?? '').matchAll(re)) {
    const phrase = m[0].trim();
    if (!seen.has(phrase)) {
      seen.add(phrase);
      out.push(phrase);
    }
  }
  return out;
}

// U+2024 ONE DOT LEADER: stands in for a period inside a two-letter dotted
// abbreviation (U.S., U.K., e.g., i.e., ...) while we split on sentence
// boundaries, so those periods are never mistaken for sentence-enders.
const ABBREV_PLACEHOLDER = '․';
const ABBREV_RE = /\b([A-Za-z])\.([A-Za-z])\./g;
const RESTORE_RE = new RegExp(ABBREV_PLACEHOLDER, 'g');

/** Split JD text into trimmed, non-empty sentence-like chunks. */
export function splitSentences(text) {
  const protectedText = String(text ?? '').replace(ABBREV_RE, `$1${ABBREV_PLACEHOLDER}$2${ABBREV_PLACEHOLDER}`);
  return protectedText
    .split(/(?<=[.;!?])\s+|\n+|\r+|[•·▪◦]|(?:^|\n)\s*[-*]\s+/)
    .map((s) => s.replace(RESTORE_RE, '.').replace(/^[\s\-*•·]+/, '').replace(/[.;!?]+\s*$/, '').trim())
    .filter(Boolean);
}

function clone(re) { return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); }

/**
 * Run every enabled text rule over `text`.
 * Returns Finding[] sorted red-first, then by numeric value descending.
 */
export function analyze(text, config = DEFAULTS) {
  const rules = TEXT_RULES.filter((r) => config.rules?.[r.id] ?? r.defaultOn);
  const salaryOn = config.rules?.['salary-max'] ?? DEFAULTS.rules['salary-max'];
  const applicantsOn = config.rules?.applicants ?? DEFAULTS.rules.applicants;
  const applicantsMax = config.applicantsMax ?? DEFAULTS.applicantsMax;
  const seen = new Set();
  const out = [];
  let bestSalary = null; // keep only the lowest (most severe) max across sentences
  let bestApplicants = null; // keep only the highest (most severe) count across sentences

  for (const sentence of splitSentences(text)) {
    const soft = SOFTENERS.test(sentence);

    if (salaryOn && sentence.includes('$') && PAY_KEYWORD_RE.test(sentence)) {
      const parsed = parseSalary(sentence);
      if (parsed && typeof parsed.max === 'number' && parsed.max < config.salaryFloor) {
        if (!bestSalary || parsed.max < bestSalary.value) {
          bestSalary = { id: 'salary', category: 'salary', severity: 'red', value: parsed.max, sentence: sentence.slice(0, 240) };
        }
      }
    }

    if (applicantsOn) {
      // Not softener-downgradable (unlike the generic text rules below): "88+ applicants,
      // ideally fewer" is still 88 applicants.
      const am = sentence.match(APPLICANTS_RE);
      if (am) {
        const value = parseInt(am[1].replace(/,/g, ''), 10);
        if (value >= applicantsMax && (!bestApplicants || value > bestApplicants.value)) {
          bestApplicants = { id: 'applicants', category: 'competition', severity: 'red', value, sentence: sentence.slice(0, 240) };
        }
      }
    }

    for (const rule of rules) {
      const re = clone(rule.pattern);
      let m;
      while ((m = re.exec(sentence))) {
        let value;
        if (rule.id === 'yoe') {
          if (YOE_NOISE.test(sentence) || YOE_CAP.test(sentence) || YOE_COMPANY_RE.test(sentence)) continue;
          const afterText = sentence.slice(re.lastIndex, re.lastIndex + 50);
          const beforeText = sentence.slice(Math.max(0, m.index - 50), m.index);
          const hasContext = YOE_AFTER_CTX.test(afterText) || YOE_BEFORE_CTX.test(beforeText) || /:\s*$/.test(beforeText);
          if (!hasContext) continue;
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

  if (bestSalary) out.push(bestSalary);
  if (bestApplicants) out.push(bestApplicants);

  return out.sort((a, b) =>
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) ||
    ((ID_ORDER[a.id] ?? 0) - (ID_ORDER[b.id] ?? 0)) ||
    ((b.value ?? -1) - (a.value ?? -1)));
}

export function worstSeverity(findings) {
  let worst = 'green';
  for (const f of findings ?? []) {
    if (f.severity === 'red') return 'red';
    if (f.severity === 'yellow') worst = 'yellow';
  }
  return worst;
}
