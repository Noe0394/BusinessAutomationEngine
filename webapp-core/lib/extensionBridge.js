// Client de l'extension navigateur compagnon (voir browser-extension/ à la
// racine du dépôt) — seule voie d'envoi WhatsApp 100% automatique (sans clic
// humain dans WhatsApp Web) possible dans un onglet navigateur classique,
// voir adapters/browser.js pour le contexte complet. Absente/non installée :
// toutes les fonctions ci-dessous résolvent { installed:false }, l'appelant
// retombe sur le Mode Manuel Express (deep link).
(function () {
  'use strict';

  const EXTENSION_ID = 'jipfnoinknhgogheokkmildhfdbhomep';
  const PING_TIMEOUT_MS = 1200;

  function hasChromeRuntime() {
    return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage);
  }

  function call(message, timeoutMs) {
    if (!hasChromeRuntime()) return Promise.resolve({ ok: false, installed: false });
    return new Promise((resolve) => {
      let settled = false;
      const timer = timeoutMs ? setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, installed: false, error: 'TIMEOUT' });
      }, timeoutMs) : null;
      try {
        chrome.runtime.sendMessage(EXTENSION_ID, message, (response) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          // chrome.runtime.lastError = pas d'extension installée à cet ID,
          // ou l'utilisateur ne l'a pas encore chargée — cas normal, pas une
          // vraie erreur applicative.
          if (chrome.runtime.lastError || !response) {
            resolve({ ok: false, installed: false });
            return;
          }
          resolve(Object.assign({ installed: true }, response));
        });
      } catch (e) {
        if (timer) clearTimeout(timer);
        resolve({ ok: false, installed: false });
      }
    });
  }

  window.Cyrus = window.Cyrus || {};
  window.Cyrus.extensionBridge = {
    EXTENSION_ID: EXTENSION_ID,
    ping: function () { return call({ action: 'ping' }, PING_TIMEOUT_MS); },
    getStatus: function () { return call({ action: 'getStatus' }, PING_TIMEOUT_MS); },
    openWhatsApp: function () { return call({ action: 'openWhatsApp' }, 5000); },
    sendMessage: function (to, text) { return call({ action: 'sendMessage', to: to, text: text }, 30000); },
    getGroups: function () { return call({ action: 'getGroups' }, 18000); },
    getGroupMembers: function (groupId) { return call({ action: 'getGroupMembers', groupId: groupId }, 18000); },
  };
})();
