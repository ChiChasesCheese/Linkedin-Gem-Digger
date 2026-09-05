// Right-edge dock: tab + drawer + settings form + scan controls, all in one shadow-root host.
// All DOM writes for the dock live here. No document/location/chrome access at module top level.
import { worstSeverity } from './analyze.js';
import { DEFAULTS } from './config.js';
import { DOCK_ID } from './render.js';

const LABELS = {
  yoe: 'YOE', citizenship: 'Citizenship', clearance: 'Clearance', sponsorship: 'Sponsorship',
  degree: 'Degree', reposted: 'Reposted', 'title-seniority': 'Title', 'salary-max': 'Salary',
  salary: 'Salary', viewed: 'Viewed', promoted: 'Promoted', applicants: 'Applicants',
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
  :host {
    all: initial;
    --gd-red: #c62828; --gd-yellow: #ef6c00; --gd-green: #2e7d32; --gd-grey: #8a8a8a;
    --gd-bg: #fff; --gd-text: #1f1f1f; --gd-muted: #6b6b6b; --gd-border: #e6e6e6; --gd-primary: #0a66c2;
    --gd-font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  .tab {
    position: fixed; right: 0; top: 30vh; width: 34px; height: 96px; border-radius: 10px 0 0 10px;
    background: var(--gd-grey); display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; cursor: pointer; z-index: 2147483647; color: #fff; user-select: none;
    transition: right .16s ease, filter .1s ease; font-family: var(--gd-font);
  }
  .tab:hover { filter: brightness(1.15); }
  .tab.open { right: 320px; }
  .tab.red { background: var(--gd-red); }
  .tab.yellow { background: var(--gd-yellow); }
  .tab.green { background: var(--gd-green); }
  .tab.grey { background: var(--gd-grey); }
  .wordmark { font: 700 11px/1.3 system-ui, sans-serif; text-align: center; letter-spacing: .5px; }
  .count {
    min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: #fff; color: #1f1f1f;
    font: 700 10px/16px system-ui, sans-serif; text-align: center;
  }
  .count[hidden] { display: none; }
  .drawer {
    position: fixed; right: 0; top: 0; height: 100vh; width: 320px; background: var(--gd-bg); color: var(--gd-text);
    border-left: 1px solid var(--gd-border); box-shadow: 0 0 24px rgba(0,0,0,.18); font: var(--gd-font);
    transform: translateX(100%); transition: transform .16s ease; z-index: 2147483646;
    display: flex; flex-direction: column;
  }
  .drawer.open { transform: translateX(0); }
  .header { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--gd-border); flex: none; }
  .header .title { flex: 1; font: 600 15px/1 system-ui, sans-serif; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dot.red { background: var(--gd-red); } .dot.yellow { background: var(--gd-yellow); }
  .dot.green { background: var(--gd-green); } .dot.grey { background: var(--gd-grey); }
  .close { all: unset; cursor: pointer; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; color: var(--gd-muted); }
  .body { flex: 1; overflow-y: auto; padding: 4px 16px 20px; }
  h2 { font: 600 11px/1.2 system-ui, sans-serif; color: var(--gd-muted); text-transform: uppercase; letter-spacing: .04em; margin: 16px 0 8px; }
  .finding { border: 1px solid var(--gd-border); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
  .f-badge { display: inline-block; color: #fff; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 600; }
  .f-badge.red { background: var(--gd-red); } .f-badge.yellow { background: var(--gd-yellow); }
  .f-value { margin-left: 6px; font-weight: 600; }
  .f-sentence { color: var(--gd-muted); font-size: 12px; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .pill-clean { display: inline-block; background: var(--gd-green); color: #fff; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; }
  .muted { color: var(--gd-muted); font-size: 12px; }
  .scan-row { display: flex; gap: 8px; margin: 8px 0; }
  .gd-btn { flex: 1; padding: 7px; border-radius: 6px; border: 1px solid #bbb; background: #f7f7f7; cursor: pointer; font: inherit; color: var(--gd-text); }
  .gd-btn.primary { background: var(--gd-primary); color: #fff; border-color: var(--gd-primary); }
  .gd-btn:disabled { opacity: .5; cursor: default; }
  progress { width: 100%; margin-bottom: 6px; }
  #gd-status { font-size: 12px; color: var(--gd-muted); min-height: 16px; }
  fieldset { border: 1px solid var(--gd-border); border-radius: 6px; margin: 0 0 10px; padding: 8px 10px; }
  legend { font-weight: 600; font-size: 12px; color: var(--gd-muted); }
  label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px; }
  input[type=number] { width: 80px; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; }
</style>
<div class="tab" id="gd-tab" title="Gem Digger">
  <div class="wordmark">G<br>E<br>M</div>
  <div class="count" id="gd-count" hidden>0</div>
</div>
<div class="drawer" id="gd-drawer">
  <div class="header">
    <span class="dot grey" id="gd-dot"></span>
    <span class="title">Gem Digger</span>
    <button class="close" id="gd-close" title="Close" aria-label="Close">
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
    </button>
  </div>
  <div class="body">
    <h2 style="margin-top:0">This posting</h2>
    <div id="gd-flags"></div>

    <div id="gd-scan-section" hidden>
      <h2>Scan</h2>
      <div class="muted">Fetches each visible card's posting, one at a time, ~1.5 s apart. Cached 7 days.</div>
      <div class="scan-row">
        <button class="gd-btn primary" id="gd-scan">Scan visible cards</button>
        <button class="gd-btn" id="gd-cancel" disabled>Cancel</button>
      </div>
      <progress id="gd-progress" value="0" max="1" hidden></progress>
      <div id="gd-status"></div>
      <div class="scan-row"><button class="gd-btn" id="gd-clear">Clear cache</button></div>
    </div>

    <h2>Settings</h2>
    <div id="gd-settings">
      <div class="muted" style="margin-bottom:8px">Checked = treat this as a red flag (grey the card / show it in the drawer). Unchecked = ignore it.</div>
      <fieldset><legend>Thresholds</legend>
        <label>Flag if years of experience &ge; <input type="number" id="yoeThreshold" min="0" max="30"></label>
        <label>Flag if max salary &lt; $ <input type="number" id="salaryFloor" min="0" step="1000"></label>
        <label>Flag if applicants &ge; <input type="number" id="applicantsMax" min="0"></label>
      </fieldset>
      <fieldset><legend>Flag a posting when it says...</legend>
        <label>Requires &ge; threshold years of experience <input type="checkbox" data-rule="yoe"></label>
        <label>Requires US citizenship <input type="checkbox" data-rule="citizenship"></label>
        <label>Requires security clearance / ITAR <input type="checkbox" data-rule="clearance"></label>
        <label>No visa sponsorship (incl. H-1B) <input type="checkbox" data-rule="sponsorship"></label>
        <label>Requires PhD / Master's (yellow only) <input type="checkbox" data-rule="degree"></label>
        <label>Posting is a repost (yellow) <input type="checkbox" data-rule="reposted"></label>
        <label>&nbsp;&nbsp;treat repost as red instead <input type="checkbox" id="repostedIsRed"></label>
      </fieldset>
      <fieldset><legend>Grey out a LinkedIn card when...</legend>
        <label>Title contains a seniority word: <input type="checkbox" data-rule="title-seniority"></label>
        <textarea id="titleGreylist" rows="2" placeholder="Senior, Staff, ..."></textarea>
        <label>Max salary is below the floor <input type="checkbox" data-rule="salary-max"></label>
        <label>You already viewed it <input type="checkbox" data-rule="viewed"></label>
        <label>It is a Promoted (paid) listing <input type="checkbox" data-rule="promoted"></label>
        <label>Applicants &ge; threshold (needs scan) <input type="checkbox" data-rule="applicants"></label>
        <label>Hide flagged cards instead of greying <input type="checkbox" id="hideInsteadOfGrey"></label>
      </fieldset>
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
  const tab = $('gd-tab'), countEl = $('gd-count'), drawer = $('gd-drawer'), dot = $('gd-dot');
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

  function renderFlags(findings) {
    if (findings === null) { flagsEl.innerHTML = '<div class="muted">No job posting detected on this page.</div>'; return; }
    if (!findings.length) { flagsEl.innerHTML = '<div class="pill-clean">No red flags found</div>'; return; }
    flagsEl.innerHTML = findings.map((f) => `
      <div class="finding">
        <span class="f-badge ${esc(f.severity)}">${esc(LABELS[f.id] ?? f.id)}</span>
        <span class="f-value">${esc(valueLabel(f))}</span>
        <div class="f-sentence">${esc(f.sentence)}</div>
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
      statusEl.textContent = `${s.cards} cards on page · cache: ${s.cacheCount} jobs.`;
      scanBtn.disabled = s.cards === 0;
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
      rules,
    };
  }

  $('gd-settings').addEventListener('change', () => saveConfig(read()));

  fill();
  applyStatus();

  return { setFindings, setScanProgress, setScanDone, refreshStatus };
}
