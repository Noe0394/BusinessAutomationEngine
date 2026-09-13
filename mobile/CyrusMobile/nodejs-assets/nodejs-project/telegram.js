// Session Telegram mono-utilisateur pour le mobile, adaptee de
// adapters/telegram.js (VPS) : meme bibliotheque (GramJS, compte utilisateur
// reel via MTProto, pas l'API Bot), sans l'isolation multi-tenant, la
// sauvegarde GitHub ni le regulateur de sessions du VPS (inutiles pour un
// seul utilisateur sur son propre telephone). Tourne dans le runtime Node
// embarque (nodejs-mobile-react-native), comme Baileys dans main.js -
// aucun serveur/VPS requis pour Telegram non plus.
const fs = require('fs');
const path = require('path');
const rn_bridge = require('rn-bridge');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const DATA_DIR = rn_bridge.app.datadir();
const SESSION_PATH = path.join(DATA_DIR, 'telegram_session.txt');
const CREDENTIALS_PATH = path.join(DATA_DIR, 'telegram_credentials.json');

let client = null;
let connected = false;
let codeResolver = null;
let passwordResolver = null;
let loginError = null;
const incomingMessageListeners = [];

function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveCredentials(apiId, apiHash) {
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ apiId, apiHash }), 'utf8');
}

function loadSessionString() {
  try {
    return fs.readFileSync(SESSION_PATH, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function saveSessionString(value) {
  fs.writeFileSync(SESSION_PATH, value, 'utf8');
}

function registerIncomingHandler() {
  const { NewMessage } = require('telegram/events');
  client.addEventHandler((event) => {
    if (event.message && !event.message.out) {
      incomingMessageListeners.forEach((cb) => cb(event.message));
    }
  }, new NewMessage({}));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentStep() {
  if (connected) return 'connected';
  if (loginError) return 'error';
  if (passwordResolver) return 'password_required';
  if (codeResolver) return 'code_required';
  return 'pending';
}

async function init() {
  const creds = loadCredentials();
  const session = loadSessionString();
  if (!creds || !session) return; // aucune session a restaurer

  client = new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, { connectionRetries: 5 });
  registerIncomingHandler();
  await client.connect();
  connected = await client.checkAuthorization();
}

async function startLogin(apiId, apiHash, phoneNumber) {
  saveCredentials(apiId, apiHash);

  if (client) {
    try { await client.disconnect(); } catch (e) { /* ignore */ }
  }

  client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
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
    onError: (err) => { loginError = err; },
  }).then(() => {
    saveSessionString(client.session.save());
    connected = true;
  }).catch((err) => {
    loginError = err;
  });

  await sleep(2000);
  return currentStep();
}

async function submitCode(code) {
  if (!codeResolver) throw new Error('NO_PENDING_CODE_REQUEST');
  codeResolver(code);
  codeResolver = null;
  await sleep(2000);
  return currentStep();
}

async function submitPassword(password) {
  if (!passwordResolver) throw new Error('NO_PENDING_PASSWORD_REQUEST');
  passwordResolver(password);
  passwordResolver = null;
  await sleep(2000);
  return currentStep();
}

async function getDialogs() {
  if (!connected) throw new Error('TELEGRAM_NOT_CONNECTED');
  const dialogs = await client.getDialogs({ limit: 100 });
  return dialogs.map((d) => ({
    id: d.id ? d.id.toString() : null,
    name: d.title || d.name || 'Sans nom',
    isGroup: Boolean(d.isGroup),
    isChannel: Boolean(d.isChannel),
    unreadCount: d.unreadCount || 0,
  })).filter((d) => d.id);
}

async function resolveRecipient(identifier) {
  if (!connected) throw new Error('TELEGRAM_NOT_CONNECTED');
  const value = String(identifier || '').trim();
  const looksLikeUsername = value.startsWith('@') || /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value);
  if (looksLikeUsername) {
    return client.getEntity(value.startsWith('@') ? value : `@${value}`);
  }
  const { Api } = require('telegram');
  const digits = value.replace(/[^\d+]/g, '');
  const phone = digits.startsWith('+') ? digits : `+${digits}`;
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
}

async function sendMessage(identifier, text) {
  if (!connected) throw new Error('TELEGRAM_NOT_CONNECTED');
  const entity = await resolveRecipient(identifier);
  return client.sendMessage(entity, { message: text });
}

function onIncomingMessage(cb) {
  incomingMessageListeners.push(cb);
}

function isConnected() {
  return connected;
}

module.exports = {
  init,
  startLogin,
  submitCode,
  submitPassword,
  getDialogs,
  sendMessage,
  onIncomingMessage,
  isConnected,
  getLoginError: () => (loginError ? (loginError.message || String(loginError)) : null),
};
