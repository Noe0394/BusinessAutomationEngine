const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const telegramAuthStore = require('./telegramAuthStore');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// Comme pour auth_info_baileys/, ce fichier vit sur le disque local : sans
// disque persistant Render monté sur ce chemin, la session Telegram est
// reperdue à chaque redéploiement et il faut se reconnecter (numéro + code) —
// sauf si GITHUB_TOKEN/GITHUB_DATA_REPO sont définis (voir telegramAuthStore.js),
// auquel cas elle est aussi sauvegardée dans le repo GitHub dédié et restaurée
// au démarrage (voir restoreSessionFromRemote, appelée une fois par index.js
// avant le premier init()), sur le même principe que la session WhatsApp.
const SESSION_PATH = process.env.TELEGRAM_SESSION_PATH || path.join(__dirname, '..', 'telegram_session.txt');

if (!process.env.TELEGRAM_SESSION_PATH && !telegramAuthStore.enabled) {
  console.warn(
    `TELEGRAM_SESSION_PATH non défini et sauvegarde GitHub désactivée : la session Telegram est stockée dans "${SESSION_PATH}" sur le disque local uniquement. ` +
    'Sur Render, ce fichier est effacé à chaque redéploiement/redémarrage sauf disque persistant ou GITHUB_TOKEN/GITHUB_DATA_REPO configurés.',
  );
}

/**
 * Adaptateur Telegram basé sur GramJS (protocole MTProto d'un compte
 * utilisateur réel), et non sur l'API Bot officielle. C'est un choix
 * déliberé : un bot Telegram (node-telegram-bot-api) ne peut PAS lister les
 * groupes/canaux existants (aucun endpoint "mes groupes" côté Bot API — un
 * bot ne connaît que les chats où il a déjà reçu un message). Pour
 * reproduire la fonctionnalité "lister mes groupes" demandée, il faut donc
 * se connecter comme un vrai compte via MTProto, à l'image de l'adaptateur
 * WhatsApp/Baileys. Contrairement à Facebook, Telegram documente et
 * supporte officiellement ce type de client (my.telegram.org).
 *
 * Nécessite TELEGRAM_API_ID et TELEGRAM_API_HASH (obtenus sur
 * https://my.telegram.org/apps).
 */
class TelegramAdapter {
  constructor() {
    this.apiId = parseInt(process.env.TELEGRAM_API_ID, 10) || null;
    this.apiHash = process.env.TELEGRAM_API_HASH || null;
    this.client = null;
    this.connected = false;
    this._codeResolver = null;
    this._passwordResolver = null;
    this._loginError = null;
    this._heartbeatTimer = null;
    this._syncStarted = false;

    if (!this.apiId || !this.apiHash) {
      console.warn(
        'TELEGRAM_API_ID / TELEGRAM_API_HASH non définis : le module Telegram est inactif ' +
        '(les routes /api/telegram/* renverront une erreur 503).',
      );
    }
  }

  isConfigured() {
    return Boolean(this.apiId && this.apiHash);
  }

  isConnected() {
    return this.connected;
  }

