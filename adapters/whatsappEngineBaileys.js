// Moteur Baileys — extrait tel quel de l'ancien adapters/whatsapp.js lors de
// l'introduction du Feature Flag WHATSAPP_ENGINE (voir adapters/whatsapp.js,
// qui sélectionne ce fichier par défaut). Contenu inchangé : reste le moteur
// de référence, actif tant que WHATSAPP_ENGINE n'est pas explicitement mis à
// "wwebjs".
const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const whatsappAuthStore = require('./whatsappAuthStore');

// Isolation stricte par tenant (voir adapters/whatsappManager.js) : chaque
// clé de licence obtient sa PROPRE instance WhatsApp (son propre socket
// Baileys, son propre QR code, sa propre session, son propre cache de noms
// publics) — plus aucun état n'est partagé au niveau du module comme
// c'était le cas avant cette refonte. createSession(tenantId) est appelée
// une fois par tenant par le gestionnaire, qui conserve l'instance retournée
// tant que ce tenant reste actif.
//
// Baileys credentials and Signal keys form one session and must stay together.
// AUTH_DIR must point to persistent storage in production; a creds.json-only
// remote backup cannot restore an encrypted session safely.
const AUTH_DIR_BASE = process.env.AUTH_DIR || 'auth_info_baileys';

if (!process.env.AUTH_DIR) {
  console.warn(
    `AUTH_DIR is not set: WhatsApp sessions use "${AUTH_DIR_BASE}/<tenant>" on local disk. ` +
    'Configure persistent storage or Signal keys will be lost on restart.',
  );
}
// HEARTBEAT_INTERVAL_MS : signal de présence périodique. Sans trafic,
// certains réseaux/proxies intermédiaires (et parfois WhatsApp lui-même)
// peuvent considérer la connexion inactive et la couper.
// sendPresenceUpdate('available') est un appel très léger, sans impact sur
// les quotas d'envoi de messages.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

// Pas de résolution dynamique de version WA Web ici — testé en production le
// 2026-09-07 : fetchLatestWaWebVersion() (ajouté lors d'une tentative de
// "futureproofing" précédente) a provoqué un rejet SYSTÉMATIQUE du QR par
// WhatsApp. Cause : le numéro de version à lui seul ne garantit rien, seul le
// format binaire (protobufs) réellement implémenté dans la lib Baileys
// installée compte — annoncer à WhatsApp une version plus récente que ce que
// Baileys sait effectivement parler fait que ses serveurs s'attendent à des
// champs/comportements que la lib ne fournit pas, et rejettent la session.
// La FAQ officielle Baileys (https://baileys.wiki/faq) est explicite :
// "Avoid calling fetchLatestWaWebVersion on every connect — newer versions
// can be incompatible. [...] The default version Baileys ships with is the
// recommended one." La bonne façon de rester à jour vis-à-vis du protocole
// WhatsApp est de mettre à jour le paquet @whiskeysockets/baileys lui-même
// (nouveau protobufs + nouvelle version par défaut assortie), pas de
// substituer un numéro de version à l'exécution. makeWASocket() ci-dessous
// n'a donc PAS d'option `version` — la valeur compilée dans la lib installée
// (voir node_modules/@whiskeysockets/baileys/lib/Defaults/baileys-version.json)
// est utilisée telle quelle.

