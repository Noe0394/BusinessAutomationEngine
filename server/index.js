require('dotenv').config({ quiet: true });

const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const fs = require('fs');
const express = require('express');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const whatsappAuthStore = require('./lib/whatsappAuthStore');

// MICRO-SERVICE BAILEYS AUTONOME — pensé pour un hébergeur H24 à ressources
// limitées (Koyeb free tier : 0.1 vCPU / 512 Mo RAM), séparé du backend
// principal (index.js à la racine du dépôt, lui-même en attente d'un hôte
// définitif après la suspension de facturation Render). Volontairement
// MONO-TENANT (un seul compte WhatsApp par déploiement) contrairement à
// adapters/whatsapp.js (multi-tenant, une session par clé de licence) — la
// logique de connexion/reconnexion ci-dessous est directement reprise de ce
// fichier (déjà éprouvée en production, voir les commentaires d'origine
// conservés) ; seule la gestion multi-tenant, le cache de noms de contacts et
// l'intégration licences/campagnes ont été retirés, hors périmètre d'un
// simple connecteur.
//
// Le backend principal (ou tout autre appelant) communique avec ce service
// par HTTP : POST /send pour émettre, GET /status et GET /qr pour l'état de
// connexion/l'appairage, et reçoit les messages entrants via un webhook HTTP
// sortant (WEBHOOK_URL) plutôt que par un lien direct en mémoire — les deux
// process ne partagent plus le même espace mémoire.
const PORT = process.env.PORT || 8000;
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';

if (!SHARED_SECRET) {
  console.warn(
    'SHARED_SECRET non défini : /send, /send-media, /pairing-code et /logout sont accessibles SANS authentification. ' +
    'À définir impérativement avant tout déploiement public (Koyeb, etc.).',
  );
}

const authStore = whatsappAuthStore.createAuthStore('default');

let sock = null;
let latestQR = null;
let connected = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let consecutiveFailures = 0;
let connectGeneration = 0;
let syncStarted = false;

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!sock || !connected) return;
    sock.sendPresenceUpdate('available').catch((err) => {
      console.warn('Heartbeat WhatsApp : échec de l\'envoi de présence —', err.message);
    });
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

// Backoff exponentiel (3s, 6s, 12s... plafonné à 5 min) — voir
// adapters/whatsapp.js#scheduleReconnect : protège contre un martèlement des
// serveurs WhatsApp en cas d'échec persistant (session révoquée, coupure
// réseau, blocage anti-abus).
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delayMs = Math.min(BASE_RECONNECT_DELAY_MS * (2 ** consecutiveFailures), MAX_RECONNECT_DELAY_MS);
  consecutiveFailures += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      console.error('Erreur lors de la tentative de reconnexion WhatsApp :', err);
      scheduleReconnect();
    });
  }, delayMs);
}

function forwardToWebhook(event, payload) {
  if (!WEBHOOK_URL) return;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SHARED_SECRET ? { 'x-shared-secret': SHARED_SECRET } : {}),
    },
    body: JSON.stringify({ event, payload }),
  }).catch((err) => {
    console.warn(`Échec de la transmission au webhook (${event}) :`, err.message);
  });
}

// Sérialise connect()/logout() : voir adapters/whatsapp.js#runSerialized —
// évite qu'une reconnexion automatique et une déconnexion manuelle ne
// touchent AUTH_DIR en parallèle et ne corrompent la session locale.
let lifecycleQueue = Promise.resolve();
function runSerialized(fn) {
  const run = lifecycleQueue.then(fn, fn);
  lifecycleQueue = run.then(() => {}, () => {});
  return run;
}

async function doConnect() {
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (err) { /* ignore */ }
    try { sock.end(new Error('Superseded by a new connect() call.')); } catch (err) { /* ignore */ }
  }

  connectGeneration += 1;
  const myGeneration = connectGeneration;
  const isStale = () => myGeneration !== connectGeneration;

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const wasRegisteredBeforeThisAttempt = Boolean(state?.creds?.registered);

  // Pas d'option `version` ici — voir adapters/whatsapp.js pour le
  // raisonnement complet (FAQ Baileys : ne jamais substituer un numéro de
  // version au protocole binaire réellement implémenté par la lib
  // installée). Se tenir à jour = mettre à jour @whiskeysockets/baileys,
  // jamais fetchLatestWaWebVersion() à l'exécution.
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    // 120s (au lieu des 20-60s par défaut) : un cycle de régénération trop
    // rapide a déjà déclenché un blocage anti-abus WhatsApp en production —
    // voir adapters/whatsapp.js.
    qrTimeout: 120_000,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', async () => {
    if (isStale()) return;
    await saveCreds();
    authStore.pushSnapshot(AUTH_DIR);
  });

  if (!syncStarted) {
    syncStarted = true;
    authStore.startPeriodicSync(AUTH_DIR);
  }

  sock.ev.on('connection.update', (update) => {
    if (isStale()) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      forwardToWebhook('qr', { qr });
    }

    if (connection === 'close') {
      connected = false;
      stopHeartbeat();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut && wasRegisteredBeforeThisAttempt) {
        console.log(`Connexion WhatsApp fermée (code: ${statusCode}) — session révoquée, régénération d'un identifiant frais.`);
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        authStore.clearRemote().catch(() => {});
        forwardToWebhook('account-reset', {});
        scheduleReconnect();
      } else {
        console.log('Connexion WhatsApp fermée.', statusCode ? `(code: ${statusCode})` : '', '— reconnexion automatique planifiée.');
        scheduleReconnect();
      }
    } else if (connection === 'open') {
      connected = true;
      latestQR = null;
      consecutiveFailures = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      console.log('Connexion WhatsApp établie.');
      authStore.pushSnapshot(AUTH_DIR);
      startHeartbeat();
      forwardToWebhook('connection-open', {});
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    if (isStale()) return;
    (m.messages || []).forEach((msg) => {
      if (m.type === 'notify' && msg.key && !msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
        forwardToWebhook('message', msg);
      }
    });
  });

  return sock;
}

