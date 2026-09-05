// All DOM *writes* for LinkedIn cards live here. The dock (src/dock.js) owns its own shadow root.
import { worstSeverity } from './analyze.js';

export const DOCK_ID = 'gem-digger-dock';
export const STRIP_CLASS = 'gem-digger-strip';
export const STATUS_CLASS = 'gem-digger-status';

const COLORS = { red: '#c62828', yellow: '#ef6c00', green: '#2e7d32' };

function findingsSig(findings) {
  return findings.map((f) => `${f.id}:${f.severity}:${f.sentence}`).join('|');
}

function cardSig(findings, config) {
  return `${findingsSig(findings)}|${config?.hideInsteadOfGrey ? 'hide' : 'grey'}`;
}

/** Grey out (or hide) a LinkedIn card and add a one-line reason strip. Idempotent; a true no-op when nothing changed. */
export function markCard(el, findings, config) {
  const sig = cardSig(findings, config);
  if (el.dataset.gemSig === sig) return; // nothing changed: don't touch the DOM (avoids a MutationObserver feedback loop)
  unmarkCard(el);
  el.dataset.gemSig = sig;
  if (!findings.length) return;
  const sev = worstSeverity(findings);
  el.dataset.gemSeverity = sev;
  if (sev === 'red' && config?.hideInsteadOfGrey) { el.style.display = 'none'; return; }
  el.style.opacity = sev === 'red' ? '0.45' : '1';
  el.style.borderLeft = `4px solid ${COLORS[sev]}`;
  const strip = el.ownerDocument.createElement('div');
  strip.className = STRIP_CLASS;
  strip.style.cssText = `font: 11px system-ui; color: ${COLORS[sev]}; padding: 2px 8px 4px 12px;`;
  strip.textContent = findings.map((f) => f.sentence).join(' · ');
  el.appendChild(strip);
}

export function unmarkCard(el) {
  delete el.dataset.gemSeverity;
  delete el.dataset.gemSig;
  el.style.opacity = '';
  el.style.borderLeft = '';
  el.style.display = '';
  el.querySelector(`.${STRIP_CLASS}`)?.remove();
  el.querySelector(`.${STATUS_CLASS}`)?.remove();
}

/** Small grey status text on a card (used by the scanner: "scanning…", "scan failed"). */
export function setCardStatus(el, text) {
  let s = el.querySelector(`.${STATUS_CLASS}`);
  if (!text) { s?.remove(); return; }
  if (s && s.textContent === text) return; // nothing changed: don't touch the DOM
  if (!s) { s = el.ownerDocument.createElement('div'); s.className = STATUS_CLASS; s.style.cssText = 'font:11px system-ui;color:#888;padding:0 8px 4px 12px;'; el.appendChild(s); }
  s.textContent = text;
}
