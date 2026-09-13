/**
 * Script injecté dans la WebView WhatsApp Web (voir WhatsAppWebEngine.tsx).
 *
 * Ce n'est PAS un port de whatsapp-web.js/Utils.js (des milliers de lignes,
 * pensées pour Puppeteer : médias, citations, sondages, boutons, listes,
 * statuts, chaînes...). C'est une réécriture volontairement minimale ciblant
 * exactement le même périmètre que le spike Baileys qu'elle remplace (voir
 * nodejs-assets/nodejs-project/main.js) : texte seul, un contact à la fois,
 * rien d'autre.
 *
 * Elle s'appuie sur les MÊMES modules internes que whatsapp-web.js
 * (`window.require('WAWebXxx')`, cf. local-client/node_modules/whatsapp-web.js
 * /src/Client.js et src/util/Injected/Utils.js) — mais `window.require` est un
 * global exposé par le bundle WhatsApp Web LUI-MÊME (pas par Puppeteer/
 * whatsapp-web.js), donc ça fonctionne identiquement dans une WebView Android
 * native. C'est exactement l'hypothèse validée par WebViewTest.tsx.
 *
 * Fragilité assumée : ces noms de modules sont ceux de la version de
 * WhatsApp Web en vigueur au moment de l'écriture (2026-09-10) et peuvent
 * changer lors d'une mise à jour WhatsApp — même fragilité structurelle que
 * whatsapp-web.js côté PC, qui casse aussi à chaque changement de ce type.
 *
 * ATTENTION piège vécu (2026-09-10) : ce script est un template literal —
 * `\'` dedans est consommé par le PARSEUR EXTERNE (Babel/Metro) et devient
 * un simple `'` dans le texte injecté, PAS un `\'` echappé pour le moteur
 * JS de la WebView. Résultat : une apostrophe dans une chaîne à quotes
 * simples à l'intérieur du script casse le JS injecté avec une erreur de
 * syntaxe QUE `curl .../index.bundle` NE DETECTE JAMAIS (il ne valide que
 * le TypeScript externe, jamais le JS à l'intérieur de ce template
 * literal) — le seul symptôme est un pont qui ne s'installe jamais
 * (bloqué sur "Chargement...", aucun `bridge-ready`/`state` reçu), sans
 * aucune erreur visible. Toujours utiliser des guillemets doubles `"..."`
 * pour toute chaîne interne contenant une apostrophe.
 */

export const WHATSAPP_WEB_BRIDGE_SCRIPT = `
(function () {
  function post(type, payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, payload: payload }));
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

      // Reception : un seul evenement, filtre au strict necessaire (texte,
      // pas les accuses de reception/placeholders) - meme filtre que cote
      // Baileys mobile (voir main.js, mitigation CVE-2026-48063).
      Collections.Msg.on('add', function (msg) {
        if (!msg.isNewMsg) return;
        if (msg.type === 'ciphertext' || msg.type === 'revoked') return;
        try {
          const m = msg.serialize();
          const body = m.body || (m.caption || '');
          if (!body) return; // texte seul pour ce moteur
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

      // Repro de window.WWebJS.enforceLidAndPnRetrieval (voir Utils.js
      // lignes ~1694-1722) : force la resolution serveur du mapping
      // LID<->numero d'un contact quand elle n'est pas deja en cache
      // local. Necessaire AVANT d'envoyer a un contact jamais ouvert dans
      // cette session : sans ca, WhatsApp adresse en interne certains
      // contacts par LID (identifiant prive, deploiement progressif cote
      // WhatsApp) et l'envoi echoue avec "Error: No lid for user" - un
      // repli sur l'identite numero classique seul (tente en premier,
      // insuffisant) ne resout pas cette absence de mapping. Observe en
      // conditions reelles (2026-09-10, changement de destinataire).
      // "safe*" : plusieurs des accesseurs WA internes utilises ici (LID en
      // cours de deploiement, comportement pas totalement stabilise cote
      // WhatsApp) se sont averes LEVER une exception plutot que renvoyer
      // une valeur vide en l'absence de mapping (constate en conditions
      // reelles le 2026-09-10 : "Error: No lid for user" survenait des le
      // tout debut de l'envoi, avant meme la resolution du chat). Chaque
      // accesseur est donc isole dans son propre try/catch : le but de
      // cette fonction est d'AMELIORER les chances de succes en
      // prechargeant le mapping LID<->numero, jamais de faire echouer
      // l'envoi elle-meme si elle n'y arrive pas.
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
        return {lid: lid, phone: phone};
      }

      // Envoi - equivalent minimal de window.WWebJS.sendMessage (texte
      // seul), voir local-client/node_modules/whatsapp-web.js/src/util/
      // Injected/Utils.js lignes ~445-586 pour la version complete dont
      // ceci est extrait.
      window.__cyrusSend = async function (chatId, text) {
        // "stage" : etiquette la derniere etape entamee, pour que le
        // message d'erreur remonte (via post('send-result', ...)) dise
        // PRECISEMENT ou ca a casse - indispensable ici, aucun acces
        // devtools sur cette WebView pour inspecter une pile d'appels.
        let stage = 'init';
        try {
          const WidFactory = window.require('WAWebWidFactory');
          const chatWid = WidFactory.createWid(chatId);

          stage = 'enforceLidAndPnRetrieval';
          try {
            await enforceLidAndPnRetrieval(chatId);
          } catch (e) {
            // Purement best-effort (prechargement de cache) - une echec
            // ici ne doit jamais empecher de tenter l'envoi lui-meme.
            post('bridge-error', {where: 'enforceLidAndPnRetrieval', message: String(e)});
          }

          // "Collections.Chat.find()" n'est pas une methode publique valide
          // ici (produit "TypeError: this.findImpl is not a function") -
          // c'est WAWebFindChatAction.findOrCreateLatestChat() qu'utilise
          // reellement whatsapp-web.js pour creer une conversation absente,
          // voir local-client/node_modules/whatsapp-web.js/src/util/
          // Injected/Utils.js (window.WWebJS.getChat), ligne ~868.
          stage = 'findOrCreateLatestChat';
          let chat = Collections.Chat.get(chatWid);
          if (!chat) {
            const found = await window
              .require('WAWebFindChatAction')
              .findOrCreateLatestChat(chatWid);
            chat = found && found.chat;
          }
          if (!chat) throw new Error('Chat introuvable: ' + chatId);

          // WhatsApp adresse certains contacts en interne au format "LID"
          // (identifiant prive, deploiement progressif cote WhatsApp) -
          // pour leur repondre, il faut alors envoyer depuis SA PROPRE
          // identite LID plutot que son numero. Plusieurs des accesseurs
          // ci-dessous se sont averes LEVER une exception ("No lid for
          // user") plutot que renvoyer une valeur vide en l'absence de
          // mapping - constate en conditions reelles le 2026-09-10 -
          // d'ou safeCall() sur chacun plutot qu'un seul try/catch global.
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

      post('bridge-ready', {});
      return true;
    } catch (e) {
      post('bridge-error', { where: 'installBridge', message: String(e) });
      return false;
    }
  }

  // Les modules internes de WhatsApp Web ne sont pas disponibles des le
  // premier tick apres le chargement HTML (bundle encore en cours
  // d'execution) - on sonde par intervalle plutot que de deviner un delai
  // fixe, avec un plafond pour ne pas tourner indefiniment si la page ne
  // charge jamais WhatsApp Web (ex: erreur reseau).
  let attempts = 0;
  const maxAttempts = 40; // ~40 x 750ms = 30s
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
`;
