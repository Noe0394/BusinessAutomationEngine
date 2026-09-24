// Script injecte dans la WebView chargeant web.telegram.org/k/ (client
// officiel Telegram "WebK", 100% navigateur - contrairement a GramJS qui
// exige un vrai runtime Node (net/os/path), voir CLAUDE.md pour l'historique
// du crash GramJS sur le runtime Node embarque du 2026-09-10.
//
// STATUT : base sur une exploration live de l'API interne de web.telegram.org/k/
// (window.rootScope.managers.*, voir CLAUDE.md). Le format de history_multiappend
// suit la source Telegram Web K : handleNewMessage emet directement le modele
// message. La reception et le repondeur restent a valider avec un compte et
// un appareil reels.
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

      // Le WebK courant emet directement le modele message a cet evenement.
      // Les discussions privees et groupes texte peuvent alimenter le
      // repondeur mobile; les messages sortants et publications de canal sont ignores.
      rootScope.addEventListener('history_multiappend', function (message) {
        try {
          if (!message || message._ !== 'message' || !message.pFlags || message.pFlags.out) return;
          const peerId = String(message.peerId == null ? '' : message.peerId);
          if (!/^-?\d{1,12}$/.test(peerId) || Number(peerId) === 0 || message.pFlags.post) return;
          const body = String(message.message || '').trim();
          if (!body) return;
          const mid = String(message.mid != null ? message.mid : (message.id != null ? message.id : ''));
          if (!mid) return;
          post('message', {
            id: 'tg:' + peerId + ':' + mid,
            from: peerId,
            body: body.slice(0, 4000),
            date: Number(message.date) || Math.floor(Date.now() / 1000),
            fromMe: false,
            isGroup: Number(peerId) < 0,
          });
        } catch (e) {
          post('bridge-error', { where: 'history_multiappend', message: String(e) });
        }
      });

      async function resolvePeerId(identifier) {
        const trimmed = String(identifier || '').trim();
        if (trimmed.startsWith('@')) {
          const resolved = await managers.appUsersManager.resolveUsername(trimmed.slice(1));
          return resolved && (resolved.id !== undefined ? resolved.id : resolved);
        }
        if (/^-?\d+$/.test(trimmed) && trimmed.length < 13 && Number(trimmed) !== 0) {
          // Deja un peerId Telegram numerique (pas un numero de telephone).
          return Number(trimmed);
        }
        const digits = trimmed.replace(/[^\d+]/g, '');
        if (!managers.appUsersManager.importContact) {
          throw new Error('importContact indisponible sur cette version de appUsersManager');
        }
        const imported = await managers.appUsersManager.importContact(digits, 'Contact', '');
        return imported && (imported.id !== undefined ? imported.id : imported);
      }

      window.__cyrusTgSend = async function (identifier, text) {
        let stage = 'init';
        try {
          stage = 'resolvePeer';
          const peerId = await resolvePeerId(identifier);
          if (!peerId) throw new Error('Peer introuvable pour: ' + identifier);

          stage = 'sendText';
          await managers.appMessagesManager.sendText({ peerId: peerId, text: text });

          post('send-result', { ok: true, chatId: identifier });
          return { ok: true };
        } catch (e) {
          post('send-result', { ok: false, chatId: identifier, error: '[' + stage + '] ' + String(e) });
          return { ok: false, error: '[' + stage + '] ' + String(e) };
        }
      };

      // Pièce jointe (image/vidéo/PDF) — NON ÉPROUVÉ sur appareil, au même
      // titre que le reste de ce fichier (voir statut en tête) : nom de
      // méthode (`sendFile`) déduit de l'API interne observée en exploration
      // live (window.rootScope.managers.appMessagesManager), jamais appelé
      // réellement. `data` : base64 brut (sans préfixe data:...;base64,).
      window.__cyrusTgSendMedia = async function (identifier, data, mimetype, filename, caption) {
        let stage = 'init';
        try {
          stage = 'resolvePeer';
          const peerId = await resolvePeerId(identifier);
          if (!peerId) throw new Error('Peer introuvable pour: ' + identifier);

          stage = 'buildFile';
          const binary = window.atob(data);
          const buffer = new ArrayBuffer(binary.length);
          const view = new Uint8Array(buffer);
          for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
          const file = new File([new Blob([buffer], { type: mimetype })], filename || 'fichier', { type: mimetype });

          stage = 'sendFile';
          await managers.appMessagesManager.sendFile({ peerId: peerId, file: file, caption: caption || '' });

          post('send-result', { ok: true, chatId: identifier });
          return { ok: true };
        } catch (e) {
          post('send-result', { ok: false, chatId: identifier, error: '[' + stage + '] ' + String(e) });
          return { ok: false, error: '[' + stage + '] ' + String(e) };
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

      // Recherche globale officielle Telegram Web K. requestHistory passe par
      // appMessagesManager puis messages.searchGlobal avec groups_only /
      // broadcasts_only; les entites sont enregistrees par le manager avant
      // d'etre retournees a l'annuaire local.
      window.__cyrusTgDiscoverCommunities = async function (rawKeywords, requestedLimit) {
        let stage = 'validate';
        try {
          const keywords = [...new Set(String(rawKeywords || '').split(/[,;\n]/).map(x => x.trim()).filter(x => x.length >= 2))].slice(0, 5);
          if (!keywords.length) throw new Error('Indique au moins un mot-clé de 2 caractères.');
          const limit = Math.max(1, Math.min(30, Number(requestedLimit) || 15));
          const found = new Map();
          for (const keyword of keywords) {
            for (const chatType of ['groups', 'channels']) {
              stage = 'searchGlobal:' + chatType;
              const result = await managers.appMessagesManager.requestHistory({
                peerId: 0,
                query: keyword,
                inputFilter: { _: 'inputMessagesFilterEmpty' },
                limit,
                chatType,
              });
              for (const chat of (result && result.chats) || []) {
                const username = String(chat.username || '').replace(/^@/, '');
                if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) continue;
                const peerId = await managers.appPeersManager.getPeerId(chat);
                if (peerId == null || !Number.isFinite(Number(peerId))) continue;
                const item = {
                  channel: 'TELEGRAM', ref: String(peerId), id: String(peerId),
                  name: String(chat.title || ('@' + username)), username,
                  link: 'https://t.me/' + username,
                  kind: chatType === 'channels' ? 'channel' : 'group',
                  members: chat.participants_count == null ? null : Number(chat.participants_count),
                  description: '', verified: true, keywords: [keyword],
                };
                const key = item.ref;
                if (found.has(key)) found.get(key).keywords.push(keyword); else found.set(key, item);
              }
              await new Promise(resolve => setTimeout(resolve, 800));
            }
          }
          post('community-search-results', { channel: 'TELEGRAM', results: [...found.values()].slice(0, 60) });
        } catch (e) {
          post('bridge-error', { where: 'discoverCommunities:' + stage, message: String(e && (e.errorMessage || e.message) || e) });
        }
      };

      window.__cyrusTgDiscoverPeople = async function (rawKeywords, requestedLimit) {
        let stage = 'validate';
        try {
          const keywords = [...new Set(String(rawKeywords || '').split(/[,;\n]/).map(x => x.trim().replace(/^@/, '')).filter(x => x.length >= 2))].slice(0, 5);
          if (!keywords.length) throw new Error('Indique au moins un mot-clé de 2 caractères.');
          const limit = Math.max(1, Math.min(30, Number(requestedLimit) || 15));
          const found = new Map();
          for (const keyword of keywords) {
            stage = 'searchGlobal:users';
            const result = await managers.appMessagesManager.requestHistory({
              peerId: 0,
              query: keyword,
              inputFilter: { _: 'inputMessagesFilterEmpty' },
              limit,
              chatType: 'users',
            });
            for (const user of (result && result.users) || []) {
              const username = String(user.username || '').replace(/^@/, '');
              const id = String(user.id == null ? '' : user.id);
              if (!/^\d{1,11}$/.test(id) || Number(id) <= 0 || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) continue;
              const name = [user.first_name || user.firstName, user.last_name || user.lastName].filter(Boolean).join(' ') || ('@' + username);
              if (found.has(id)) found.get(id).keywords.push(keyword);
              else found.set(id, { channel: 'TELEGRAM', id, identifier: id, username, name, link: 'https://t.me/' + username, keywords: [keyword] });
            }
            await new Promise(resolve => setTimeout(resolve, 800));
          }
          post('community-people-results', { channel: 'TELEGRAM', results: [...found.values()].slice(0, 60) });
        } catch (e) {
          post('bridge-error', { where: 'discoverPeople:' + stage, message: String(e && (e.errorMessage || e.message) || e) });
        }
      };

      // Création d'un supergroupe puis invitations unitaires. Les méthodes
      // createChannel/inviteToChannel et AppChatInvitesManager.exportChatInvite
      // sont les méthodes publiques de Telegram Web K; chaque action reste
      // déclenchée par le formulaire et la confirmation explicite de Cyrus.
      window.__cyrusTgCommunityCreate = async function (payload) {
        const jobId = String(payload && payload.jobId || '');
        let stage = 'validate';
        try {
          const title = String(payload && payload.title || '').trim().slice(0, 128);
          const about = String(payload && payload.about || '').trim().slice(0, 255);
          if (!jobId || title.length < 2) throw new Error('Nom de groupe invalide.');
          if (!rootScope.myId) throw new Error('Connecte-toi à Telegram avant de créer un groupe.');
          if (!managers.appChatsManager || typeof managers.appChatsManager.createChannel !== 'function') throw new Error('Création de groupe indisponible dans cette version Telegram.');
          stage = 'createChannel';
          const created = await managers.appChatsManager.createChannel({ broadcast: false, megagroup: true, title: title, about: about });
          const rawGroupId = created && typeof created === 'object'
            ? (created.id !== undefined ? created.id : created.chatId !== undefined ? created.chatId : created.peerId)
            : created;
          const groupId = Number(rawGroupId);
          if (!Number.isSafeInteger(groupId) || groupId === 0) {
            const error = new Error('Telegram a répondu sans identifiant de groupe exploitable. Vérifie la liste des groupes avant toute nouvelle création.');
            error.ambiguous = true;
            throw error;
          }
          let inviteLink = '';
          let linkError = '';
          try {
            stage = 'exportInvite';
            if (!managers.appChatInvitesManager || typeof managers.appChatInvitesManager.exportChatInvite !== 'function') throw new Error('Export de lien d’invitation indisponible.');
            const invite = await managers.appChatInvitesManager.exportChatInvite({ chatId: groupId });
            inviteLink = String(invite && invite.link || '');
            if (!/^https:\/\/t\.me\//i.test(inviteLink)) throw new Error('Telegram n’a pas retourné de lien t.me valide.');
          } catch (e) { linkError = String(e && (e.errorMessage || e.message) || e); }
          post('community-operation-result', { jobId: jobId, action: 'create', ok: true, groupId: String(groupId), title: title, inviteLink: inviteLink, linkError: linkError });
        } catch (e) {
          post('community-operation-result', { jobId: jobId, action: 'create', ok: false, ambiguous: !!(e && e.ambiguous) || stage === 'createChannel', stage: stage, error: String(e && (e.errorMessage || e.message) || e) });
        }
      };

      window.__cyrusTgCommunityInvite = async function (payload) {
        const jobId = String(payload && payload.jobId || '');
        const identifier = String(payload && payload.identifier || '').trim();
        const groupId = Number(payload && payload.groupId);
        let stage = 'resolveRecipient';
        try {
          if (!jobId || !identifier || !Number.isSafeInteger(groupId) || groupId === 0) throw new Error('Données d’invitation invalides.');
          if (!rootScope.myId) throw new Error('La session Telegram est déconnectée.');
          let userId;
          if (identifier.startsWith('@')) {
            const user = await managers.appUsersManager.resolveUsername(identifier.slice(1));
            userId = user && user.id !== undefined ? user.id : user;
          } else if (/^\d{1,11}$/.test(identifier) && Number(identifier) > 0) {
            userId = Number(identifier);
          } else {
            throw new Error('Utilise un @username ou un identifiant utilisateur Telegram numérique.');
          }
          if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw new Error('Utilisateur Telegram introuvable.');
          userId = Number(userId);
          const user = managers.appUsersManager.getUser(userId) || {};
          const name = [user.first_name || user.firstName, user.last_name || user.lastName].filter(Boolean).join(' ') || identifier;
          stage = 'inviteToChannel';
          const missing = await managers.appChatsManager.inviteToChannel(groupId, [userId]);
          if (!missing || !missing.length) {
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'INVITED', name: name });
            return;
          }
          const inviteLink = String(payload.inviteLink || '');
          if (payload.sendFallback === true && inviteLink && managers.appMessagesManager && typeof managers.appMessagesManager.sendText === 'function') {
            stage = 'sendInviteLink';
            const template = String(payload.inviteMessage || 'Bonjour {nom}, tu es invité(e) à rejoindre le groupe « {groupe} » : {lien}').slice(0, 600);
            const message = (template.replace(/\{nom\}/g, name).replace(/\{groupe\}/g, String(payload.title || 'groupe')).replace(/\{lien\}/g, inviteLink).slice(0, 600).includes(inviteLink))
              ? template.replace(/\{nom\}/g, name).replace(/\{groupe\}/g, String(payload.title || 'groupe')).replace(/\{lien\}/g, inviteLink).slice(0, 600)
              : (template.replace(/\{nom\}/g, name).replace(/\{groupe\}/g, String(payload.title || 'groupe')).slice(0, 500) + ' ' + inviteLink);
            await managers.appMessagesManager.sendText({ peerId: userId, text: message });
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'LINK_SENT', name: name });
          } else {
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'NEEDS_LINK', name: name, inviteLink: inviteLink, error: 'Telegram a refusé l’ajout direct pour ce compte.' });
          }
        } catch (e) {
          const error = String(e && (e.errorMessage || e.message || e.type) || e);
          const type = String(e && (e.type || e.errorMessage) || error).toUpperCase();
          post('community-operation-result', { jobId: jobId, action: 'invite', ok: false, identifier: identifier, outcome: /FLOOD_WAIT|SLOWMODE_WAIT|RATE_LIMIT/.test(type + ' ' + error.toUpperCase()) ? 'RATE_LIMIT' : 'FAILED', stage: stage, error: error });
        }
      };

      window.__cyrusTgScheduledSend = async function (payload) {
        try {
          const result = payload && payload.media
            ? await window.__cyrusTgSendMedia(payload.identifier, payload.media.data, payload.media.mimetype, payload.media.filename, payload.text || '')
            : await window.__cyrusTgSend(payload.identifier, String(payload && payload.text || ''));
          post('scheduled-send-result', { id: String(payload && payload.id || ''), ok: !!(result && result.ok), error: result && result.error || '' });
        } catch (error) {
          post('scheduled-send-result', { id: String(payload && payload.id || ''), ok: false, error: String(error && error.message || error) });
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
