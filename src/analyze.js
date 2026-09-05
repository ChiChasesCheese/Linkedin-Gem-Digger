import { TEXT_RULES, YOE_NOISE, SOFTENERS } from './rules.js';
import { DEFAULTS } from './config.js';

const SEVERITY_RANK = { red: 2, yellow: 1 };

/** Split JD text into trimmed, non-empty sentence-like chunks. */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.;!?])(?<!\b[A-Za-z]\.)\s+|\n+|\r+|[•·▪◦]|(?:^|\n)\s*[-*]\s+/)
    .map((s) => s.replace(/^[\s\-*•·]+/, '').replace(/[.;!?]+\s*$/, '').trim())
    .filter(Boolean);
}

function clone(re) { return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); }

/**
 * Run every enabled text rule over `text`.
 * Returns Finding[] sorted red-first, then by numeric value descending.
 */
export function analyze(text, config = DEFAULTS) {
  const rules = TEXT_RULES.filter((r) => config.rules?.[r.id] ?? r.defaultOn);
  const seen = new Set();
  const out = [];

  for (const sentence of splitSentences(text)) {
    const soft = SOFTENERS.test(sentence);
    for (const rule of rules) {
      const re = clone(rule.pattern);
      let m;
      while ((m = re.exec(sentence))) {
        let value;
        if (rule.id === 'yoe') {
          if (YOE_NOISE.test(sentence)) continue;
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

  return out.sort((a, b) =>
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || ((b.value ?? -1) - (a.value ?? -1)));
}

export function worstSeverity(findings) {
  let worst = 'green';
  for (const f of findings ?? []) {
    if (f.severity === 'red') return 'red';
    if (f.severity === 'yellow') worst = 'yellow';
  }
  return worst;
}
