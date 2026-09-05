import { loadConfig } from './config.js';
import { analyze } from './analyze.js';
import { analyzeCard, parseCardText } from './cards.js';
import { getJobText, getJobId, getCards, isLinkedInList } from './extract.js';
import { renderPanel, removePanel, markCard } from './render.js';

let config;
let timer = null;
let lastUrl = null;

// Elements/attributes we write ourselves (render.js): the observer below must ignore mutations
// that only touch these, or our own writes would re-trigger schedule() forever.
const OWN_SELECTOR = '#gem-digger-panel, .gem-digger-strip, .gem-digger-status';

function ownElement(node) {
  return node?.nodeType === 1 ? node : node?.parentElement ?? null;
}

function isOwn(node) {
  const el = ownElement(node);
  return !!el?.closest?.(OWN_SELECTOR);
}

/** True when a MutationRecord is entirely explained by our own DOM writes. */
function isOwnMutation(record) {
  if (isOwn(record.target)) return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.length > 0 && nodes.every(isOwn);
}

function runDetail() {
  const text = getJobText();
  if (!text) { removePanel(); return; }
  renderPanel(analyze(text, config), { key: getJobId() ?? location.href });
}

function runCards() {
  if (!isLinkedInList()) return;
  for (const card of getCards()) {
    if (card.el.dataset.gemDeep) continue; // deep-scan result already applied (Task 7)
    const meta = { title: card.title, ...parseCardText(card.text) };
    markCard(card.el, analyzeCard(meta, config), config);
  }
}

export function rerun() {
  runCards();
  runDetail();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rerun, 500);
}

export async function init() {
  lastUrl = location.href;
  config = await loadConfig();

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync' && changes.config) { config = await loadConfig(); rerun(); }
    });
  }

  const mo = new MutationObserver((records) => {
    let urlChanged = false;
    if (location.href !== lastUrl) { lastUrl = location.href; removePanel(); urlChanged = true; }
    if (urlChanged || records.some((r) => !isOwnMutation(r))) schedule();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.__gemDigger = { rerun, get config() { return config; } };
  schedule();
}
