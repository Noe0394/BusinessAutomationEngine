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

module.exports = { connect, sendMessage };
