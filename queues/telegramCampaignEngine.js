const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');
const { personalizeMessage, buildPersonalizationVars } = require('../lib/personalization');
const circuitBreaker = require('../lib/circuitBreaker');
const messageHistory = require('../lib/messageHistory');

// Normalise un destinataire Telegram pour l'envoi : un identifiant ("username
// Telegram, numéro, ou identifiant de groupe/canal déjà résolu — voir
// recipientType ci-dessous) et le jeu complet de variables dynamiques
// ("vars", voir lib/personalization.js#buildPersonalizationVars), construit à
// partir du nom éventuellement associé lors de l'import Excel/CSV (voir
// /api/telegram/contacts/import) — vide si absent ou si le profil Telegram
// est masqué, auquel cas personalizeMessage retombe proprement sur des
// variables vides. Accepte soit un identifiant simple (chaîne — ancien
// format, ou identifiant de groupe), soit un contact enrichi
// { identifier, name }.
function normalizeTelegramRecipient(recipient) {
  if (recipient && typeof recipient === 'object') {
    const identifier = String(recipient.identifier ?? recipient.username ?? recipient.telephone ?? recipient.to ?? '').trim();
    const name = String(recipient.name ?? recipient.prenom ?? recipient.nom ?? '').trim();
    return { identifier, vars: buildPersonalizationVars(name, identifier) };
  }
  const identifier = String(recipient ?? '').trim();
  return { identifier, vars: buildPersonalizationVars('', identifier) };
}

// Persistance de la progression d'une campagne Telegram (messages directs
// vers une liste de contacts importée), tenant par tenant — même principe
// que queues/campaignEngine.js côté WhatsApp : sur un environnement
// Docker/Render où le conteneur est éphémère, un redéploiement/crash ne doit
// ni perdre la progression déjà envoyée, ni renvoyer les messages déjà
// livrés au redémarrage. Répertoires distincts de ceux de WhatsApp
// (TELEGRAM_CAMPAIGNS_DIR plutôt que CAMPAIGNS_DIR) pour rester indépendants
// plutôt que de coupler les deux canaux via un module partagé.
const CAMPAIGNS_DIR = process.env.TELEGRAM_CAMPAIGNS_DIR || path.join(__dirname, '..', 'telegram_campaigns_state');
const MEDIA_DIR = path.join(CAMPAIGNS_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const REMOTE_CAMPAIGNS_DIR = process.env.GITHUB_TELEGRAM_CAMPAIGNS_DIR || 'telegram_campaigns_state';
const MEDIA_REMOTE_DIR = `${REMOTE_CAMPAIGNS_DIR}/media`;

if (!process.env.TELEGRAM_CAMPAIGNS_DIR && !githubStore.enabled) {
  console.warn(
    `TELEGRAM_CAMPAIGNS_DIR non défini et sauvegarde GitHub désactivée : la progression des campagnes Telegram est stockée dans "${CAMPAIGNS_DIR}" sur le disque local uniquement. ` +
    'Sur Render/Docker, ce dossier est effacé à chaque redéploiement/redémarrage sauf disque persistant ou GITHUB_TOKEN/GITHUB_DATA_REPO configurés.',
  );
}

function statePath(tenantId) {
  return path.join(CAMPAIGNS_DIR, `${tenantId}.json`);
}

function remoteFilePath(tenantId) {
  return `${REMOTE_CAMPAIGNS_DIR}/${tenantId}.json`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// Fenêtre de délai imposée entre deux envois individuels — non contournable
// depuis le frontend, qui ne peut que choisir un délai fixe ou aléatoire à
// l'intérieur de cette fenêtre (recommandation explicite de l'utilisateur
// pour rester dans un usage raisonnable de l'API Telegram).
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60_000;

function clampDelayMs(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, MIN_DELAY_MS), MAX_DELAY_MS);
}

// Durée de la pause appliquée à la file d'attente dès qu'un contact répond
// pendant l'envoi d'une campagne — même principe que
// queues/campaignEngine.js#INCOMING_REPLY_PAUSE_MS côté WhatsApp.
const INCOMING_REPLY_PAUSE_MS = 30_000;

// Pause courte, fixe, entre l'envoi du média et celui du texte associé (voir
// _run ci-dessous) : évite d'agréger les deux dans le même appel API, sans
// viser une quelconque variation aléatoire.
const MEDIA_TEXT_SEQUENCE_PAUSE_MS = 3_000;

// Voir queues/campaignEngine.js#HEARTBEAT_INTERVAL_MS/DEFAULT_STALE_MS (même
// principe et mêmes valeurs par défaut, dupliqué plutôt que partagé pour
// rester indépendant du côté WhatsApp).
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_MS = (parseFloat(process.env.CAMPAIGN_STALE_HOURS) || 48) * 3_600_000;

// Une campagne DM Telegram ne porte au plus qu'UNE pièce jointe (contrairement
// à la séquence WhatsApp) : persistée une seule fois au lancement, sur le
// même principe que persistSequenceMedia dans queues/campaignEngine.js
// (disque local + blob GitHub pour survivre à un redéploiement).
async function persistMedia(tenantId, media) {
  if (!media) return null;

  const mediaFile = `${tenantId}.bin`;
  fs.writeFileSync(path.join(MEDIA_DIR, mediaFile), media.buffer);

  let mediaBlobSha = null;
  if (githubStore.enabled) {
    try {
      mediaBlobSha = await githubStore.pushLargeFile(`${MEDIA_REMOTE_DIR}/${mediaFile}`, media.buffer);
    } catch (err) {
      console.error(`Échec de la sauvegarde GitHub de la pièce jointe Telegram "${mediaFile}" :`, err.message);
    }
  }

  return { mediaFile, mediaBlobSha, mimetype: media.mimetype, filename: media.filename };
}

