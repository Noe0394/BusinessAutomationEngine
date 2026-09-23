// Session WhatsApp locale, mono-poste (un seul client, pas de multi-tenant
// contrairement à adapters/whatsappManager.js à la racine — un package
// installé = un PC = un compte WhatsApp). Basé sur le même moteur que
// adapters/whatsapp-wwebjs.js (whatsapp-web.js/Puppeteer, args bridés RAM),
// adapté ici en session unique et branché sur la base SQLite locale
// (lib/db.js) au lieu du disque JSON/GitHub du backend multi-tenant.
const fs = require('fs');
const path = require('path');
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

// Écouteurs "message entrant" (voir ai-engine/emotionalCloser.js côté
// local-client, message-triage.js) — même patron que stateListeners
// ci-dessus. Le SQLite recordMessage() déjà en place (voir client.on('message'))
// reste inchangé, ceci est un DEUXIÈME abonné indépendant.
const incomingMessageListeners = [];
function onIncomingMessage(callback) {
  incomingMessageListeners.push(callback);
}

// --- Canal propriétaire (self-chat) : l'utilisateur s'écrit à lui-même depuis son téléphone -> Chat Intelligent.
// Même logique que adapters/whatsappEngineBaileys.js#checkOwnerMessage/isSelfChatJid (VPS, Baileys) — adaptée à
// whatsapp-web.js : l'évènement 'message' ci-dessus ne fournit QUE les messages reçus d'un tiers (fromMe toujours
// false) ; 'message_create' (enregistré dans connect() ci-dessous) fournit TOUS les messages, y compris envoyés —
// filtré ici sur fromMe=true ET chat = moi-même (self-chat), avec un registre "sentByMe" + court délai pour ignorer
// l'écho d'un message que CE client vient lui-même d'envoyer (ex: une alerte livrée dans le self-chat).
const ownerMessageListeners = [];
function onOwnerMessage(callback) { ownerMessageListeners.push(callback); }
const sentByMe = new Set();
function rememberSent(id) {
  if (!id) return;
  sentByMe.add(String(id));
  if (sentByMe.size > 500) sentByMe.delete(sentByMe.values().next().value);
}