function connect() {
  return runSerialized(doConnect);
}

async function logout() {
  return runSerialized(async () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopHeartbeat();

    if (sock) {
      try { await sock.logout(); } catch (err) {
        console.warn('Erreur lors du logout WhatsApp (nettoyage local effectué quand même) :', err.message);
      }
    }

    connected = false;
    latestQR = null;
    sock = null;

    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    await authStore.clearRemote();
    forwardToWebhook('account-reset', {});

    await doConnect();
  });
}

async function requestPairingCode(phoneNumber) {
  const digits = String(phoneNumber).replace(/\D/g, '');
  if (!digits) throw new Error('INVALID_PHONE_NUMBER');

  if (connected) {
    await logout();
  } else if (!sock) {
    await connect();
  }

  if (!sock) throw new Error('Adaptateur WhatsApp non initialisé.');

  const rawCode = await sock.requestPairingCode(digits);
  return rawCode.replace(/-/g, '').match(/.{1,4}/g).join('-');
}

// ---------- API HTTP ----------
const app = express();
app.use(express.json({ limit: '15mb' }));

function requireSecret(req, res, next) {
  if (!SHARED_SECRET) return next(); // voir l'avertissement au démarrage
  if (req.get('x-shared-secret') !== SHARED_SECRET) {
    return res.status(401).json({ error: 'Secret invalide ou absent (en-tête x-shared-secret).' });
  }
  return next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected });
});

app.get('/status', requireSecret, (req, res) => {
  res.json({ connected, hasQR: Boolean(latestQR), storage: authStore.getStatus() });
});

app.get('/qr', requireSecret, async (req, res) => {
  if (!latestQR) return res.status(404).json({ error: 'Aucun QR disponible pour le moment (déjà connecté, ou pas encore généré).' });
  const dataUrl = await qrcode.toDataURL(latestQR);
  res.json({ qr: latestQR, dataUrl });
});

app.post('/pairing-code', requireSecret, async (req, res) => {
  try {
    const code = await requestPairingCode((req.body || {}).phoneNumber);
    res.json({ code });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/send', requireSecret, async (req, res) => {
  const { to, text } = req.body || {};
  if (!sock) return res.status(503).json({ error: 'Non connecté.' });
  try {
    const result = await sock.sendMessage(to, { text });
    res.json({ ok: true, id: result?.key?.id || null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/send-media', requireSecret, async (req, res) => {
  const {
    to, base64, mimetype, filename, caption,
  } = req.body || {};
  if (!sock) return res.status(503).json({ error: 'Non connecté.' });
  try {
    const buffer = Buffer.from(base64, 'base64');
    let payload;
    if (mimetype && mimetype.startsWith('image/')) payload = { image: buffer, caption };
    else if (mimetype && mimetype.startsWith('video/')) payload = { video: buffer, caption };
    else payload = { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: filename || 'fichier', caption };
    const result = await sock.sendMessage(to, payload);
    res.json({ ok: true, id: result?.key?.id || null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/logout', requireSecret, async (req, res) => {
  try {
    await logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Micro-service Baileys en écoute sur le port ${PORT}.`);
  // À appeler UNE SEULE FOIS avant le tout premier connect() (voir
  // lib/whatsappAuthStore.js#restoreSessionFromRemote) : restaure creds.json
  // depuis le repo GitHub de sauvegarde s'il existe, pour rouvrir la session
  // sans réappairage après un redémarrage sur disque éphémère (Koyeb free
  // tier n'offre pas de stockage persistant par défaut).
  await authStore.restoreSessionFromRemote(AUTH_DIR).catch((err) => {
    console.error('Échec de la restauration de session depuis GitHub :', err.message);
  });
  connect().catch((err) => console.error('Échec de la connexion WhatsApp initiale :', err));
});