async function resolveMedia(persisted) {
  if (!persisted) return null;

  const filePath = path.join(MEDIA_DIR, persisted.mediaFile);
  let buffer;
  if (fs.existsSync(filePath)) {
    buffer = fs.readFileSync(filePath);
  } else if (persisted.mediaBlobSha && githubStore.enabled) {
    try {
      buffer = await githubStore.fetchLargeFile(persisted.mediaBlobSha);
    } catch (err) {
      throw new Error(`MEDIA_FILE_MISSING: ${persisted.mediaFile} (échec de restauration GitHub : ${err.message})`);
    }
    if (!buffer) {
      throw new Error(`MEDIA_FILE_MISSING: ${persisted.mediaFile} (introuvable sur GitHub)`);
    }
    fs.writeFileSync(filePath, buffer);
    console.log(`Pièce jointe Telegram "${persisted.mediaFile}" restaurée depuis GitHub (disque local vidé par un redéploiement).`);
  } else {
    throw new Error(`MEDIA_FILE_MISSING: ${persisted.mediaFile}`);
  }

  return { buffer, mimetype: persisted.mimetype, filename: persisted.filename };
}

function removeMedia(persisted) {
  if (persisted && persisted.mediaFile) {
    fs.rmSync(path.join(MEDIA_DIR, persisted.mediaFile), { force: true });
  }
}

// Empreinte du MODÈLE de message (avant personnalisation par destinataire),
// pour l'anti-doublons — voir queues/campaignEngine.js#sequenceHashParts
// (même principe, adapté au message unique + média unique de Telegram).
function messageHashParts(message, persistedMedia) {
  const parts = [`text:${message || ''}`];
  if (persistedMedia) parts.push(`media:${persistedMedia.filename || ''}:${persistedMedia.mimetype || ''}`);
  return parts;
}

// Un moteur par tenant (voir adapters/telegramManager.js), lié à l'instance
// Telegram de ce même tenant : aucune campagne, aucun destinataire, aucun
// résultat n'est jamais partagé entre deux clés de licence.
class TelegramCampaignEngine {
  // onActivity : voir adapters/sessionRegulator.js — repousse l'échéance
  // d'inactivité du tenant à chaque envoi réel pendant que la campagne tourne
  // en tâche de fond.
  constructor(tenantId, session, onActivity) {
    this.tenantId = tenantId;
    this.session = session;
    this.onActivity = onActivity;
    this.campaign = null;
    this.persistedMedia = null;
    this.resolvedMedia = null;
    this.remoteStore = githubStore.createStore(remoteFilePath(tenantId));
    // Voir queues/campaignEngine.js#incomingPauseUntil (même principe,
    // propriété de l'instance plutôt que de campaign : pas besoin de
    // survivre à un redémarrage).
    this.incomingPauseUntil = 0;
    if (typeof session.onIncomingMessage === 'function') {
      session.onIncomingMessage(() => this._pauseForIncomingReply());
    }
    // Voir lib/circuitBreaker.js — même principe que côté WhatsApp
    // (queues/campaignEngine.js#networkHealth) : signal de santé réseau
    // "live", non persisté.
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    // Voir queues/campaignEngine.js#_lastHeartbeatAt/_runActive (même
    // principe côté WhatsApp).
    this._lastHeartbeatAt = 0;
    this._runActive = false;
    // Voir queues/campaignEngine.js#_historyEntries/_messageHash (même
    // principe : historique anti-doublons, chargé une fois par
    // start()/premier envoi après reprise).
    this._historyEntries = null;
    this._messageHash = null;
  }

  // Voir queues/campaignEngine.js#_heartbeat (même principe).
  _heartbeat() {
    const now = Date.now();
    if (now - this._lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    this._lastHeartbeatAt = now;
    this._persist();
  }

  // Voir queues/campaignEngine.js#_pauseForIncomingReply (même principe).
  _pauseForIncomingReply() {
    if (!this.campaign || this.campaign.status !== 'running') return;
    const until = Date.now() + INCOMING_REPLY_PAUSE_MS;
    if (until > this.incomingPauseUntil) {
      this.incomingPauseUntil = until;
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): réponse entrante détectée — pause de ${INCOMING_REPLY_PAUSE_MS / 1000}s avant de reprendre l'envoi.`);
    }
  }

  // Voir queues/campaignEngine.js#_recordSendLatency (même principe).
  _recordSendLatency(elapsedMs) {
    if (this.networkHealth.recordLatency(elapsedMs)) {
      console.log(
        `Campagne Telegram (tenant "${this.tenantId}"): latence élevée (${elapsedMs}ms) sur 2 requêtes consécutives — ` +
        `statut 'degraded_network', pause de ${circuitBreaker.DEGRADED_NETWORK_PAUSE_MS / 60000} min.`,
      );
    }
  }

  // Voir queues/campaignEngine.js#_buildInitialResults (même principe,
  // adapté à normalizeTelegramRecipient).
  _buildInitialResults(recipients, windowMs, historyEntries, messageHash) {
    const now = Date.now();
    const historySeen = new Set();
    for (const entry of historyEntries) {
      if (!entry || entry.messageHash !== messageHash) continue;
      const age = now - new Date(entry.sentAt).getTime();
      if (age < windowMs) historySeen.add(entry.contactKey);
    }

    const seenInThisCampaign = new Set();
    return recipients.map((recipient) => {
      const { identifier } = normalizeTelegramRecipient(recipient);
      const key = messageHistory.normalizeContactKey(identifier);
      const isDuplicate = Boolean(key) && (historySeen.has(key) || seenInThisCampaign.has(key));
      if (key) seenInThisCampaign.add(key);
      return { to: String(identifier), status: isDuplicate ? 'skipped_duplicate' : 'pending', timestamp: null };
    });
  }

