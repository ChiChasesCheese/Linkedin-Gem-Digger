import { loadConfig, saveConfig, DEFAULTS } from '../src/config.js';

const $ = (id) => document.getElementById(id);
let config;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function send(msg) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch { return null; }
}

function fill() {
  $('yoeThreshold').value = config.yoeThreshold;
  $('salaryFloor').value = config.salaryFloor;
  $('applicantsMax').value = config.applicantsMax;
  $('repostedIsRed').checked = config.repostedIsRed;
  $('hideInsteadOfGrey').checked = config.hideInsteadOfGrey;
  $('titleGreylist').value = config.titleGreylist.join(', ');
  for (const el of document.querySelectorAll('[data-rule]')) el.checked = !!config.rules[el.dataset.rule];
}

function read() {
  const num = (id, fallback) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : fallback; };
  const rules = { ...config.rules };
  for (const el of document.querySelectorAll('[data-rule]')) rules[el.dataset.rule] = el.checked;
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

function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

async function refreshStatus() {
  const s = await send({ type: 'gem:status' });
  const scan = $('scan');
  if (!s) { $('status').textContent = 'Open a LinkedIn jobs search to scan.'; scan.disabled = true; return; }
  if (!s.isList) { $('status').textContent = `Not a list page. Cache: ${s.cacheCount} jobs.`; scan.disabled = true; return; }
  if (s.backoffUntil > Date.now()) { $('status').textContent = `Rate-limited by LinkedIn. Try after ${fmtTime(s.backoffUntil)}.`; scan.disabled = true; return; }
  $('status').textContent = `${s.cards} cards on page · cache: ${s.cacheCount} jobs.`;
  scan.disabled = s.cards === 0;
}

function setScanning(on) {
  $('scan').disabled = on; $('cancel').disabled = !on; $('progress').hidden = !on;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'gem:progress') { $('progress').max = msg.total; $('progress').value = msg.done; $('status').textContent = `Scanning ${msg.done} / ${msg.total}…`; }
  if (msg?.type === 'gem:done') {
    setScanning(false);
    const s = msg.summary;
    $('status').textContent = s.error
      ? `Scan failed: ${s.error}`
      : s.rateLimited
      ? `Rate-limited. Stopped. Try after ${fmtTime(s.backoffUntil)}.`
      : `Done: ${s.scanned} fetched, ${s.cached} cached, ${s.failed} failed${s.aborted ? ', cancelled' : ''}.`;
  }
});

(async function main() {
  config = await loadConfig();
  fill();
  document.body.addEventListener('change', async () => { config = read(); await saveConfig(config); });
  $('scan').addEventListener('click', async () => {
    setScanning(true);
    const r = await send({ type: 'gem:scan' });
    if (!r?.started) { setScanning(false); $('status').textContent = r?.reason ?? 'Could not start scan.'; }
  });
  $('cancel').addEventListener('click', () => send({ type: 'gem:cancel' }));
  $('clear').addEventListener('click', async () => { await send({ type: 'gem:clear-cache' }); refreshStatus(); });
  refreshStatus();
})();
