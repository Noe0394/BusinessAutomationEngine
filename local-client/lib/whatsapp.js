// Session WhatsApp locale, mono-poste (un seul client, pas de multi-tenant
// contrairement à adapters/whatsappManager.js à la racine — un package
// installé = un PC = un compte WhatsApp). Basé sur le même moteur que
// adapters/whatsapp-wwebjs.js (whatsapp-web.js/Puppeteer, args bridés RAM),
// adapté ici en session unique et branché sur la base SQLite locale
// (lib/db.js) au lieu du disque JSON/GitHub du backend multi-tenant.
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { WHATSAPP_AUTH_DIR } = require('./paths');
const { upsertContact, recordMessage } = require('./db');

// --max-old-space-size abaisse a 150 Mo (au lieu de 256) et --single-process
// ajoutes sur demande explicite (cahier des charges "Zero-VPS", session du
// 2026-09-10) - a SURVEILLER : --single-process desactive l'architecture
// multi-processus de Chromium (rendu + reseau + GPU dans le meme processus),
// ce qui economise de la RAM mais rend tout crash du renderer fatal pour
// TOUTE la session WhatsApp d'un coup (au lieu d'un simple onglet qui
// plante) - accepte ici car combine avec le blocage des medias lourds
// ci-dessous (voir applyRequestInterception), qui reduit fortement la
// pression memoire qui aurait justifie 256 Mo. Si des crashs Puppeteer
// apparaissent en usage reel, remonter cette valeur ou retirer
// --single-process en premier reflexe de diagnostic.
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--single-process',
  '--js-flags="--max-old-space-size=150"',
];

// Blocage des medias lourds (images/video/audio/polices) - PAS des feuilles
// de style : bloquer les CSS casserait entierement la mise en page de
// WhatsApp Web (aucun moyen fiable de distinguer via Puppeteer un CSS
// "critique" d'un CSS "non critique", contrairement a images/video/audio qui
// sont un type de ressource explicite et sans risque fonctionnel a bloquer -
// seul l'affichage des photos de profil/apercus media est degrade, jamais
// l'envoi/reception de texte). Applique au plus tot des que `pupPage` existe
// (voir client.pupPage, expose par whatsapp-web.js dans Client.js) - le tout
// premier chargement de la page a deja pu telecharger quelques ressources
// avant ce point, mais tout chargement ULTERIEUR (nouveaux messages, media
// scrolle dans une conversation) est bloque, qui est la vraie source de
// croissance RAM sur une session longue.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

async function applyRequestInterception(state) {
  if (state.interceptionApplied || !client || !client.pupPage) return;
  state.interceptionApplied = true;
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
    console.warn('Interception des requêtes Puppeteer non appliquée :', err.message);
  }
}

let client = null;
let latestQR = null;
let connected = false;
const stateListeners = [];

function notifyState() {
  stateListeners.forEach((cb) => {
    try {
      cb({ connected, qr: latestQR });
    } catch (err) {
      // ignore
    }
  });
}

function onStateChange(callback) {
  stateListeners.push(callback);
}

function connect() {
  if (client) return Promise.resolve();

  // Etat d'interception scope a CETTE session (pas une variable de module) -
  // une reconnexion apres logout() cree un nouveau `client`/`pupPage` et doit
  // donc pouvoir re-appliquer l'interception, jamais reutiliser un flag deja
  // passe a true par la session precedente.
  const interceptionState = { interceptionApplied: false };

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'local-pc', dataPath: WHATSAPP_AUTH_DIR }),
    puppeteer: { args: PUPPETEER_ARGS },
  });

  client.on('qr', (qr) => {
    latestQR = qr;
    qrcode.generate(qr, { small: true });
    applyRequestInterception(interceptionState);
    notifyState();
  });
  client.on('loading_screen', () => {
    applyRequestInterception(interceptionState);
  });
  client.on('ready', () => {
    connected = true;
    latestQR = null;
    applyRequestInterception(interceptionState);
    console.log('whatsapp-web.js (local-client) : connecté.');
    notifyState();
  });
  client.on('authenticated', () => {
    latestQR = null;
  });
  client.on('disconnected', (reason) => {
    connected = false;
    console.warn(`whatsapp-web.js (local-client) déconnecté : ${reason}`);
    notifyState();
  });
  client.on('message', (msg) => {
    try {
      upsertContact({ jid: msg.from });
      recordMessage({ jid: msg.from, direction: 'in', body: msg.body });
    } catch (err) {
      console.error('Erreur enregistrement message entrant (SQLite) :', err.message);
    }
  });

  return client.initialize().catch((err) => {
    console.error('Erreur d\'initialisation whatsapp-web.js (local-client) :', err.message);
    client = null;
    throw err;
  });
}

function jidToWwebjs(jid) {
  return String(jid || '').replace(/@s\.whatsapp\.net$/, '@c.us');
}

async function sendMessage(to, text) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const target = jidToWwebjs(to);
  const result = await client.sendMessage(target, text);
  recordMessage({ jid: target, direction: 'out', body: text });
  return result;
}

async function sendMedia(to, { buffer, mimetype, filename, caption }) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const target = jidToWwebjs(to);
  const media = new MessageMedia(mimetype || 'application/octet-stream', buffer.toString('base64'), filename || 'fichier');
  const result = await client.sendMessage(target, media, { caption });
  recordMessage({ jid: target, direction: 'out', body: caption || `[média: ${filename || mimetype}]` });
  return result;
}

// Extraction de groupes/membres (feuille de route "export Excel") - la
// GroupChat de whatsapp-web.js expose directement `participants`, pas besoin
// de rappel groupMetadata.update() comme côté pont WebView mobile (voir
// mobile/webapp/www/whatsappBridge.js) : ici c'est le vrai client
// whatsapp-web.js, pas une injection DOM.
async function getGroups() {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const chats = await client.getChats();
  return chats
    .filter((c) => c.isGroup)
    .map((c) => ({ id: c.id._serialized, name: c.name || '', participantsCount: (c.participants || []).length }));
}

async function getGroupMembers(groupId) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const chat = await client.getChatById(groupId);
  if (!chat || !chat.isGroup) throw new Error('Groupe introuvable.');
  return (chat.participants || []).map((p) => ({ id: p.id._serialized, isAdmin: !!p.isAdmin }));
}

function getQRCode() {
  return latestQR;
}

// Rendu en image (data URL PNG) du QR courant - jusqu'ici le QR n'était
// affiché qu'en ASCII dans le terminal du SERVEUR (voir qrcode-terminal
// ci-dessus, conservé pour le debug en console), inutilisable pour quelqu'un
// qui lance ce client sans regarder ce terminal précis. GET /api/status (voir
// index.js) expose ce data URL pour un <img> direct côté navigateur - régénéré
// à la demande à partir de `latestQR` (jamais mis en cache), donc suit
// automatiquement chaque nouveau QR émis par whatsapp-web.js (le code WhatsApp
// expire au bout de ~20-60s et un nouvel évènement 'qr' est alors émis).
async function getQRCodeImage() {
  if (!latestQR) return null;
  return QRCode.toDataURL(latestQR, { margin: 1, width: 280 });
}

function isConnected() {
  return connected;
}

async function logout() {
  if (client) {
    await client.logout().catch(() => {});
    await client.destroy().catch(() => {});
  }
  client = null;
  connected = false;
  latestQR = null;
  notifyState();
}

module.exports = {
  connect, sendMessage, sendMedia, getQRCode, getQRCodeImage, isConnected, onStateChange, logout, getGroups, getGroupMembers,
};
