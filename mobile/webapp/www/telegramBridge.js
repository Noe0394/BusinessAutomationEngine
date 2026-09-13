// Script injecte dans la WebView chargeant web.telegram.org/k/ (client
// officiel Telegram "WebK", 100% navigateur - contrairement a GramJS qui
// exige un vrai runtime Node (net/os/path), voir CLAUDE.md pour l'historique
// du crash GramJS sur le runtime Node embarque du 2026-09-10.
//
// STATUT : premiere version basee sur une exploration en direct de l'API
// interne de web.telegram.org/k/ (window.rootScope.managers.*, voir
// CLAUDE.md) - la connexion/lecture d'etat a ete confirmee reelle (compte
// deja connecte observe), mais l'envoi (sendText) et le format exact de
// l'evenement de reception (history_multiappend) n'ont PAS encore ete
// exerces de bout en bout sur un vrai envoi/reception (contrairement au
// pont WhatsApp, entierement valide). A traiter comme un premier jet a
// tester, pas comme une integration prouvee.
(function () {
  function post(type, payload) {
    if (window.Cyrus) {
      window.Cyrus.postMessage(JSON.stringify({ type: type, payload: payload }));
    }
  }

  if (window.__cyrusTgBridgeInstalled) return true;
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

      // Format exact non confirme (premiere version, voir statut en tete de
      // fichier) - transmis brut cote app, a affiner une fois observe en
      // conditions reelles avec un vrai message entrant.
      rootScope.addEventListener('history_multiappend', function (data) {
        try {
          post('history-event', { raw: safeStringify(data) });
        } catch (e) {
          post('bridge-error', { where: 'history_multiappend', message: String(e) });
        }
      });

      window.__cyrusTgSend = async function (identifier, text) {
        let stage = 'init';
        try {
          const trimmed = String(identifier || '').trim();
          stage = 'resolvePeer';
          let peerId;

          if (trimmed.startsWith('@')) {
            const resolved = await managers.appUsersManager.resolveUsername(trimmed.slice(1));
            peerId = resolved && (resolved.id !== undefined ? resolved.id : resolved);
          } else if (/^\d+$/.test(trimmed) && trimmed.length < 12) {
            // Deja un peerId Telegram numerique (pas un numero de telephone).
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

      // Extraction groupes/canaux + membres - NON CONFIRME sur appareil
      // (contrairement a sendText/state ci-dessus), voir statut en tete de
      // fichier. Noms de methodes deduits de l'exploration live de
      // window.rootScope.managers (dialogsStorage, apiManagerProxy.getChat/
      // getCommunityFull observes lors de l'exploration du 2026-09-10) mais
      // jamais appeles reellement - stage-tagging pour diagnostiquer vite si
      // un nom est faux.
      window.__cyrusTgGetGroups = async function () {
        let stage = 'init';
        try {
          stage = 'getDialogs';
          const result = await managers.dialogsStorage.getDialogs({ offsetIndex: 0, limit: 200 });
          const dialogs = (result && result.dialogs) || result || [];
          stage = 'filterGroups';
          const groups = dialogs
            .filter(function (d) {
              const id = d.peerId !== undefined ? d.peerId : d.id;
              return typeof id === 'number' && id < 0; // convention Telegram : id negatif = groupe/canal
            })
            .map(function (d) {
              return { id: String(d.peerId !== undefined ? d.peerId : d.id), name: d.title || '' };
            });
          post('groups', { groups: groups });
        } catch (e) {
          post('bridge-error', { where: 'tg-getGroups:' + stage, message: String(e) });
        }
      };

      window.__cyrusTgGetGroupMembers = async function (groupId) {
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

  let attempts = 0;
  const maxAttempts = 40;
  const interval = setInterval(function () {
    attempts += 1;
    if (installBridge()) {
      clearInterval(interval);
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
      post('bridge-error', { where: 'timeout', message: 'rootScope Telegram non detecte apres 30s' });
    }
  }, 750);
})();
true;
