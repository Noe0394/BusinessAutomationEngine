// Session Telegram locale, mono-poste (un seul client, meme principe que
// lib/whatsapp.js) - flux de connexion GramJS (numero -> code -> mot de
// passe 2FA eventuel) et helpers d'envoi adaptes de adapters/telegram.js
// (racine du depot, jamais modifie ni requis directement ici - local-client
// reste un dossier autonome packageable en .exe, voir lib/campaigns.js pour
// la meme justification). Session sauvegardee dans un simple fichier local
// (voir lib/paths.js#TELEGRAM_SESSION_PATH), jamais synchronisee ailleurs.
const fs = require('fs');
const { TelegramClient, Api } = require('telegram');
const { NewMessage } = require('telegram/events');
const { StringSession } = require('telegram/sessions');
const { TELEGRAM_SESSION_PATH } = require('./paths');
const { upsertContact, recordMessage } = require('./db');

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10) || null;
const API_HASH = process.env.TELEGRAM_API_HASH || null;

if (!API_ID || !API_HASH) {
  console.warn(
    'TELEGRAM_API_ID / TELEGRAM_API_HASH non définis dans local-client/.env : le module Telegram ' +
    'est inactif (les routes /api/telegram/* renverront une erreur 503). Obtenir ces identifiants ' +
    'sur https://my.telegram.org (identifiants de l\'APPLICATION, pas du compte).',
  );
}

let client = null;
let connected = false;
let codeResolver = null;
let passwordResolver = null;
let loginError = null;
const stateListeners = [];

function isConfigured() {
  return Boolean(API_ID && API_HASH);
}

function isConnected() {
  return connected;
}

function notifyState() {
  stateListeners.forEach((cb) => {
    try {
      cb({ connected });
    } catch (err) {
      // ignore
    }
  });
}

function onStateChange(callback) {
  stateListeners.push(callback);
}

// Voir lib/whatsapp.js#onIncomingMessage — même patron.
const incomingMessageListeners = [];
function onIncomingMessage(callback) {
  incomingMessageListeners.push(callback);
}

// Tampon glissant des derniers messages reçus — parité avec le VPS/PC WhatsApp.
const RECENT_MESSAGES_MAX = 50;
const recentMessages = [];
function recordIncomingMessage(m) {
  try {
    if (!m) return;
    const senderId = m.senderId != null ? String(m.senderId) : null;
    const chatId = m.chatId != null ? String(m.chatId) : null;
    const from = senderId || chatId;
    if (!from) return;
    const sender = m.sender || null;
    let isGroup = false;
    try { isGroup = !!(m.isGroup || m.isChannel); } catch (e) { isGroup = false; }
    const ts = Number.isFinite(Number(m.date)) && Number(m.date) > 0 ? Number(m.date) : Math.floor(Date.now() / 1000);
    recentMessages.push({
      from, number: null,
      name: sender ? (sender.firstName || sender.username || null) : null,
      username: sender && sender.username ? sender.username : null,
      text: m.message || '', hasMedia: !!m.media, isGroup, ts,
    });
    if (recentMessages.length > RECENT_MESSAGES_MAX) recentMessages.splice(0, recentMessages.length - RECENT_MESSAGES_MAX);
  } catch (err) { /* jamais bloquant */ }
}
function getRecentMessages(limit) {
  const n = Math.max(1, Math.min(RECENT_MESSAGES_MAX, Number(limit) || 10));
  return recentMessages.slice(-n).reverse().map((r) => Object.assign({}, r));
}
function isPaired() {
  try { return connected || Boolean(loadSessionString()); } catch (err) { return connected; }
}

function loadSessionString() {
  try {
    return fs.readFileSync(TELEGRAM_SESSION_PATH, 'utf8').trim();
  } catch (err) {
    return '';
  }
}

function saveSessionString(value) {
  fs.writeFileSync(TELEGRAM_SESSION_PATH, value, 'utf8');
}

function registerIncomingHandler() {
  client.addEventHandler((event) => {
    if (!event.message || event.message.out) return;
    try {
      const jid = String(event.message.senderId || event.message.chatId || '');
      upsertContact({ jid: `tg:${jid}` });
      recordMessage({ jid: `tg:${jid}`, direction: 'in', body: event.message.message || '' });
    } catch (err) {
      console.error('Erreur enregistrement message Telegram entrant (SQLite) :', err.message);
    }
    recordIncomingMessage(event.message);
    incomingMessageListeners.forEach((cb) => {
      try { cb(event.message); } catch (err) { console.error('Erreur dans un écouteur de message entrant Telegram :', err.message); }
    });
  }, new NewMessage({}));
}

