const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(msg) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch { return null; }
}

$('clear').addEventListener('click', async () => {
  const r = await send({ type: 'gem:clear-cache' });
  $('status').textContent = r?.ok ? 'Cache cleared.' : 'Open a supported job page to clear its cache.';
});
