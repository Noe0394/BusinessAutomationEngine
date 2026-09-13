// Content script ISOLATED world sur web.whatsapp.com — relie injected-bridge.js
// (MAIN world, aucun accès à chrome.runtime) au service worker de l'extension.
// Deux sens : évènements du pont -> background (chrome.runtime.sendMessage),
// commandes du background -> pont (window.postMessage, capté par
// injected-bridge.js).
(function () {
  const CHANNEL = '__CYRUS_WA_BRIDGE__';

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    chrome.runtime.sendMessage({ source: 'cyrus-wa-bridge', type: data.type, payload: data.payload }).catch(function () {
      // Le service worker peut être inactif entre deux évènements (MV3) —
      // sans conséquence, chrome.runtime le réveille à la prochaine tentative.
    });
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.target !== 'cyrus-wa-page') return;
    window.postMessage({ channel: CHANNEL + '_CMD', type: msg.type, payload: msg.payload }, '*');
  });
})();