  // Voir queues/campaignEngine.js#_migrateResults (même principe).
  _migrateResults(results, recipients) {
    const list = Array.isArray(results) ? results.slice() : [];
    for (let i = list.length; i < recipients.length; i += 1) {
      const { identifier } = normalizeTelegramRecipient(recipients[i]);
      list.push({ to: String(identifier), status: 'pending', timestamp: null });
    }
    return list.map((r) => {
      if (r.status === 'delivered') return { ...r, status: 'sent' };
      if (r.status === 'interrupted') return { ...r, status: 'pending' };
      return r;
    });
  }

  // Voir queues/campaignEngine.js#_recordHistorySent (même principe).
  async _recordHistorySent(contactKey) {
    if (!contactKey) return;
    if (!this._historyEntries) {
      this._historyEntries = await messageHistory.loadHistory('telegram', this.tenantId);
    }
    this._historyEntries.push({ contactKey, messageHash: this._messageHash, sentAt: new Date().toISOString() });
    this._historyEntries = messageHistory.saveHistory('telegram', this.tenantId, this._historyEntries);
  }

  // Voir queues/campaignEngine.js#_waitForNetworkHold (même principe).
  async _waitForNetworkHold() {
    const campaign = this.campaign;
    const health = this.networkHealth;
    if (!health.isHeld()) return;

    campaign.paused = true;
    this._persist();
    console.log(
      `Campagne Telegram (tenant "${this.tenantId}"): file en pause — statut réseau '${health.networkStatus}', ` +
      `reprise prévue vers ${new Date(health.holdUntil).toISOString()}.`,
    );

    while (!campaign.stopRequested && !campaign.superseded && health.isHeld()) {
      this._heartbeat();
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    while (!campaign.stopRequested && !campaign.superseded && !this.session.isConnected()) {
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): health check négatif — nouvelle vérification dans 30s avant reprise.`);
      this._heartbeat();
      await sleep(circuitBreaker.HEALTH_RECHECK_INTERVAL_MS);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    const wasCircuitOpen = health.networkStatus === 'circuit_open';
    health.networkStatus = 'normal';
    campaign.paused = false;
    this._persist();
    console.log(
      `Campagne Telegram (tenant "${this.tenantId}"): health check nominal — reprise de l'envoi` +
      `${wasCircuitOpen ? ' au destinataire précédemment en échec de surcharge' : ''}.`,
    );
  }

  _buildRecord() {
    const c = this.campaign;
    return {
      tenantId: this.tenantId,
      status: c.status,
      paused: c.paused,
      userPaused: c.userPaused,
      stopRequested: c.stopRequested,
      total: c.total,
      sent: c.sent,
      success: c.success,
      failed: c.failed,
      // Voir queues/campaignEngine.js#skippedDuplicates/messageHash (même
      // principe côté WhatsApp).
      skippedDuplicates: c.skippedDuplicates,
      messageHash: c.messageHash,
      duplicateWindowHours: c.duplicateWindowHours,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      // Voir queues/campaignEngine.js#lastProgressAt (même principe et même
      // usage par purgeStaleCampaigns()).
      lastProgressAt: c.lastProgressAt,
      cancelReason: c.cancelReason || null,
      nextIndex: c.nextIndex,
      recipients: c.recipients,
      recipientType: c.recipientType,
      message: c.message,
      results: c.results,
      delaySeconds: c.delaySeconds,
      minDelayMs: c.minDelayMs,
      maxDelayMs: c.maxDelayMs,
      batchSize: c.batchSize,
      batchPauseSeconds: c.batchPauseSeconds,
      // Voir lib/circuitBreaker.js#toJSON : persisté pour qu'une pause de
      // sécurité ('degraded_network'/'circuit_open') survive à un
      // redéploiement plutôt que d'être silencieusement oubliée.
      networkHealth: this.networkHealth.toJSON(),
      media: this.persistedMedia,
    };
  }

  _persist() {
    if (!this.campaign) return;
    this.campaign.lastProgressAt = new Date().toISOString();
    const content = JSON.stringify(this._buildRecord(), null, 2);
    // Écriture locale synchrone volontaire, comme queues/campaignEngine.js :
    // volume négligeable (une campagne à la fois par tenant).
    fs.writeFileSync(statePath(this.tenantId), content, 'utf8');
    // Sauvegarde GitHub en fire-and-forget : jamais bloquant pour la boucle
    // d'envoi.
    this.remoteStore.pushRemote(content).catch((err) => {
      console.error(`Échec de la sauvegarde de la campagne Telegram sur GitHub pour le tenant "${this.tenantId}" :`, err.message);
    });
  }

  getStatus() {
    if (!this.campaign) return null;
    const {
      total, sent, success, failed, skippedDuplicates, duplicateWindowHours, recipientType,
      status, paused, userPaused, stopRequested, startedAt, finishedAt, results, resumeError, cancelReason,
    } = this.campaign;
    const base = {
      total, sent, success, failed, skippedDuplicates, duplicateWindowHours,
      // Un seul moteur/verrou de campagne par tenant sert à la fois les
      // messages directs (contacts importés) et la diffusion vers des
      // groupes/canaux (voir index.js#/api/telegram/queue) : exposé pour que
      // le dashboard n'affiche/ne pilote jamais depuis le mauvais onglet la
      // campagne réellement en cours.
      recipientType: recipientType || 'contacts',
      status, paused, userPaused, stopRequested, startedAt, finishedAt, results,
      networkStatus: this.networkHealth.networkStatus,
      retryAfterSeconds: this.networkHealth.getRetryAfterSeconds(),
    };
    if (resumeError) base.resumeError = resumeError;
    if (cancelReason) base.cancelReason = cancelReason;
    return base;
  }

