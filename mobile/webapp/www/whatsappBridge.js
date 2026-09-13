// Script injecte tel quel (via EmbeddedWebView.evaluate) dans la WebView
// chargeant web.whatsapp.com. Charge comme fichier texte brut (fetch + .text())
// plutot qu'une chaine JS imbriquee dans app.js : evite le piege des quotes
// echappees consommees par un parseur externe (vecu avec le template literal
// TypeScript de la version React Native, voir mobile/CyrusMobile/
// whatsappWebBridge.ts). Reprend la meme logique, deja validee sur appareil
// reel (connexion/envoi/reception confirmes le 2026-09-10) - seul postMessage
// change (window.Cyrus.postMessage au lieu de window.ReactNativeWebView.postMessage).
(function () {
  function post(type, payload) {
    if (window.Cyrus) {
      window.Cyrus.postMessage(JSON.stringify({ type: type, payload: payload }));
    }
  }

  if (window.__cyrusBridgeInstalled) return true;
  window.__cyrusBridgeInstalled = true;

  function installBridge() {
    try {
      if (!window.require) return false;

      const Socket = window.require('WAWebSocketModel').Socket;
      const Collections = window.require('WAWebCollections');
      if (!Socket || !Collections || !Collections.Msg || !Collections.Chat) {
        return false;
      }

      const reportState = function () {
        post('state', { state: Socket.state });
      };
      Socket.on('change:state', reportState);
      reportState();

      Collections.Msg.on('add', function (msg) {
        if (!msg.isNewMsg) return;
        if (msg.type === 'ciphertext' || msg.type === 'revoked') return;
        try {
          const m = msg.serialize();
          const body = m.body || (m.caption || '');
          if (!body) return;
          post('message', {
            id: m.id && m.id._serialized,
            from: m.from && m.from._serialized,
            to: m.to && m.to._serialized,
            fromMe: !!(m.id && m.id.fromMe),
            body: body,
            t: m.t,
          });
        } catch (e) {
          post('bridge-error', { where: 'msg-add', message: String(e) });
        }
      });

      function safeCall(fn) {
        try {
          return fn();
        } catch (e) {
          return undefined;
        }
      }

      async function enforceLidAndPnRetrieval(userId) {
        const wid = window.require('WAWebWidFactory').createWid(userId);
        const isLid = wid.server === 'lid';
        const ApiContact = window.require('WAWebApiContact');
        const QueryExists = window.require('WAWebQueryExistsJob');

        let lid = isLid ? wid : safeCall(function () { return ApiContact.getCurrentLid(wid); });
        let phone = isLid ? safeCall(function () { return ApiContact.getPhoneNumber(wid); }) : wid;

        if (!isLid && !lid) {
          const queryResult = await QueryExists.queryWidExists(wid).catch(function () { return null; });
          if (queryResult && queryResult.wid) {
            lid = safeCall(function () { return ApiContact.getCurrentLid(wid); });
          }
        }
        if (isLid && !phone) {
          const queryResult = await QueryExists.queryWidExists(wid).catch(function () { return null; });
          if (queryResult && queryResult.wid) {
            phone = safeCall(function () { return ApiContact.getPhoneNumber(wid); });
          }
        }
        return { lid: lid, phone: phone };
      }

      window.__cyrusSend = async function (chatId, text) {
        let stage = 'init';
        try {
          const WidFactory = window.require('WAWebWidFactory');
          const chatWid = WidFactory.createWid(chatId);

          stage = 'enforceLidAndPnRetrieval';
          try {
            await enforceLidAndPnRetrieval(chatId);
          } catch (e) {
            post('bridge-error', { where: 'enforceLidAndPnRetrieval', message: String(e) });
          }

          stage = 'findOrCreateLatestChat';
          let chat = Collections.Chat.get(chatWid);
          if (!chat) {
            const found = await window
              .require('WAWebFindChatAction')
              .findOrCreateLatestChat(chatWid);
            chat = found && found.chat;
          }
          if (!chat) throw new Error('Chat introuvable: ' + chatId);

          stage = 'resolveFrom';
          const meUsers = window.require('WAWebUserPrefsMeUser');
          let from = chat.id.isLid()
            ? safeCall(function () { return meUsers.getMaybeMeLidUser(); })
            : undefined;
          if (!from) from = safeCall(function () { return meUsers.getMaybeMePnUser(); });
          if (!from) throw new Error("Impossible de determiner l'identite expeditrice (from)");

          stage = 'buildMessage';
          const MsgKey = window.require('WAWebMsgKey');
          const newId = await MsgKey.newId();
          const newMsgKey = new MsgKey({
            from: from,
            to: chat.id,
            id: newId,
            selfDir: 'out',
          });

          const message = {
            id: newMsgKey,
            ack: 0,
            body: text,
            from: from,
            to: chat.id,
            local: true,
            self: 'out',
            t: parseInt(String(Date.now() / 1000), 10),
            isNewMsg: true,
            type: 'chat',
          };

          stage = 'addAndSendMsgToChat';
          const result = window
            .require('WAWebSendMsgChatAction')
            .addAndSendMsgToChat(chat, message);
          await result[0];

          post('send-result', { ok: true, chatId: chatId });
        } catch (e) {
          post('send-result', { ok: false, chatId: chatId, error: '[' + stage + '] ' + String(e) });
        }
      };

      // Extraction : liste des groupes (Collections.Chat.isGroup()) puis,
      // sur demande, leurs membres (chat.groupMetadata.participants) - pour
      // le module "extraction de donnees" de la webapp (import de listes de
      // diffusion depuis un groupe existant).
      window.__cyrusGetGroups = function () {
        try {
          const groups = Collections.Chat.getModelsArray()
            .filter(function (c) { return c.isGroup && c.isGroup(); })
            .map(function (c) {
              return {
                id: c.id && c.id._serialized,
                name: c.name || c.formattedTitle || '',
                participantsCount: c.groupMetadata && c.groupMetadata.participants
                  ? c.groupMetadata.participants.length
                  : 0,
              };
            });
          post('groups', { groups: groups });
        } catch (e) {
          post('bridge-error', { where: 'getGroups', message: String(e) });
        }
      };

      window.__cyrusGetGroupMembers = async function (groupId) {
        try {
          const WidFactory = window.require('WAWebWidFactory');
          const groupWid = WidFactory.createWid(groupId);
          let chat = Collections.Chat.get(groupWid);
          if (!chat) {
            const found = await window.require('WAWebFindChatAction').findOrCreateLatestChat(groupWid);
            chat = found && found.chat;
          }
          if (!chat || !chat.groupMetadata) {
            throw new Error('Groupe introuvable ou metadonnees indisponibles: ' + groupId);
          }
          if ((!chat.groupMetadata.participants || chat.groupMetadata.participants.length === 0)
            && typeof chat.groupMetadata.update === 'function') {
            await chat.groupMetadata.update();
          }
          const members = (chat.groupMetadata.participants || []).map(function (p) {
            return { id: p.id && p.id._serialized, isAdmin: !!p.isAdmin };
          });
          post('group-members', { groupId: groupId, members: members });
        } catch (e) {
          post('bridge-error', { where: 'getGroupMembers', message: String(e) });
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
      post('bridge-error', { where: 'timeout', message: 'Modules WhatsApp Web non detectes apres 30s' });
    }
  }, 750);
})();
true;
