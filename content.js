// Classic content script: MV3 content_scripts cannot be modules, so bootstrap the module graph here.
import(chrome.runtime.getURL('src/main.js'))
  .then((m) => m.init())
  .catch((e) => console.error('[gem-digger] failed to start', e));