  // Relance Manuelle Express (voir queues/campaignEngine.js#getManualRelaunchQueue
  // pour l'équivalent WhatsApp, même principe) : liste des destinataires
  // encore 'pending' ou 'failed' de la dernière campagne DIRECTE (contacts,
  // pas groupes/canaux — un deep link t.me/wa.me n'a de sens que pour un
  // contact individuel) connue de ce tenant. this.campaign n'est remis à
  // null que par reset(), jamais à la simple fin d'une campagne, donc ce
  // rapport reste consultable après un Stop ou une complétion.
  getManualRelaunchQueue() {
    if (!this.campaign || this.campaign.recipientType !== 'contacts') return [];
    const template = this.campaign.message || '';
    const items = [];
    this.campaign.results.forEach((result, index) => {
      if (result.status !== 'pending' && result.status !== 'failed') return;
      const { identifier, vars } = normalizeTelegramRecipient(this.campaign.recipients[index]);
      // Un identifiant Telegram importé est soit un numéro (que t.me/tg://
      // savent résoudre via ?phone=), soit un username (résolu par
      // https://t.me/<username> directement) — jamais les deux.
      const isPhone = /^\+?\d[\d\s-]{5,}$/.test(identifier);
      items.push({
        index,
        to: result.to,
        isPhone,
        phone: isPhone ? identifier.replace(/[^\d]/g, '') : '',
        username: !isPhone ? identifier.replace(/^@/, '') : '',
        name: vars.name,
        message: personalizeMessage(template, vars),
        status: result.status,
      });
    });
    return items;
  }

  // Voir queues/campaignEngine.js#markManualSent (même principe) : ne
  // touche ni nextIndex ni les compteurs sent/success/failed, seulement une
  // trace consultable dans le rapport de campagne.
  markManualSent(index) {
    if (!this.campaign || !this.campaign.results[index]) return null;
    this.campaign.results[index] = {
      ...this.campaign.results[index],
      status: 'sent_manual',
      timestamp: new Date().toISOString(),
    };
    this._persist();
    return this.campaign.results[index];
  }

