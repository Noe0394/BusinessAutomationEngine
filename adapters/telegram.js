const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { NewMessage } = require('telegram/events');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const githubStore = require('../githubStore');
const telegramAuthStore = require('./telegramAuthStore');
const { resolveSpintax } = require('../lib/spintax');
const circuitBreaker = require('../lib/circuitBreaker');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Isolation stricte par tenant (voir adapters/telegramManager.js), sur le
// même principe que adapters/whatsapp.js : chaque clé de licence obtient son
// PROPRE client MTProto (son propre compte Telegram connecté, sa propre
// session, son propre état de connexion) — plus aucun état partagé au niveau
// du module, contrairement à l'ancienne classe TelegramAdapter instanciée une
// seule fois pour tout le serveur (qui faisait qu'ouvrir une 2e connexion
// Telegram déconnectait/écrasait la première). createSession(tenantId) est
// appelée une fois par tenant par le gestionnaire, qui conserve l'instance
// retournée tant que ce tenant reste actif.
//
// apiId/apiHash restent lus une seule fois au niveau du module : ce sont les
// identifiants de l'APPLICATION Telegram (my.telegram.org), partagés par
// construction entre tous les tenants — seul le COMPTE (numéro de téléphone)
// connecté via ce client diffère par tenant.
const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10) || null;
const API_HASH = process.env.TELEGRAM_API_HASH || null;

if (!API_ID || !API_HASH) {
  console.warn(
    'TELEGRAM_API_ID / TELEGRAM_API_HASH non définis : le module Telegram est inactif ' +
    '(les routes /api/telegram/* renverront une erreur 503).',
  );
}

// Chaque tenant a son propre fichier de session (SESSION_DIR_BASE/<tenantId>.txt),
// sur le même principe que AUTH_DIR/<tenantId>/ côté WhatsApp. Sur Render
// (et la plupart des PaaS), le disque local est éphémère : sans disque
// persistant monté sur ce chemin, la session est reperdue à chaque
// redéploiement/redémarrage et il faut se reconnecter — sauf si
// GITHUB_TOKEN/GITHUB_DATA_REPO sont définis (voir telegramAuthStore.js), la
// session de chaque tenant est aussi sauvegardée dans le repo GitHub et
// restaurée au démarrage.
const SESSION_DIR_BASE = process.env.TELEGRAM_SESSION_DIR || path.join(__dirname, '..', 'telegram_sessions');

// Chemin de l'ancien fichier de session unique (avant l'isolation par
// tenant) — conservé pour que adapters/telegramManager.js puisse migrer une
// session historique déjà appairée vers le tenant admin plutôt que de la
// perdre silencieusement (voir migrateLegacyLocalAuth()).
const LEGACY_SESSION_PATH = process.env.TELEGRAM_SESSION_PATH || path.join(__dirname, '..', 'telegram_session.txt');

if (!process.env.TELEGRAM_SESSION_DIR && !githubStore.enabled) {
  console.warn(
    `TELEGRAM_SESSION_DIR non défini et sauvegarde GitHub désactivée : les sessions Telegram sont stockées sous "${SESSION_DIR_BASE}/<tenant>.txt" sur le disque local uniquement. ` +
    'Sur Render, ce dossier est effacé à chaque redéploiement/redémarrage sauf disque persistant ou GITHUB_TOKEN/GITHUB_DATA_REPO configurés.',
  );
}

function sessionPathFor(tenantId) {
  return path.join(SESSION_DIR_BASE, `${tenantId}.txt`);
}

const BASE_RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

/**
 * Adaptateur Telegram basé sur GramJS (protocole MTProto d'un compte
 * utilisateur réel), et non sur l'API Bot officielle — voir la justification
 * complète dans l'historique du projet : un bot Telegram ne peut pas lister
 * les groupes/canaux existants (aucun endpoint "mes groupes" côté Bot API).
 *
 * createSession(tenantId) retourne une instance totalement indépendante,
 * conservée par adapters/telegramManager.js tant que ce tenant reste actif.
 */
