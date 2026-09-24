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
            isGroup: /@g\.us$/.test(String(m.to && m.to._serialized || m.from && m.from._serialized || '')),
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
          return { ok: true };
        } catch (e) {
          post('send-result', { ok: false, chatId: chatId, error: '[' + stage + '] ' + String(e) });
          return { ok: false, error: '[' + stage + '] ' + String(e) };
        }
      };

      // Envoi de pièce jointe (image/vidéo/PDF) — port fidèle du chemin
      // média de whatsapp-web.js (processMediaData + sendMessage, voir
      // local-client/node_modules/whatsapp-web.js/src/util/Injected/Utils.js,
      // seule référence utilisée pour ce portage, jamais testée sur cet
      // appareil précis contrairement à l'envoi texte déjà validé
      // ci-dessus — mêmes modules internes WA Web réels, pas une
      // simulation). `data` : base64 brut (pas de préfixe data:...;base64,).
      function mediaInfoToFile(data, mimetype, filename) {
        const binary = window.atob(data);
        const buffer = new ArrayBuffer(binary.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
        const blob = new Blob([buffer], { type: mimetype });
        return new File([blob], filename || 'fichier', { type: mimetype, lastModified: Date.now() });
      }

      window.__cyrusSendMedia = async function (chatId, data, mimetype, filename, caption) {
        let stage = 'init';
        try {
          const WidFactory = window.require('WAWebWidFactory');
          const chatWid = WidFactory.createWid(chatId);

          stage = 'findOrCreateLatestChat';
          let chat = Collections.Chat.get(chatWid);
          if (!chat) {
            const found = await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid);
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

          stage = 'processMediaData';
          const file = mediaInfoToFile(data, mimetype, filename);
          const OpaqueData = window.require('WAWebMediaOpaqueData');
          const opaqueData = await OpaqueData.createFromData(file, mimetype);
          const mediaPrep = window.require('WAWebPrepRawMedia').prepRawMedia(opaqueData, {});
          const mediaData = await mediaPrep.waitForPrep();
          const mediaObject = window.require('WAWebMediaStorage').getOrCreateMediaObject(mediaData.filehash);
          const mediaType = window.require('WAWebMmsMediaTypes').msgToMediaType({ type: mediaData.type, isGif: mediaData.isGif });
          if (!mediaData.filehash) throw new Error('media-fault: filehash undefined');

          if (!(mediaData.mediaBlob instanceof OpaqueData)) {
            mediaData.mediaBlob = await OpaqueData.createFromData(mediaData.mediaBlob, mediaData.mediaBlob.type);
          }
          mediaData.renderableUrl = mediaData.mediaBlob.url();
          mediaObject.consolidate(mediaData.toJSON());
          mediaData.mediaBlob.autorelease();

          stage = 'uploadMedia';
          const { uploadMedia } = window.require('WAWebMediaMmsV4Upload');
          const uploadedMedia = await uploadMedia({ mimetype: mediaData.mimetype, mediaObject: mediaObject, mediaType: mediaType });
          const mediaEntry = uploadedMedia.mediaEntry;
          if (!mediaEntry) throw new Error('upload failed: media entry was not created');

          mediaData.set({
            clientUrl: mediaEntry.mmsUrl,
            deprecatedMms3Url: mediaEntry.deprecatedMms3Url,
            directPath: mediaEntry.directPath,
            mediaKey: mediaEntry.mediaKey,
            mediaKeyTimestamp: mediaEntry.mediaKeyTimestamp,
            filehash: mediaObject.filehash,
            encFilehash: mediaEntry.encFilehash,
            uploadhash: mediaEntry.uploadHash,
            size: mediaObject.size,
            streamingSidecar: mediaEntry.sidecar,
            firstFrameSidecar: mediaEntry.firstFrameSidecar,
          });

          stage = 'buildMessage';
          const MsgKey = window.require('WAWebMsgKey');
          const newId = await MsgKey.newId();
          const newMsgKey = new MsgKey({ from: from, to: chat.id, id: newId, selfDir: 'out' });

          const message = Object.assign({
            id: newMsgKey,
            ack: 0,
            body: caption || '',
            caption: caption || '',
            from: from,
            to: chat.id,
            local: true,
            self: 'out',
            t: parseInt(String(Date.now() / 1000), 10),
            isNewMsg: true,
            type: mediaType,
          }, mediaData.toJSON ? mediaData.toJSON() : {});

          stage = 'addAndSendMsgToChat';
          const result = window.require('WAWebSendMsgChatAction').addAndSendMsgToChat(chat, message);
          await result[0];

          post('send-result', { ok: true, chatId: chatId });
          return { ok: true };
        } catch (e) {
          post('send-result', { ok: false, chatId: chatId, error: '[' + stage + '] ' + String(e) });
          return { ok: false, error: '[' + stage + '] ' + String(e) };
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

      // Création/invitation de groupes. La création WhatsApp exige au moins
      // un participant; le premier contact validé sert donc de membre initial.
      // Les autres ajouts sont déclenchés un par un par l'interface, avec un
      // délai entre deux appels et une confirmation explicite côté Cyrus.
      window.__cyrusWaCommunityCreate = async function (payload) {
        const jobId = String(payload && payload.jobId || '');
        let stage = 'validate';
        try {
          const title = String(payload && payload.title || '').trim().slice(0, 100);
          const about = String(payload && payload.about || '').trim().slice(0, 255);
          const identifier = String(payload && payload.firstIdentifier || '').replace(/\D/g, '');
          if (!jobId || title.length < 2 || !/^\d{8,15}$/.test(identifier)) throw new Error('Nom du groupe ou premier numéro invalide.');
          stage = 'verifyFirstMember';
          const WidFactory = window.require('WAWebWidFactory');
          const firstWid = WidFactory.createWid(identifier);
          const exists = await window.require('WAWebQueryExistsJob').queryWidExists(firstWid);
          if (!exists || !exists.wid) throw new Error('Le premier contact ne possède pas de compte WhatsApp actif.');

          stage = 'createGroup';
          const created = await window.require('WAWebGroupCreateJob').createGroup({
            addressingModeOverride: 'lid', memberAddMode: false, membershipApprovalMode: false,
            announce: false, restrict: false, ephemeralDuration: 0, title: title,
          }, [{ phoneNumber: firstWid }]);
          if (!created || !created.wid || !created.wid._serialized) throw new Error(typeof created === 'string' ? created : 'WhatsApp n’a pas confirmé la création du groupe.');
          const groupId = created.wid._serialized;
          let inviteLink = '';
          let linkError = '';
          try {
            stage = 'exportInvite';
            const result = await window.require('WAWebMexFetchGroupInviteCodeJob').fetchMexGroupInviteCode(groupId);
            const code = String(result && result.code || result || '');
            if (!/^[A-Za-z0-9_-]{8,}$/.test(code)) throw new Error('Code de lien officiel indisponible.');
            inviteLink = 'https://chat.whatsapp.com/' + code;
          } catch (error) { linkError = String(error && error.message || error); }
          const first = (created.participants || []).find(function (item) {
            const wid = item && item.wid;
            return wid && (wid._serialized === firstWid._serialized || wid.user === firstWid.user);
          }) || (created.participants || [])[0];
          const firstCode = first && Number(first.error || 200);
          const firstOutcome = !first ? 'UNKNOWN'
            : firstCode === 200 ? 'INVITED'
            : firstCode === 409 ? 'ALREADY'
              : firstCode === 403 || firstCode === 408 ? 'NEEDS_LINK'
                : firstCode === 404 ? 'NOT_ON_PLATFORM' : 'FAILED';
          post('community-operation-result', {
            jobId: jobId, action: 'create', ok: true, groupId: groupId,
            title: String(created.subject || title), inviteLink: inviteLink, linkError: linkError,
            firstIdentifier: identifier, firstOutcome: firstOutcome,
            firstError: !first ? 'Le groupe est créé, mais WhatsApp n’a pas confirmé le résultat pour le premier membre. Vérifie le groupe avant une nouvelle invitation.' : first.error ? 'WhatsApp a refusé l’ajout direct (' + first.error + ').' : '',
          });
        } catch (error) {
          post('community-operation-result', { jobId: jobId, action: 'create', ok: false, stage: stage, error: String(error && error.message || error) });
        }
      };

      window.__cyrusWaCommunityInvite = async function (payload) {
        const jobId = String(payload && payload.jobId || '');
        const identifier = String(payload && payload.identifier || '').replace(/\D/g, '');
        const groupId = String(payload && payload.groupId || '');
        let stage = 'validate';
        try {
          if (!jobId || !/^\d{8,15}$/.test(identifier) || !/@g\.us$/.test(groupId)) throw new Error('Numéro WhatsApp ou identifiant de groupe invalide.');
          const WidFactory = window.require('WAWebWidFactory');
          const groupWid = WidFactory.createWid(groupId);
          const memberWid = WidFactory.createWid(identifier);
          stage = 'verifyContact';
          const exists = await window.require('WAWebQueryExistsJob').queryWidExists(memberWid);
          if (!exists || !exists.wid) {
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'NOT_ON_PLATFORM' });
            return;
          }
          stage = 'loadGroup';
          await window.require('WAWebGroupQueryJob').queryAndUpdateGroupMetadataById({ id: groupId });
          const collections = window.require('WAWebCollections');
          let group = collections.Chat.get(groupWid);
          if (!group) group = await collections.Chat.find(groupWid);
          if (!group) throw new Error('Groupe introuvable après création.');
          if (typeof group.iAmAdmin === 'function' && !group.iAmAdmin()) throw new Error('Le compte connecté n’est pas administrateur de ce groupe.');

          // WWebJS est fourni par l'adaptateur whatsapp-web.js sur PC, pas
          // par la WebView Android. Dans ce cas mobile, le seul repli proposé
          // est le lien officiel du groupe, avec opt-in explicite du job.
          if (!window.WWebJS || typeof window.WWebJS.getAddParticipantsRpcResult !== 'function') {
            stage = 'exportInvite';
            const inviteResult = await window.require('WAWebMexFetchGroupInviteCodeJob').fetchMexGroupInviteCode(groupId);
            const codeText = String(inviteResult && inviteResult.code || inviteResult || '');
            if (!/^[A-Za-z0-9_-]{8,}$/.test(codeText)) throw new Error('Ajout direct indisponible dans cette WebView et lien officiel introuvable.');
            const inviteLink = 'https://chat.whatsapp.com/' + codeText;
            if (payload.sendFallback !== true) {
              post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'NEEDS_LINK', inviteLink: inviteLink, error: 'Le pont mobile ne permet pas l’ajout direct; partage le lien officiel manuellement.' });
              return;
            }
            stage = 'sendInviteLink';
            const template = String(payload.inviteMessage || 'Bonjour {nom}, vous êtes invité(e) à rejoindre le groupe « {groupe} » : {lien}').slice(0, 600);
            const text = template.replace(/\{nom\}/g, String(payload.name || '')).replace(/\{groupe\}/g, String(payload.title || 'groupe')).replace(/\{lien\}/g, inviteLink);
            const sent = await window.__cyrusSend(identifier + '@c.us', text);
            if (!sent || !sent.ok) throw new Error(sent && sent.error || 'WhatsApp n’a pas confirmé l’envoi du lien.');
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'LINK_SENT', inviteLink: inviteLink });
            return;
          }

          stage = 'addParticipant';
          const result = await window.WWebJS.getAddParticipantsRpcResult(groupWid, memberWid);
          const code = Number(result && result.code);
          if (code === 200) {
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'INVITED' });
            return;
          }
          if (code === 409) {
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'ALREADY' });
            return;
          }
          if (code === 404) {
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'NOT_ON_PLATFORM' });
            return;
          }
          if (code === 419) {
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'FAILED', error: 'Le groupe a atteint sa limite de membres.' });
            return;
          }
          if (code === 403 || code === 408 || code === 417) {
            stage = 'exportInvite';
            const inviteResult = await window.require('WAWebMexFetchGroupInviteCodeJob').fetchMexGroupInviteCode(groupId);
            const codeText = String(inviteResult && inviteResult.code || inviteResult || '');
            if (!/^[A-Za-z0-9_-]{8,}$/.test(codeText)) throw new Error('Ajout direct refusé et lien officiel indisponible.');
            const inviteLink = 'https://chat.whatsapp.com/' + codeText;
            if (payload.sendFallback !== true) {
              post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'NEEDS_LINK', inviteLink: inviteLink });
              return;
            }
            stage = 'sendInviteLink';
            const template = String(payload.inviteMessage || 'Bonjour {nom}, vous êtes invité(e) à rejoindre le groupe « {groupe} » : {lien}').slice(0, 600);
            const text = template.replace(/\{nom\}/g, String(payload.name || '')).replace(/\{groupe\}/g, String(payload.title || 'groupe')).replace(/\{lien\}/g, inviteLink);
            const sent = await window.__cyrusSend(identifier + '@c.us', text);
            if (!sent || !sent.ok) throw new Error(sent && sent.error || 'WhatsApp n’a pas confirmé l’envoi du lien.');
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'LINK_SENT', inviteLink: inviteLink });
            return;
          }
          if (/429|rate|overlimit|flood/i.test(String(result && (result.message || result.code)))) {
            post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'RATE_LIMIT', error: String(result && result.message || 'Limitation de débit WhatsApp.') });
            return;
          }
          post('community-operation-result', { jobId: jobId, action: 'invite', ok: true, identifier: identifier, outcome: 'FAILED', error: String(result && result.message || ('Refus WhatsApp (' + (code || 'inconnu') + ').')) });
        } catch (error) {
          const message = String(error && error.message || error);
          post('community-operation-result', { jobId: jobId, action: 'invite', ok: false, identifier: identifier, outcome: /rate|429|overlimit|flood/i.test(message) ? 'RATE_LIMIT' : 'FAILED', stage: stage, error: message });
        }
      };

      window.__cyrusWaScheduledSend = async function (payload) {
        try {
          const identifier = String(payload && payload.identifier || '').replace(/\D/g, '');
          const recipient = identifier + '@c.us';
          const result = payload && payload.media
            ? await window.__cyrusSendMedia(recipient, payload.media.data, payload.media.mimetype, payload.media.filename, payload.text || '')
            : await window.__cyrusSend(recipient, String(payload && payload.text || ''));
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
      post('bridge-error', { where: 'timeout', message: 'Modules WhatsApp Web non detectes apres 30s' });
    }
  }, 750);
})();
true;
