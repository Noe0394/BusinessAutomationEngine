// Content script ISOLATED world, partagé sur web.whatsapp.com ET
// web.telegram.org (voir manifest.json) — relie injected-bridge.js /
// injected-bridge-telegram.js (MAIN world, aucun accès à chrome.runtime) au
// service worker de l'extension. Deux sens : évènements du pont ->
// background (chrome.runtime.sendMessage), commandes du background -> pont
// (window.postMessage, capté par le script injecté du domaine courant).
(function () {
  const CHANNELS = {
    '__CYRUS_WA_BRIDGE__': { source: 'cyrus-wa-bridge', cmdTarget: 'cyrus-wa-page' },
    '__CYRUS_TG_BRIDGE__': { source: 'cyrus-tg-bridge', cmdTarget: 'cyrus-tg-page' },
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    const entry = data && CHANNELS[data.channel];
    if (!entry) return;
    chrome.runtime.sendMessage({ source: entry.source, type: data.type, payload: data.payload }).catch(function () {
      // Le service worker peut être inactif entre deux évènements (MV3) —
      // sans conséquence, chrome.runtime le réveille à la prochaine tentative.
    });
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    const match = Object.keys(CHANNELS).find(function (ch) { return CHANNELS[ch].cmdTarget === (msg && msg.target); });
    if (!match) return;
    window.postMessage({ channel: match + '_CMD', type: msg.type, payload: msg.payload }, '*');
  });
})();