// Restaure une session deja autorisee au demarrage, sans redemander de code -
// no-op silencieux si aucune session ou credentials absents (meme esprit que
// whatsapp.connect(), appele inconditionnellement depuis index.js).
async function connect() {
  if (!isConfigured() || client) return;
  const stringSession = new StringSession(loadSessionString());
  client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });
  registerIncomingHandler();
  await client.connect();
  connected = await client.checkAuthorization();
  notifyState();
  if (connected) console.log('Telegram (local-client) : session restaurée, connecté.');
}

function currentStep() {
  if (connected) return 'connected';
  if (loginError) return 'error';
  if (passwordResolver) return 'password_required';
  if (codeResolver) return 'code_required';
  return 'pending';
}

// Flux pilote par callbacks internes a GramJS (client.start()) - les routes
// HTTP /api/telegram/login/code et /login/password resolvent codeResolver/
// passwordResolver au fur et a mesure que l'utilisateur saisit ces valeurs
// dans l'interface (voir index.js), sans WebSocket/SSE : le frontend
// re-interroge GET /api/telegram/status pour savoir quelle etape afficher.
async function startLogin(phoneNumber) {
  if (!isConfigured()) throw new Error('TELEGRAM_NOT_CONFIGURED');

  if (client) {
    try { await client.disconnect(); } catch (err) { /* ignore */ }
  }

  const stringSession = new StringSession('');
  client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });
  registerIncomingHandler();
  await client.connect();

  codeResolver = null;
  passwordResolver = null;
  loginError = null;
  connected = false;

  client.start({
    phoneNumber: async () => phoneNumber,
    phoneCode: async () => new Promise((resolve) => { codeResolver = resolve; }),
    password: async () => new Promise((resolve) => { passwordResolver = resolve; }),
    onError: (err) => {
      loginError = err;
      console.error('Telegram (local-client) : erreur pendant la connexion :', err);
    },
  }).then(() => {
    saveSessionString(client.session.save());
    connected = true;
    notifyState();
    console.log('Telegram (local-client) : connexion établie et session sauvegardée.');
  }).catch((err) => {
    loginError = err;
    console.error('Telegram (local-client) : échec de connexion :', err);
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));
  return currentStep();
}

async function submitCode(code) {
  if (!codeResolver) throw new Error('NO_PENDING_CODE_REQUEST');
  codeResolver(code);
  codeResolver = null;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return currentStep();
}

async function submitPassword(password) {
  if (!passwordResolver) throw new Error('NO_PENDING_PASSWORD_REQUEST');
  passwordResolver(password);
  passwordResolver = null;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return currentStep();
}

function getLoginError() {
  return loginError ? (loginError.message || String(loginError)) : null;
}

async function logout() {
  // GramJS n'expose pas de méthode client.logout() (bug jamais exercé
  // jusqu'ici : ce chemin plantait tout le process avec un TypeError, aucun
  // try/catch ne pouvant rattraper un throw synchrone sur un appel de
  // méthode inexistante) — la révocation réelle passe par l'appel API brut
  // auth.LogOut, voir adapters/telegram.js#logout (racine, déjà éprouvé).
  if (client) {
    try {
      if (connected) {
        await client.invoke(new Api.auth.LogOut());
      }
    } catch (err) {
      console.warn('Erreur lors du logout Telegram (nettoyage local effectué quand même) :', err.message);
    }
    try {
      await client.disconnect();
    } catch (err) {
      // ignore
    }
  }
  client = null;
  connected = false;
  recentMessages.length = 0;
  try { fs.unlinkSync(TELEGRAM_SESSION_PATH); } catch (err) { /* ignore */ }
  notifyState();
}

async function getGroups() {
  if (!connected) throw new Error('TELEGRAM_NOT_CONNECTED');
  const dialogs = await client.getDialogs({ limit: 200 });
  return dialogs
    .filter((d) => d.isGroup || d.isChannel)
    .map((d) => ({
      id: d.id ? d.id.toString() : null,
      name: d.title || d.name || 'Sans nom',
      isChannel: Boolean(d.isChannel),
    }))
    .filter((g) => g.id);
}

// Résumé des groupes avec rôle (isAdmin via creator/adminRights) + taille —
// parité avec adapters/telegram.js#getGroupsSummary (VPS). Non-lançant.
async function getGroupsSummary() {
  if (!connected) return [];
  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    return dialogs.filter((d) => d.isGroup || d.isChannel).map((d) => {
      const e = d.entity || {};
      return {
        id: d.id ? d.id.toString() : null,
        name: d.title || d.name || 'Sans nom',
        isChannel: Boolean(d.isChannel),
        size: e.participantsCount || 0,
        isAdmin: !!(e.creator || e.adminRights),
        channel: 'TELEGRAM',
      };
    }).filter((g) => g.id);
  } catch (err) {
    console.error('getGroupsSummary Telegram (local-client) :', err.message);
    return [];
  }
}

