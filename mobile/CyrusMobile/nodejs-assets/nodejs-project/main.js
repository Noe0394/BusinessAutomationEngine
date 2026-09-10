// Point d'entree du runtime Node embarque (nodejs-mobile-react-native).
// Spike Android : pairing par code (numero de telephone) + envoi/reception
// de texte, rien d'autre (pas de medias, pas de groupes, pas de campagnes)
// - cf. mobile/README.md. Code plutot que QR visuel : evite d'ajouter une
// dependance de rendu QR (react-native-svg + lib QR) cote React Native,
// dans l'esprit "allege" retenu pour ce projet.
//
// Baileys tourne ICI, reellement sur le telephone. Aucune connexion a un
// VPS ou a un serveur externe n'est necessaire pour WhatsApp lui-meme.

const path = require('path');
const rn_bridge = require('rn-bridge');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('baileys');

// nodejs-assets/nodejs-project est ecrase a chaque mise a jour de l'appli :
// les credentials d'auth doivent vivre dans le dossier de donnees persistant
// de l'appli (rn_bridge.app.datadir(), FilesDir sur Android), jamais ici.
const AUTH_DIR = path.join(rn_bridge.app.datadir(), 'baileys-auth');

let sock;
let authState;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  authState = state;

  sock = makeWASocket({
    auth: state,
    // Evite le plus gros pic CPU/RAM de Baileys au premier appairage.
    syncFullHistory: false,
    // Pas de store en memoire (chats/contacts/messages non borne) : on ne
    // garde que les credentials d'auth, rien d'autre pour ce spike.
    // Pairing par code (pas de QR affiche) : pas besoin d'imprimer le QR.
    printQRInTerminal: false,
    logger: require('pino')({ level: 'error' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      rn_bridge.channel.post('status', { connected: true });
    }

    if (connection === 'close') {
      rn_bridge.channel.post('status', { connected: false });
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        connect();
      } else {
        rn_bridge.channel.post('status', { connected: false, loggedOut: true });
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      // Mitigation officielle CVE-2026-48063 (GHSA-qvv5-jq5g-4cgg) : baileys
      // 6.7.16 est vulnerable a l'usurpation de messages via un payload
      // placeholderResendMessage forge, qui declenche un faux messages.upsert
      // portant un champ requestId. Aucun correctif n'existe pour Node 18 (le
      // fix officiel, 6.7.22+/7.0.0-rc12+, exige Node >=20). A retirer des que
      // nodejs-mobile-react-native proposera un runtime Node >=20.
      if (msg.requestId || msg.message?.placeholderResendMessage) continue;
      if (msg.key.fromMe) continue;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;
      if (!text) continue; // spike texte seul : on ignore les autres types
      rn_bridge.channel.post('message', {
        from: msg.key.remoteJid,
        text,
      });
    }
  });
}

// Commandes recues depuis le cote React Native. Enregistrees une seule fois
// (pas dans connect(), qui est rappelee a chaque reconnexion) pour eviter
// d'accumuler des listeners en double au fil des reconnexions.
rn_bridge.channel.on('request-pairing-code', async ({ phoneNumber }) => {
  try {
    if (!sock || !authState) throw new Error('Runtime WhatsApp pas encore pret.');
    if (authState.creds.registered) {
      rn_bridge.channel.post('pairing-code', { error: 'Deja appaire.' });
      return;
    }
    const code = await sock.requestPairingCode(phoneNumber);
    rn_bridge.channel.post('pairing-code', { code });
  } catch (err) {
    rn_bridge.channel.post('pairing-code', { error: String(err) });
  }
});

rn_bridge.channel.on('send', async ({ to, text }) => {
  try {
    if (!sock) throw new Error('Pas encore connecte a WhatsApp.');
    await sock.sendMessage(to, { text });
    rn_bridge.channel.post('send-result', { ok: true, to });
  } catch (err) {
    rn_bridge.channel.post('send-result', { ok: false, to, error: String(err) });
  }
});

rn_bridge.app.on('pause', (pauseLock) => {
  // Rien a fermer explicitement : le socket WebSocket de Baileys doit
  // continuer de tourner en arriere-plan (c'est tout le but du foreground
  // service Android a mettre en place cote React Native).
  pauseLock.release();
});

connect();

// Evenement nomme, pas channel.send() : channel.send() poste sous le nom
// generique 'message', qui est deja utilise pour les messages WhatsApp
// entrants (voir sock.ev.on('messages.upsert') plus haut) — les melanger
// romprait le cote React Native.
rn_bridge.channel.post('node-ready');