// Tampon glissant des derniers messages reçus — parité avec
// adapters/whatsappEngineBaileys.js#getRecentMessages (VPS). Permet à la couche
// intelligence de répondre à "quel est le dernier message reçu ?". En mémoire,
// vidé au logout.
const RECENT_MESSAGES_MAX = 50;
const recentMessages = [];
function recordIncomingMessage(msg) {
  try {
    const from = msg && msg.from;
    if (!from) return;
    const isGroup = String(from).endsWith('@g.us');
    const number = String((isGroup ? (msg.author || '') : from)).split('@')[0];
    recentMessages.push({
      from,
      number,
      name: (msg._data && msg._data.notifyName) || null,
      text: msg.body || '',
      hasMedia: !!msg.hasMedia,
      isGroup,
      ts: msg.timestamp || Math.floor(Date.now() / 1000),
    });
    if (recentMessages.length > RECENT_MESSAGES_MAX) recentMessages.splice(0, recentMessages.length - RECENT_MESSAGES_MAX);
  } catch (err) { /* jamais bloquant */ }
}
function getRecentMessages(limit) {
  const n = Math.max(1, Math.min(RECENT_MESSAGES_MAX, Number(limit) || 10));
  return recentMessages.slice(-n).reverse().map((r) => Object.assign({}, r));
}
function getConnectedNumber() {
  try {
    return (client && client.info && client.info.wid && client.info.wid.user) || null;
  } catch (err) { return null; }
}
// Appairé si connecté OU si une session whatsapp-web.js est déjà persistée sur
// le disque (LocalAuth : dossier session-<clientId>). Distingue "appairé mais
// pas encore reconnecté" de "jamais appairé".
function isPaired() {
  if (connected) return true;
  try { return fs.existsSync(path.join(WHATSAPP_AUTH_DIR, 'session-local-pc')); } catch (err) { return false; }
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
    recordIncomingMessage(msg);
    incomingMessageListeners.forEach((cb) => {
      try { cb(msg); } catch (err) { console.error('Erreur dans un écouteur de message entrant WhatsApp :', err.message); }
    });
  });
  client.on('message_create', (msg) => {
    if (!msg.fromMe) return; // déjà géré par 'message' ci-dessus (fromMe toujours false sur cet évènement)
    const meId = (client.info && client.info.wid && client.info.wid._serialized) || null;
    if (!meId || msg.to !== meId) return; // pas un self-chat (message envoyé à un vrai contact) : hors périmètre du canal propriétaire
    // Court délai : l'écho d'un message envoyé par CE client peut arriver avant que rememberSent() ne l'ait mémorisé.
    setTimeout(() => {
      if (sentByMe.has(String(msg.id && msg.id._serialized))) return; // message généré par ce client lui-même : jamais retraité
      ownerMessageListeners.forEach((cb) => {
        try { cb(msg); } catch (err) { console.error('Erreur dans un écouteur de message propriétaire WhatsApp :', err.message); }
      });
    }, 700);
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
  rememberSent(result && result.id && result.id._serialized); // évite que le canal propriétaire retraite son propre envoi (self-chat)
  return result;
}

async function sendMedia(to, { buffer, mimetype, filename, caption }) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const target = jidToWwebjs(to);
  const media = new MessageMedia(mimetype || 'application/octet-stream', buffer.toString('base64'), filename || 'fichier');
  const result = await client.sendMessage(target, media, { caption });
  recordMessage({ jid: target, direction: 'out', body: caption || `[média: ${filename || mimetype}]` });
  rememberSent(result && result.id && result.id._serialized);
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

// Résumé de tous les groupes avec le rôle du compte connecté (isAdmin) + la
// taille — parité avec adapters/whatsappEngineBaileys.js#getGroupsSummary (VPS).
async function getGroupsSummary() {
  if (!client || !connected) return [];
  try {
    const meId = (client.info && client.info.wid && client.info.wid._serialized) || null;
    const chats = await client.getChats();
    return chats.filter((c) => c.isGroup).map((c) => {
      const participants = c.participants || [];
      let isAdmin = false;
      if (meId) {
        const mine = participants.find((p) => p.id && p.id._serialized === meId);
        isAdmin = !!(mine && (mine.isAdmin || mine.isSuperAdmin));
      }
      return { id: c.id._serialized, name: c.name || 'Sans nom', size: participants.length, isAdmin, channel: 'WHATSAPP' };
    });
  } catch (err) {
    console.error('getGroupsSummary WhatsApp (local-client) :', err.message);
    return [];
  }
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
  recentMessages.length = 0;
  notifyState();
}

// ---------------------------------------------------------------------------
// GESTION DE GROUPES — ajouté le 2026-09-22 pour porter ai-engine/communityService.js et communityDiscovery.js
// (VPS, Baileys) vers le PC. whatsapp-web.js expose les mêmes opérations mais avec une forme de retour différente
// (voir node_modules/whatsapp-web.js/src/Client.js et src/structures/GroupChat.js, lus directement pour ces
// signatures — pas une supposition) : adapté ici pour renvoyer la MÊME FORME que adapters/whatsappEngineBaileys.js
// (VPS), afin que communityService.js/communityDiscovery.js copiés sans changement de logique métier.
// NON TESTÉ en conditions réelles (nécessite un compte WhatsApp local réellement connecté) — à vérifier avant un
// premier usage réel, contrairement au reste du portage de cette session qui a été vérifié par exécution directe.

// Baileys renvoie [{number, exists}, ...] pour un lot de numéros (checkNumbersOnWhatsApp côté VPS) ;
// whatsapp-web.js n'a que getNumberId(number) un par un (pas de lot natif) — boucle séquentielle ici.
async function checkNumbersOnWhatsApp(numbers) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const out = [];
  for (const raw of (Array.isArray(numbers) ? numbers : [])) {
    const number = String(raw).replace(/\D/g, '');
    let exists = false;
    try { exists = !!(await client.getNumberId(number)); } catch (err) { exists = false; }
    out.push({ number: raw, exists });
  }
  return out;
}