  // Vérification de session légère et périodique : GramJS gère déjà la
  // reconnexion réseau bas niveau (connectionRetries), mais rien ne
  // confirme que la session MTProto reste réellement autorisée côté
  // serveurs Telegram sur la durée. getMe() est un appel minimal, sans
  // aucun effet de bord.
  startHeartbeat() {
    this.stopHeartbeat();
    const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
    this._heartbeatTimer = setInterval(async () => {
      if (!this.client) return;
      try {
        await this.client.getMe();
      } catch (err) {
        console.warn('Heartbeat Telegram: vérification de session échouée —', err.message);
        this.connected = false;
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Ne bloque jamais l'arrêt propre du process.
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  loadSessionString() {
    try {
      return fs.readFileSync(SESSION_PATH, 'utf8').trim();
    } catch (err) {
      return '';
    }
  }

  saveSessionString(value) {
    fs.writeFileSync(SESSION_PATH, value, 'utf8');
  }

  // À appeler une seule fois, au tout premier démarrage du processus, avant
  // init() — restaure la session Telegram depuis le repo GitHub dédié si
  // elle y est présente (voir telegramAuthStore.js), sur le même principe
  // que whatsapp.restoreSessionFromRemote().
  async restoreSessionFromRemote() {
    return telegramAuthStore.restoreSessionFromRemote(SESSION_PATH);
  }

  getStorageStatus() {
    return telegramAuthStore.getStatus();
  }

  // Déconnexion manuelle (bouton "Se déconnecter de Telegram" du dashboard) :
  // révoque la session côté serveurs Telegram (auth.LogOut, pour qu'un fichier
  // de session dérobé ne serve plus à rien), ferme le client, efface le
  // fichier de session local ET distant, puis repasse en attente — prêt pour
  // une nouvelle connexion (même numéro ou un autre) via
  // POST /api/telegram/login/start, sans redémarrage du serveur.
  async logout() {
    this.stopHeartbeat();

    if (this.client) {
      try {
        if (this.connected) {
          await this.client.invoke(new Api.auth.LogOut());
        }
      } catch (err) {
        console.warn('Erreur lors du logout Telegram (nettoyage local effectué quand même) :', err.message);
      }
      try {
        await this.client.disconnect();
      } catch (err) {
        // ignore
      }
    }

    this.client = null;
    this.connected = false;
    this._codeResolver = null;
    this._passwordResolver = null;
    this._loginError = null;

    try {
      fs.unlinkSync(SESSION_PATH);
    } catch (err) {
      // déjà absent
    }
    await telegramAuthStore.clearRemote();
  }

  // À appeler au démarrage du serveur : restaure une session déjà autorisée
  // si le fichier de session existe, sans redemander de code.
  async init() {
    if (!this.isConfigured()) {
      return;
    }

    const stringSession = new StringSession(this.loadSessionString());
    this.client = new TelegramClient(stringSession, this.apiId, this.apiHash, { connectionRetries: 5 });
    await this.client.connect();
    this.connected = await this.client.checkAuthorization();

    if (!this._syncStarted) {
      this._syncStarted = true;
      telegramAuthStore.startPeriodicSync(SESSION_PATH);
    }

    if (this.connected) {
      console.log('Telegram: session restaurée, connecté.');
      this.startHeartbeat();
    } else {
      console.log('Telegram: aucune session valide — connexion requise via POST /api/telegram/login/start.');
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
  async startLogin(phoneNumber) {
    if (!this.isConfigured()) {
      throw new Error('TELEGRAM_NOT_CONFIGURED');
    }

    this.stopHeartbeat();

    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (err) {
        // ignore
      }
    }

    const stringSession = new StringSession('');
    this.client = new TelegramClient(stringSession, this.apiId, this.apiHash, { connectionRetries: 5 });
    await this.client.connect();

    this._codeResolver = null;
    this._passwordResolver = null;
    this._loginError = null;
    this.connected = false;

    this.client.start({
      phoneNumber: async () => phoneNumber,
      phoneCode: async () => new Promise((resolve) => { this._codeResolver = resolve; }),
      password: async () => new Promise((resolve) => { this._passwordResolver = resolve; }),
      onError: (err) => {
        this._loginError = err;
        console.error('Telegram: erreur pendant la connexion:', err);
      },
    }).then(() => {
      this.saveSessionString(this.client.session.save());
      this.connected = true;
      this.startHeartbeat();
      if (!this._syncStarted) {
        this._syncStarted = true;
        telegramAuthStore.startPeriodicSync(SESSION_PATH);
      }
      // Poussé tout de suite plutôt que d'attendre le prochain instantané
      // périodique, pour ne pas devoir se reconnecter si le process redémarre
      // juste après une connexion réussie (même principe que creds.update
      // côté WhatsApp).
      telegramAuthStore.pushSnapshot(SESSION_PATH);
      console.log('Telegram: connexion établie et session sauvegardée.');
    }).catch((err) => {
      this._loginError = err;
      console.error('Telegram: échec de connexion:', err);
    });

    await sleep(2000);
    return this._currentStep();
  }

  _currentStep() {
    if (this.connected) return 'connected';
    if (this._loginError) return 'error';
    if (this._passwordResolver) return 'password_required';
    if (this._codeResolver) return 'code_required';
    return 'pending';
  }

  async submitCode(code) {
    if (!this._codeResolver) {
      throw new Error('NO_PENDING_CODE_REQUEST');
    }
    this._codeResolver(code);
    this._codeResolver = null;
    await sleep(2000);
    return this._currentStep();
  }

  async submitPassword(password) {
    if (!this._passwordResolver) {
      throw new Error('NO_PENDING_PASSWORD_REQUEST');
    }
    this._passwordResolver(password);
    this._passwordResolver = null;
    await sleep(2000);
    return this._currentStep();
  }

  getLoginError() {
    return this._loginError ? (this._loginError.message || String(this._loginError)) : null;
  }

  async getGroups() {
    if (!this.connected) {
      throw new Error('TELEGRAM_NOT_CONNECTED');
    }

    const dialogs = await this.client.getDialogs({ limit: 200 });

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
  async resolveRecipient(identifier) {
    if (!this.connected) {
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
        return await this.client.getEntity(username);
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
      const result = await this.client.invoke(new Api.contacts.ImportContacts({
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

  async sendMessage(chatId, text) {
    if (!this.connected) {
      throw new Error('TELEGRAM_NOT_CONNECTED');
    }
    return this.client.sendMessage(chatId, { message: text });
  }

  async sendMedia(chatId, { buffer, filename, caption }) {
    if (!this.connected) {
      throw new Error('TELEGRAM_NOT_CONNECTED');
    }
    const file = new CustomFile(filename || 'fichier', buffer.length, '', buffer);
    return this.client.sendFile(chatId, { file, caption });
  }

  /**
   * Envoi en masse avec régulateur de débit : délai (fixe ou 10-15s
   * aléatoire par défaut) entre chaque envoi, et pause de sécurité triplée
   * toutes les `batchSize` messages pour rester sous les limites anti-flood
   * de Telegram.
   */
  async sendBulk(chatIds, message, options = {}) {
    const { delaySeconds, batchSize, media, onProgress } = options;
    const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : chatIds.length;
    const results = [];

    for (let i = 0; i < chatIds.length; i += 1) {
      const chatId = chatIds[i];
      let status = 'failed';

      try {
        if (media) {
          await this.sendMedia(chatId, { ...media, caption: message });
        } else {
          await this.sendMessage(chatId, message);
        }
        status = 'delivered';
      } catch (err) {
        console.error(`Telegram: échec de l'envoi à ${chatId}:`, err.message || err);
      }

      results.push({ to: String(chatId), status, timestamp: new Date().toISOString() });

      if (typeof onProgress === 'function') {
        onProgress({ sent: results.length, total: chatIds.length, status });
      }

      if (i < chatIds.length - 1) {
        const baseDelayMs = delaySeconds ? delaySeconds * 1000 : randomDelay(10000, 15000);
        const endOfBatch = (i + 1) % batch === 0;
        const delayMs = endOfBatch ? baseDelayMs * 3 : baseDelayMs;
        await sleep(delayMs);
      }
    }

    return results;
  }
}

module.exports = TelegramAdapter;
