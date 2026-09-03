const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

let sock = null;
let latestQR = null;
let connected = false;

function getQRCode() {
  return latestQR;
}

function isConnected() {
  return connected;
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      qrcode.generate(qr, { small: true });
      console.log("=== QR CODE BRUT ===");
      console.log(qr);
      console.log("====================");
    }

    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connexion WhatsApp fermée.', statusCode ? `(code: ${statusCode})` : '', 'Reconnexion:', shouldReconnect);
      if (shouldReconnect) {
        connect();
      }
    } else if (connection === 'open') {
      connected = true;
      latestQR = null;
      console.log('Connexion WhatsApp établie.');
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    console.log('Nouveau message reçu:', JSON.stringify(m, null, 2));
  });

  return sock;
}

async function sendMessage(to, text) {
  if (!sock) {
    throw new Error('Adaptateur WhatsApp non initialisé.');
  }
  return sock.sendMessage(to, { text });
}

async function sendMedia(to, { buffer, mimetype, filename, caption }) {
  if (!sock) {
    throw new Error('Adaptateur WhatsApp non initialisé.');
  }

  if (mimetype === 'image/webp') {
    return sock.sendMessage(to, { sticker: buffer });
  }

  if (mimetype && mimetype.startsWith('image/')) {
    return sock.sendMessage(to, { image: buffer, caption });
  }

  if (mimetype && mimetype.startsWith('video/')) {
    return sock.sendMessage(to, { video: buffer, caption });
  }

  return sock.sendMessage(to, {
    document: buffer,
    mimetype: mimetype || 'application/octet-stream',
    fileName: filename || 'fichier',
    caption,
  });
}

async function getGroupMetadata(groupId) {
  if (!sock) {
    throw new Error('Adaptateur WhatsApp non initialisé.');
  }
  return sock.groupMetadata(groupId);
}

async function getGroups() {
  if (!sock) {
    return [];
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups);
  } catch (err) {
    console.error('Erreur lors de la récupération des groupes:', err);
    return [];
  }
}

async function getGroupParticipants(groupId) {
  const metadata = await getGroupMetadata(groupId);
  return metadata.participants;
}

module.exports = {
  connect,
  sendMessage,
  sendMedia,
  getQRCode,
  isConnected,
  getGroupMetadata,
  getGroups,
  getGroupParticipants,
};
