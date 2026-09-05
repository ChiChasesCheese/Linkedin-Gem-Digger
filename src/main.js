import { loadConfig } from './config.js';
import { analyze } from './analyze.js';
import { analyzeCard, parseCardText } from './cards.js';
import { getJobText, getJobId, getCards, isLinkedInList } from './extract.js';
import { renderPanel, removePanel, markCard } from './render.js';

let config;
let timer = null;
let lastUrl = null;

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

  const mo = new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; removePanel(); }
    schedule();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.__gemDigger = { rerun, get config() { return config; } };
  schedule();
}