// Membres d'un groupe/canal (feuille de route "extraction + export Excel") -
// client.getParticipants resout directement l'entite a partir de l'id texte
// renvoye par getGroups.
async function getGroupMembers(groupId) {
  if (!connected) throw new Error('TELEGRAM_NOT_CONNECTED');
  const entity = await client.getEntity(groupId);
  const participants = await client.getParticipants(entity, { limit: 5000 });
  return participants.map((p) => ({
    id: p.id ? p.id.toString() : null,
    username: p.username || '',
    phone: p.phone || '',
    firstName: p.firstName || '',
    lastName: p.lastName || '',
  })).filter((p) => p.id);
}

// Resout un identifiant fourni par l'utilisateur (username "@untel" ou
// numero de telephone) vers une entite Telegram utilisable par sendMessage -
// un numero necessite contacts.importContacts (l'API MTProto n'autorise pas
// la recherche libre d'un numero), voir adapters/telegram.js#resolveRecipient
// (racine) pour la justification complete de cette contrainte.
async function resolveRecipient(identifier) {
  if (!connected) throw new Error('TELEGRAM_NOT_CONNECTED');
  const value = String(identifier || '').trim();
  if (!value) throw new Error('EMPTY_RECIPIENT');

  const looksLikeUsername = value.startsWith('@') || /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value);
  if (looksLikeUsername) {
    const username = value.startsWith('@') ? value : `@${value}`;
    try {
      return await client.getEntity(username);
    } catch (err) {
      throw new Error('RECIPIENT_NOT_FOUND');
    }
  }

  // Diffusion groupe/canal (pas un DM) : identifiant négatif, déjà connu du
  // client GramJS (mis en cache après un appel à getGroups() dans cette même
  // session — voir index.js#/api/telegram/groups) - jamais résolu via
  // ImportContacts (réservé aux numéros de téléphone individuels).
  if (/^-\d+$/.test(value)) {
    try {
      return await client.getEntity(value);
    } catch (err) {
      throw new Error('RECIPIENT_NOT_FOUND');
    }
  }

  const digits = value.replace(/[^\d+]/g, '');
  if (!digits.replace('+', '')) throw new Error('INVALID_RECIPIENT');
  const phone = digits.startsWith('+') ? digits : `+${digits}`;

  try {
    const result = await client.invoke(new Api.contacts.ImportContacts({
      contacts: [new Api.InputPhoneContact({
        clientId: Math.floor(Math.random() * 1_000_000_000),
        phone,
        firstName: 'Contact',
        lastName: '',
      })],
    }));
    if (!result.users || result.users.length === 0) throw new Error('RECIPIENT_NOT_FOUND');
    return result.users[0];
  } catch (err) {
    if (err.message === 'RECIPIENT_NOT_FOUND') throw err;
    throw new Error('RECIPIENT_NOT_FOUND');
  }
}

async function sendMessage(to, text) {
  if (!connected) throw new Error('TELEGRAM_NOT_CONNECTED');
  const entity = await resolveRecipient(to);
  const result = await client.sendMessage(entity, { message: text });
  recordMessage({ jid: `tg:${to}`, direction: 'out', body: text });
  return result;
}

// Pièce jointe (image/vidéo/PDF) — GramJS envoie un Buffer directement via
// sendFile, pas besoin d'un objet média dédié comme whatsapp-web.js
// (MessageMedia). `filename` conditionne l'extension que Telegram affichera
// pour un document (PDF, etc.) ; sans lui GramJS déduit un nom générique.
async function sendMedia(to, { buffer, filename, caption }) {
  if (!connected) throw new Error('TELEGRAM_NOT_CONNECTED');
  const entity = await resolveRecipient(to);
  const result = await client.sendFile(entity, {
    file: buffer,
    caption: caption || '',
    attributes: filename ? [new Api.DocumentAttributeFilename({ fileName: filename })] : undefined,
  });
  recordMessage({ jid: `tg:${to}`, direction: 'out', body: caption || `[média: ${filename || 'fichier'}]` });
  return result;
}

module.exports = {
  isConfigured,
  isConnected,
  onStateChange,
  onIncomingMessage,
  connect,
  startLogin,
  submitCode,
  submitPassword,
  getLoginError,
  logout,
  getGroups,
  getGroupsSummary,
  getGroupMembers,
  getRecentMessages,
  isPaired,
  sendMessage,
  sendMedia,
};