  // Gère à la fois la pause volontaire (boutons Pause/Reprendre) et la perte
  // de connexion (auto-pause le temps que Telegram se reconnecte, voir le
  // heartbeat de adapters/telegram.js qui relance la connexion tout seul en
  // arrière-plan) — les deux cas se traduisent de la même façon pour la file
  // d'attente : on attend avant de continuer, sans marquer les destinataires
  // restants comme échoués.
  async _waitWhileBlocked() {
    const campaign = this.campaign;
    const isBlocked = () => campaign.userPaused || !this.session.isConnected() || Date.now() < this.incomingPauseUntil;
    if (!isBlocked()) {
      return;
    }

    campaign.paused = true;
    this._persist();
    if (campaign.userPaused) {
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): en pause (demandée par l'utilisateur).`);
    } else if (!this.session.isConnected()) {
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): mise en pause — connexion perdue, en attente de reconnexion...`);
    } else {
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): en pause — réponse entrante détectée.`);
    }

    while (!campaign.stopRequested && !campaign.superseded && isBlocked()) {
      this._heartbeat();
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    campaign.paused = false;
    console.log(`Campagne Telegram (tenant "${this.tenantId}"): reprise.`);
  }

  // Comme interruptibleSleep (WhatsApp), mais réagit aussi à une pause
  // utilisateur déclenchée en pleine attente entre deux envois.
  async _interruptibleSleep(ms) {
    const campaign = this.campaign;
    const tickMs = 300;
    let elapsed = 0;
    while (elapsed < ms) {
      if (campaign.stopRequested || campaign.superseded) return;
      if (campaign.userPaused) {
        campaign.paused = true;
        this._heartbeat();
        await sleep(tickMs);
        continue;
      }
      campaign.paused = false;
      const step = Math.min(tickMs, ms - elapsed);
      await sleep(step);
      elapsed += step;
    }
  }

  // Voir queues/campaignEngine.js#_markRemainingInterrupted (même principe) :
  // `results[]` est pré-rempli dès start() et reflète déjà l'état correct
  // ('pending' ou 'skipped_duplicate') de chaque destinataire non encore
  // traité — rien à y réécrire ici.
  _markRemainingInterrupted(fromIndex) {
    const campaign = this.campaign;
    campaign.nextIndex = campaign.recipients.length;
    campaign.status = 'stopped';
    campaign.paused = false;
    campaign.finishedAt = new Date().toISOString();
  }

  // Voir queues/campaignEngine.js#_run/_runLoop (même principe : _runActive
  // suit le cycle de vie de cet appel, utilisé par resume() pour savoir s'il
  // doit redémarrer une boucle ou simplement débloquer celle déjà active).
  async _run(startIndex) {
    this._runActive = true;
    try {
      await this._runLoop(startIndex);
    } finally {
      this._runActive = false;
    }
  }

  async _runLoop(startIndex) {
    const campaign = this.campaign;
    const recipients = campaign.recipients;

    // Voir queues/campaignEngine.js#_run pour la justification complète :
    // stop()/pauseForShutdown() finalisent `campaign` de façon SYNCHRONE
    // (voir plus bas) — ce passage de boucle doit alors juste s'arrêter sans
    // rien retoucher, jamais re-marquer/re-persister par-dessus un état déjà
    // clos (potentiellement celui d'une toute nouvelle campagne démarrée
    // entre-temps, le verrou ayant été libéré immédiatement par stop()).
    const shouldAbort = () => campaign.stopRequested || campaign.superseded;

    let i = startIndex;
    while (i < recipients.length) {
      if (shouldAbort()) return;

      await this._waitWhileBlocked();
      if (shouldAbort()) return;

      await this._waitForNetworkHold();
      if (shouldAbort()) return;

      // Voir queues/campaignEngine.js#_runLoop (même principe) : Smart
      // Screening anti-doublons déjà tranché dans campaign.results[i] —
      // saut instantané, sans requête réseau ni délai, placé APRÈS les
      // attentes ci-dessus pour rester gelé par une pause/un arrêt comme un
      // envoi normal.
      if (campaign.results[i].status === 'skipped_duplicate') {
        campaign.results[i].timestamp = new Date().toISOString();
        campaign.sent += 1;
        campaign.skippedDuplicates += 1;
        campaign.nextIndex = i + 1;
        this._persist();
        if (this.onActivity) this.onActivity();
        console.log(`Campagne Telegram (tenant "${this.tenantId}"): destinataire ${campaign.results[i].to} ignoré (doublon détecté, ${i + 1}/${recipients.length}).`);
        i += 1;
        continue;
      }

      const { identifier, vars } = normalizeTelegramRecipient(recipients[i]);
      let status = 'failed';
      let errorReason = null;
      let overloadDetected = false;

      try {
        // 'groups' : identifiants de groupes/canaux déjà connus (getGroups()),
        // utilisables directement sans passer par resolveRecipient (qui ne
        // sait résoudre qu'un username Telegram ou un numéro de téléphone).
        // 'contacts' (par défaut) : identifiants importés à résoudre.
        const entity = campaign.recipientType === 'groups' ? identifier : await this.session.resolveRecipient(identifier);
        // Spintax résolu PUIS variables de personnalisation substituées (voir
        // lib/personalization.js#personalizeMessage) — dans cet ordre, et À
        // CHAQUE destinataire (pas une seule fois pour toute la campagne) :
        // deux destinataires reçoivent alors rarement le texte identique mot
        // pour mot, même à partir du même modèle.
        const personalizedMessage = personalizeMessage(campaign.message, vars);
        if (this.resolvedMedia) {
          // Séquencement standard média + texte : le média est expédié seul
          // (sans légende), puis le texte associé est envoyé séparément
          // juste après — jamais agrégés dans le même appel API.
          const mediaStartedAt = Date.now();
          await this.session.sendMedia(entity, this.resolvedMedia);
          this._recordSendLatency(Date.now() - mediaStartedAt);
          if (personalizedMessage) {
            await sleep(MEDIA_TEXT_SEQUENCE_PAUSE_MS);
            const textStartedAt = Date.now();
            await this.session.sendMessage(entity, personalizedMessage);
            this._recordSendLatency(Date.now() - textStartedAt);
          }
        } else {
          const textStartedAt = Date.now();
          await this.session.sendMessage(entity, personalizedMessage);
          this._recordSendLatency(Date.now() - textStartedAt);
        }
        status = 'sent';
        campaign.success += 1;
        this.networkHealth.recordSuccess();
        await this._recordHistorySent(messageHistory.normalizeContactKey(identifier));
        console.log(`Campagne Telegram (tenant "${this.tenantId}"): message envoyé à ${identifier} (${i + 1}/${recipients.length}).`);
      } catch (err) {
        if (circuitBreaker.isOverloadError(err)) {
          // Signal de surcharge (429, FloodWaitError, reset de socket...) :
          // pas un échec du destinataire — son index est conservé
          // (campaign.nextIndex reste à i) pour le RETENTER après le délai
          // de mise en veille et un health check positif (voir
          // _waitForNetworkHold), sans le compter ni avancer la file.
          overloadDetected = true;
          const backoffMs = this.networkHealth.recordOverloadFailure(err);
          if (!shouldAbort()) this._persist();
          console.log(
            `Campagne Telegram (tenant "${this.tenantId}"): signal de surcharge détecté (${err.message}) — ` +
            `statut 'circuit_open', nouvelle tentative pour ${identifier} dans ${Math.round(backoffMs / 60000)} min (index ${i} conservé).`,
          );
        } else {
          campaign.failed += 1;
          errorReason = err.message || String(err);
          console.error(`Campagne Telegram (tenant "${this.tenantId}"): échec de l'envoi à ${identifier}:`, errorReason);
        }
      }

      // stop()/pauseForShutdown() a pu finaliser `campaign` PENDANT l'envoi
      // ci-dessus (attente réseau non interruptible) : ne pas laisser cet
      // envoi qui vient de se terminer réécrire un état déjà clos.
      if (shouldAbort()) return;

      if (overloadDetected) {
        // Ne pas incrémenter i : le prochain passage dans la boucle
        // retentera CE MÊME destinataire, après _waitForNetworkHold().
        continue;
      }

      campaign.sent += 1;
      campaign.nextIndex = i + 1;
      campaign.results[i] = { to: String(identifier), status, error: errorReason, timestamp: new Date().toISOString() };
      this._persist();
      if (this.onActivity) this.onActivity();

      i += 1;

      if (i < recipients.length && !shouldAbort()) {
        // Délai fixe et configurable en priorité (standard, sans
        // randomisation) ; à défaut, on retombe sur l'ancienne fenêtre
        // aléatoire min/max pour ne pas casser les campagnes déjà
        // paramétrées ainsi.
        const baseDelayMs = Number.isFinite(campaign.delaySeconds) && campaign.delaySeconds > 0
          ? campaign.delaySeconds * 1000
          : randomDelay(campaign.minDelayMs, campaign.maxDelayMs);
        const batch = Number.isInteger(campaign.batchSize) && campaign.batchSize > 0 ? campaign.batchSize : recipients.length;
        // i a déjà été incrémenté ci-dessus : il représente ici le nombre de
        // destinataires traités jusqu'ici (compte 1-based), pas un index.
        const endOfBatch = i % batch === 0;
        // batchPauseSeconds : pause après un lot, configurable indépendamment
        // du délai par message — à défaut, 3x le délai par message.
        const batchPauseMs = Number.isFinite(campaign.batchPauseSeconds) && campaign.batchPauseSeconds > 0
          ? campaign.batchPauseSeconds * 1000
          : baseDelayMs * 3;
        await this._interruptibleSleep(endOfBatch ? batchPauseMs : baseDelayMs);
      }
    }

    if (shouldAbort()) return;

    if (campaign.status === 'running') {
      campaign.status = 'completed';
      campaign.finishedAt = new Date().toISOString();
      this._persist();
    }

    removeMedia(this.persistedMedia);
    console.log(`Campagne Telegram (tenant "${this.tenantId}"): terminée.`);
  }

  async start(recipients, message, options = {}) {
    if (this.campaign && this.campaign.status === 'running') {
      throw new Error('CAMPAIGN_IN_PROGRESS');
    }

    // Aucune troncature du fichier importé, quelle que soit sa taille
    // (400, 800, 1000+ contacts) : "batchSize"/"batchPauseSeconds" ci-dessous
    // ne bornent que la taille d'une VAGUE d'envoi (voir _run()), pas le
    // nombre total de destinataires traités — la boucle continue
    // automatiquement vague après vague jusqu'à épuisement complet de la
    // liste.
    const { media, delaySeconds, batchSize, batchPauseSeconds } = options;
    const recipientType = options.recipientType === 'groups' ? 'groups' : 'contacts';

    const minDelayMs = clampDelayMs(options.minDelayMs) || MIN_DELAY_MS;
    const maxDelayMs = Math.max(clampDelayMs(options.maxDelayMs) || MAX_DELAY_MS, minDelayMs);

    this.persistedMedia = await persistMedia(this.tenantId, media);
    this.resolvedMedia = media ? { buffer: media.buffer, mimetype: media.mimetype, filename: media.filename } : null;

    // Voir queues/campaignEngine.js#start (même principe) : Smart Screening
    // anti-doublons calculé UNE FOIS ici, avant le premier envoi. Un même
    // moteur/tenant sert aussi bien les messages directs (recipientType
    // 'contacts') que la diffusion vers groupes/canaux (recipientType
    // 'groups') — l'historique et le hash de modèle s'appliquent
    // identiquement dans les deux cas.
    const messageHash = messageHistory.hashTemplate(messageHashParts(message, this.persistedMedia));
    const duplicateWindowHours = messageHistory.clampWindowHours(options.duplicateWindowHours);
    const historyEntries = await messageHistory.loadHistory('telegram', this.tenantId);
    const results = this._buildInitialResults(recipients, duplicateWindowHours * 3_600_000, historyEntries, messageHash);
    this._historyEntries = historyEntries;
    this._messageHash = messageHash;

    this.campaign = {
      total: recipients.length,
      sent: 0,
      success: 0,
      failed: 0,
      skippedDuplicates: 0,
      messageHash,
      duplicateWindowHours,
      status: 'running',
      paused: false,
      userPaused: false,
      stopRequested: false,
      superseded: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lastProgressAt: new Date().toISOString(),
      nextIndex: 0,
      recipients,
      recipientType,
      message,
      results,
      delaySeconds: Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds : undefined,
      minDelayMs,
      maxDelayMs,
      batchSize: Number.isInteger(batchSize) && batchSize > 0 ? batchSize : undefined,
      batchPauseSeconds: Number.isFinite(batchPauseSeconds) && batchPauseSeconds > 0 ? batchPauseSeconds : undefined,
    };
    this.incomingPauseUntil = 0;
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._lastHeartbeatAt = 0;
    this._persist();

    const campaign = this.campaign;
    this._run(0).catch((err) => {
      console.error(`Erreur pendant la campagne Telegram (tenant "${this.tenantId}"):`, err);
      if (this.campaign !== campaign || campaign.stopRequested || campaign.superseded) return;
      campaign.status = 'stopped';
      campaign.paused = false;
      campaign.finishedAt = new Date().toISOString();
      this._persist();
    });

    return this.campaign;
  }

  pause() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.userPaused = true;
    this._persist();
  }

  // Voir queues/campaignEngine.js#resume (même principe) : si aucune boucle
  // n'est déjà en vie (campagne restaurée via resumeIfPending() mais jamais
  // relancée depuis), en démarre une nouvelle à partir de nextIndex plutôt
  // que de se contenter de lever le drapeau userPaused, que personne
  // n'observerait alors.
  resume() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.userPaused = false;
    if (!this._runActive) {
      this.campaign.paused = false;
    }
    this._persist();
    if (!this._runActive) {
      const campaign = this.campaign;
      this._run(campaign.nextIndex).catch((err) => {
        console.error(`Erreur pendant la reprise de campagne Telegram (tenant "${this.tenantId}"):`, err);
        if (this.campaign !== campaign || campaign.stopRequested || campaign.superseded) return;
        campaign.status = 'stopped';
        campaign.paused = false;
        campaign.finishedAt = new Date().toISOString();
        this._persist();
      });
    }
  }

  // Arrêt DÉFINITIF (voir queues/campaignEngine.js#stop pour la
  // justification complète) : finalise la campagne de façon SYNCHRONE
  // (destinataires restants marqués "interrupted", statut "stopped") au lieu
  // d'attendre que la boucle en tâche de fond ne remarque stopRequested —
  // libère donc le verrou immédiatement pour permettre un nouveau
  // lancement. superseded=true fait taire la boucle en tâche de fond si elle
  // est encore active, sans qu'elle ne retouche cet état déjà finalisé.
  stop() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.stopRequested = true;
    this._markRemainingInterrupted(this.campaign.nextIndex);
    this.campaign.superseded = true;
    // Voir queues/campaignEngine.js#stop (même principe) : libère
    // immédiatement le coupe-circuit pour ce tenant, même en pleine pause de
    // sécurité au moment de l'arrêt.
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._persist();
  }

  // Voir queues/campaignEngine.js#pauseForShutdown (même principe) : appelée
  // par le régulateur de sessions juste avant de disposer la session
  // Telegram d'un tenant — ne jamais annuler, juste mettre en pause pour une
  // reprise ultérieure.
  pauseForShutdown() {
    if (!this.campaign || this.campaign.status !== 'running') return;
    this.campaign.userPaused = true;
    this.campaign.paused = true;
    this.campaign.superseded = true;
    this._persist();
    console.log(`Campagne Telegram (tenant "${this.tenantId}"): mise en pause (session libérée) — reprise possible ultérieurement.`);
  }

  // Appelée par adapters/telegramManager.js dès que le COMPTE Telegram
  // connecté sous ce tenant change (déconnexion manuelle, ré-appairage d'un
  // autre numéro — voir adapters/telegram.js#onAccountReset) : contrairement
  // à pauseForShutdown() ci-dessus (même compte, session juste libérée
  // temporairement), l'ancien ET le nouveau compte n'ont ici RIEN en
  // commun — une campagne "running"/"paused" de l'ancien compte ne doit
  // JAMAIS verrouiller le lancement d'une campagne pour le nouveau.
  reset() {
    if (this.campaign && this.campaign.status === 'running') {
      this._markRemainingInterrupted(this.campaign.nextIndex);
      this.campaign.superseded = true;
      this.campaign.status = 'cancelled';
      this.campaign.cancelReason = 'Compte Telegram déconnecté ou changé — campagne annulée.';
      this._persist();
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): annulée — le compte Telegram connecté a changé.`);
      removeMedia(this.persistedMedia);
    }
    this.campaign = null;
    this.persistedMedia = null;
    this.resolvedMedia = null;
    this.incomingPauseUntil = 0;
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._lastHeartbeatAt = 0;
    this._runActive = false;
    this._historyEntries = null;
    this._messageHash = null;
  }

  async _loadRecord() {
    try {
      return JSON.parse(fs.readFileSync(statePath(this.tenantId), 'utf8'));
    } catch (err) {
      // Pas de fichier local : tenter GitHub avant d'abandonner.
    }

    if (!this.remoteStore.enabled) return null;

    try {
      const remote = await this.remoteStore.fetchRemote();
      if (!remote || !remote.content) return null;
      fs.writeFileSync(statePath(this.tenantId), remote.content, 'utf8');
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): état restauré depuis GitHub (disque local vidé par un redéploiement).`);
      return JSON.parse(remote.content);
    } catch (err) {
      console.error(`Campagne Telegram (tenant "${this.tenantId}"): échec de restauration depuis GitHub :`, err.message);
      return null;
    }
  }

  // Appelée une fois par tenant au démarrage du process (voir
  // adapters/telegramManager.js#bootResumePendingCampaigns) si un état
  // persisté indique une campagne encore "running"/"paused" au moment où le
  // conteneur s'est arrêté — reprend l'envoi exactement au destinataire
  // suivant (nextIndex), sans action requise de l'utilisateur.
  // Voir queues/campaignEngine.js#resumeIfPending pour la justification
  // complète : appelée au boot ET à chaque (re)création d'instance en cours
  // de fonctionnement (voir getOrCreate() dans telegramManager.js). Ne
  // relance JAMAIS l'envoi automatiquement — restaure en pause
  // (userPaused=true), à reprendre manuellement via resume() une fois certain
  // que le compte n'est plus restreint. `if (this.campaign) return false`
  // rend l'appel idempotent (boot + requête HTTP concurrente sans risque de
  // double reprise).
  async resumeIfPending() {
    if (this.campaign) return false;

    const record = await this._loadRecord();
    if (!record) return false;

    if (record.status !== 'running' && record.status !== 'paused') {
      return false;
    }

    this.persistedMedia = record.media || null;
    // Voir queues/campaignEngine.js#resumeIfPending (même principe) :
    // l'historique lui-même est chargé paresseusement au premier envoi réel
    // après la reprise (voir _recordHistorySent) ; seul messageHash doit
    // survivre, restauré depuis le disque ou recalculé pour un état
    // persisté avant ce déploiement.
    this._historyEntries = null;
    this._messageHash = record.messageHash || messageHistory.hashTemplate(messageHashParts(record.message, this.persistedMedia));
    const migratedResults = this._migrateResults(record.results, record.recipients);

    try {
      this.resolvedMedia = await resolveMedia(this.persistedMedia);
    } catch (err) {
      console.error(
        `Campagne Telegram (tenant "${this.tenantId}"): reprise impossible — ${err.message}. ` +
        'Pièce jointe irrécupérable — campagne marquée "stopped", à relancer manuellement.',
      );
      this.campaign = {
        ...record,
        skippedDuplicates: record.skippedDuplicates || 0,
        messageHash: this._messageHash,
        duplicateWindowHours: record.duplicateWindowHours || messageHistory.DEFAULT_WINDOW_HOURS,
        results: migratedResults,
        status: 'stopped',
        paused: false,
        userPaused: false,
        stopRequested: true,
        superseded: false,
        finishedAt: new Date().toISOString(),
        resumeError: 'Pièce jointe introuvable après redéploiement — relancez la campagne.',
      };
      this._persist();
      return false;
    }

    this.campaign = {
      ...record,
      skippedDuplicates: record.skippedDuplicates || 0,
      messageHash: this._messageHash,
      duplicateWindowHours: record.duplicateWindowHours || messageHistory.DEFAULT_WINDOW_HOURS,
      results: migratedResults,
      status: 'running',
      paused: true,
      userPaused: true,
      stopRequested: false,
      superseded: false,
      finishedAt: null,
    };
    this.incomingPauseUntil = 0;
    this._lastHeartbeatAt = 0;
    // Restaure la pause de sécurité en cours (voir lib/circuitBreaker.js) le
    // cas échéant, plutôt que de repartir sur un compteur d'échecs à zéro —
    // sans effet tant que userPaused reste true, mais restauré pour rester
    // cohérent une fois resume() appelé.
    this.networkHealth = circuitBreaker.CircuitBreakerState.fromJSON(record.networkHealth);
    this._persist();

    console.log(
      `Campagne Telegram (tenant "${this.tenantId}"): restaurée en PAUSE après redémarrage/reconnexion, ` +
      `au destinataire ${record.nextIndex + 1}/${record.total} — cliquez "Reprendre" pour continuer l'envoi.`,
    );

    return true;
  }
}

