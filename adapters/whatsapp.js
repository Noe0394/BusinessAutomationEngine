const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeInMemoryStore,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

const store = makeInMemoryStore({});

let sock = null;
let latestQR = null;

function getQRCode() {
  return latestQR;
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  store.bind(sock.ev);

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
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connexion WhatsApp fermée.', statusCode ? `(code: ${statusCode})` : '', 'Reconnexion:', shouldReconnect);
      if (shouldReconnect) {
        connect();
      }
    } else if (connection === 'open') {
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

async function getGroupMetadata(groupId) {
  if (!sock) {
    throw new Error('Adaptateur WhatsApp non initialisé.');
  }
  return sock.groupMetadata(groupId);
}

async function getGroups() {
  const cached = store.groupMetadata ? Object.values(store.groupMetadata) : [];
  if (cached.length > 0) {
    return cached;
  }

  if (!sock) {
    return [];
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups);
  } catch (err) {
    console.error('Erreur lors de la récupération des groupes (fallback):', err);
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
  getQRCode,
  getGroupMetadata,
  getGroups,
  getGroupParticipants,
};
