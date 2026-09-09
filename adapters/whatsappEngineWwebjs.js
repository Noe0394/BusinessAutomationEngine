const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// Même racine que le moteur Baileys (voir adapters/whatsappEngineBaileys.js)
// pour rester sur le même volume Docker déjà monté en persistance
// (docker-compose.yml, service "whatsapp_auth") — chaque tenant obtient un
// sous-dossier dédié géré par LocalAuth lui-même ("session-<tenantId>").
const AUTH_DIR_BASE = process.env.AUTH_DIR || 'auth_info_baileys';
const WWEBJS_DIR_BASE = path.join(AUTH_DIR_BASE, 'wwebjs');
fs.mkdirSync(WWEBJS_DIR_BASE, { recursive: true });

// --max-old-space-size=256 : plafonne le tas V8 de CHAQUE instance Chromium
// à 256 Mo — nécessaire pour tenir un grand nombre de tenants simultanés
// (haute densité, 50 utilisateurs visés) sur une RAM serveur partagée. Un
// dépassement fait planter le processus de rendu (pas tout Chromium) ; le
// moteur reconnecte automatiquement (voir scheduleReconnect) le cas échéant.
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--js-flags=--max-old-space-size=256',
];

// Types de ressources bloquées en continu après le chargement initial (voir
// leur mise en place dans doConnect ci-dessous) : aucune valeur pour un
// client 100% headless jamais affiché à un humain, mais un coût RAM/réseau
// réel et récurrent (avatars de contacts, miniatures de médias reçus, police
// et emoji SVG rechargés). "stylesheet" est DÉLIBÉRÉMENT absent de cette
// liste : WhatsApp Web s'appuie en interne sur des calculs de style (visibilité
// via offsetParent/display) pour détecter certains états (QR prêt, écran de
// chargement) — le bloquer a déjà cassé cette détection en usage réel
// communautaire de whatsapp-web.js. Le gain RAM de bloquer le CSS est de
// toute façon marginal (quelques dizaines de Ko) comparé au risque de
// perdre la connexion WhatsApp elle-même.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media']);

// whatsapp-web.js adresse les contacts individuels en "<numero>@c.us" là où
// Baileys (et donc tout le reste de ce serveur : campagnes, contacts
// mémorisés...) utilise "<numero>@s.whatsapp.net" — les identifiants de
// groupe ("@g.us") sont eux identiques dans les deux librairies. Sans cette
// traduction dans les deux sens, changer WHATSAPP_ENGINE casserait
// silencieusement l'envoi vers des destinataires déjà enregistrés sous
// l'autre moteur.
function toWwebjsId(jid) {
  return String(jid || '').replace(/@s\.whatsapp\.net$/, '@c.us');
}
function toBaileysId(id) {
  return String(id || '').replace(/@c\.us$/, '@s.whatsapp.net');
}

