import { loadConfig } from './config.js';
import { analyze } from './analyze.js';
import { analyzeCard, parseCardText } from './cards.js';
import { getJobText, getJobId, getCards, isLinkedInList } from './extract.js';
import { renderPanel, removePanel, markCard, setCardStatus } from './render.js';
import { fetchJobDetail } from './linkedin-api.js';
import { createScanner, createStorageCache } from './scanner.js';

let config;
let timer = null;
let lastUrl = null;
let cache = null;
let abort = null;
const deep = new Map(); // jobId → cache entry applied to a card this page-life

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

function cardFindings(card) {
  const meta = { title: card.title, ...parseCardText(card.text) };
  const d = card.jobId ? deep.get(card.jobId) : null;
  if (d) {
    if (d.applies != null) meta.applies = d.applies;
    if (d.reposted) meta.reposted = true;
  }
  const findings = analyzeCard(meta, config);
  if (d?.findings?.length) {
    for (const f of d.findings) if (config.rules?.[f.id] ?? true) findings.push({ ...f, sentence: f.id === 'yoe' ? `${f.value}+ yrs` : (f.category ?? f.id) });
  }
  return findings;
}

function runDetail() {
  const text = getJobText();
  if (!text) { removePanel(); return; }
  renderPanel(analyze(text, config), { key: getJobId() ?? location.href });
}

function runCards() {
  if (!isLinkedInList()) return;
  for (const card of getCards()) markCard(card.el, cardFindings(card), config);
}

export function rerun() {
  runCards();
  runDetail();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rerun, 500);
}

async function startScan() {
  if (!isLinkedInList()) return { started: false, reason: 'Not a LinkedIn list page.' };
  if (abort) return { started: false, reason: 'Scan already running.' };
  const cards = getCards();
  if (!cards.length) return { started: false, reason: 'No cards found on page.' };

  abort = new AbortController();
  const scanner = createScanner({ fetchDetail: fetchJobDetail, cache, config });
  for (const c of cards) if (c.jobId && !deep.has(c.jobId)) setCardStatus(c.el, 'queued…');

  scanner.scan(cards, {
    signal: abort.signal,
    onProgress: (p) => chrome.runtime.sendMessage({ type: 'gem:progress', ...p }).catch(() => {}),
    onResult: (card, entry) => {
      deep.set(card.jobId, entry);
      setCardStatus(card.el, '');
      markCard(card.el, cardFindings(card), config);
    },
  }).then((summary) => {
    for (const c of cards) setCardStatus(c.el, '');
    chrome.runtime.sendMessage({ type: 'gem:done', summary }).catch(() => {});
  }).finally(() => { abort = null; });

  return { started: true };
}

function onMessage(msg, _sender, reply) {
  (async () => {
    switch (msg?.type) {
      case 'gem:status': {
        const bo = await cache.getBackoff();
        return { isList: isLinkedInList(), cards: getCards().length, backoffUntil: bo.backoffUntil, cacheCount: await cache.count() };
      }
      case 'gem:scan': return startScan();
      case 'gem:cancel': abort?.abort(); return { ok: true };
      case 'gem:clear-cache': await cache.clear(); deep.clear(); rerun(); return { ok: true };
      default: return undefined;
    }
  })().then(reply, (e) => reply({ error: String(e) }));
  return true; // keep the channel open for the async reply
}

export async function init() {
  lastUrl = location.href;
  config = await loadConfig();
  cache = createStorageCache();

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync' && changes.config) { config = await loadConfig(); rerun(); }
    });
  }
  chrome.runtime.onMessage.addListener(onMessage);

  const mo = new MutationObserver((records) => {
    let urlChanged = false;
    if (location.href !== lastUrl) { lastUrl = location.href; removePanel(); urlChanged = true; }
    if (urlChanged || records.some((r) => !isOwnMutation(r))) schedule();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.__gemDigger = { rerun, get config() { return config; } };
  schedule();
}
