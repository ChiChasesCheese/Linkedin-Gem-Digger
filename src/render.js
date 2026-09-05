// All DOM *writes* live here. Panel uses a shadow root so host CSS cannot leak in.
const PANEL_ID = 'gem-digger-panel';
const COLORS = { red: '#c62828', yellow: '#ef6c00', green: '#2e7d32' };
const LABELS = {
  yoe: 'YOE', citizenship: 'Citizenship', clearance: 'Clearance', sponsorship: 'Sponsorship',
  degree: 'Degree', reposted: 'Reposted', 'title-seniority': 'Title', 'salary-max': 'Salary',
  viewed: 'Viewed', promoted: 'Promoted', applicants: 'Applicants',
};

const dismissed = new Set();
let collapsed = false;

function worst(findings) {
  if (findings.some((f) => f.severity === 'red')) return 'red';
  if (findings.some((f) => f.severity === 'yellow')) return 'yellow';
  return 'green';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function valueLabel(f) {
  if (f.id === 'yoe') return `${f.value}+ yrs`;
  if (f.id === 'applicants') return `${f.value}`;
  return '';
}

function findingsSig(findings) {
  return findings.map((f) => `${f.id}:${f.severity}:${f.sentence}`).join('|');
}

/** Draw or update the bottom-right panel. `key` identifies the posting so a dismissed panel stays dismissed. */
export function renderPanel(findings, { key = location.href } = {}) {
  if (dismissed.has(key)) return;
  let host = document.getElementById(PANEL_ID);
  const sig = `${key}||${findingsSig(findings)}`;
  if (host && host.dataset.gemSig === sig) return; // nothing changed: skip the rebuild (preserves collapse state, avoids churn)
  if (!host) {
    host = document.createElement('div');
    host.id = PANEL_ID;
    host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
  }
  host.dataset.gemSig = sig;
  const sev = worst(findings);
  const rows = findings.length
    ? findings.map((f) => `
        <div class="row ${esc(f.severity)}">
          <span class="badge">${esc(LABELS[f.id] ?? f.id)}</span>
          <span class="val">${esc(valueLabel(f))}</span>
          <div class="sent">${esc(f.sentence)}</div>
        </div>`).join('')
    : '<div class="row green"><div class="sent">No red flags found</div></div>';

  host.shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; right: 16px; bottom: 16px; width: 280px; max-height: 50vh; overflow: auto;
             background: #fff; color: #222; font: 12px/1.4 system-ui, sans-serif; border-radius: 8px;
             box-shadow: 0 4px 16px rgba(0,0,0,.25); z-index: 2147483647; }
      .hd { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px;
            color: #fff; font-weight: 600; background: ${COLORS[sev]}; cursor: pointer; }
      .hd button { all: unset; cursor: pointer; padding: 0 4px; font-size: 14px; }
      .row { padding: 6px 10px; border-top: 1px solid #eee; }
      .row.red .badge { background: ${COLORS.red}; }
      .row.yellow .badge { background: ${COLORS.yellow}; }
      .row.green .sent { color: ${COLORS.green}; }
      .badge { display: inline-block; color: #fff; border-radius: 3px; padding: 1px 5px; font-size: 11px; }
      .val { margin-left: 6px; font-weight: 600; }
      .sent { color: #555; margin-top: 2px; }
      .collapsed .row { display: none; }
    </style>
    <div class="box">
      <div class="hd"><span>Gem Digger · ${findings.length ? findings.length + ' flag' + (findings.length > 1 ? 's' : '') : 'clean'}</span><button title="Close">✕</button></div>
      ${rows}
    </div>`;
  const box = host.shadowRoot.querySelector('.box');
  box.classList.toggle('collapsed', collapsed);
  host.shadowRoot.querySelector('.hd').addEventListener('click', () => {
    collapsed = !collapsed;
    box.classList.toggle('collapsed', collapsed);
  });
  host.shadowRoot.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); dismissed.add(key); removePanel(); });
}

export function removePanel() {
  document.getElementById(PANEL_ID)?.remove();
}

const STRIP_CLASS = 'gem-digger-strip';

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
  const sev = worst(findings);
  el.dataset.gemSeverity = sev;
  if (sev === 'red' && config?.hideInsteadOfGrey) { el.style.display = 'none'; return; }
  el.style.opacity = sev === 'red' ? '0.45' : '1';
  el.style.borderLeft = `4px solid ${COLORS[sev]}`;
  const strip = document.createElement('div');
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
  el.querySelector('.gem-digger-status')?.remove();
}

/** Small grey status text on a card (used by the scanner: "scanning…", "scan failed"). */
export function setCardStatus(el, text) {
  let s = el.querySelector('.gem-digger-status');
  if (!text) { s?.remove(); return; }
  if (s && s.textContent === text) return; // nothing changed: don't touch the DOM
  if (!s) { s = document.createElement('div'); s.className = 'gem-digger-status'; s.style.cssText = 'font:11px system-ui;color:#888;padding:0 8px 4px 12px;'; el.appendChild(s); }
  s.textContent = text;
}