// Énumère les tenants ayant un fichier d'état persisté indiquant une
// campagne Telegram interrompue — même logique que
// queues/campaignEngine.js#listTenantsWithPendingCampaigns, dupliquée
// (répertoires distincts) plutôt que couplée via un module partagé.
async function listTenantsWithPendingCampaigns() {
  const tenantsFromLocal = [];
  let localFiles = [];
  try {
    localFiles = fs.readdirSync(CAMPAIGNS_DIR);
  } catch (err) {
    // Dossier absent : rien en local, on continue quand même vers GitHub.
  }

  for (const file of localFiles) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, file), 'utf8'));
      const tenantId = record.tenantId || file.replace(/\.json$/, '');
      if (record.status === 'running' || record.status === 'paused') {
        tenantsFromLocal.push(tenantId);
      }
    } catch (err) {
      console.error(`État de campagne Telegram local illisible (${file}) :`, err.message);
    }
  }

  if (!githubStore.enabled) {
    return tenantsFromLocal;
  }

  const knownLocally = new Set(tenantsFromLocal);
  const remoteFiles = await githubStore.listDirectory(REMOTE_CAMPAIGNS_DIR);
  const tenantsFromRemote = [];

  for (const filename of remoteFiles) {
    if (!filename.endsWith('.json')) continue;
    const tenantId = filename.replace(/\.json$/, '');
    if (knownLocally.has(tenantId)) continue;

    try {
      const store = githubStore.createStore(`${REMOTE_CAMPAIGNS_DIR}/${filename}`);
      const remote = await store.fetchRemote();
      if (!remote || !remote.content) continue;
      const record = JSON.parse(remote.content);
      if (record.status === 'running' || record.status === 'paused') {
        tenantsFromRemote.push(tenantId);
      }
    } catch (err) {
      console.error(`État de campagne Telegram distant illisible (${filename}) :`, err.message);
    }
  }

  return [...tenantsFromLocal, ...tenantsFromRemote];
}

