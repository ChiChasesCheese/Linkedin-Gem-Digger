// Edge dock (left or right, configurable): tab + drawer + settings form + scan controls, all in
// one shadow-root host. All DOM writes for the dock live here. No document/location/chrome access
// at module top level.
import { worstSeverity } from './analyze.js';
import { DEFAULTS } from './config.js';
import { DOCK_ID } from './render.js';

const LABELS = {
  yoe: 'YOE', citizenship: 'Citizenship', clearance: 'Clearance', sponsorship: 'Sponsorship',
  degree: 'Degree', reposted: 'Reposted', 'title-seniority': 'Title', 'salary-max': 'Salary',
  salary: 'Salary', viewed: 'Viewed', promoted: 'Promoted', 'easy-apply': 'Easy Apply', applicants: 'Applicants',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function valueLabel(f) {
  if (f.id === 'yoe') return `${f.value}+ yrs`;
  if (f.id === 'applicants') return `${f.value} applicants`;
  if (f.id === 'salary' || f.id === 'salary-max') return `$ ${Math.round(f.value / 1000)}K max`;
  return '';
}

/** Signature covering key + findings; used to skip rebuilding the Flags section when nothing changed. */
function sigOf(key, findings) {
  const body = findings === null ? 'null' : findings.map((f) => `${f.id}:${f.severity}:${f.sentence}`).join('|');
  return `${key}||${body}`;
}

const TEMPLATE = `
<style>
  /* --- tokens ------------------------------------------------------------------------------ */
  :host {
    all: initial;
    --gd-sp-1: 4px; --gd-sp-2: 8px; --gd-sp-3: 12px; --gd-sp-4: 16px; --gd-sp-5: 24px;
    --gd-r-sm: 10px; --gd-r-lg: 14px;
    --gd-font: -apple-system, "SF Pro Text", Inter, "Segoe UI", system-ui, sans-serif;
    --gd-fs-body: 13px; --gd-fs-sec: 12px; --gd-fs-label: 11px;
    --gd-accent: #0a66c2;
    --gd-red: #dc2626; --gd-amber: #d97706; --gd-green: #16a34a; --gd-grey: #8a8f96;
    --gd-surface-0: #ffffff; --gd-surface-1: #f7f7f8; --gd-surface-2: #eef0f2;
    --gd-border: #e3e5e8; --gd-text: #16181d; --gd-text-2: #5b6067; --gd-text-3: #8a8f96;
    --gd-focus: #0a66c2; --gd-drawer-w: 340px;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --gd-surface-0: #1c1d1f; --gd-surface-1: #232427; --gd-surface-2: #2b2d31;
      --gd-border: #34363b; --gd-text: #f0f1f3; --gd-text-2: #a8adb5; --gd-text-3: #787d85;
      --gd-accent: #4c9aff; --gd-red: #f87171; --gd-amber: #fbbf24; --gd-green: #4ade80; --gd-grey: #787d85;
      --gd-focus: #4c9aff;
    }
  }
  * { box-sizing: border-box; }
  button, input, textarea { font-family: var(--gd-font); color: inherit; }

  /* --- edge tab ------------------------------------------------------------------------------ */
  .tab {
    position: fixed; top: 30vh; width: 32px; height: 88px; z-index: 2147483647;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--gd-sp-2);
    background: var(--gd-grey); color: #fff; cursor: pointer; user-select: none;
    transition: transform .12s ease, filter .1s ease, left .16s ease, right .16s ease;
  }
  .tab:hover { filter: brightness(1.12); transform: translateY(-2px); }
  .tab.red { background: var(--gd-red); } .tab.yellow { background: var(--gd-amber); }
  .tab.green { background: var(--gd-green); } .tab.grey { background: var(--gd-grey); }
  .wordmark { font: 700 10px/1.3 var(--gd-font); text-align: center; letter-spacing: .04em; }
  .count { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: #fff; color: var(--gd-text);
    font: 700 10px/16px var(--gd-font); text-align: center; font-variant-numeric: tabular-nums; }
  .count[hidden] { display: none; }
  :host([data-side="right"]) .tab { right: 0; border-radius: var(--gd-r-sm) 0 0 var(--gd-r-sm); }
  :host([data-side="right"]) .tab.open { right: var(--gd-drawer-w); }
  :host([data-side="left"]) .tab { left: 0; border-radius: 0 var(--gd-r-sm) var(--gd-r-sm) 0; }
  :host([data-side="left"]) .tab.open { left: var(--gd-drawer-w); }

  /* --- drawer -------------------------------------------------------------------------------- */
  .drawer { position: fixed; top: 0; height: 100vh; width: var(--gd-drawer-w); z-index: 2147483646;
    background: var(--gd-surface-0); color: var(--gd-text); font: var(--gd-fs-body)/1.45 var(--gd-font);
    display: flex; flex-direction: column; transition: transform .16s ease; }
  :host([data-side="right"]) .drawer { right: 0; border-left: 1px solid var(--gd-border); transform: translateX(100%); }
  :host([data-side="right"]) .drawer.open { transform: translateX(0); }
  :host([data-side="left"]) .drawer { left: 0; border-right: 1px solid var(--gd-border); transform: translateX(-100%); }
  :host([data-side="left"]) .drawer.open { transform: translateX(0); }

  .header { display: flex; align-items: center; gap: var(--gd-sp-2); padding: var(--gd-sp-3) var(--gd-sp-4);
    border-bottom: 1px solid var(--gd-border); flex: none; }
  .header .title { flex: 1; font: 600 14px/1 var(--gd-font); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.red { background: var(--gd-red); } .dot.yellow { background: var(--gd-amber); }
  .dot.green { background: var(--gd-green); } .dot.grey { background: var(--gd-grey); }
  .count-pill { background: var(--gd-surface-2); color: var(--gd-text-2); border-radius: 999px; padding: 2px 8px;
    font: 600 11px/1.4 var(--gd-font); font-variant-numeric: tabular-nums; }
  .count-pill[hidden] { display: none; }
  .close { all: unset; cursor: pointer; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    color: var(--gd-text-3); border-radius: 6px; }
  .close:hover { background: var(--gd-surface-2); }
  .close:focus-visible { outline: 2px solid var(--gd-focus); outline-offset: 1px; }

  .body { flex: 1; overflow-y: auto; padding: var(--gd-sp-4); }
  .section-label { font: 600 var(--gd-fs-label)/1.2 var(--gd-font); color: var(--gd-text-3);
    text-transform: uppercase; letter-spacing: .06em; margin: var(--gd-sp-5) 0 var(--gd-sp-2); }
  .body > .section-label:first-child { margin-top: 0; }
  .card { border: 1px solid var(--gd-border); border-radius: var(--gd-r-lg); padding: var(--gd-sp-3);
    background: var(--gd-surface-1); margin-bottom: var(--gd-sp-3); }
  .help { color: var(--gd-text-3); font-size: var(--gd-fs-sec); margin: 2px 0 var(--gd-sp-2); }

  /* --- flags --------------------------------------------------------------------------------- */
  .finding { display: flex; padding: var(--gd-sp-2) var(--gd-sp-3); background: var(--gd-surface-1);
    border-radius: var(--gd-r-sm); border-left: 3px solid var(--gd-grey); margin-bottom: var(--gd-sp-2); }
  .finding.red { border-left-color: var(--gd-red); } .finding.yellow { border-left-color: var(--gd-amber); }
  .f-badge { display: inline-block; color: #fff; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 600; }
  .f-badge.red { background: var(--gd-red); } .f-badge.yellow { background: var(--gd-amber); }
  .f-value { margin-left: var(--gd-sp-1); font-weight: 600; }
  .f-sentence { color: var(--gd-text-2); font-size: var(--gd-fs-sec); margin-top: 2px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .state-clean { display: flex; align-items: center; gap: var(--gd-sp-2); color: var(--gd-green);
    font-size: var(--gd-fs-sec); font-weight: 600; padding: var(--gd-sp-2) 0; }
  .state-muted { color: var(--gd-text-3); font-size: var(--gd-fs-sec); padding: var(--gd-sp-2) 0; }

  /* --- toggle rows ----------------------------------------------------------------------------- */
  .rule-row { display: flex; align-items: center; justify-content: space-between; gap: var(--gd-sp-2);
    height: 40px; border-bottom: 1px solid var(--gd-border); }
  .rule-row:last-child { border-bottom: none; }
  .rule-row .rule-label { flex: 1; }
  input[type=checkbox].gd-switch { appearance: none; -webkit-appearance: none; width: 36px; height: 20px;
    border-radius: 999px; background: var(--gd-surface-2); border: 1px solid var(--gd-border); position: relative;
    cursor: pointer; flex: none; transition: background .12s ease, border-color .12s ease; }
  input[type=checkbox].gd-switch::after { content: ''; position: absolute; top: 1px; left: 1px; width: 16px; height: 16px;
    border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .12s ease; }
  input[type=checkbox].gd-switch:checked { background: var(--gd-accent); border-color: var(--gd-accent); }
  input[type=checkbox].gd-switch:checked::after { transform: translateX(16px); }
  input[type=checkbox].gd-switch:focus-visible { outline: 2px solid var(--gd-focus); outline-offset: 2px; }

  /* --- numeric fields -------------------------------------------------------------------------- */
  .field { margin-bottom: var(--gd-sp-3); } .field:last-child { margin-bottom: 0; }
  .field-row { display: flex; align-items: center; justify-content: space-between; gap: var(--gd-sp-2); }
  .field-row label, .field > label { font-size: var(--gd-fs-sec); }
  .num-group { display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 var(--gd-sp-2);
    background: var(--gd-surface-2); border: 1px solid var(--gd-border); border-radius: var(--gd-r-sm); flex: none; }
  .num-group .unit { font-size: var(--gd-fs-sec); color: var(--gd-text-3); }
  .num-group input[type=number] { all: unset; width: 64px; text-align: right;
    font: 600 var(--gd-fs-body)/1 ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }

  /* --- segmented control ----------------------------------------------------------------------- */
  .segmented { display: flex; background: var(--gd-surface-2); border: 1px solid var(--gd-border);
    border-radius: var(--gd-r-sm); padding: 2px; }
  .segmented input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .segmented label { flex: 1; text-align: center; padding: 5px 0; border-radius: 8px; font-size: var(--gd-fs-sec);
    font-weight: 600; cursor: pointer; color: var(--gd-text-2); }
  .segmented input:checked + label { background: var(--gd-accent); color: #fff; }
  .segmented input:focus-visible + label { outline: 2px solid var(--gd-focus); outline-offset: 2px; }

  textarea.gd-textarea { width: 100%; min-height: 44px; resize: vertical; font: var(--gd-fs-sec)/1.4 var(--gd-font);
    color: var(--gd-text); background: var(--gd-surface-2); border: 1px solid var(--gd-border); border-radius: var(--gd-r-sm);
    padding: var(--gd-sp-2); margin-top: var(--gd-sp-1); }
  textarea.gd-textarea:focus-visible { outline: 2px solid var(--gd-focus); outline-offset: 1px; }

  /* --- scan ------------------------------------------------------------------------------------ */
  .gd-btn { height: 36px; border-radius: var(--gd-r-sm); border: 1px solid var(--gd-border); background: var(--gd-surface-2);
    cursor: pointer; font: 600 var(--gd-fs-body)/1 var(--gd-font); color: var(--gd-text); padding: 0 var(--gd-sp-3); }
  .gd-btn.primary { width: 100%; background: var(--gd-accent); color: #fff; border-color: var(--gd-accent); }
  .gd-btn.text { background: transparent; border: none; color: var(--gd-text-2); text-decoration: underline; padding: 0; height: auto; }
  .gd-btn:disabled { opacity: .5; cursor: default; }
  .gd-btn:focus-visible { outline: 2px solid var(--gd-focus); outline-offset: 2px; }
  .scan-row { display: flex; align-items: center; gap: var(--gd-sp-2); margin: var(--gd-sp-2) 0; }
  .scan-row.end { justify-content: flex-end; }
  progress { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border: none;
    border-radius: 999px; overflow: hidden; margin-bottom: var(--gd-sp-2); }
  progress::-webkit-progress-bar { background: var(--gd-surface-2); border-radius: 999px; }
  progress::-webkit-progress-value { background: var(--gd-accent); border-radius: 999px; }
  #gd-status { font-size: var(--gd-fs-sec); color: var(--gd-text-2); min-height: 16px; }

  @media (prefers-reduced-motion: reduce) {
    .tab, .drawer, .close, .gd-btn, input[type=checkbox].gd-switch, input[type=checkbox].gd-switch::after { transition: none !important; }
  }
</style>
<div class="tab" id="gd-tab" title="Gem Digger">
  <div class="wordmark">G<br>E<br>M</div>
  <div class="count" id="gd-count" hidden>0</div>
</div>
<div class="drawer" id="gd-drawer">
  <div class="header">
    <span class="dot grey" id="gd-dot"></span>
    <span class="title">Gem Digger</span>
    <span class="count-pill" id="gd-count-pill" hidden>0</span>
    <button class="close" id="gd-close" title="Close" aria-label="Close">
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
    </button>
  </div>
  <div class="body">
    <div class="section-label">This posting</div>
    <div id="gd-flags"></div>

    <div id="gd-scan-section" hidden>
      <div class="section-label">Scan</div>
      <div class="card">
        <div class="help" style="margin-top:0">Scrolls the list once to load every card, then fetches each posting one at a time (~1.5 s apart). Cached 7 days.</div>
        <div class="scan-row"><button class="gd-btn primary" id="gd-scan">Scan this page</button></div>
        <div class="scan-row end"><button class="gd-btn text" id="gd-cancel" disabled>Cancel</button></div>
        <progress id="gd-progress" value="0" max="1" hidden></progress>
        <div id="gd-status"></div>
        <div class="scan-row"><button class="gd-btn text" id="gd-clear">Clear cache</button></div>
      </div>
    </div>

    <div class="section-label">Settings</div>
    <div id="gd-settings">
      <div class="card">
        <div class="field-row" style="margin-bottom:6px"><label>Dock position</label></div>
        <div class="segmented" role="radiogroup" aria-label="Dock position">
          <input type="radio" name="dockSide" id="dockSideLeft" value="left">
          <label for="dockSideLeft">Left</label>
          <input type="radio" name="dockSide" id="dockSideRight" value="right">
          <label for="dockSideRight">Right</label>
        </div>
      </div>

      <div class="card">
        <div class="section-label" style="margin-top:0">Thresholds</div>
        <div class="field">
          <div class="field-row">
            <label for="yoeThreshold">Years of experience</label>
            <div class="num-group"><span class="unit">&ge;</span><input type="number" id="yoeThreshold" min="0" max="30"><span class="unit">yrs</span></div>
          </div>
        </div>
        <div class="field">
          <div class="field-row">
            <label for="salaryFloor">Max salary floor</label>
            <div class="num-group"><span class="unit">$</span><input type="number" id="salaryFloor" min="0" step="1000"></div>
          </div>
        </div>
        <div class="field">
          <div class="field-row">
            <label for="applicantsMax">Applicants</label>
            <div class="num-group"><span class="unit">&ge;</span><input type="number" id="applicantsMax" min="0"></div>
          </div>
        </div>
      </div>

      <div class="section-label" style="margin-top:var(--gd-sp-3)">Flag a posting when it says…</div>
      <div class="card">
        <div class="rule-row"><span class="rule-label">Requires threshold+ years of experience</span><input type="checkbox" class="gd-switch" data-rule="yoe"></div>
        <div class="rule-row"><span class="rule-label">Requires US citizenship</span><input type="checkbox" class="gd-switch" data-rule="citizenship"></div>
        <div class="rule-row"><span class="rule-label">Requires security clearance / ITAR</span><input type="checkbox" class="gd-switch" data-rule="clearance"></div>
        <div class="rule-row"><span class="rule-label">No visa sponsorship (incl. H-1B)</span><input type="checkbox" class="gd-switch" data-rule="sponsorship"></div>
        <div class="rule-row"><span class="rule-label">Requires PhD / Master's (yellow only)</span><input type="checkbox" class="gd-switch" data-rule="degree"></div>
        <div class="rule-row"><span class="rule-label">Posting is a repost (yellow)</span><input type="checkbox" class="gd-switch" data-rule="reposted"></div>
        <div class="rule-row"><span class="rule-label">Treat repost as red instead</span><input type="checkbox" class="gd-switch" id="repostedIsRed"></div>
      </div>

      <div class="section-label">Grey out a card when…</div>
      <div class="card">
        <div class="rule-row"><span class="rule-label">Title contains a seniority word</span><input type="checkbox" class="gd-switch" data-rule="title-seniority"></div>
        <div class="field">
          <textarea class="gd-textarea" id="titleGreylist" rows="2" placeholder="Senior, Staff, ..."></textarea>
        </div>
        <div class="field">
          <label for="titleIgnorelist">Ignore these title phrases</label>
          <div class="help">Removed from the title before the seniority check, so "Member of Technical Staff" is not treated as Staff.</div>
          <textarea class="gd-textarea" id="titleIgnorelist" rows="2" placeholder="Member of Technical Staff, ..."></textarea>
        </div>
        <div class="rule-row"><span class="rule-label">Max salary is below the floor</span><input type="checkbox" class="gd-switch" data-rule="salary-max"></div>
        <div class="rule-row"><span class="rule-label">You already viewed it</span><input type="checkbox" class="gd-switch" data-rule="viewed"></div>
        <div class="rule-row"><span class="rule-label">It is a Promoted (paid) listing</span><input type="checkbox" class="gd-switch" data-rule="promoted"></div>
        <div class="rule-row"><span class="rule-label">It is an Easy Apply listing</span><input type="checkbox" class="gd-switch" data-rule="easy-apply"></div>
        <div class="rule-row"><span class="rule-label">Applicants over threshold (needs scan)</span><input type="checkbox" class="gd-switch" data-rule="applicants"></div>
        <div class="rule-row"><span class="rule-label">Hide flagged cards instead of greying</span><input type="checkbox" class="gd-switch" id="hideInsteadOfGrey"></div>
      </div>
    </div>
  </div>
</div>`;

/**
 * Build the dock (tab + drawer) and mount it. `actions` supplies scan/cancel/clearCache/status;
 * getConfig/saveConfig back the settings form; isListPage gates the Scan section.
 */
export function createDock({ getConfig, saveConfig, isListPage, actions }) {
  const host = document.createElement('div');
  host.id = DOCK_ID;
  host.attachShadow({ mode: 'open' });
  host.shadowRoot.innerHTML = TEMPLATE;
  document.documentElement.appendChild(host);

  const root = host.shadowRoot;
  const $ = (id) => root.getElementById(id);
  const tab = $('gd-tab'), countEl = $('gd-count'), countPillEl = $('gd-count-pill'), drawer = $('gd-drawer'), dot = $('gd-dot');
  const flagsEl = $('gd-flags'), scanSection = $('gd-scan-section');
  const scanBtn = $('gd-scan'), cancelBtn = $('gd-cancel'), progressEl = $('gd-progress'), statusEl = $('gd-status');

  let open = false;
  let lastSig = null;

  function setOpen(next) {
    open = next;
    drawer.classList.toggle('open', open);
    tab.classList.toggle('open', open);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) chrome.storage.local.set({ dockOpen: open }).catch(() => {});
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get('dockOpen').then(({ dockOpen }) => { if (dockOpen) setOpen(true); }).catch(() => {});
  }
  tab.addEventListener('click', () => { setOpen(!open); if (open) applyStatus(); });
  $('gd-close').addEventListener('click', () => setOpen(false));

  // Dock side: re-anchor immediately on change, independent of the async settings save below.
  for (const r of root.querySelectorAll('input[name="dockSide"]')) {
    r.addEventListener('change', () => { host.setAttribute('data-side', r.value); });
  }

  function renderFlags(findings) {
    if (findings === null) { flagsEl.innerHTML = '<div class="state-muted">No job posting detected on this page.</div>'; return; }
    if (!findings.length) { flagsEl.innerHTML = '<div class="state-clean">✓ No red flags found</div>'; return; }
    flagsEl.innerHTML = findings.map((f) => `
      <div class="finding ${esc(f.severity)}">
        <div class="f-body">
          <span class="f-badge ${esc(f.severity)}">${esc(LABELS[f.id] ?? f.id)}</span>
          <span class="f-value">${esc(valueLabel(f))}</span>
          <div class="f-sentence">${esc(f.sentence)}</div>
        </div>
      </div>`).join('');
  }

  function setFindings(findings, { key = location.href } = {}) {
    const sig = sigOf(key, findings);
    if (sig === lastSig) return; // nothing changed: skip the rebuild (never touch settings/scan while typing)
    lastSig = sig;
    const sev = findings === null ? 'grey' : worstSeverity(findings);
    const count = findings?.length ?? 0;
    tab.className = `tab ${sev}${open ? ' open' : ''}`;
    dot.className = `dot ${sev}`;
    countEl.textContent = String(count);
    countEl.hidden = count === 0;
    countPillEl.textContent = String(count);
    countPillEl.hidden = count === 0;
    tab.title = `Gem Digger — ${count} flag${count === 1 ? '' : 's'}`;
    renderFlags(findings);
  }

  function setScanning(on) { scanBtn.disabled = on; cancelBtn.disabled = !on; progressEl.hidden = !on; }
  scanBtn.addEventListener('click', async () => {
    setScanning(true);
    const r = await actions.scan();
    if (!r?.started) { setScanning(false); statusEl.textContent = r?.reason ?? 'Could not start scan.'; }
  });
  cancelBtn.addEventListener('click', () => actions.cancel());
  $('gd-clear').addEventListener('click', async () => { await actions.clearCache(); applyStatus(); });

  /** Actual status query + redraw. Not exported directly: main.js's rerun()/URL-change hook can
   * fire in bursts, and this hits chrome.storage, so the public refreshStatus() below debounces it. */
  async function applyStatus() {
    const listPage = isListPage();
    scanSection.hidden = !listPage;
    if (!listPage) return;
    const s = await actions.status();
    if (s.backoffUntil > Date.now()) {
      statusEl.textContent = `Rate-limited by LinkedIn. Try after ${fmtTime(s.backoffUntil)}.`;
      scanBtn.disabled = true;
    } else {
      statusEl.textContent = `${s.cards} shown · ${s.cardsTotal} on page · ${s.cacheCount} cached`;
      scanBtn.disabled = s.cardsTotal === 0;
    }
  }

  // Public refreshStatus(): coalesces bursts of calls (e.g. from schedule()'s rerun() firing
  // repeatedly during page churn) into a single applyStatus() every 500ms. No polling: if nothing
  // calls it, no timer is ever running.
  let refreshTimer = null;
  function refreshStatus() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(applyStatus, 500);
  }

  function setScanProgress({ done, total }) {
    scanSection.hidden = false;
    setScanning(true);
    progressEl.max = total;
    progressEl.value = done;
    statusEl.textContent = `Scanning ${done} / ${total}…`;
  }

  function setScanDone(summary) {
    setScanning(false);
    statusEl.textContent = summary.error
      ? `Scan failed: ${summary.error}`
      : summary.locked
      ? 'Another tab is scanning. Wait for it to finish.'
      : summary.rateLimited
      ? `Rate-limited. Stopped. Try after ${fmtTime(summary.backoffUntil)}.`
      : `Done: ${summary.scanned} fetched, ${summary.cached} cached, ${summary.failed} failed${summary.aborted ? ', cancelled' : ''}.`;
  }

  // --- Settings form: fill()/read() mirror the old popup.js logic exactly. ---
  function fill() {
    const config = getConfig();
    $('yoeThreshold').value = config.yoeThreshold;
    $('salaryFloor').value = config.salaryFloor;
    $('applicantsMax').value = config.applicantsMax;
    $('repostedIsRed').checked = config.repostedIsRed;
    $('hideInsteadOfGrey').checked = config.hideInsteadOfGrey;
    $('titleGreylist').value = config.titleGreylist.join(', ');
    $('titleIgnorelist').value = config.titleIgnorelist.join(', ');
    const side = config.dockSide === 'right' ? 'right' : 'left';
    host.setAttribute('data-side', side);
    $(side === 'right' ? 'dockSideRight' : 'dockSideLeft').checked = true;
    for (const el of root.querySelectorAll('[data-rule]')) el.checked = !!config.rules[el.dataset.rule];
  }

  function read() {
    const config = getConfig();
    const num = (id, fallback) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : fallback; };
    const rules = { ...config.rules };
    for (const el of root.querySelectorAll('[data-rule]')) rules[el.dataset.rule] = el.checked;
    return {
      ...config,
      yoeThreshold: num('yoeThreshold', DEFAULTS.yoeThreshold),
      salaryFloor: num('salaryFloor', DEFAULTS.salaryFloor),
      applicantsMax: num('applicantsMax', DEFAULTS.applicantsMax),
      repostedIsRed: $('repostedIsRed').checked,
      hideInsteadOfGrey: $('hideInsteadOfGrey').checked,
      titleGreylist: $('titleGreylist').value.split(',').map((s) => s.trim()).filter(Boolean),
      titleIgnorelist: $('titleIgnorelist').value.split(',').map((s) => s.trim()).filter(Boolean),
      dockSide: root.querySelector('input[name="dockSide"]:checked')?.value ?? config.dockSide,
      rules,
    };
  }

  $('gd-settings').addEventListener('change', () => saveConfig(read()));

  fill();
  applyStatus();

  return { setFindings, setScanProgress, setScanDone, refreshStatus };
}