function createSession(tenantId) {
  const AUTH_DIR = path.join(AUTH_DIR_BASE, tenantId);
  const authStore = whatsappAuthStore.createAuthStore(tenantId);

  let sock = null;
  let latestQR = null;
  let connected = false;
  let authState = null;
  let reconnectTimer = null;
  let syncStarted = false;
  let heartbeatTimer = null;
  // Nombre d'échecs consécutifs (close sans jamais atteindre 'open' entre
  // deux) — remis à zéro dès qu'une connexion réussit. Sert de base au
  // backoff exponentiel de scheduleReconnect ci-dessous : un problème
  // persistant (identifiants revoqués, ou pire, un blocage réseau/anti-abus
  // WhatsApp) ne doit jamais déclencher de nouvelles tentatives toutes les
  // 3 secondes indéfiniment — observé en production après le correctif du
  // 401 (voir plus bas) : sans ce frein, deux tenants ont martelé les
  // serveurs WhatsApp en continu pendant plusieurs minutes.
  let consecutiveFailures = 0;

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
  // contacts. Isolé par tenant comme le reste de la session : le compte
  // WhatsApp d'une clé ne doit jamais faire fuiter les noms qu'il connaît vers
  // une autre clé sur ce même serveur. WhatsApp n'expose aucune API pour
  // demander le nom public d'un numéro qu'on n'a jamais "rencontré" (aucun
  // message échangé, aucune synchronisation de contact) : ce cache reste donc
  // incomplet par nature, et vide après une déconnexion (voir logout()) pour
  // ne pas faire fuiter les noms d'un compte vers le suivant sur cette même
  // instance.
  const contactNames = new Map();
  // Noms ENREGISTRÉS par le propriétaire (champ « name » du répertoire, pas le nom public) : sert à savoir si un contact est
  // « enregistré » (isSavedContact) et à le nommer comme le propriétaire le fait.
  const savedNames = new Map();

  // Tampon glissant des derniers messages RÉELLEMENT reçus (isolé par tenant,
  // en mémoire, cycle de vie du process). Permet à la couche intelligence de
  // répondre à "quel est le dernier message reçu / qui m'a écrit ?" avec des
  // données réelles plutôt qu'une réponse vide (voir lib/intelligence/
  // action-executor.js#READ_RECENT_MESSAGES). Vidé à la déconnexion (comme
  // contactNames) pour ne jamais faire fuiter les messages d'un compte vers le
  // suivant sur cette même instance. NON persistant : après un redémarrage du
  // serveur il repart vide et se remplit à chaque nouveau message entrant.
  const RECENT_MESSAGES_MAX = 50;
  const recentMessages = [];

  function extractMessageText(msg) {
    const m = msg && msg.message;
    if (!m) return '';
    return m.conversation
      || (m.extendedTextMessage && m.extendedTextMessage.text)
      || (m.imageMessage && m.imageMessage.caption)
      || (m.videoMessage && m.videoMessage.caption)
      || (m.documentMessage && m.documentMessage.caption)
      || '';
  }

  // Correspondance LID -> JID téléphonique, apprise UNIQUEMENT à partir de ce que WhatsApp fournit (événements de
  // contacts, senderPn/participantPn/remoteJidAlt des messages). Jamais déduite des chiffres d'un identifiant.
  const lidToPn = new Map();
  function learnLidPair(a, b) {
    const isLid = (x) => /@lid$/i.test(String(x || ''));
    const isPn = (x) => /@s\.whatsapp\.net$/i.test(String(x || ''));
    if (isLid(a) && isPn(b)) lidToPn.set(String(a), String(b));
    else if (isLid(b) && isPn(a)) lidToPn.set(String(b), String(a));
  }

  // Indices d'identité d'un message entrant (pour ai-engine/contactIdentity.js). `phoneNumber` est renseigné
  // seulement si un vrai JID téléphonique est disponible ; sinon null.
  function getIdentityHints(msg) {
    const key = (msg && msg.key) || {};
    const primary = key.remoteJid || null;
    const isGroup = /@g\.us$/i.test(String(primary || ''));
    const senderJid = isGroup ? (key.participant || null) : primary;
    const alts = [key.remoteJidAlt, key.senderPn, key.participantPn, key.participantAlt].filter(Boolean);
    alts.forEach((a) => learnLidPair(senderJid, a));
    const known = senderJid && lidToPn.get(String(senderJid));
    if (known) alts.push(known);
    const pnJid = [senderJid].concat(alts).find((j) => /^\d{6,15}(?::\d+)?@s\.whatsapp\.net$/i.test(String(j || '')));
    return {
      jid: primary,
      senderJid,
      altJids: alts.map(String),
      pushName: msg && msg.pushName ? String(msg.pushName) : null,
      savedName: (senderJid && savedNames.get(senderJid)) || (pnJid && savedNames.get(pnJid)) || null,
      knownName: (senderJid && contactNames.get(senderJid)) || (pnJid && contactNames.get(pnJid)) || null,
      phoneNumber: pnJid ? String(pnJid).split('@')[0].split(':')[0] : null,
      isGroup,
    };
  }

  // Identifiants du compte connecté (numéro + LID) : sert à reconnaître la conversation « à soi-même » (self-chat).
  function getSelfIds() {
    const out = { pn: null, lid: null };
    try {
      const u = (sock && sock.user) || (authState && authState.creds && authState.creds.me) || {};
      if (u.id) out.pn = String(u.id).split(':')[0].split('@')[0] + '@s.whatsapp.net';
      const lid = u.lid || (authState && authState.creds && authState.creds.me && authState.creds.me.lid);
      if (lid) out.lid = String(lid).split(':')[0].split('@')[0] + '@lid';
    } catch (e) { /* ids inconnus */ }
    return out;
  }

  function isSelfChatJid(jid) {
    const ids = getSelfIds();
    const base = (j) => String(j || '').split(':')[0].split('@')[0] + '@' + String(j || '').split('@')[1];
    const b = base(jid);
    return !!jid && ((ids.pn && b === ids.pn) || (ids.lid && b === ids.lid));
  }

  function recordIncomingMessage(msg) {
    try {
      const from = msg.key && msg.key.remoteJid;
      if (!from) return;
      const hasMedia = !!(msg.message && (msg.message.imageMessage || msg.message.videoMessage
        || msg.message.audioMessage || msg.message.documentMessage || msg.message.stickerMessage));
      const tsRaw = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp);
      // `number` = vrai numéro UNIQUEMENT (JID téléphonique) ; un @lid n'est pas un numéro (contactIdentity).
      const idHints = getIdentityHints(msg);
      recentMessages.push({
        from,
        number: idHints.phoneNumber,
        name: msg.pushName || contactNames.get(from) || null,
        text: extractMessageText(msg) || '',
        hasMedia,
        isGroup: String(from).endsWith('@g.us'),
        ts: (Number.isFinite(tsRaw) && tsRaw > 0) ? tsRaw : Math.floor(Date.now() / 1000),
      });
      if (recentMessages.length > RECENT_MESSAGES_MAX) {
        recentMessages.splice(0, recentMessages.length - RECENT_MESSAGES_MAX);
      }
    } catch (err) {
      // jamais bloquant : un message non enregistré ne doit rien casser.
    }
  }

  // Derniers messages reçus, du plus récent au plus ancien (limite bornée).
  function getRecentMessages(limit) {
    const n = Math.max(1, Math.min(RECENT_MESSAGES_MAX, Number(limit) || 10));
    return recentMessages.slice(-n).reverse().map((r) => Object.assign({}, r));
  }

  // Numéro du compte WhatsApp réellement connecté (sans le suffixe d'appareil
  // ni le domaine), pour permettre à l'agent de confirmer "oui, je suis bien
  // connecté au numéro X". null si non connecté.
  function getConnectedNumber() {
    try {
      const id = (sock && sock.user && sock.user.id)
        || (authState && authState.creds && authState.creds.me && authState.creds.me.id);
      if (!id) return null;
      return String(id).split(':')[0].split('@')[0] || null;
    } catch (err) {
      return null;
    }
  }

  // Le compte est-il APPAIRÉ (creds enregistrées), indépendamment de l'état
  // live du socket ? Permet de distinguer "appairé mais reconnexion en cours"
  // (fréquent : coupures 428 côté WhatsApp sur IP cloud) de "jamais appairé".
  // Survit aux flaps de connexion (authState.creds persiste tant qu'on ne fait
  // pas logout()), ce que isConnected() ne fait pas.
  function isPaired() {
    try {
      return !!(authState && authState.creds && authState.creds.registered);
    } catch (err) {
      return false;
    }
  }

  // Écouteurs "message entrant" (voir onIncomingMessage plus bas) : le moteur
  // de campagne (queues/campaignEngine.js) s'y abonne pour mettre la file
  // d'attente en pause dès qu'un contact répond pendant l'envoi d'une
  // campagne, plutôt que de continuer à lui envoyer la suite de la séquence
  // sans tenir compte de sa réponse.
  const incomingMessageListeners = [];

  function onIncomingMessage(callback) {
    incomingMessageListeners.push(callback);
  }

  // Activité humaine : messages « fromMe » qui ne viennent pas de Cyrus (l'utilisateur écrit depuis son téléphone).
  const sentByCyrus = new Set();
  function rememberSent(id) {
    sentByCyrus.add(String(id));
    if (sentByCyrus.size > 2000) sentByCyrus.delete(sentByCyrus.values().next().value);
  }
  // Mémoire 7 jours : messages HISTORIQUES (synchronisation initiale), rattrapés hors ligne (type « append ») et écrits par
  // l'utilisateur/Cyrus (fromMe). Ils alimentent la mémoire uniquement : aucune réponse automatique.
  const historyMessageListeners = [];
  function onHistoryMessage(callback) { historyMessageListeners.push(callback); }
  function notifyHistoryMessage(msg) {
    try {
      if (!msg || !msg.key || !msg.key.remoteJid || msg.key.remoteJid === 'status@broadcast') return;
      const tsRaw = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp);
      if (Number.isFinite(tsRaw) && tsRaw > 0 && tsRaw * 1000 < Date.now() - 7 * 24 * 3600 * 1000) return;
      historyMessageListeners.forEach((callback) => {
        try { callback(msg); } catch (err) { console.error(`Erreur dans un écouteur d'historique (tenant "${tenantId}") :`, err.message); }
      });
    } catch (err) { /* jamais bloquant */ }
  }
  // Canal propriétaire : messages écrits par l'utilisateur dans SA propre conversation (self-chat). Ce ne sont pas des
  // messages clients ni de l'« activité humaine » sur une conversation : ils vont vers l'interface propriétaire.
  const ownerMessageListeners = [];
  function onOwnerMessage(callback) { ownerMessageListeners.push(callback); }
  function checkOwnerMessage(msg) {
    // Court délai : l'écho d'un message envoyé par Cyrus peut arriver avant que son identifiant soit mémorisé.
    setTimeout(() => {
      if (!msg.key || sentByCyrus.has(String(msg.key.id))) return; // message généré par Cyrus : jamais retraité
      ownerMessageListeners.forEach((callback) => {
        try { callback(msg); } catch (err) { console.error(`Erreur dans un écouteur de message propriétaire (tenant "${tenantId}") :`, err.message); }
      });
    }, 700);
  }
  function wasSentByCyrus(id) { return sentByCyrus.has(String(id)); }
  const humanActivityListeners = [];
  function onOutgoingMessage(callback) { humanActivityListeners.push(callback); }
  function checkHumanActivity(msg) {
    // Délai : l'évènement peut précéder la fin de sock.sendMessage (qui enregistre l'identifiant).
    setTimeout(() => {
      if (!msg.key || sentByCyrus.has(String(msg.key.id))) return;
      humanActivityListeners.forEach((callback) => {
        try { callback(msg); } catch (err) { console.error(`Erreur dans un écouteur d'activité humaine (tenant "${tenantId}") :`, err.message); }
      });
    }, 3000);
  }

  function notifyIncomingMessage(msg) {
    incomingMessageListeners.forEach((callback) => {
      try {
        callback(msg);
      } catch (err) {
        console.error(`Erreur dans un écouteur de message entrant (tenant "${tenantId}") :`, err.message);
      }
    });
  }

  // Écouteurs "identité de compte réinitialisée" — adapters/whatsappManager.js
  // s'y abonne pour réinitialiser (CampaignEngine#reset) le moteur de
  // campagne de ce tenant dès que le numéro WhatsApp connecté change ou est
  // révoqué : une campagne "running"/"paused" de l'ANCIEN numéro n'a plus
  // aucun sens et ne doit JAMAIS verrouiller le lancement d'une campagne pour
  // le NOUVEAU numéro appairé sous ce même tenant (même clé de licence).
  // Déclenché par logout() (déconnexion manuelle, y compris celle effectuée
  // par requestPairingCode() avant d'appairer un nouveau numéro) et par une
  // révocation détectée côté WhatsApp (voir connection.update ci-dessous) —
  // jamais par une simple coupure réseau/reconnexion, qui garde le même
  // compte et ne doit donc rien réinitialiser.
  const accountResetListeners = [];

  function onAccountReset(callback) {
    accountResetListeners.push(callback);
  }

  function notifyAccountReset() {
    accountResetListeners.forEach((callback) => {
      try {
        callback();
      } catch (err) {
        console.error(`Erreur dans un écouteur de réinitialisation de compte (tenant "${tenantId}") :`, err.message);
      }
    });
  }

  function rememberContactName(jid, name) {
    if (jid && name) {
      contactNames.set(jid, name);
    }
  }

  // Priorité : "notify" (nom que le contact a lui-même choisi, public — voir
  // pushName sur les messages) > "verifiedName" (compte professionnel vérifié)
  // > "name" (nom qu'on aurait NOUS-MÊMES enregistré pour ce contact dans le
  // répertoire synchronisé sur ce compte WhatsApp — moins "public", mais reste
  // une source légitime pour un usage interne de gestion de contacts).
  function bestContactName(c) {
    return c.notify || c.verifiedName || c.name || null;
  }

  // Un même Contact (voir Types/Contact.d.ts) peut porter jusqu'à 3
  // identifiants différents pour la même personne : .id (soit un @lid, soit un
  // JID téléphone selon le contexte), .jid (toujours le JID téléphone quand
  // connu) et .lid (toujours le @lid quand connu). Sans mémoriser le nom sous
  // LES TROIS clés disponibles, une recherche ultérieure sous une clé
  // différente de celle utilisée à l'enregistrement (typiquement : le nom
  // synchronisé sous le @lid, mais l'export qui cherche sous le JID téléphone
  // résolu via participant.jid — voir /api/groups/export-members) échouerait
  // alors que le nom est bel et bien connu.
  function rememberContact(c) {
    learnLidPair(c.id, c.jid); learnLidPair(c.id, c.lid); learnLidPair(c.lid, c.jid);
    if (c.name) { [c.id, c.jid, c.lid].filter(Boolean).forEach((k) => savedNames.set(k, c.name)); }
    const name = bestContactName(c);
    if (!name) return;
    rememberContactName(c.id, name);
    rememberContactName(c.jid, name);
    rememberContactName(c.lid, name);
  }

  function getContactName(jid) {
    return contactNames.get(jid) || null;
  }

  // pushName voyage avec CHAQUE message (pas seulement les nouveaux reçus en
  // direct via messages.upsert, mais aussi les messages historiques fournis en
  // bloc par messaging-history.set — voir plus bas) : c'est en pratique la
  // source la plus riche pour peupler la colonne "nom" de l'export, bien
  // au-delà des seuls contacts synchronisés (elle couvre quiconque a déjà
  // écrit dans un groupe/chat partagé, même sans être enregistré dans le
  // répertoire du téléphone). Même cas que pour les participants de groupe
  // (voir /api/groups/export-members) : .participant/.remoteJid peuvent être
  // un @lid — .participantPn/.senderPn portent alors le vrai JID téléphone en
  // plus, mémorisé aussi pour que la recherche par JID téléphone le retrouve.
  function rememberFromMessage(msg) {
    if (!msg.pushName) return;
    rememberContactName(msg.key?.participant || msg.key?.remoteJid, msg.pushName);
    rememberContactName(msg.key?.participantPn || msg.key?.senderPn, msg.pushName);
  }

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
        console.warn(`Heartbeat WhatsApp (tenant "${tenantId}"): échec de l'envoi de présence —`, err.message);
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

  const BASE_RECONNECT_DELAY_MS = 3000;
  const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

  // Backoff exponentiel (3s, 6s, 12s, ... plafonné à 5 min) basé sur
  // consecutiveFailures : protège contre un martèlement des serveurs
  // WhatsApp en cas d'échec persistant, quelle qu'en soit la cause (session
  // révoquée, coupure réseau, ou blocage anti-abus WhatsApp). Remis à zéro
  // sur une connexion réussie (voir connection === 'open' plus bas).
  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }
    const delayMs = Math.min(BASE_RECONNECT_DELAY_MS * (2 ** consecutiveFailures), MAX_RECONNECT_DELAY_MS);
    consecutiveFailures += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err) => {
        console.error(`Erreur lors de la tentative de reconnexion WhatsApp (tenant "${tenantId}"):`, err);
        scheduleReconnect();
      });
    }, delayMs);
  }

  async function restoreSessionFromRemote() {
    return authStore.restoreSessionFromRemote(AUTH_DIR);
  }

  // Sérialise toute opération qui touche à sock/AUTH_DIR (doConnect, logout) :
  // sans ça, une reconnexion automatique programmée par scheduleReconnect()
  // peut se déclencher au moment exact où l'utilisateur demande un nouveau
  // code d'appairage (requestPairingCode -> logout), et les deux finissent par
  // lire/écrire useMultiFileAuthState(AUTH_DIR) en parallèle — l'une pouvant
  // supprimer (fs.rmSync) le dossier de session pendant que l'autre est en
  // train d'y écrire les creds d'une tentative de connexion différente,
  // corrompant la session locale. Chaque appel attend la fin du précédent,
  // qu'il ait réussi ou échoué, avant de démarrer.
  let lifecycleQueue = Promise.resolve();
  function runSerialized(fn) {
    const run = lifecycleQueue.then(fn, fn);
    lifecycleQueue = run.then(() => {}, () => {});
    return run;
  }

  async function doConnect() {
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
    // Capturé UNE FOIS ici, avant toute tentative de connexion : Baileys peut
    // remettre creds.registered à false en interne dès qu'il détecte un rejet
    // (le close handler ci-dessous verrait alors toujours "jamais enregistré"
    // même pour un compte qui l'était il y a une seconde, si on relisait
    // authState.creds.registered en direct au moment du close). Cette valeur
    // figée reflète fidèlement l'état AVANT cette tentative précise.
    const wasRegisteredBeforeThisAttempt = Boolean(state?.creds?.registered);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      // Par défaut, Baileys ne laisse vivre un QR que 60s pour le premier,
      // puis seulement 20s pour chaque QR suivant avant de fermer la
      // connexion et d'en régénérer un autre (code 408) — bien trop court
      // pour qu'un utilisateur ait le temps de sortir son téléphone et
      // scanner sereinement. Observé en production : ce cycle de 20s a
      // tourné en boucle pendant plusieurs minutes (QR jamais scanné à
      // temps), et WhatsApp a fini par considérer ces régénérations
      // répétées comme suspectes et bloquer temporairement l'appairage de ce
      // compte (fermeture avec code 401 en pleine tentative de connexion,
      // avant même tout enregistrement réussi). 120s laisse largement le
      // temps de scanner sans multiplier les régénérations qui déclenchent
      // ce blocage anti-abus.
      qrTimeout: 120_000,
      // Sans ça, Baileys ne demande pas la synchronisation complète de
      // l'historique (dont la liste de contacts synchronisés sur ce compte)
      // au moment de l'appairage — la seule vraie source de noms de profil
      // pour des contacts qu'on n'a pas encore soi-même "rencontrés" via un
      // message (voir messaging-history.set ci-dessous). Ne prend effet qu'au
      // prochain appairage complet (QR/code d'association) : une session déjà
      // connectée ne le déclenche pas rétroactivement.
      syncFullHistory: true,
    });

    // Mémorise l'identifiant de TOUT message envoyé par Cyrus (réponses, campagnes, relances) : un message
    // « fromMe » absent de cet ensemble a été écrit par l'utilisateur lui-même (activité humaine).
    const originalSend = sock.sendMessage.bind(sock);
    sock.sendMessage = async (...args) => {
      const res = await originalSend(...args);
      try { if (res && res.key && res.key.id) rememberSent(res.key.id); } catch (e) { /* non bloquant */ }
      return res;
    };

    sock.ev.on('creds.update', async () => {
      if (isStale()) return;
      await saveCreds();
      // Les créds changent surtout au moment de l'appairage (QR/pairing code) :
      // on pousse immédiatement plutôt que d'attendre le prochain instantané
      // périodique, pour ne pas devoir rescanner si le process redémarre juste
      // après un appairage réussi.
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
        qrcode.generate(qr, { small: true });
        console.log(`=== QR CODE BRUT (tenant "${tenantId}") ===`);
        console.log(qr);
        console.log("====================");
      }

      if (connection === 'close') {
        connected = false;
        // Un QR affiché n'est plus valable une fois la connexion fermée : on le
        // purge pour ne jamais laisser la garde d'attente de requestPairingCode
        // (voir waitForStreamReady) résoudre sur le QR périmé d'un socket mort —
        // le prochain QR réel réarmera latestQR. Sert aussi de signal honnête à
        // getQRCode() pendant la fenêtre de reconnexion.
        latestQR = null;
        stopHeartbeat();
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut && wasRegisteredBeforeThisAttempt) {
          // Un compte déjà appairé avec succès qui reçoit un 401 signifie que
          // WhatsApp a révoqué ce lien (déconnexion depuis le téléphone,
          // conflit d'appairage...) : retenter avec les MÊMES identifiants
          // échouerait indéfiniment puisqu'ils sont désormais invalides côté
          // WhatsApp — les laisser en l'état bloquait le tenant sans jamais
          // regénérer de QR (l'ancien bug), et les réutiliser en boucle
          // martèlerait inutilement les serveurs WhatsApp avec un identifiant
          // mort. On purge et relance une connexion fraîche pour régénérer un
          // QR exploitable, exactement comme logout() le ferait.
          console.log(
            `Connexion WhatsApp fermée (tenant "${tenantId}"). (code: ${statusCode}) — session révoquée par WhatsApp, régénération d'un identifiant frais.`,
          );
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          contactNames.clear();
          recentMessages.length = 0;
          authStore.clearRemote().catch(() => {});
          // Le prochain appairage réussi sous ce tenant peut concerner un
          // numéro totalement différent (l'ancien lien étant révoqué) — voir
          // onAccountReset ci-dessus.
          notifyAccountReset();
          scheduleReconnect();
        } else if (!wasRegisteredBeforeThisAttempt && consecutiveFailures >= 3) {
          // Constaté en production (tenant "__admin__", 2026-09-13) : un
          // appairage JAMAIS finalisé qui échoue à répétition (QR/code
          // régénéré puis fermeture quasi immédiate, code 428 ou 401, en
          // boucle sur des heures) ne se rétablit jamais tout seul en
          // conservant les mêmes identifiants — l'identité d'appareil
          // (devicePairingData) de ces tentatives finit par être flaguée par
          // l'anti-abus WhatsApp (même mécanisme que documenté plus haut pour
          // qrTimeout), et retenter avec cette identité échoue indéfiniment.
          // Un tenant flambant neuf sur ce même VPS/IP s'appaire sans
          // problème (vérifié en diagnostic) — la cause est bien l'identité
          // de CE tenant, pas l'IP. Purger après 3 échecs consécutifs sans
          // jamais avoir réussi force une IDENTITÉ D'APPAREIL neuve au
          // prochain essai (nouveau QR/code), sans rapport avec le cas
          // ci-dessus (aucune session valide à révoquer ici, jamais
          // enregistrée) — donc pas d'onAccountReset()/campagne à annuler.
          console.log(
            `Connexion WhatsApp fermée (tenant "${tenantId}"). (code: ${statusCode}) — ${consecutiveFailures} échecs consécutifs sans appairage réussi, régénération d'une identité d'appareil neuve.`,
          );
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          consecutiveFailures = 0;
          scheduleReconnect();
        } else {
          // Tout autre cas (coupure réseau, timeout de QR non scanné à
          // temps, 401 pendant un appairage jamais finalisé...) : on relance
          // normalement avec les identifiants existants, encore valides ou
          // pas encore validés par WhatsApp — pas besoin de les purger.
          console.log(
            `Connexion WhatsApp fermée (tenant "${tenantId}").`,
            statusCode ? `(code: ${statusCode})` : '',
            '— reconnexion automatique planifiée.',
          );
          scheduleReconnect();
        }
      } else if (connection === 'open') {
        connected = true;
        latestQR = null;
        consecutiveFailures = 0;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        console.log(`Connexion WhatsApp établie (tenant "${tenantId}").`);
        authStore.pushSnapshot(AUTH_DIR);
        startHeartbeat();
      }
    });

    sock.ev.on('messages.upsert', (m) => {
      if (isStale()) return;
      (m.messages || []).forEach((msg) => {
        rememberFromMessage(msg);
        // Ne notifie que pour un vrai message reçu en direct (m.type ===
        // 'notify', pas un message historique rejoué par la synchronisation),
        // envoyé par le contact (pas un message qu'on vient nous-mêmes
        // d'envoyer) et hors diffusion "statut" (status@broadcast, qui n'est
        // jamais une réponse d'un contact précis).
        if (m.type === 'notify' && msg.key && !msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
          recordIncomingMessage(msg);
          notifyIncomingMessage(msg);
        } else if (m.type === 'notify' && msg.key && msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
          notifyHistoryMessage(msg);
          if (isSelfChatJid(msg.key.remoteJid)) checkOwnerMessage(msg);
          else checkHumanActivity(msg);
        } else if (m.type === 'append') {
          notifyHistoryMessage(msg); // messages reçus pendant une déconnexion, rattrapés à la reconnexion
        }
      });
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      if (isStale()) return;
      (contacts || []).forEach((c) => rememberContact(c));
    });

    sock.ev.on('contacts.update', (updates) => {
      if (isStale()) return;
      (updates || []).forEach((c) => rememberContact(c));
    });

    // Synchronisation initiale de l'historique (voir syncFullHistory ci-dessus,
    // ne se déclenche qu'après un appairage complet) : porte à la fois la
    // liste des contacts déjà synchronisés ET l'historique des messages de
    // toutes les discussions/groupes partagés — cette seconde partie est en
    // pratique la source la plus riche (voir rememberFromMessage), puisqu'elle
    // couvre quiconque a déjà écrit dans un groupe partagé, pas seulement les
    // contacts enregistrés dans le répertoire du téléphone.
    sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
      if (isStale()) return;
      (contacts || []).forEach((c) => rememberContact(c));
      (messages || []).forEach(rememberFromMessage);
      (messages || []).forEach(notifyHistoryMessage);
    });

    return sock;
  }

  function connect() {
    return runSerialized(doConnect);
  }

  async function sendMessage(to, text) {
    if (!sock) {
      throw new Error('Adaptateur WhatsApp non initialisé.');
    }
    return sock.sendMessage(to, { text });
  }

  // forceDocument (voir adapters/videoCompressor.js) : une vidéo trop lourde
  // qui n'a pas pu être compressée sous la limite visée est envoyée en pièce
  // jointe "document" plutôt qu'en message "vidéo" — WhatsApp accepte des
  // documents bien plus lourds, ce qui contourne l'échec probable d'un envoi
  // vidéo trop volumineux.
  async function sendMedia(to, { buffer, mimetype, filename, caption, forceDocument }) {
    if (!sock) {
      throw new Error('Adaptateur WhatsApp non initialisé.');
    }

    if (!forceDocument) {
      if (mimetype === 'image/webp') {
        return sock.sendMessage(to, { sticker: buffer });
      }

      if (mimetype && mimetype.startsWith('image/')) {
        return sock.sendMessage(to, { image: buffer, caption });
      }

      if (mimetype && mimetype.startsWith('video/')) {
        return sock.sendMessage(to, { video: buffer, caption });
      }
    }

    return sock.sendMessage(to, {
      document: buffer,
      mimetype: mimetype || 'application/octet-stream',
      fileName: filename || 'fichier',
      caption,
    });
  }

  // Note vocale (voir ai-engine/voiceProcessor.js) — `ptt:true` fait
  // apparaître le message comme une VRAIE note vocale WhatsApp (forme d'onde,
  // lecture inline) plutôt qu'une pièce jointe audio classique. WhatsApp
  // n'accepte en PTT que de l'Opus/OGG encodé correctement — la conversion
  // (ffmpeg) est à la charge de l'appelant (voir voiceProcessor.js), jamais
  // faite ici.
  async function sendVoiceNote(to, buffer) {
    if (!sock) {
      throw new Error('Adaptateur WhatsApp non initialisé.');
    }
    return sock.sendMessage(to, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  }

  // Téléchargement d'un média entrant (note vocale, voir
  // ai-engine/voiceProcessor.js) — API canonique de Baileys, `reuploadRequest`
  // gère le cas rare d'une clé média déjà expirée en redemandant l'envoi au
  // téléphone source.
  async function downloadIncomingMedia(msg) {
    if (!sock) {
      throw new Error('Adaptateur WhatsApp non initialisé.');
    }
    return downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
  }

  // ---- Garde d'attente avant la demande d'un code d'appairage ----
  // Cause racine des "Connection Closed" / "Connection Failure" / "TIMEOUT"
  // constatés sur la génération du code (diagnostic du 2026-09-13) : le moteur
  // appelait sock.requestPairingCode() immédiatement après connect()/logout(),
  // pendant que la WebSocket WhatsApp était encore en phase CONNECTING (le
  // noise handshake n'étant pas terminé). Côté Baileys, envoyer le nœud 'iq'
  // de demande de code sur une ws dont ws.isOpen est faux lève
  // Boom('Connection Closed', {statusCode: connectionClosed}) — un défaut de
  // SÉQUENCEMENT de l'appelant, pas un défaut de protocole/version. La voie
  // sûre est d'attendre que le flux soit réellement armé AVANT d'envoyer la
  // demande.
  //
  // Signal d'armement : pour un appareil JAMAIS enregistré, connection==='open'
  // ne survient qu'APRÈS l'appairage réussi — jamais avant. Le seul signal
  // fiable "le flux est prêt pour un appairage" est l'émission d'un `qr` dans
  // connection.update (émis juste après le handshake, quand WhatsApp offre le
  // mode pair-device). Un socket déjà enregistré (cas d'un requestPairingCode
  // suivant un logout) aboutit directement en 'open'. Une fermeture avant
  // armement rejette la promesse avec le statusCode, pour une erreur honnête.
  function waitForStreamReady(targetSock, timeoutMs) {
    return new Promise((resolve, reject) => {
      // Déjà armé (le listener principal a déjà émis un QR pour ce socket —
      // ex. l'utilisateur a laissé la connexion s'établir avant de cliquer sur
      // "Obtenir le code") : aucune attente nécessaire.
      if (latestQR) {
        resolve();
        return;
      }

      let settled = false;
      let timer = null;

      const finalize = (err) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (targetSock && targetSock.ev && typeof targetSock.ev.off === 'function') {
          try {
            targetSock.ev.off('connection.update', onUpdate);
          } catch (err) {
            // l'écouteur a pu être déjà détaché par doConnect() — sans gravité
          }
        }
        if (err) reject(err);
        else resolve();
      };

      const onUpdate = (update) => {
        if (settled) return;
        if (update && update.qr) {
          finalize();
        } else if (update && update.connection === 'open') {
          finalize();
        } else if (update && update.connection === 'close') {
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          finalize(
            new Error(
              statusCode
                ? `Connexion WhatsApp fermée avant l'appairage (code: ${statusCode}).`
                : "Connexion WhatsApp fermée avant l'appairage.",
            ),
          );
        }
      };

      if (targetSock && targetSock.ev) {
        try {
          targetSock.ev.on('connection.update', onUpdate);
        } catch (err) {
          // finalize() fera de toute façon le ménage
        }
      }

      // Le QR Baileys vit 120s (voir qrTimeout) ; l'armement du flux arrive en
      // quelques secondes au pire. 30s est un garde-fou large qui ne masque
      // jamais un vrai refus WhatsApp (ceux-ci arrivent via 'close', pas ici).
      timer = setTimeout(() => {
        finalize(new Error("Connexion WhatsApp non armée pour l'appairage (TIMEOUT)."));
      }, timeoutMs || 30_000);
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

    // Attente de l'armement du flux (voir waitForStreamReady au-dessus), puis
    // demande du code. Une fermeture réelle (code: 401/408/428…) rejette
    // immédiatement au lieu d'un "Connection Closed" trompeur. La relecture de
    // `sock` à chaque tentative absorbe une reconnexion déclenchée par le
    // moteur entre deux essais.
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const targetSock = sock;
      try {
        await waitForStreamReady(targetSock);
        const rawCode = await targetSock.requestPairingCode(digits);
        return rawCode.replace(/-/g, '').match(/.{1,4}/g).join('-');
      } catch (err) {
        lastError = err;
        const isSequencingError = (e) =>
          e && e.message && /Connection Closed|connection closed|closed before/i.test(e.message);
        // Seul un échec de séquencement (socket pas encore armé entre la garde
        // et l'envoi effectif) est retenté — les refus WhatsApp réels (401,
        // 408, 428, timeout d'attente...) sont définitifs et remontés tels
        // quels. Passé ce délai, l'armement est acquis (voir le fast-path
        // latestQR de waitForStreamReady), donc le retry résout ou échoue vite.
        if (isSequencingError(err) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        break;
      }
    }
    throw lastError || new Error("Impossible de générer le code d'appairage.");
  }

  // ---- MODULE COMMUNAUTÉS (création/invitation de groupes, découverte) : primitives minimales du moteur ; toute la logique (respect de la
  // vie privée, cadence, DM d'invitation, rapport) est dans ai-engine/communityService.js. Rien ici ne décide ni n'envoie de son propre chef.
  const digitsOf = (x) => String(x || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  const toUserJid = (n) => `${digitsOf(n)}@s.whatsapp.net`;

  // Quels numéros existent réellement sur WhatsApp ? -> [{ number, exists, jid }]
  async function checkNumbersOnWhatsApp(numbers) {
    if (!sock) throw new Error('Adaptateur WhatsApp non initialisé.');
    const list = (numbers || []).map(digitsOf).filter(Boolean);
    if (!list.length) return [];
    const res = (await sock.onWhatsApp(...list.map(toUserJid))) || [];
    const byNum = new Map(res.map((r) => [digitsOf(r.jid), r]));
    return list.map((n) => { const r = byNum.get(n); return { number: n, exists: !!(r && r.exists), jid: r && r.jid ? r.jid : toUserJid(n) }; });
  }
  async function createGroup(subject, participantNumbers) {
    if (!sock) throw new Error('Adaptateur WhatsApp non initialisé.');
    const g = await sock.groupCreate(String(subject).slice(0, 100), (participantNumbers || []).map(toUserJid));
    return { id: g.id, subject: g.subject || subject };
  }
  // Ajout de participants : renvoie le statut RÉEL de WhatsApp par participant ('200' ajouté, '403' confidentialité : ajout direct refusé,
  // '408' a quitté récemment, '409' déjà membre, '401' refusé/bloqué…).
  async function addGroupParticipants(groupJid, numbers) {
    if (!sock) throw new Error('Adaptateur WhatsApp non initialisé.');
    const res = (await sock.groupParticipantsUpdate(groupJid, (numbers || []).map(toUserJid), 'add')) || [];
    return res.map((p) => ({ number: digitsOf(p.jid), jid: p.jid, status: String(p.status) }));
  }
  async function getGroupInviteLink(groupJid) {
    if (!sock) throw new Error('Adaptateur WhatsApp non initialisé.');
    const code = await sock.groupInviteCode(groupJid);
    return code ? `https://chat.whatsapp.com/${code}` : null;
  }
  async function setGroupDescription(groupJid, text) {
    if (!sock) throw new Error('Adaptateur WhatsApp non initialisé.');
    await sock.groupUpdateDescription(groupJid, String(text || '').slice(0, 2000));
  }
  // Informations RÉELLES d'un groupe à partir de son code d'invitation (nom, taille, description) — sans le rejoindre.
  async function getInviteInfo(code) {
    if (!sock) throw new Error('Adaptateur WhatsApp non initialisé.');
    const i = await sock.groupGetInviteInfo(String(code));
    return { id: i.id, subject: i.subject || '', description: i.desc || '', size: i.size != null ? i.size : (i.participants || []).length, createdAt: i.creation || null };
  }

  // Adhésion à un groupe via son code d'invitation — action EXPLICITE, jamais
  // déclenchée automatiquement par la découverte de communautés (voir
  // ai-engine/communityDiscovery.js) : chaque adhésion doit rester un clic
  // volontaire du propriétaire, groupe par groupe, pour ne pas reproduire le
  // pattern de connexions/actions en rafale qui a déjà provoqué des
  // révocations WhatsApp (voir adapters/whatsappManager.js).
  async function joinGroupByInvite(code) {
    if (!sock) throw new Error('Adaptateur WhatsApp non initialisé.');
    const groupId = await sock.groupAcceptInvite(String(code));
    return { id: groupId };
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
      console.error(`Erreur lors de la récupération des groupes (tenant "${tenantId}"):`, err);
      return [];
    }
  }

  async function getGroupParticipants(groupId) {
    const metadata = await getGroupMetadata(groupId);
    return metadata.participants;
  }

  // Résumé de TOUS les groupes du compte, avec le rôle du compte connecté
  // (isAdmin) + la taille — permet à l'agent de cibler "les groupes dont je
  // suis admin", "les groupes contenant tel mot", etc. (voir
  // lib/intelligence/action-executor.js#LIST_GROUPS). Best-effort : renvoie []
  // si non connecté plutôt que de lever.
  async function getGroupsSummary() {
    if (!sock) return [];
    try {
      const meNum = getConnectedNumber();
      const groups = await sock.groupFetchAllParticipating();
      return Object.values(groups || {}).map((g) => {
        const participants = g.participants || [];
        let isAdmin = false;
        // Le compte peut apparaître par son NUMÉRO ou par son LID selon le mode d'adressage du groupe : on compare aux deux
        // identifiants du compte connecté (sinon un vrai administrateur serait vu comme simple membre).
        const selfLid = (getSelfIds().lid || '').split('@')[0];
        const meNums = [meNum, selfLid].filter(Boolean);
        if (meNums.length) {
          const mine = participants.find((p) => [p.id, p.jid, p.lid].some((x) => {
            const num = String(x || '').split('@')[0].split(':')[0];
            return num && meNums.includes(num);
          }));
          isAdmin = !!(mine && (mine.admin === 'admin' || mine.admin === 'superadmin'));
        }
        return {
          id: g.id,
          name: g.subject || 'Sans nom',
          size: participants.length,
          isAdmin,
          channel: 'WHATSAPP',
        };
      });
    } catch (err) {
      console.error(`getGroupsSummary WhatsApp (tenant "${tenantId}") :`, err.message);
      return [];
    }
  }

  // Déconnexion manuelle demandée par l'utilisateur (bouton "Se déconnecter" du
  // dashboard) : contrairement à une coupure réseau (voir connection.update /
  // DisconnectReason.loggedOut), il faut ici explicitement effacer les
  // identifiants locaux pour permettre de lier un nouvel appareil/numéro — sans
  // quoi useMultiFileAuthState() rechargerait les mêmes creds et resterait
  // enregistré sur l'ancien compte. On relance ensuite connect() tout de suite
  // pour que l'utilisateur obtienne un nouveau QR code sans devoir redémarrer
  // le serveur.
  function logout() {
    // runSerialized (voir plus haut) : empêche qu'une reconnexion automatique
    // en cours (doConnect() déclenché par scheduleReconnect) ne lise/écrive
    // AUTH_DIR en parallèle de la purge ci-dessous.
    return runSerialized(async () => {
      // Voir onAccountReset ci-dessus : le prochain appairage sous ce tenant
      // peut concerner un numéro totalement différent — le moteur de campagne
      // ne doit jamais hériter d'un état "running"/"paused" de l'ancien.
      notifyAccountReset();

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopHeartbeat();

      if (sock) {
        try {
          await sock.logout();
        } catch (err) {
          console.warn(`Erreur lors du logout WhatsApp (tenant "${tenantId}", nettoyage local effectué quand même) :`, err.message);
        }
      }

      connected = false;
      latestQR = null;
      authState = null;
      sock = null;
      contactNames.clear();
      recentMessages.length = 0;

      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      await authStore.clearRemote();

      await doConnect();
    });
  }

  // Libération "douce" déclenchée par le régulateur de sessions (voir
  // adapters/sessionRegulator.js) quand ce tenant est inactif depuis plus de
  // 15 minutes, ou est la plus ancienne session sans campagne en cours,
  // et qu'une nouvelle session doit prendre sa place sous la limite fixée
  // par MAX_ACTIVE_SESSIONS. Contrairement à logout(), NE supprime PAS les
  // identifiants (creds.json, local et GitHub) : le tenant reste appairé et
  // se reconnectera automatiquement (sans rescanner de QR) à sa prochaine
  // requête, quand whatsappManager rappellera whatsapp.createSession() pour
  // ce même tenantId.
  function dispose() {
    connectGeneration += 1; // rend obsolètes les écouteurs du socket en cours
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    authStore.stopPeriodicSync();

    if (sock) {
      try {
        sock.ev.removeAllListeners();
      } catch (err) {
        // ignore
      }
      try {
        sock.end(new Error('Session libérée par le régulateur de sessions (inactivité ou limite atteinte).'));
      } catch (err) {
        // ignore
      }
    }

    sock = null;
    connected = false;
    latestQR = null;
  }

  return {
    tenantId,
    connect,
    restoreSessionFromRemote,
    sendMessage,
    sendMedia,
    sendVoiceNote,
    downloadIncomingMedia,
    getQRCode,
    isConnected,
    requestPairingCode,
    getGroupMetadata,
    getGroups,
    getGroupsSummary,
    getGroupParticipants,
    getContactName,
    getIdentityHints,
    getSelfIds,
    isSelfChatJid,
    onOwnerMessage,
    wasSentByCyrus,
    getRecentMessages,
    getConnectedNumber,
    isPaired,
    checkNumbersOnWhatsApp,
    createGroup,
    addGroupParticipants,
    getGroupInviteLink,
    setGroupDescription,
    getInviteInfo,
    joinGroupByInvite,
    onIncomingMessage,
    onOutgoingMessage,
    onHistoryMessage,
    onAccountReset,
    logout,
    dispose,
    getStorageStatus: authStore.getStatus,
  };
}

module.exports = {
  createSession,
  AUTH_DIR_BASE,
};
