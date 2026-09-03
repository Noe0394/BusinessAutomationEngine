const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const whatsappAuthStore = require('./whatsappAuthStore');

// Sur Render (et la plupart des PaaS), le disque local est éphémère : sans
// disque persistant monté sur ce chemin, la session est reperdue à chaque
// redéploiement/redémarrage et il faut se réappairer. Le chemin est donc
// configurable via AUTH_DIR pour pointer vers un Render Disk si disponible.
// Si GITHUB_TOKEN/GITHUB_DATA_REPO sont définis (voir whatsappAuthStore.js),
// la session est aussi sauvegardée dans le repo GitHub dédié et restaurée au
// démarrage (voir restoreSessionFromRemote, appelée une fois par index.js
// avant le premier connect()), sur le même principe que les licences.
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';

if (!process.env.AUTH_DIR && !whatsappAuthStore.enabled) {
  console.warn(
    `AUTH_DIR non défini et sauvegarde GitHub désactivée : la session WhatsApp est stockée dans "${AUTH_DIR}" sur le disque local uniquement. ` +
    'Sur Render, ce dossier est effacé à chaque redéploiement/redémarrage sauf disque persistant ou GITHUB_TOKEN/GITHUB_DATA_REPO configurés.',
  );
}

async function restoreSessionFromRemote() {
  return whatsappAuthStore.restoreSessionFromRemote(AUTH_DIR);
}

let sock = null;
let latestQR = null;
let connected = false;
let authState = null;
let reconnectTimer = null;
let syncStarted = false;

function getQRCode() {
  return latestQR;
}

function isConnected() {
  return connected;
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      console.error('Erreur lors de la tentative de reconnexion WhatsApp:', err);
      scheduleReconnect();
    });
  }, delayMs);
}

async function connect() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  authState = state;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    // Les créds changent surtout au moment de l'appairage (QR/pairing code) :
    // on pousse immédiatement plutôt que d'attendre le prochain instantané
    // périodique, pour ne pas devoir rescanner si le process redémarre juste
    // après un appairage réussi.
    whatsappAuthStore.pushSnapshot(AUTH_DIR);
  });

  if (!syncStarted) {
    syncStarted = true;
    whatsappAuthStore.startPeriodicSync(AUTH_DIR);
  }

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
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        'Connexion WhatsApp fermée.',
        statusCode ? `(code: ${statusCode})` : '',
        loggedOut ? '— déconnexion volontaire, pas de reconnexion.' : '— reconnexion automatique planifiée.',
      );

      if (!loggedOut) {
        scheduleReconnect();
      }
    } else if (connection === 'open') {
      connected = true;
      latestQR = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      console.log('Connexion WhatsApp établie.');
      whatsappAuthStore.pushSnapshot(AUTH_DIR);
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

async function requestPairingCode(phoneNumber) {
  if (!sock) {
    throw new Error('Adaptateur WhatsApp non initialisé.');
  }

  if (authState?.creds?.registered) {
    throw new Error('ALREADY_REGISTERED');
  }

  const digits = String(phoneNumber).replace(/\D/g, '');
  if (!digits) {
    throw new Error('INVALID_PHONE_NUMBER');
  }

  const rawCode = await sock.requestPairingCode(digits);
  return rawCode.replace(/-/g, '').match(/.{1,4}/g).join('-');
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
  restoreSessionFromRemote,
  sendMessage,
  sendMedia,
  getQRCode,
  isConnected,
  requestPairingCode,
  getGroupMetadata,
  getGroups,
  getGroupParticipants,
  getStorageStatus: whatsappAuthStore.getStatus,
};
