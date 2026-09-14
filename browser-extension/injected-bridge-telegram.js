// Script injecté en MAIN world dans web.telegram.org (voir manifest.json).
// Port du brouillon mobile/webapp/www/telegramBridge.js (jamais exercé de
// bout en bout - voir son en-tête) vers le mécanisme d'extension navigateur :
// même API interne (window.rootScope.managers.*), même limite documentée
// (état de connexion confirmé réel, mais sendText/history_multiappend
// jamais validés sur un vrai échange) - seul post() change, window.postMessage
// au lieu de window.Cyrus.postMessage (pont Capacitor, absent ici), capté
// par content-relay.js (isolated world) qui relaie vers l'extension.
(function () {
  const CHANNEL = '__CYRUS_TG_BRIDGE__';

  function post(type, payload) {
    window.postMessage({ channel: CHANNEL, type: type, payload: payload }, '*');
  }

  if (window.__cyrusTgBridgeInstalled) return;
  window.__cyrusTgBridgeInstalled = true;

  function safeCall(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function safeStringify(x) {
    try {
      return JSON.stringify(x, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; });
    } catch (e) {
      return String(x);
    }
  }

  function installBridge() {
    try {
      const rootScope = window.rootScope;
      if (!rootScope || !rootScope.managers || !rootScope.managers.appMessagesManager) return false;

      const managers = rootScope.managers;

      const reportAuth = function () {
        post('state', { authorized: !!rootScope.myId, userId: rootScope.myId ? String(rootScope.myId) : null });
      };
      rootScope.addEventListener('user_auth', reportAuth);
      rootScope.addEventListener('connection_status_change', function (status) {
        post('connection', { status: safeStringify(status) });
      });
      reportAuth();

      // Format exact non confirmé (premier jet, voir statut en tête de
      // fichier) - transmis brut côté app, à affiner une fois observé en
      // conditions réelles avec un vrai message entrant.
      rootScope.addEventListener('history_multiappend', function (data) {
        try {
          post('history-event', { raw: safeStringify(data) });
        } catch (e) {
          post('bridge-error', { where: 'history_multiappend', message: String(e) });
        }
      });

      window.__cyrusSend = async function (identifier, text) {
        let stage = 'init';
        try {
          const trimmed = String(identifier || '').trim();
          stage = 'resolvePeer';
          let peerId;

          if (trimmed.startsWith('@')) {
            const resolved = await managers.appUsersManager.resolveUsername(trimmed.slice(1));
            peerId = resolved && (resolved.id !== undefined ? resolved.id : resolved);
          } else if (/^\d+$/.test(trimmed) && trimmed.length < 12) {
            // Déjà un peerId Telegram numérique (pas un numéro de téléphone).
            peerId = Number(trimmed);
          } else {
            const digits = trimmed.replace(/[^\d+]/g, '');
            if (!managers.appUsersManager.importContact) {
              throw new Error('importContact indisponible sur cette version de appUsersManager');
            }
            const imported = await managers.appUsersManager.importContact(digits, 'Contact', '');
            peerId = imported && (imported.id !== undefined ? imported.id : imported);
          }
          if (!peerId) throw new Error('Peer introuvable pour: ' + identifier);

          stage = 'sendText';
          await managers.appMessagesManager.sendText({ peerId: peerId, text: text });

          post('send-result', { ok: true, chatId: identifier });
        } catch (e) {
          post('send-result', { ok: false, chatId: identifier, error: '[' + stage + '] ' + String(e) });
        }
      };

      // Extraction groupes/canaux + membres - NON CONFIRMÉ (voir statut en
      // tête de fichier). Noms de méthodes déduits d'une exploration live de
      // window.rootScope.managers, jamais appelés réellement - stage-tagging
      // pour diagnostiquer vite si un nom est faux.
      window.__cyrusGetGroups = async function () {
        let stage = 'init';
        try {
          stage = 'getDialogs';
          const result = await managers.dialogsStorage.getDialogs({ offsetIndex: 0, limit: 200 });
          const dialogs = (result && result.dialogs) || result || [];
          stage = 'filterGroups';
          const groups = dialogs
            .filter(function (d) {
              const id = d.peerId !== undefined ? d.peerId : d.id;
              return typeof id === 'number' && id < 0; // convention Telegram : id négatif = groupe/canal
            })
            .map(function (d) {
              return { id: String(d.peerId !== undefined ? d.peerId : d.id), name: d.title || '' };
            });
          post('groups', { groups: groups });
        } catch (e) {
          post('bridge-error', { where: 'tg-getGroups:' + stage, message: String(e) });
        }
      };

      window.__cyrusGetGroupMembers = async function (groupId) {
        let stage = 'init';
        try {
          stage = 'getCommunityFull';
          const full = await managers.apiManagerProxy.getCommunityFull(Number(groupId));
          const participants = (full && full.participants && full.participants.participants) || [];
          const members = participants.map(function (p) {
            return { id: String(p.user_id || p.userId || ''), isAdmin: !!(p.admin_rights || p.adminRights) };
          });
          post('group-members', { groupId: groupId, members: members });
        } catch (e) {
          post('bridge-error', { where: 'tg-getGroupMembers:' + stage, message: String(e) });
        }
      };

      post('bridge-ready', {});
      return true;
    } catch (e) {
      post('bridge-error', { where: 'installBridge', message: String(e) });
      return false;
    }
  }

  // Relais des commandes reçues de content-relay.js (elles-mêmes reçues de
  // l'extension) vers les fonctions __cyrus* ci-dessus - mêmes noms
  // génériques que le pont WhatsApp (injected-bridge.js) : le background
  // n'a pas besoin de savoir quel canal il pilote.
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL + '_CMD') return;
    if (data.type === 'send') window.__cyrusSend && window.__cyrusSend(data.payload.to, data.payload.text);
    else if (data.type === 'getGroups') window.__cyrusGetGroups && window.__cyrusGetGroups();
    else if (data.type === 'getGroupMembers') window.__cyrusGetGroupMembers && window.__cyrusGetGroupMembers(data.payload.groupId);
  });

  let attempts = 0;
  const maxAttempts = 40;
  const interval = setInterval(function () {
    attempts += 1;
    if (installBridge()) {
      clearInterval(interval);
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
      post('bridge-error', { where: 'timeout', message: 'rootScope Telegram non détecté après 30s' });
    }
  }, 750);
})();
