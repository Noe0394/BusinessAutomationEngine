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
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const githubStore = require('../githubStore');
const whatsappAuthStore = require('./whatsappAuthStore');

// Isolation stricte par tenant (voir adapters/whatsappManager.js) : chaque
// clé de licence obtient sa PROPRE instance WhatsApp (son propre socket
// Baileys, son propre QR code, sa propre session, son propre cache de noms
// publics) — plus aucun état n'est partagé au niveau du module comme
// c'était le cas avant cette refonte. createSession(tenantId) est appelée
// une fois par tenant par le gestionnaire, qui conserve l'instance retournée
// tant que ce tenant reste actif.
//
// Sur Render (et la plupart des PaaS), le disque local est éphémère : sans
// disque persistant monté sur ce chemin, la session est reperdue à chaque
// redéploiement/redémarrage et il faut se réappairer. Le chemin est donc
// configurable via AUTH_DIR pour pointer vers un Render Disk / volume Docker
// si disponible — chaque tenant obtient un sous-dossier dédié
// (AUTH_DIR/<tenantId>/). Si GITHUB_TOKEN/GITHUB_DATA_REPO sont définis (voir
// whatsappAuthStore.js), la session de chaque tenant est aussi sauvegardée
// dans un fichier dédié du repo GitHub et restaurée au démarrage, sur le même
// principe que les licences.
const AUTH_DIR_BASE = process.env.AUTH_DIR || 'auth_info_baileys';

if (!process.env.AUTH_DIR && !githubStore.enabled) {
  console.warn(
    `AUTH_DIR non défini et sauvegarde GitHub désactivée : les sessions WhatsApp sont stockées sous "${AUTH_DIR_BASE}/<tenant>" sur le disque local uniquement. ` +
    'Sur Render/Docker, ce dossier est effacé à chaque redéploiement/redémarrage sauf disque persistant (volume Docker monté) ou GITHUB_TOKEN/GITHUB_DATA_REPO configurés.',
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

  // Écouteurs "message entrant" (voir onIncomingMessage plus bas) : le moteur
  // de campagne (queues/campaignEngine.js) s'y abonne pour mettre la file
  // d'attente en pause dès qu'un contact répond pendant l'envoi d'une
  // campagne, plutôt que de continuer à lui envoyer la suite de la séquence
  // sans tenir compte de sa réponse.
  const incomingMessageListeners = [];

  function onIncomingMessage(callback) {
    incomingMessageListeners.push(callback);
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
          authStore.clearRemote().catch(() => {});
          // Le prochain appairage réussi sous ce tenant peut concerner un
          // numéro totalement différent (l'ancien lien étant révoqué) — voir
          // onAccountReset ci-dessus.
          notifyAccountReset();
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
          notifyIncomingMessage(msg);
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
      console.error(`Erreur lors de la récupération des groupes (tenant "${tenantId}"):`, err);
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
    getQRCode,
    isConnected,
    requestPairingCode,
    getGroupMetadata,
    getGroups,
    getGroupParticipants,
    getContactName,
    onIncomingMessage,
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