// Baileys : createGroup(title, numbers) -> { id, subject }. whatsapp-web.js : createGroup(title, participants,
// options) -> { title, gid: {_serialized}, participants: {...} } ou une CHAÎNE d'erreur (pas d'exception) — les
// deux cas sont normalisés ici en une exception, jamais un objet ambigu remonté à l'appelant.
async function createGroup(title, participants) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const ids = (Array.isArray(participants) ? participants : []).map((p) => (String(p).includes('@') ? p : `${String(p).replace(/\D/g, '')}@c.us`));
  const res = await client.createGroup(title, ids);
  if (typeof res === 'string') throw new Error(`Création de groupe WhatsApp refusée : ${res}`);
  return { id: res.gid._serialized, subject: title };
}

async function setGroupDescription(groupId, text) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const chat = await client.getChatById(groupId);
  if (!chat || !chat.isGroup) throw new Error('Groupe introuvable.');
  await chat.setDescription(String(text || '').slice(0, 2000));
}

// Baileys : addGroupParticipants(groupJid, numbers) -> [{number, status}] (codes '200'/'403'/'408'/'409'...).
// whatsapp-web.js : GroupChat#addParticipants(ids) -> { [id]: { code, message, isInviteV4Sent } } — mêmes codes
// numériques (200/403/404/408/409...), juste reformatés ici en la MÊME liste que Baileys, `status` en chaîne pour
// rester comparable telle quelle par communityService.js (`r.status === '200'`).
async function addGroupParticipants(groupId, numbers) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const chat = await client.getChatById(groupId);
  if (!chat || !chat.isGroup) throw new Error('Groupe introuvable.');
  const ids = (Array.isArray(numbers) ? numbers : []).map((n) => (String(n).includes('@') ? n : `${String(n).replace(/\D/g, '')}@c.us`));
  const res = await chat.addParticipants(ids);
  if (typeof res === 'string') throw new Error(`Ajout de participants refusé : ${res}`);
  return ids.map((id, i) => {
    const r = res[id];
    return { number: String(numbers[i]), status: r ? String(r.code) : 'unknown' };
  });
}

async function getGroupInviteLink(groupId) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const chat = await client.getChatById(groupId);
  if (!chat || !chat.isGroup) throw new Error('Groupe introuvable.');
  const code = await chat.getInviteCode();
  return code ? `https://chat.whatsapp.com/${code}` : null;
}

// Baileys : getInviteInfo(code) -> { id, subject, description, size, createdAt } (sans rejoindre). whatsapp-web.js :
// Client#getInviteInfo(code) renvoie l'objet brut WAWebGroupQueryJob.queryGroupInvite — champs jamais garantis
// documentés côté whatsapp-web.js (pas de typedef officiel) : lecture DÉFENSIVE avec plusieurs noms de champs
// possibles plutôt qu'un accès direct qui casserait si le nom réel diffère légèrement.
async function getInviteInfo(code) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const i = await client.getInviteInfo(String(code));
  if (!i) throw new Error('Lien d\'invitation invalide ou expiré.');
  const id = (i.id && i.id._serialized) || i.id || null;
  return {
    id,
    subject: i.subject || i.name || '',
    description: i.desc || i.description || '',
    size: i.size != null ? i.size : (Array.isArray(i.participants) ? i.participants.length : 0),
    createdAt: i.creation || i.createdAt || null,
  };
}

// Baileys : joinGroupByInvite(code) -> { id }. whatsapp-web.js : Client#acceptInvite(code) -> chatId (chaîne).
async function joinGroupByInvite(code) {
  if (!client || !connected) throw new Error('Session WhatsApp non connectée.');
  const id = await client.acceptInvite(String(code));
  return { id };
}

module.exports = {
  connect, sendMessage, sendMedia, getQRCode, getQRCodeImage, isConnected, onStateChange, onIncomingMessage, onOwnerMessage, logout, getGroups, getGroupMembers,
  getRecentMessages, getGroupsSummary, getConnectedNumber, isPaired,
  checkNumbersOnWhatsApp, createGroup, setGroupDescription, addGroupParticipants, getGroupInviteLink, getInviteInfo, joinGroupByInvite,
};