// Voir queues/campaignEngine.js#purgeStaleCampaigns (même principe et mêmes
// garanties : n'annule jamais une campagne activement suivie par un process,
// aussi longue que soit son attente — seule une campagne dont AUCUN process
// n'a donné signe de vie depuis plus de maxAgeMs est annulée).
function purgeStaleCampaigns(maxAgeMs = DEFAULT_STALE_MS) {
  let files = [];
  try {
    files = fs.readdirSync(CAMPAIGNS_DIR);
  } catch (err) {
    return [];
  }

  const purged = [];
  const now = Date.now();

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(CAMPAIGNS_DIR, file);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      continue;
    }

    if (record.status !== 'running' && record.status !== 'paused') continue;

    const referenceTime = record.lastProgressAt || record.startedAt;
    if (!referenceTime) continue;
    const ageMs = now - new Date(referenceTime).getTime();
    if (!Number.isFinite(ageMs) || ageMs < maxAgeMs) continue;

    const tenantId = record.tenantId || file.replace(/\.json$/, '');
    const ageHours = Math.round(ageMs / 3_600_000);
    record.status = 'cancelled';
    record.paused = false;
    record.userPaused = false;
    record.stopRequested = true;
    record.finishedAt = new Date().toISOString();
    record.cancelReason = `Campagne inactive depuis plus de ${ageHours}h (aucun process ne l'a suivie) — annulée automatiquement.`;

    try {
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
    } catch (err) {
      console.error(`Purge campagne Telegram (tenant "${tenantId}") : échec d'écriture locale —`, err.message);
      continue;
    }

    removeMedia(record.media);

    if (githubStore.enabled) {
      githubStore.createStore(remoteFilePath(tenantId)).pushRemote(JSON.stringify(record, null, 2)).catch((err) => {
        console.error(`Purge campagne Telegram (tenant "${tenantId}") : échec de synchronisation GitHub —`, err.message);
      });
    }

    console.log(`Campagne Telegram (tenant "${tenantId}") : annulée automatiquement après ${ageHours}h sans aucun signe de vie.`);
    purged.push(tenantId);
  }

  return purged;
}

module.exports = {
  TelegramCampaignEngine,
  listTenantsWithPendingCampaigns,
  purgeStaleCampaigns,
  DEFAULT_STALE_MS,
};
