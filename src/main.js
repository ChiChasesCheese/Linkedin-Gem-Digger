import { loadConfig, saveConfig } from './config.js';
import { analyze } from './analyze.js';
import { analyzeCard, parseCardText } from './cards.js';
import { getJobText, getJobId, getCards, isLinkedInList } from './extract.js';
import { markCard, setCardStatus, DOCK_ID, STRIP_CLASS, STATUS_CLASS } from './render.js';
import { createDock } from './dock.js';
import { fetchJobDetail } from './linkedin-api.js';
import { createScanner, createStorageCache } from './scanner.js';

let config;
let timer = null;
let lastUrl = null;
let cache = null;
let abort = null;
let dock = null;
const deep = new Map(); // jobId → cache entry applied to a card this page-life

// LinkedIn's SPA shell ("interop" mode) hosts the classic job pages inside a same-origin
// `iframe[src*="/preload/"]`, invisible to a content script that only observes the top document.
// These track the frame observer so we can (re)wire it to whichever contentDocument is current.
let frameObserver = null;
let lastFrameDoc = null;
let lastFrameEl = null;

// Elements/attributes we write ourselves (render.js/dock.js): the observer below must ignore
// mutations that only touch these, or our own writes would re-trigger schedule() forever.
const OWN_SELECTOR = `#${DOCK_ID}, .${STRIP_CLASS}, .${STATUS_CLASS}`;

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
  if (!text) { dock.setFindings(null, { key: location.href }); return; }
  dock.setFindings(analyze(text, config), { key: getJobId() ?? location.href });
}

function runCards() {
  if (!isLinkedInList()) return;
  for (const card of getCards()) markCard(card.el, cardFindings(card), config);
}

export function rerun() {
  ensureFrameObserver();
  runCards();
  runDetail();
  dock.refreshStatus();
}

/**
 * (Re)wire a MutationObserver onto the interop iframe's contentDocument when one is present and
 * has changed (first sighting, or the frame reloaded/was replaced on navigation). Cheap: a single
 * querySelector plus an identity check when nothing changed, so it's safe to call from both
 * schedule() and rerun(). Uses the same onMutations callback as the top-document observer, which
 * already ignores our own writes via isOwnMutation (closest()/matches() work the same regardless
 * of which document owns the node).
 */
function ensureFrameObserver() {
  const f = document.querySelector('iframe[src*="/preload/"]');
  if (f && f !== lastFrameEl) {
    lastFrameEl = f;
    f.addEventListener('load', () => { ensureFrameObserver(); schedule(); });
  }
  const d = f?.contentDocument;
  if (!d || d === lastFrameDoc) return;
  frameObserver?.disconnect();
  lastFrameDoc = d;
  frameObserver = new MutationObserver(onMutations);
  frameObserver.observe(d.documentElement, { childList: true, subtree: true, characterData: true });
}

function schedule() {
  ensureFrameObserver();
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
    onProgress: (p) => { chrome.runtime.sendMessage({ type: 'gem:progress', ...p }).catch(() => {}); dock.setScanProgress(p); },
    onResult: (card, entry) => {
      deep.set(card.jobId, entry);
      setCardStatus(card.el, '');
      markCard(card.el, cardFindings(card), config);
    },
  }).then((summary) => {
    for (const c of cards) setCardStatus(c.el, '');
    chrome.runtime.sendMessage({ type: 'gem:done', summary }).catch(() => {});
    dock.setScanDone(summary);
  }).catch((e) => {
    for (const c of cards) setCardStatus(c.el, '');
    const summary = { scanned: 0, cached: 0, failed: 0, aborted: true, rateLimited: false, backoffUntil: 0, error: String(e) };
    chrome.runtime.sendMessage({ type: 'gem:done', summary }).catch(() => {});
    dock.setScanDone(summary);
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

  dock = createDock({
    getConfig: () => config,
    saveConfig,
    isListPage: () => isLinkedInList(),
    actions: {
      scan: () => startScan(),
      cancel: () => abort?.abort(),
      clearCache: async () => { await cache.clear(); deep.clear(); rerun(); },
      status: async () => ({ cards: getCards().length, backoffUntil: (await cache.getBackoff()).backoffUntil, cacheCount: await cache.count() }),
    },
  });

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync' && changes.config) { config = await loadConfig(); rerun(); }
    });
  }
  chrome.runtime?.onMessage?.addListener(onMessage);

  const mo = new MutationObserver(onMutations);
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.__gemDigger = { rerun, get config() { return config; } };
  schedule();
}

/** Shared MutationObserver callback for both the top-document observer and the interop-iframe
 * observer (see ensureFrameObserver). Filters out mutations that are entirely our own writes. */
function onMutations(records) {
  let urlChanged = false;
  if (location.href !== lastUrl) { lastUrl = location.href; dock.setFindings(null, { key: lastUrl }); dock.refreshStatus(); urlChanged = true; }
  if (urlChanged || records.some((r) => !isOwnMutation(r))) schedule();
}
