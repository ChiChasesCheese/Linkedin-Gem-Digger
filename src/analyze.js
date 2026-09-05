import { TEXT_RULES, YOE_NOISE, YOE_CAP, SOFTENERS, PAY_KEYWORD_RE } from './rules.js';
import { DEFAULTS } from './config.js';
import { parseSalary } from './cards.js';

const SEVERITY_RANK = { red: 2, yellow: 1 };
// Tie-break within equal severity: lower sorts first. Everything not listed is 0,
// so 'salary' (1) always sorts after 'yoe' (and every other rule) at equal severity.
const ID_ORDER = { salary: 1 };

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
  const seen = new Set();
  const out = [];
  let bestSalary = null; // keep only the lowest (most severe) max across sentences

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

    for (const rule of rules) {
      const re = clone(rule.pattern);
      let m;
      while ((m = re.exec(sentence))) {
        let value;
        if (rule.id === 'yoe') {
          if (YOE_NOISE.test(sentence) || YOE_CAP.test(sentence)) continue;
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