function createSession(tenantId) {
  const sessionPath = sessionPathFor(tenantId);
  const authStore = telegramAuthStore.createAuthStore(tenantId);

  let client = null;
  let connected = false;
  let codeResolver = null;
  let passwordResolver = null;
  let loginError = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let syncStarted = false;
  let consecutiveFailures = 0;
  // Écouteurs "message entrant" (voir onIncomingMessage plus bas) : le moteur
  // de campagne (queues/telegramCampaignEngine.js) s'y abonne pour mettre la
  // file d'attente en pause dès qu'un contact répond pendant l'envoi d'une
  // campagne.
  const incomingMessageListeners = [];
  // Incrémenté à chaque logout()/startLogin()/dispose() : les callbacks
  // asynchrones liés à un client remplacé ou libéré entre-temps (heartbeat en
  // vol, résolution tardive de client.start(), reconnexion planifiée) se
  // désactivent au lieu de muter `connected` avec un état périmé — même
  // principe que connectGeneration dans adapters/whatsapp.js.
  let sessionGeneration = 0;

  function isConfigured() {
    return Boolean(API_ID && API_HASH);
  }

  function isConnected() {
    return connected;
  }

  function onIncomingMessage(callback) {
    incomingMessageListeners.push(callback);
  }

  // Écouteurs "identité de compte réinitialisée" — adapters/telegramManager.js
  // s'y abonne pour réinitialiser (TelegramCampaignEngine#reset) le moteur de
  // campagne de ce tenant dès que le compte Telegram connecté change : une
  // campagne "running"/"paused" de l'ANCIEN compte n'a plus aucun sens et ne
  // doit JAMAIS verrouiller le lancement d'une campagne pour le NOUVEAU
  // compte connecté sous ce même tenant (même clé de licence). Déclenché par
  // logout() ET par startLogin() (qui remplace le client sans passer par
  // logout(), voir plus bas) — jamais par une simple reconnexion automatique
  // (attemptReconnect), qui garde le même compte et ne doit donc rien
  // réinitialiser.
  const accountResetListeners = [];

  function onAccountReset(callback) {
    accountResetListeners.push(callback);
  }

  function notifyAccountReset() {
    accountResetListeners.forEach((callback) => {
      try {
        callback();
      } catch (err) {
        console.error(`Erreur dans un écouteur de réinitialisation de compte Telegram (tenant "${tenantId}") :`, err.message);
      }
    });
  }

  // Enregistré une fois par instance de TelegramClient (init() et
  // startLogin() en créent chacun une nouvelle) : reste actif à travers les
  // reconnexions automatiques (attemptReconnect réutilise le même client),
  // puisque GramJS conserve les gestionnaires d'événements tant que le client
  // lui-même n'est pas recréé.
  function registerIncomingHandler() {
    client.addEventHandler((event) => {
      // event.message.out === true : message envoyé par CE compte (notre
      // propre campagne, ou une réponse manuelle de l'utilisateur) — seul un
      // message reçu d'un contact doit mettre la file d'attente en pause.
      if (event.message && !event.message.out) {
        incomingMessageListeners.forEach((callback) => {
          try {
            callback(event.message);
          } catch (err) {
            console.error(`Erreur dans un écouteur de message entrant Telegram (tenant "${tenantId}") :`, err.message);
          }
        });
      }
    }, new NewMessage({}));
  }

  function loadSessionString() {
    try {
      return fs.readFileSync(sessionPath, 'utf8').trim();
    } catch (err) {
      return '';
    }
  }

  function saveSessionString(value) {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, value, 'utf8');
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function stopReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // Backoff exponentiel (5s, 10s, 20s, ... plafonné à 5 min), même principe
  // que scheduleReconnect() dans adapters/whatsapp.js : protège contre un
  // martèlement des serveurs Telegram en cas d'échec persistant. Remis à
  // zéro dès qu'une reconnexion réussit.
  function scheduleReconnect() {
    if (reconnectTimer) return;
    const myGeneration = sessionGeneration;
    const delayMs = Math.min(BASE_RECONNECT_DELAY_MS * (2 ** consecutiveFailures), MAX_RECONNECT_DELAY_MS);
    consecutiveFailures += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attemptReconnect(myGeneration);
    }, delayMs);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  // Tentative de reconnexion silencieuse déclenchée soit par un échec de
  // heartbeat (session MTProto plus autorisée côté serveurs Telegram), soit
  // par une coupure réseau détectée par GramJS — sans jamais bloquer le
  // reste du système (queue de campagne, autres tenants) : voir le cahier des
  // charges sur le health-check en arrière-plan.
  async function attemptReconnect(myGeneration) {
    if (myGeneration !== sessionGeneration || !client) return;

    try {
      if (!client.connected) {
        await client.connect();
      }
      const authorized = await client.checkAuthorization();
      if (myGeneration !== sessionGeneration) return;

      if (authorized) {
        connected = true;
        consecutiveFailures = 0;
        console.log(`Telegram (tenant "${tenantId}"): reconnexion automatique réussie.`);
        startHeartbeat();
      } else {
        console.warn(`Telegram (tenant "${tenantId}"): session non autorisée après reconnexion — nouvelle connexion requise via /api/telegram/login/start.`);
      }
    } catch (err) {
      if (myGeneration !== sessionGeneration) return;
      console.warn(`Telegram (tenant "${tenantId}"): tentative de reconnexion échouée —`, err.message);
      scheduleReconnect();
    }
  }

  // Vérification de session légère et périodique : GramJS gère déjà la
  // reconnexion réseau bas niveau (connectionRetries), mais rien ne
  // confirme que la session MTProto reste réellement autorisée côté
  // serveurs Telegram sur la durée. getMe() est un appel minimal, sans
  // aucun effet de bord. Un échec déclenche maintenant une reconnexion
  // automatique (voir scheduleReconnect) au lieu de laisser la session
  // marquée "déconnectée" indéfiniment sans jamais la relancer.
  function startHeartbeat() {
    stopHeartbeat();
    const myGeneration = sessionGeneration;
    const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
    heartbeatTimer = setInterval(async () => {
      if (!client || myGeneration !== sessionGeneration) return;
      try {
        await client.getMe();
      } catch (err) {
        if (myGeneration !== sessionGeneration) return;
        console.warn(`Heartbeat Telegram (tenant "${tenantId}"): vérification de session échouée —`, err.message);
        connected = false;
        stopHeartbeat();
        scheduleReconnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Ne bloque jamais l'arrêt propre du process.
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  // À appeler une seule fois, au tout premier démarrage du processus, avant
  // init() — restaure la session depuis le repo GitHub dédié à ce tenant si
  // elle y est présente.
  async function restoreSessionFromRemote() {
    return authStore.restoreSessionFromRemote(sessionPath);
  }

  function getStorageStatus() {
    return authStore.getStatus();
  }

  // Déconnexion manuelle (bouton "Se déconnecter de Telegram" du dashboard) :
  // révoque la session côté serveurs Telegram (auth.LogOut, pour qu'un
  // fichier de session dérobé ne serve plus à rien), ferme le client, efface
  // le fichier de session local ET distant, puis repasse en attente — prêt
  // pour une nouvelle connexion (même numéro ou un autre) via
  // POST /api/telegram/login/start, sans redémarrage du serveur.
  async function logout() {
    // Voir onAccountReset ci-dessus : le prochain compte connecté sous ce
    // tenant peut être totalement différent — le moteur de campagne ne doit
    // jamais hériter d'un état "running"/"paused" de l'ancien.
    notifyAccountReset();

    sessionGeneration += 1;
    stopHeartbeat();
    stopReconnectTimer();

    if (client) {
      try {
        if (connected) {
          await client.invoke(new Api.auth.LogOut());
        }
      } catch (err) {
        console.warn(`Erreur lors du logout Telegram (tenant "${tenantId}", nettoyage local effectué quand même) :`, err.message);
      }
      try {
        await client.disconnect();
      } catch (err) {
        // ignore
      }
    }

    client = null;
    connected = false;
    codeResolver = null;
    passwordResolver = null;
    loginError = null;

    try {
      fs.unlinkSync(sessionPath);
    } catch (err) {
      // déjà absent
    }
    await authStore.clearRemote();
  }

  // Libération "douce" déclenchée par le régulateur de sessions (voir
  // adapters/sessionRegulator.js) quand ce tenant est inactif depuis plus de
  // 15 minutes, ou est le plus ancien sans campagne en cours, et qu'une
  // nouvelle session doit prendre sa place sous la limite fixée par
  // MAX_ACTIVE_SESSIONS. Contrairement à logout(), NE révoque PAS la session
  // côté Telegram et NE supprime PAS le fichier de session : le tenant reste
  // authentifié et se reconnectera automatiquement (sans redemander de code)
  // à sa prochaine requête, quand telegramManager rappellera
  // telegram.createSession() pour ce même tenantId.
  function dispose() {
    sessionGeneration += 1;
    stopHeartbeat();
    stopReconnectTimer();
    authStore.stopPeriodicSync();

    if (client) {
      client.disconnect().catch(() => {});
    }

    client = null;
    connected = false;
  }

  // À appeler au démarrage du serveur : restaure une session déjà autorisée
  // si le fichier de session existe, sans redemander de code.
  async function init() {
    if (!isConfigured()) {
      return;
    }

    const stringSession = new StringSession(loadSessionString());
    client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });
    registerIncomingHandler();
    await client.connect();
    connected = await client.checkAuthorization();

    if (!syncStarted) {
      syncStarted = true;
      authStore.startPeriodicSync(sessionPath);
    }

    if (connected) {
      console.log(`Telegram (tenant "${tenantId}"): session restaurée, connecté.`);
      startHeartbeat();
    } else {
      console.log(`Telegram (tenant "${tenantId}"): aucune session valide — connexion requise via POST /api/telegram/login/start.`);
    }
  }

  /**
   * Démarre le flux de connexion GramJS (numéro -> code SMS/app -> mot de
   * passe 2FA éventuel). `client.start()` est piloté par callbacks internes ;
   * ce pont les résout depuis submitCode()/submitPassword(), appelées par
   * les routes HTTP correspondantes. Les courtes pauses laissent le temps à
   * la machine d'état de GramJS d'avancer avant de renvoyer l'étape
   * suivante au frontend — volontairement simple (pas de WebSocket/SSE).
   */
  async function startLogin(phoneNumber) {
    if (!isConfigured()) {
      throw new Error('TELEGRAM_NOT_CONFIGURED');
    }

    // Voir onAccountReset ci-dessus : ce nouveau flux de connexion peut
    // aboutir sur un compte totalement différent de celui précédemment
    // connecté sous ce tenant (numéro de téléphone différent).
    notifyAccountReset();

    sessionGeneration += 1;
    const myGeneration = sessionGeneration;
    stopHeartbeat();
    stopReconnectTimer();

    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        // ignore
      }
    }

    const stringSession = new StringSession('');
    client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });
    registerIncomingHandler();
    await client.connect();

    codeResolver = null;
    passwordResolver = null;
    loginError = null;
    connected = false;

    client.start({
      phoneNumber: async () => phoneNumber,
      phoneCode: async () => new Promise((resolve) => { codeResolver = resolve; }),
      password: async () => new Promise((resolve) => { passwordResolver = resolve; }),
      onError: (err) => {
        loginError = err;
        console.error(`Telegram (tenant "${tenantId}"): erreur pendant la connexion:`, err);
      },
    }).then(() => {
      // Ce login a été remplacé entre-temps (nouvel appel startLogin(),
      // logout() ou dispose()) : ne pas ressusciter un état "connecté" périmé
      // sur le client actuellement actif.
      if (myGeneration !== sessionGeneration) return;
      saveSessionString(client.session.save());
      connected = true;
      consecutiveFailures = 0;
      startHeartbeat();
      if (!syncStarted) {
        syncStarted = true;
        authStore.startPeriodicSync(sessionPath);
      }
      // Poussé tout de suite plutôt que d'attendre le prochain instantané
      // périodique, pour ne pas devoir se reconnecter si le process redémarre
      // juste après une connexion réussie (même principe que creds.update
      // côté WhatsApp).
      authStore.pushSnapshot(sessionPath);
      console.log(`Telegram (tenant "${tenantId}"): connexion établie et session sauvegardée.`);
    }).catch((err) => {
      if (myGeneration !== sessionGeneration) return;
      loginError = err;
      console.error(`Telegram (tenant "${tenantId}"): échec de connexion:`, err);
    });

    await sleep(2000);
    return currentStep();
  }

  function currentStep() {
    if (connected) return 'connected';
    if (loginError) return 'error';
    if (passwordResolver) return 'password_required';
    if (codeResolver) return 'code_required';
    return 'pending';
  }

  async function submitCode(code) {
    if (!codeResolver) {
      throw new Error('NO_PENDING_CODE_REQUEST');
    }
    codeResolver(code);
    codeResolver = null;
    await sleep(2000);
    return currentStep();
  }

  async function submitPassword(password) {
    if (!passwordResolver) {
      throw new Error('NO_PENDING_PASSWORD_REQUEST');
    }
    passwordResolver(password);
    passwordResolver = null;
    await sleep(2000);
    return currentStep();
  }

  function getLoginError() {
    return loginError ? (loginError.message || String(loginError)) : null;
  }

  async function getGroups() {
    if (!connected) {
      throw new Error('TELEGRAM_NOT_CONNECTED');
    }

    const dialogs = await client.getDialogs({ limit: 200 });

    return dialogs
      .filter((d) => d.isGroup || d.isChannel)
      .map((d) => ({
        id: d.id ? d.id.toString() : null,
        name: d.title || d.name || 'Sans nom',
        isChannel: Boolean(d.isChannel),
        unreadCount: d.unreadCount || 0,
      }))
      .filter((g) => g.id);
  }

  /**
   * Résout un identifiant fourni par l'utilisateur (username "@untel" ou
   * numéro de téléphone) vers une entité Telegram utilisable par
   * sendMessage/sendFile. Un username se résout directement via getEntity.
   * Un numéro nécessite de passer par contacts.importContacts (l'API
   * MTProto n'autorise pas la recherche libre d'un numéro par respect de la
   * vie privée) — cette étape ajoute aussi le contact au carnet du compte
   * connecté, ce qui est le comportement attendu pour une "liste de
   * diffusion" de contacts qu'on gère. Si Telegram ne peut pas relier ce
   * numéro à un compte (non inscrit, ou visibilité restreinte par ses
   * paramètres de confidentialité), la résolution échoue proprement.
   */
  async function resolveRecipient(identifier) {
    if (!connected) {
      throw new Error('TELEGRAM_NOT_CONNECTED');
    }

    const value = String(identifier || '').trim();
    if (!value) {
      throw new Error('EMPTY_RECIPIENT');
    }

    const looksLikeUsername = value.startsWith('@') || /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value);

    if (looksLikeUsername) {
      const username = value.startsWith('@') ? value : `@${value}`;
      try {
        return await client.getEntity(username);
      } catch (err) {
        throw new Error('RECIPIENT_NOT_FOUND');
      }
    }

    const digits = value.replace(/[^\d+]/g, '');
    if (!digits.replace('+', '')) {
      throw new Error('INVALID_RECIPIENT');
    }
    const phone = digits.startsWith('+') ? digits : `+${digits}`;

    try {
      const result = await client.invoke(new Api.contacts.ImportContacts({
        contacts: [new Api.InputPhoneContact({
          clientId: Math.floor(Math.random() * 1_000_000_000),
          phone,
          firstName: 'Contact',
          lastName: '',
        })],
      }));

      if (!result.users || result.users.length === 0) {
        throw new Error('RECIPIENT_NOT_FOUND');
      }
      return result.users[0];
    } catch (err) {
      if (err.message === 'RECIPIENT_NOT_FOUND') throw err;
      throw new Error('RECIPIENT_NOT_FOUND');
    }
  }

  async function sendMessage(chatId, text) {
    if (!connected) {
      throw new Error('TELEGRAM_NOT_CONNECTED');
    }
    return client.sendMessage(chatId, { message: text });
  }

  async function sendMedia(chatId, { buffer, filename, caption }) {
    if (!connected) {
      throw new Error('TELEGRAM_NOT_CONNECTED');
    }
    const file = new CustomFile(filename || 'fichier', buffer.length, '', buffer);
    return client.sendFile(chatId, { file, caption });
  }

  /**
   * Envoi en masse avec régulateur de débit : délai (fixe ou 10-15s
   * aléatoire par défaut) entre chaque envoi, et pause de sécurité triplée
   * toutes les `batchSize` messages pour rester sous les limites anti-flood
   * de Telegram. Un échec individuel "métier" (destinataire invalide,
   * contenu refusé...) est journalisé et marqué "failed" dans les résultats :
   * la file continue automatiquement vers le destinataire suivant plutôt que
   * de s'arrêter. Un signal de surcharge (429, FloodWaitError...) est traité
   * différemment (voir lib/circuitBreaker.js) : la file se met en pause pour
   * la durée EXACTE exigée par Telegram (FLOOD_WAIT_X) avant de RETENTER ce
   * même destinataire, plutôt que de le compter comme un échec.
   */
  async function sendBulk(chatIds, message, options = {}) {
    const { delaySeconds, batchSize, batchPauseSeconds, media, onProgress } = options;
    const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : chatIds.length;
    const results = [];
    const networkHealth = new circuitBreaker.CircuitBreakerState();

    for (let i = 0; i < chatIds.length; i += 1) {
      const chatId = chatIds[i];
      let status = 'failed';
      // Résolu à chaque destinataire (voir lib/spintax.js) : deux
      // destinataires reçoivent alors rarement le texte identique mot pour
      // mot, même à partir du même modèle.
      const personalizedMessage = resolveSpintax(message);

      // Boucle de retentative bornée aux seuls signaux de surcharge : un
      // échec "métier" (destinataire invalide, contenu refusé...) sort tout
      // de suite (break) et passe au destinataire suivant normalement.
      for (;;) {
        if (networkHealth.isHeld()) {
          await sleep(Math.max(0, networkHealth.holdUntil - Date.now()));
          networkHealth.networkStatus = 'normal';
        }
        try {
          if (media) {
            await sendMedia(chatId, { ...media, caption: personalizedMessage });
          } else {
            await sendMessage(chatId, personalizedMessage);
          }
          status = 'delivered';
          networkHealth.recordSuccess();
          break;
        } catch (err) {
          if (circuitBreaker.isOverloadError(err)) {
            const backoffMs = networkHealth.recordOverloadFailure(err);
            console.log(
              `Telegram (tenant "${tenantId}"): signal de surcharge détecté (${err.message}) — ` +
              `nouvelle tentative pour ${chatId} dans ${Math.round(backoffMs / 1000)}s.`,
            );
            continue;
          }
          console.error(`Telegram (tenant "${tenantId}"): échec de l'envoi à ${chatId}:`, err.message || err);
          break;
        }
      }

      results.push({ to: String(chatId), status, timestamp: new Date().toISOString() });

      if (typeof onProgress === 'function') {
        onProgress({ sent: results.length, total: chatIds.length, status });
      }

      if (i < chatIds.length - 1) {
        // Délai fixe et configurable (standard, sans randomisation) : à
        // défaut de valeur fournie, 12s reste une valeur raisonnable pour un
        // usage normal de l'API Telegram.
        const baseDelayMs = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds * 1000 : 12_000;
        const endOfBatch = (i + 1) % batch === 0;
        // batchPauseSeconds : pause après un lot, configurable indépendamment
        // du délai par message — à défaut, 3x le délai par message.
        const batchPauseMs = Number.isFinite(batchPauseSeconds) && batchPauseSeconds > 0
          ? batchPauseSeconds * 1000
          : baseDelayMs * 3;
        await sleep(endOfBatch ? batchPauseMs : baseDelayMs);
      }
    }

    return results;
  }

  return {
    tenantId,
    isConfigured,
    isConnected,
    onIncomingMessage,
    onAccountReset,
    restoreSessionFromRemote,
    getStorageStatus,
    logout,
    dispose,
    init,
    startLogin,
    submitCode,
    submitPassword,
    getLoginError,
    getGroups,
    resolveRecipient,
    sendMessage,
    sendMedia,
    sendBulk,
  };
}

module.exports = {
  createSession,
  sessionPathFor,
  SESSION_DIR_BASE,
  LEGACY_SESSION_PATH,
};