function createSession(tenantId) {
  const tenantSessionDir = path.join(WWEBJS_DIR_BASE, `session-${tenantId}`);

  let client = null;
  let latestQR = null;
  let connected = false;
  let reconnectTimer = null;
  let consecutiveFailures = 0;

  const contactNames = new Map();
  const incomingMessageListeners = [];
  const accountResetListeners = [];

  function onIncomingMessage(callback) {
    incomingMessageListeners.push(callback);
  }

  function notifyIncomingMessage(msg) {
    incomingMessageListeners.forEach((callback) => {
      try {
        callback(msg);
      } catch (err) {
        console.error(`Erreur dans un écouteur de message entrant (tenant "${tenantId}", moteur wwebjs) :`, err.message);
      }
    });
  }

  function onAccountReset(callback) {
    accountResetListeners.push(callback);
  }

  function notifyAccountReset() {
    accountResetListeners.forEach((callback) => {
      try {
        callback();
      } catch (err) {
        console.error(`Erreur dans un écouteur de réinitialisation de compte (tenant "${tenantId}", moteur wwebjs) :`, err.message);
      }
    });
  }

  function rememberContactName(jid, name) {
    if (jid && name) contactNames.set(jid, name);
  }

  function getContactName(jid) {
    return contactNames.get(jid) || null;
  }

  function getQRCode() {
    return latestQR;
  }

  function isConnected() {
    return connected;
  }

  const BASE_RECONNECT_DELAY_MS = 3000;
  const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

  // Même backoff exponentiel que le moteur Baileys (voir
  // whatsappEngineBaileys.js) : protège contre un martèlement en boucle en
  // cas d'échec persistant (Chromium qui crash au lancement, session
  // révoquée...).
  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delayMs = Math.min(BASE_RECONNECT_DELAY_MS * (2 ** consecutiveFailures), MAX_RECONNECT_DELAY_MS);
    consecutiveFailures += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      doConnect().catch((err) => {
        console.error(`Erreur lors de la tentative de reconnexion WhatsApp (tenant "${tenantId}", moteur wwebjs):`, err);
        scheduleReconnect();
      });
    }, delayMs);
  }

  // Sérialise connect()/logout() comme le moteur Baileys (voir
  // whatsappEngineBaileys.js#runSerialized) : évite qu'une reconnexion
  // automatique et une déconnexion manuelle ne manipulent le même profil
  // Chromium (tenantSessionDir) en parallèle.
  let lifecycleQueue = Promise.resolve();
  function runSerialized(fn) {
    const run = lifecycleQueue.then(fn, fn);
    lifecycleQueue = run.then(() => {}, () => {});
    return run;
  }

  async function doConnect() {
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        // ignore
      }
    }

    client = new Client({
      authStrategy: new LocalAuth({ clientId: tenantId, dataPath: WWEBJS_DIR_BASE }),
      puppeteer: {
        headless: true,
        args: PUPPETEER_ARGS,
      },
    });

    client.on('qr', (qr) => {
      latestQR = qr;
      console.log(`=== QR CODE BRUT (tenant "${tenantId}", moteur wwebjs) ===`);
      console.log(qr);
      console.log('====================');
    });

    client.on('ready', () => {
      connected = true;
      latestQR = null;
      consecutiveFailures = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      console.log(`Connexion WhatsApp établie (tenant "${tenantId}", moteur wwebjs).`);

      // Préchauffe le cache de noms de contacts (voir getContactName) —
      // wwebjs n'envoie pas d'événement "contacts.upsert" équivalent à
      // Baileys au moment de l'appairage, donc ce best-effort ponctuel est la
      // seule source disponible en dehors des messages reçus au fil de l'eau.
      client.getContacts()
        .then((contacts) => {
          contacts.forEach((c) => {
            const name = c.pushname || c.name || c.verifiedName;
            if (name) rememberContactName(toBaileysId(c.id._serialized), name);
          });
        })
        .catch(() => {});
    });

    client.on('disconnected', (reason) => {
      connected = false;
      console.log(
        `Connexion WhatsApp fermée (tenant "${tenantId}", moteur wwebjs).`,
        reason ? `(raison: ${reason})` : '',
        '— reconnexion automatique planifiée.',
      );
      if (reason === 'LOGOUT') {
        notifyAccountReset();
      }
      scheduleReconnect();
    });

    client.on('auth_failure', (msg) => {
      connected = false;
      console.error(`Échec d'authentification WhatsApp (tenant "${tenantId}", moteur wwebjs) : ${msg}`);
      scheduleReconnect();
    });

    client.on('message', (msg) => {
      if (msg.fromMe || msg.from === 'status@broadcast') return;
      // msg._data.notifyName : champ interne non documenté de whatsapp-web.js
      // (équivalent du pushName Baileys), déjà résolu de façon synchrone sur
      // l'objet — best-effort, sans casser si l'implémentation interne change
      // un jour.
      try {
        const notifyName = msg._data && msg._data.notifyName;
        if (notifyName) rememberContactName(toBaileysId(msg.from), notifyName);
      } catch (err) {
        // ignore
      }
      notifyIncomingMessage(msg);
    });

    await client.initialize();

    // Mise en place APRÈS initialize() : whatsapp-web.js ne fournit aucun
    // point d'accroche public à sa page Puppeteer avant sa propre navigation
    // interne (Client#initialize crée la page et appelle page.goto() sans
    // hook exposé pour intervenir plus tôt) — le tout premier chargement du
    // bundle WhatsApp Web n'est donc pas couvert, seules les requêtes
    // ultérieures (durée de vie de la session) le sont, ce qui reste la part
    // la plus significative sur une session longue.
    if (client.pupPage) {
      try {
        await client.pupPage.setRequestInterception(true);
        client.pupPage.on('request', (req) => {
          if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
            req.abort().catch(() => {});
          } else {
            req.continue().catch(() => {});
          }
        });
      } catch (err) {
        console.warn(`Interception de requêtes Puppeteer non appliquée (tenant "${tenantId}", moteur wwebjs) :`, err.message);
      }
    }
  }

  function connect() {
    return runSerialized(doConnect);
  }

  // LocalAuth persiste un profil Chromium complet (cookies, IndexedDB...),
  // pas un simple creds.json — incompatible avec la sauvegarde GitHub basée
  // sur l'API Contents (limite de 1 Mo/fichier, voir whatsappAuthStore.js).
  // La persistance de ce moteur repose donc uniquement sur le volume Docker
  // monté sur AUTH_DIR_BASE : suffisant tant que ce volume survit aux
  // redéploiements, mais pas à une recréation du serveur — voir getStorageStatus.
  async function restoreSessionFromRemote() {
    return false;
  }

  function getStorageStatus() {
    return {
      enabled: false,
      repo: null,
      branch: null,
      lastPushOk: null,
      lastPushError: 'Sauvegarde GitHub non prise en charge par le moteur wwebjs (profil Chromium, pas un simple creds.json) — persistance via volume Docker uniquement.',
      lastPushAt: null,
    };
  }

  async function sendMessage(to, text) {
    if (!client) {
      throw new Error('Adaptateur WhatsApp non initialisé.');
    }
    return client.sendMessage(toWwebjsId(to), text);
  }

  async function sendMedia(to, { buffer, mimetype, filename, caption, forceDocument }) {
    if (!client) {
      throw new Error('Adaptateur WhatsApp non initialisé.');
    }
    const media = new MessageMedia(mimetype || 'application/octet-stream', buffer.toString('base64'), filename || 'fichier');
    const isSticker = !forceDocument && mimetype === 'image/webp';
    return client.sendMessage(toWwebjsId(to), media, {
      caption,
      sendMediaAsDocument: Boolean(forceDocument),
      sendMediaAsSticker: isSticker,
    });
  }

  async function requestPairingCode(phoneNumber) {
    const digits = String(phoneNumber).replace(/\D/g, '');
    if (!digits) {
      throw new Error('INVALID_PHONE_NUMBER');
    }

    if (connected) {
      await logout();
    } else if (!client) {
      await connect();
    }

    if (!client) {
      throw new Error('Adaptateur WhatsApp non initialisé.');
    }

    const rawCode = await client.requestPairingCode(digits);
    return rawCode.replace(/-/g, '').match(/.{1,4}/g).join('-');
  }

  function mapGroupChat(chat) {
    return {
      id: chat.id._serialized,
      subject: chat.name,
      participants: (chat.participants || []).map((p) => ({
        id: toBaileysId(p.id._serialized),
        admin: p.isSuperAdmin ? 'superadmin' : (p.isAdmin ? 'admin' : null),
      })),
    };
  }

  async function getGroupMetadata(groupId) {
    if (!client) {
      throw new Error('Adaptateur WhatsApp non initialisé.');
    }
    const chat = await client.getChatById(groupId);
    return mapGroupChat(chat);
  }

  async function getGroups() {
    if (!client) return [];
    try {
      const chats = await client.getChats();
      return chats.filter((c) => c.isGroup).map(mapGroupChat);
    } catch (err) {
      console.error(`Erreur lors de la récupération des groupes (tenant "${tenantId}", moteur wwebjs):`, err);
      return [];
    }
  }

  async function getGroupParticipants(groupId) {
    const metadata = await getGroupMetadata(groupId);
    return metadata.participants;
  }

  function logout() {
    return runSerialized(async () => {
      notifyAccountReset();

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (client) {
        try {
          await client.logout();
        } catch (err) {
          console.warn(`Erreur lors du logout WhatsApp (tenant "${tenantId}", moteur wwebjs, nettoyage local effectué quand même) :`, err.message);
        }
        try {
          await client.destroy();
        } catch (err) {
          // ignore
        }
      }

      connected = false;
      latestQR = null;
      client = null;
      contactNames.clear();

      fs.rmSync(tenantSessionDir, { recursive: true, force: true });

      await doConnect();
    });
  }

  // Libération "douce" (voir adapters/sessionRegulator.js) : contrairement à
  // logout(), NE supprime PAS le profil Chromium local — le tenant reste
  // appairé et se reconnectera sans rescanner de QR à sa prochaine requête.
  function dispose() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (client) {
      client.destroy().catch(() => {});
    }
    client = null;
    connected = false;
    latestQR = null;
  }

  return {
    tenantId,
    connect,
    restoreSessionFromRemote,
    sendMessage,
    sendMedia,
    getQRCode,
    isConnected,
    requestPairingCode,
    getGroupMetadata,
    getGroups,
    getGroupParticipants,
    getContactName,
    onIncomingMessage,
    onAccountReset,
    logout,
    dispose,
    getStorageStatus,
  };
}

module.exports = {
  createSession,
  AUTH_DIR_BASE,
};
