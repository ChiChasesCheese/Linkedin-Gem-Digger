// Pure aggregation over per-card Finding[] arrays (see analyze.js/cards.js for the Finding shape).
// No DOM/chrome access — dock.js renders the numbers this produces.

/**
 * cardsFindings: Array<Finding[]> — one findings array per card on the current results page
 * (the same array passed to markCard()). Returns how many cards each rule fired on, how many
 * cards are greyed out (at least one red finding), and how many cards were tallied.
 *
 * A rule counts at most once per card, even if it produced multiple findings for that card
 * (e.g. a deep-scan finding merged with a card-level one, both id 'yoe').
 */
export function tallyFindings(cardsFindings) {
  const byRule = {};
  let greyed = 0;

  for (const findings of cardsFindings) {
    const rulesHit = new Set();
    let hasRed = false;
    for (const f of findings ?? []) {
      rulesHit.add(f.id);
      if (f.severity === 'red') hasRed = true;
    }
    for (const id of rulesHit) byRule[id] = (byRule[id] ?? 0) + 1;
    if (hasRed) greyed++;
  }

  return { byRule, greyed, total: cardsFindings.length };
}
