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
let heartbeatTimer = null;

// Compteur de génération : incrémenté à chaque connect(). Les écouteurs
// d'événements d'un socket capturent la génération au moment de leur
// création et se désactivent (voir isStale ci-dessous) si un connect()
// plus récent les a entre-temps remplacés — sans ça, un ancien socket pas
// encore complètement fermé (ex: événement 'close'/'open' réseau en retard)
// peut continuer à écrire sur les variables partagées (connected, latestQR)
// après coup et désynchroniser l'état rapporté par isConnected()/getQRCode()
// de la réalité du socket actif, avec des symptômes comme "l'UI affiche
// Déconnecté mais requestPairingCode répond ALREADY_CONNECTED".
let connectGeneration = 0;

// Cache opportuniste des noms publics (pushName/notify du profil WhatsApp,
// PAS le nom privé qu'on aurait soi-même enregistré dans ses contacts) —
// alimenté au fil des messages reçus et des événements de synchronisation de
// contacts. WhatsApp n'expose aucune API pour demander le nom public d'un
// numéro qu'on n'a jamais "rencontré" (aucun message échangé, aucune
// synchronisation de contact) : ce cache reste donc incomplet par nature,
// et vide après une déconnexion (voir logout()) pour ne pas faire fuiter les
// noms d'un compte vers le suivant sur le même serveur.
const contactNames = new Map();

function rememberContactName(jid, name) {
  if (jid && name) {
    contactNames.set(jid, name);
  }
}

function getContactName(jid) {
  return contactNames.get(jid) || null;
}

// Signal de présence périodique : sans trafic, certains réseaux/proxies
// intermédiaires (et parfois WhatsApp lui-même) peuvent considérer la
// connexion inactive et la couper. sendPresenceUpdate('available') est un
// appel très léger, sans impact sur les quotas d'envoi de messages.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

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
      console.warn('Heartbeat WhatsApp: échec de l\'envoi de présence —', err.message);
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Ne bloque jamais l'arrêt propre du process.
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

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
  // Un socket précédent encore vivant (ex: connect() rappelé pendant qu'un
  // ancien socket termine sa fermeture) est explicitement détaché et fermé
  // avant d'en créer un nouveau — voir le commentaire sur connectGeneration.
  if (sock) {
    try {
      sock.ev.removeAllListeners();
    } catch (err) {
      // ignore
    }
    try {
      sock.end(new Error('Superseded by a new connect() call.'));
    } catch (err) {
      // ignore
    }
  }

  connectGeneration += 1;
  const myGeneration = connectGeneration;
  const isStale = () => myGeneration !== connectGeneration;

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  authState = state;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', async () => {
    if (isStale()) return;
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
    if (isStale()) return;
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
      stopHeartbeat();
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
      startHeartbeat();
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    if (isStale()) return;
    (m.messages || []).forEach((msg) => {
      const jid = msg.key?.participant || msg.key?.remoteJid;
      if (msg.pushName) rememberContactName(jid, msg.pushName);
    });
    console.log('Nouveau message reçu:', JSON.stringify(m, null, 2));
  });

  // "notify" = nom public affiché par le contact lui-même sur WhatsApp (par
  // opposition à "name", le nom qu'on lui aurait soi-même attribué dans son
  // répertoire) — c'est la seule source fiable pour la colonne "nom" de
  // l'export (voir /api/groups/export-members).
  sock.ev.on('contacts.upsert', (contacts) => {
    if (isStale()) return;
    (contacts || []).forEach((c) => rememberContactName(c.id, c.notify));
  });

  sock.ev.on('contacts.update', (updates) => {
    if (isStale()) return;
    (updates || []).forEach((c) => rememberContactName(c.id, c.notify));
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
  const digits = String(phoneNumber).replace(/\D/g, '');
  if (!digits) {
    throw new Error('INVALID_PHONE_NUMBER');
  }

  // Une demande explicite de code signifie que l'utilisateur veut repartir
  // de zéro : si le backend pense qu'un appareil est déjà connecté, ou que
  // l'identité locale est déjà enregistrée sur un autre numéro, on purge
  // (voir logout()) et on relance une connexion fraîche plutôt que de
  // bloquer avec une erreur — qui créerait une impasse si "connected" est un
  // instant en retard sur la réalité du socket (ex: session corrompue qui
  // s'ouvre puis se referme en boucle, ou double-appel concurrent).
  if (connected || authState?.creds?.registered) {
    await logout();
  } else if (!sock) {
    await connect();
  }

  if (!sock) {
    throw new Error('Adaptateur WhatsApp non initialisé.');
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

// Déconnexion manuelle demandée par l'utilisateur (bouton "Se déconnecter" du
// dashboard) : contrairement à une coupure réseau (voir connection.update /
// DisconnectReason.loggedOut), il faut ici explicitement effacer les
// identifiants locaux pour permettre de lier un nouvel appareil/numéro — sans
// quoi useMultiFileAuthState() rechargerait les mêmes creds et resterait
// enregistré sur l'ancien compte. On relance ensuite connect() tout de suite
// pour que l'utilisateur obtienne un nouveau QR code sans devoir redémarrer
// le serveur.
async function logout() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();

  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      console.warn('Erreur lors du logout WhatsApp (nettoyage local effectué quand même) :', err.message);
    }
  }

  connected = false;
  latestQR = null;
  authState = null;
  sock = null;
  contactNames.clear();

  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  await whatsappAuthStore.clearRemote();

  await connect();
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
  getContactName,
  logout,
  getStorageStatus: whatsappAuthStore.getStatus,
};
