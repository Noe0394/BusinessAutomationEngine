// Moteur WhatsApp alternatif basé sur whatsapp-web.js (Puppeteer/Chromium),
// réservé à un usage LOCAL sur ce PC (WHATSAPP_ENGINE=wwebjs, voir .env) —
// la production sur le VPS distant continue d'utiliser exclusivement
// adapters/whatsapp.js (Baileys, sans Chromium, bien plus léger). Les deux
// moteurs ne partagent ni dossier de session ni sauvegarde GitHub : voir
// AUTH_DIR_BASE ci-dessous et adapters/whatsappManager.js (garde
// WHATSAPP_ENGINE === 'wwebjs' sur la migration/liste GitHub héritées de
// Baileys, pour ne jamais lire/écrire l'état de session partagé avec le VPS).
//
// Expose la même interface publique que adapters/whatsapp.js#createSession
// pour rester un remplacement direct côté adapters/whatsappManager.js — voir
// ce fichier pour le détail de chaque méthode attendue par le reste de
// l'application (index.js, queues/campaignEngine.js).
let Client;
let LocalAuth;
let MessageMedia;
try {
  ({ Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'));
} catch (err) {
  throw new Error(
    "whatsapp-web.js n'est pas installé. Lancez `npm install whatsapp-web.js puppeteer` " +
    'avant de démarrer avec WHATSAPP_ENGINE=wwebjs.',
  );
}
const qrcode = require('qrcode-terminal');

// Dossier de session dédié à ce moteur, distinct de "auth_info_baileys"
// (utilisé par le VPS en production) : aucun risque d'écrasement même si ce
// dépôt est un jour partagé entre les deux environnements.
const AUTH_DIR_BASE = process.env.AUTH_DIR_WWEBJS || 'auth_info_wwebjs_local';

// Préfixe de clientId Puppeteer supplémentaire pour isoler cette machine de
// toute autre instance locale qui tournerait ailleurs avec le même dépôt —
// demandé explicitement pour éviter tout conflit avec les sessions du VPS.
const LOCAL_SESSION_ID = process.env.LOCAL_SESSION_ID || 'local-pc';

// Bridage Chromium pensé pour un PC à 4 Go de RAM (voir demande utilisateur) :
// désactive le sandbox (nécessaire dans la plupart des environnements sans
// privilèges dédiés), le rendu GPU et le /dev/shm (souvent trop petit), et
// plafonne le tas V8 à 256 Mo.
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--js-flags="--max-old-space-size=256"',
];

function jidToWwebjs(jid) {
  // Le reste de l'application (lib/whatsappRecipients.js) construit toujours
  // les identifiants individuels au format Baileys ("<digits>@s.whatsapp.net")
  // — whatsapp-web.js attend "@c.us" pour ces mêmes contacts. Les identifiants
  // de groupe ("@g.us") sont identiques dans les deux librairies.
  return String(jid || '').replace(/@s\.whatsapp\.net$/, '@c.us');
}

function createSession(tenantId) {
  const clientId = `${LOCAL_SESSION_ID}-${tenantId}`;

  let client = null;
  let latestQR = null;
  let connected = false;
  const incomingMessageListeners = [];
  const accountResetListeners = [];
  const contactNames = new Map();

  function onIncomingMessage(callback) {
    incomingMessageListeners.push(callback);
  }

  function notifyIncomingMessage() {
    incomingMessageListeners.forEach((callback) => {
      try {
        callback();
      } catch (err) {
        console.error(`Erreur dans un écouteur de message entrant (tenant "${tenantId}") :`, err.message);
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
        console.error(`Erreur dans un écouteur de réinitialisation de compte (tenant "${tenantId}") :`, err.message);
      }
    });
  }

  function getContactName(jid) {
    return contactNames.get(jid) || null;
  }

  function buildClient() {
    client = new Client({
      authStrategy: new LocalAuth({ clientId, dataPath: AUTH_DIR_BASE }),
      puppeteer: { args: PUPPETEER_ARGS },
    });

    client.on('qr', (qr) => {
      latestQR = qr;
      qrcode.generate(qr, { small: true });
    });
    client.on('ready', () => {
      connected = true;
      latestQR = null;
      console.log(`whatsapp-web.js (tenant "${tenantId}") : connecté.`);
    });
    client.on('authenticated', () => {
      latestQR = null;
    });
    client.on('disconnected', (reason) => {
      connected = false;
      console.warn(`whatsapp-web.js (tenant "${tenantId}") déconnecté : ${reason}`);
    });
    client.on('message', () => notifyIncomingMessage());
    client.on('contact_changed', (_msg, _oldId, _newId, isContact) => {
      if (isContact) {
        // Numéro migré vers un nouveau JID (changement de compte) — voir
        // adapters/whatsapp.js#onAccountReset pour la même logique côté
        // Baileys : la campagne en cours de ce tenant n'a plus de sens.
        notifyAccountReset();
      }
    });

    return client;
  }

  function connect() {
    if (client) return Promise.resolve();
    buildClient();
    return client.initialize().catch((err) => {
      console.error(`Erreur d'initialisation whatsapp-web.js (tenant "${tenantId}") :`, err.message);
      client = null;
      throw err;
    });
  }

  async function restoreSessionFromRemote() {
    // Pas de sauvegarde distante pour ce moteur : LocalAuth persiste déjà la
    // session sur le disque local (AUTH_DIR_BASE/session-<clientId>), ce qui
    // suffit pour un usage personnel sur cette seule machine. Ne touche
    // jamais au dépôt GitHub partagé utilisé par le VPS (Baileys).
  }

  async function sendMessage(to, text) {
    if (!client || !connected) {
      throw new Error('Adaptateur WhatsApp (wwebjs) non connecté.');
    }
    return client.sendMessage(jidToWwebjs(to), text);
  }

  async function sendMedia(to, { buffer, mimetype, filename, caption, forceDocument }) {
    if (!client || !connected) {
      throw new Error('Adaptateur WhatsApp (wwebjs) non connecté.');
    }
    const media = new MessageMedia(mimetype || 'application/octet-stream', buffer.toString('base64'), filename || 'fichier');
    return client.sendMessage(jidToWwebjs(to), media, {
      caption,
      sendMediaAsDocument: !!forceDocument,
      sendMediaAsSticker: !forceDocument && mimetype === 'image/webp',
    });
  }

  function getQRCode() {
    return latestQR;
  }

  function isConnected() {
    return connected;
  }

  async function requestPairingCode(phoneNumber) {
    if (!client) {
      await connect();
    }
    if (typeof client.requestPairingCode !== 'function') {
      throw new Error('Appairage par code non supporté par cette version de whatsapp-web.js — utilisez le QR code.');
    }
    const digits = String(phoneNumber).replace(/\D/g, '');
    if (!digits) {
      throw new Error('INVALID_PHONE_NUMBER');
    }
    return client.requestPairingCode(digits);
  }

  function mapParticipant(p) {
    const id = (p.id && p.id._serialized) || null;
    return { id, jid: id, lid: null, isAdmin: !!p.isAdmin, isSuperAdmin: !!p.isSuperAdmin };
  }

  async function getGroupMetadata(groupId) {
    if (!client) {
      throw new Error('Adaptateur WhatsApp (wwebjs) non initialisé.');
    }
    const chat = await client.getChatById(groupId);
    return {
      id: chat.id._serialized,
      subject: chat.name,
      participants: (chat.participants || []).map(mapParticipant),
    };
  }

  async function getGroups() {
    if (!client) return [];
    try {
      const chats = await client.getChats();
      return chats.filter((c) => c.isGroup).map((c) => ({ id: c.id._serialized, subject: c.name }));
    } catch (err) {
      console.error(`Erreur lors de la récupération des groupes (tenant "${tenantId}") :`, err.message);
      return [];
    }
  }

  async function getGroupParticipants(groupId) {
    const metadata = await getGroupMetadata(groupId);
    return metadata.participants;
  }

  async function logout() {
    notifyAccountReset();
    contactNames.clear();
    if (client) {
      // client.logout() efface aussi la session LocalAuth sur disque.
      await client.logout().catch((err) => {
        console.warn(`Erreur lors du logout whatsapp-web.js (tenant "${tenantId}") :`, err.message);
      });
      await client.destroy().catch(() => {});
    }
    client = null;
    connected = false;
    latestQR = null;
  }

  function dispose() {
    if (client) {
      client.destroy().catch(() => {});
    }
    client = null;
    connected = false;
    latestQR = null;
  }

  function getStorageStatus() {
    // Pas de sauvegarde distante pour ce moteur (voir restoreSessionFromRemote).
    return {
      enabled: false,
      repo: null,
      branch: null,
      lastPushOk: null,
      lastPushError: null,
      lastPushAt: null,
    };
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
