// Session WhatsApp locale, mono-poste (un seul client, pas de multi-tenant
// contrairement à adapters/whatsappManager.js à la racine — un package
// installé = un PC = un compte WhatsApp). Basé sur le même moteur que
// adapters/whatsapp-wwebjs.js (whatsapp-web.js/Puppeteer, args bridés RAM),
// adapté ici en session unique et branché sur la base SQLite locale
// (lib/db.js) au lieu du disque JSON/GitHub du backend multi-tenant.
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { WHATSAPP_AUTH_DIR } = require('./paths');
const { upsertContact, recordMessage } = require('./db');

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

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'local-pc', dataPath: WHATSAPP_AUTH_DIR }),
    puppeteer: { args: PUPPETEER_ARGS },
  });

  client.on('qr', (qr) => {
    latestQR = qr;
    qrcode.generate(qr, { small: true });
    notifyState();
  });
  client.on('ready', () => {
    connected = true;
    latestQR = null;
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

function getQRCode() {
  return latestQR;
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

module.exports = { connect, sendMessage, sendMedia, getQRCode, isConnected, onStateChange, logout };
