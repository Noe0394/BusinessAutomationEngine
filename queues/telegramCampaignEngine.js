const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const githubStore = require('../githubStore');
const { personalizeMessage, buildPersonalizationVars } = require('../lib/personalization');
const circuitBreaker = require('../lib/circuitBreaker');
const messageHistory = require('../lib/messageHistory');

// Normalise un destinataire Telegram pour l'envoi : un identifiant ("username
// Telegram, numéro, ou identifiant de groupe/canal déjà résolu — voir
// recipientType ci-dessous) et le jeu complet de variables dynamiques
// ("vars", voir lib/personalization.js#buildPersonalizationVars).
function normalizeTelegramRecipient(recipient) {
  if (recipient && typeof recipient === 'object') {
    const identifier = String(recipient.identifier ?? recipient.username ?? recipient.telephone ?? recipient.to ?? '').trim();
    const name = String(recipient.name ?? recipient.prenom ?? recipient.nom ?? '').trim();
    return { identifier, vars: buildPersonalizationVars(name, identifier) };
  }
  const identifier = String(recipient ?? '').trim();
  return { identifier, vars: buildPersonalizationVars('', identifier) };
}

// GESTIONNAIRE MULTI-CAMPAGNES (Play / Pause / Reprise intelligente) — voir
// queues/campaignEngine.js pour la documentation complète du modèle (même
// principe côté Telegram, dupliqué plutôt que couplé via un module partagé,
// comme le reste de ce fichier) : un tenant peut posséder PLUSIEURS
// campagnes stockées (this.campaigns : Map<id, campaign>), mais une seule à
// la fois est autorisée à envoyer sur la session Telegram partagée
// (this.activeCampaignId + this._runActive). Basculer vers une autre
// campagne (resume(id)) met d'abord l'active en PAUSE et attend que sa
// boucle d'envoi ait réellement quitté avant de lancer la nouvelle.
//
// Cycle de vie : 'queued' (EN ATTENTE, créée pendant qu'une autre campagne
// est active) -> 'running' (EN COURS) <-> 'paused' (EN PAUSE) ->
// 'completed' (TERMINÉE) | 'stopped' | 'cancelled'.
//
// Un seul fichier d'état local par tenant (TELEGRAM_CAMPAIGNS_DIR/<tenantId>.json)
// porte désormais TOUTES les campagnes (tableau "campaigns"), avec sauvegarde
// GitHub miroir — sur un environnement Docker/Render éphémère, un
// redéploiement/crash ne doit ni perdre la progression déjà envoyée, ni
// renvoyer les messages déjà livrés au redémarrage.
//
// Chaque campagne conserve explicitement `lastProcessedIndex`,
// `sentContactIds` et `pendingContactIds` (voir _refreshContactIdSets) pour
// garantir qu'une reprise ("PLAY") repart exactement à
// `lastProcessedIndex + 1` sans jamais renvoyer un destinataire déjà traité.
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
// depuis le frontend (recommandation explicite de l'utilisateur pour rester
// dans un usage raisonnable de l'API Telegram).
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60_000;

function clampDelayMs(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, MIN_DELAY_MS), MAX_DELAY_MS);
}

// Voir queues/campaignEngine.js#INCOMING_REPLY_PAUSE_MS (même principe).
const INCOMING_REPLY_PAUSE_MS = 30_000;

// Pause courte, fixe, entre l'envoi du média et celui du texte associé.
const MEDIA_TEXT_SEQUENCE_PAUSE_MS = 3_000;

// Voir queues/campaignEngine.js (mêmes valeurs par défaut, dupliquées).
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_MS = (parseFloat(process.env.CAMPAIGN_STALE_HOURS) || 48) * 3_600_000;
const RELEASE_TIMEOUT_MS = 20_000;
const MAX_RETAINED_CAMPAIGNS = 20;

// Une campagne DM Telegram ne porte au plus qu'UNE pièce jointe : persistée
// une seule fois au lancement, préfixée par campaignId pour ne jamais entrer
// en collision avec une autre campagne du même tenant.
async function persistMedia(tenantId, campaignId, media) {
  if (!media) return null;

  const mediaFile = `${tenantId}_${campaignId}.bin`;
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

// Empreinte du MODÈLE de message (avant personnalisation par destinataire).
function messageHashParts(message, persistedMedia) {
  const parts = [`text:${message || ''}`];
  if (persistedMedia) parts.push(`media:${persistedMedia.filename || ''}:${persistedMedia.mimetype || ''}`);
  return parts;
}

// Un moteur par tenant (voir adapters/telegramManager.js), lié à l'instance
// Telegram de ce même tenant : aucune campagne, aucun destinataire, aucun
// résultat n'est jamais partagé entre deux clés de licence.
class TelegramCampaignEngine {
  constructor(tenantId, session, onActivity) {
    this.tenantId = tenantId;
    this.session = session;
    this.onActivity = onActivity;
    // Voir queues/campaignEngine.js#campaigns/resolvedSequences/activeCampaignId
    // (même principe, adapté à une pièce jointe unique au lieu d'une
    // séquence de plusieurs étapes).
    this.campaigns = new Map();
    this.resolvedMediaById = new Map();
    this.activeCampaignId = null;
    this.remoteStore = githubStore.createStore(remoteFilePath(tenantId));
    this.incomingPauseUntil = 0;
    if (typeof session.onIncomingMessage === 'function') {
      session.onIncomingMessage(() => this._pauseForIncomingReply());
    }
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._lastHeartbeatAt = 0;
    this._runActive = false;
    this._historyEntries = null;
  }

  _heartbeat(campaign) {
    const now = Date.now();
    if (now - this._lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    this._lastHeartbeatAt = now;
    this._persist(campaign);
  }

  _pauseForIncomingReply() {
    const campaign = this.activeCampaignId ? this.campaigns.get(this.activeCampaignId) : null;
    if (!campaign || campaign.status !== 'running') return;
    const until = Date.now() + INCOMING_REPLY_PAUSE_MS;
    if (until > this.incomingPauseUntil) {
      this.incomingPauseUntil = until;
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): réponse entrante détectée — pause de ${INCOMING_REPLY_PAUSE_MS / 1000}s avant de reprendre l'envoi.`);
    }
  }

  _recordSendLatency(elapsedMs) {
    if (this.networkHealth.recordLatency(elapsedMs)) {
      console.log(
        `Campagne Telegram (tenant "${this.tenantId}"): latence élevée (${elapsedMs}ms) sur 2 requêtes consécutives — ` +
        `statut 'degraded_network', pause de ${circuitBreaker.DEGRADED_NETWORK_PAUSE_MS / 60000} min.`,
      );
    }
  }

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

  async _recordHistorySent(contactKey, messageHash) {
    if (!contactKey) return;
    if (!this._historyEntries) {
      this._historyEntries = await messageHistory.loadHistory('telegram', this.tenantId);
    }
    this._historyEntries.push({ contactKey, messageHash, sentAt: new Date().toISOString() });
    this._historyEntries = messageHistory.saveHistory('telegram', this.tenantId, this._historyEntries);
  }

  async _waitForNetworkHold(campaign) {
    const health = this.networkHealth;
    if (!health.isHeld()) return;

    campaign.paused = true;
    this._persist(campaign);
    console.log(
      `Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): file en pause — statut réseau '${health.networkStatus}', ` +
      `reprise prévue vers ${new Date(health.holdUntil).toISOString()}.`,
    );

    while (!campaign.stopRequested && !campaign.superseded && health.isHeld()) {
      this._heartbeat(campaign);
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    while (!campaign.stopRequested && !campaign.superseded && !this.session.isConnected()) {
      console.log(`Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): health check négatif — nouvelle vérification dans 30s avant reprise.`);
      this._heartbeat(campaign);
      await sleep(circuitBreaker.HEALTH_RECHECK_INTERVAL_MS);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    const wasCircuitOpen = health.networkStatus === 'circuit_open';
    health.networkStatus = 'normal';
    campaign.paused = false;
    this._persist(campaign);
    console.log(
      `Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): health check nominal — reprise de l'envoi` +
      `${wasCircuitOpen ? ' au destinataire précédemment en échec de surcharge' : ''}.`,
    );
  }

  // Voir queues/campaignEngine.js#_refreshContactIdSets (même principe).
  _refreshContactIdSets(campaign) {
    const sent = [];
    const pending = [];
    for (const r of campaign.results || []) {
      const key = messageHistory.normalizeContactKey(r.to) || r.to;
      if (r.status === 'sent' || r.status === 'sent_manual' || r.status === 'skipped_duplicate') {
        sent.push(key);
      } else {
        pending.push(key);
      }
    }
    campaign.sentContactIds = sent;
    campaign.pendingContactIds = pending;
    campaign.lastProcessedIndex = campaign.nextIndex - 1;
  }

  _buildFileRecord() {
    return {
      tenantId: this.tenantId,
      activeCampaignId: this.activeCampaignId,
      networkHealth: this.networkHealth.toJSON(),
      campaigns: Array.from(this.campaigns.values()),
    };
  }

  _persist(campaign) {
    if (campaign) {
      campaign.lastProgressAt = new Date().toISOString();
      this._refreshContactIdSets(campaign);
    }
    const content = JSON.stringify(this._buildFileRecord(), null, 2);
    fs.writeFileSync(statePath(this.tenantId), content, 'utf8');
    this.remoteStore.pushRemote(content).catch((err) => {
      console.error(`Échec de la sauvegarde des campagnes Telegram sur GitHub pour le tenant "${this.tenantId}" :`, err.message);
    });
  }

  // Voir queues/campaignEngine.js#_pruneOldCampaigns (même principe).
  _pruneOldCampaigns() {
    const terminal = Array.from(this.campaigns.values())
      .filter((c) => c.status === 'completed' || c.status === 'stopped' || c.status === 'cancelled')
      .sort((a, b) => new Date(a.finishedAt || a.createdAt) - new Date(b.finishedAt || b.createdAt));
    const nonTerminalCount = this.campaigns.size - terminal.length;
    const keepTerminal = Math.max(0, MAX_RETAINED_CAMPAIGNS - nonTerminalCount);
    const toRemove = terminal.slice(0, Math.max(0, terminal.length - keepTerminal));
    for (const campaign of toRemove) {
      this.campaigns.delete(campaign.id);
      this.resolvedMediaById.delete(campaign.id);
    }
  }

  _resolveDefaultCampaign() {
    if (this.activeCampaignId && this.campaigns.has(this.activeCampaignId)) {
      return this.campaigns.get(this.activeCampaignId);
    }
    const all = Array.from(this.campaigns.values());
    if (all.length === 0) return null;
    const nonTerminal = all.filter((c) => c.status === 'running' || c.status === 'paused' || c.status === 'queued');
    const pool = nonTerminal.length > 0 ? nonTerminal : all;
    return pool.reduce((latest, c) => {
      if (!latest) return c;
      const latestTime = new Date(latest.lastProgressAt || latest.createdAt).getTime();
      const cTime = new Date(c.lastProgressAt || c.createdAt).getTime();
      return cTime > latestTime ? c : latest;
    }, null);
  }

  _publicStatus(campaign) {
    const {
      id, name, total, sent, success, failed, skippedDuplicates, duplicateWindowHours, recipientType,
      status, paused, userPaused, stopRequested, createdAt, startedAt, finishedAt, results,
      resumeError, cancelReason, lastProcessedIndex, sentContactIds, pendingContactIds,
    } = campaign;
    const isActive = this.activeCampaignId === id;
    const base = {
      id,
      name,
      total,
      sent,
      success,
      failed,
      skippedDuplicates,
      duplicateWindowHours,
      // Un seul moteur/verrou de campagne par tenant sert à la fois les
      // messages directs (contacts importés) et la diffusion vers des
      // groupes/canaux — exposé pour que le dashboard n'affiche/ne pilote
      // jamais depuis le mauvais onglet la campagne réellement en cours.
      recipientType: recipientType || 'contacts',
      status,
      paused,
      userPaused,
      stopRequested,
      createdAt,
      startedAt,
      finishedAt,
      results,
      lastProcessedIndex,
      sentCount: (sentContactIds || []).length,
      pendingCount: (pendingContactIds || []).length,
      isActive,
      networkStatus: isActive ? this.networkHealth.networkStatus : 'normal',
      retryAfterSeconds: isActive ? this.networkHealth.getRetryAfterSeconds() : 0,
    };
    if (resumeError) base.resumeError = resumeError;
    if (cancelReason) base.cancelReason = cancelReason;
    return base;
  }

  getStatus(id) {
    const campaign = id ? this.campaigns.get(id) : this._resolveDefaultCampaign();
    if (!campaign) return null;
    return this._publicStatus(campaign);
  }

  listCampaigns() {
    return Array.from(this.campaigns.values())
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((c) => this._publicStatus(c));
  }

  // Relance Manuelle Express : liste des destinataires encore 'pending' ou
  // 'failed' d'une campagne DIRECTE (contacts, pas groupes/canaux — un deep
  // link t.me n'a de sens que pour un contact individuel).
  getManualRelaunchQueue(id) {
    const campaign = id ? this.campaigns.get(id) : this._resolveDefaultCampaign();
    if (!campaign || campaign.recipientType !== 'contacts') return [];
    const template = campaign.message || '';
    const items = [];
    campaign.results.forEach((result, index) => {
      if (result.status !== 'pending' && result.status !== 'failed') return;
      const { identifier, vars } = normalizeTelegramRecipient(campaign.recipients[index]);
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

  markManualSent(index, id) {
    const campaign = id ? this.campaigns.get(id) : this._resolveDefaultCampaign();
    if (!campaign || !campaign.results[index]) return null;
    campaign.results[index] = {
      ...campaign.results[index],
      status: 'sent_manual',
      timestamp: new Date().toISOString(),
    };
    this._persist(campaign);
    return campaign.results[index];
  }

  // Gère à la fois la pause volontaire et la perte de connexion (auto-pause
  // le temps que Telegram se reconnecte) — les deux se traduisent de la
  // même façon pour la file : on attend avant de continuer, sans marquer les
  // destinataires restants comme échoués.
  async _waitWhileDisconnected(campaign) {
    if (this.session.isConnected()) return;

    campaign.paused = true;
    this._persist(campaign);
    console.log(`Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): mise en pause — connexion perdue, en attente de reconnexion...`);

    while (!this.session.isConnected() && !campaign.stopRequested && !campaign.superseded) {
      this._heartbeat(campaign);
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    campaign.paused = false;
    console.log(`Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): reprise après reconnexion.`);
  }

  async _waitForIncomingPause(campaign) {
    while (Date.now() < this.incomingPauseUntil) {
      if (campaign.stopRequested || campaign.superseded) return;
      await sleep(300);
    }
  }

  // Comme queues/campaignEngine.js#interruptibleSleep, réagit à
  // shouldAbort() (stopRequested/superseded) toutes les 300ms.
  async _interruptibleSleep(ms, shouldAbort) {
    const tickMs = 300;
    let elapsed = 0;
    while (elapsed < ms) {
      if (shouldAbort()) return;
      const step = Math.min(tickMs, ms - elapsed);
      await sleep(step);
      elapsed += step;
    }
  }

  _markRemainingInterrupted(campaign) {
    campaign.nextIndex = campaign.recipients.length;
    campaign.status = 'stopped';
    campaign.paused = false;
    campaign.finishedAt = new Date().toISOString();
  }

  async _run(campaign, startIndex) {
    this._runActive = true;
    try {
      await this._runLoop(campaign, startIndex);
    } finally {
      this._runActive = false;
    }
  }

  _launch(campaign, startIndex) {
    this._run(campaign, startIndex).catch((err) => {
      console.error(`Erreur pendant la campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"):`, err);
      if (campaign.stopRequested || campaign.superseded) return;
      campaign.status = 'stopped';
      campaign.paused = false;
      campaign.finishedAt = new Date().toISOString();
      if (this.activeCampaignId === campaign.id) this.activeCampaignId = null;
      this._persist(campaign);
    });
  }

  async _runLoop(campaign, startIndex) {
    const recipients = campaign.recipients;
    const resolvedMedia = this.resolvedMediaById.get(campaign.id) || null;

    const shouldAbort = () => campaign.stopRequested || campaign.superseded;

    let i = startIndex;
    while (i < recipients.length) {
      if (shouldAbort()) return;

      await this._waitWhileDisconnected(campaign);
      if (shouldAbort()) return;

      await this._waitForIncomingPause(campaign);
      if (shouldAbort()) return;

      await this._waitForNetworkHold(campaign);
      if (shouldAbort()) return;

      if (campaign.results[i].status === 'skipped_duplicate') {
        campaign.results[i].timestamp = new Date().toISOString();
        campaign.sent += 1;
        campaign.skippedDuplicates += 1;
        campaign.nextIndex = i + 1;
        this._persist(campaign);
        if (this.onActivity) this.onActivity();
        console.log(`Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): destinataire ${campaign.results[i].to} ignoré (doublon détecté, ${i + 1}/${recipients.length}).`);
        i += 1;
        continue;
      }

      if (campaign.results[i].status === 'sent_manual') {
        campaign.sent += 1;
        campaign.nextIndex = i + 1;
        this._persist(campaign);
        if (this.onActivity) this.onActivity();
        console.log(`Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): destinataire ${campaign.results[i].to} ignoré (déjà relancé manuellement, ${i + 1}/${recipients.length}).`);
        i += 1;
        continue;
      }

      const { identifier, vars } = normalizeTelegramRecipient(recipients[i]);
      let status = 'failed';
      let errorReason = null;
      let overloadDetected = false;

      try {
        const entity = campaign.recipientType === 'groups' ? identifier : await this.session.resolveRecipient(identifier);
        const personalizedMessage = personalizeMessage(campaign.message, vars);
        if (resolvedMedia) {
          const mediaStartedAt = Date.now();
          await this.session.sendMedia(entity, resolvedMedia);
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
        await this._recordHistorySent(messageHistory.normalizeContactKey(identifier), campaign.messageHash);
        console.log(`Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): message envoyé à ${identifier} (${i + 1}/${recipients.length}).`);
      } catch (err) {
        if (circuitBreaker.isOverloadError(err)) {
          overloadDetected = true;
          const backoffMs = this.networkHealth.recordOverloadFailure(err);
          if (!shouldAbort()) this._persist(campaign);
          console.log(
            `Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): signal de surcharge détecté (${err.message}) — ` +
            `statut 'circuit_open', nouvelle tentative pour ${identifier} dans ${Math.round(backoffMs / 60000)} min (index ${i} conservé).`,
          );
        } else {
          campaign.failed += 1;
          errorReason = err.message || String(err);
          console.error(`Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): échec de l'envoi à ${identifier}:`, errorReason);
        }
      }

      if (shouldAbort()) return;
      if (overloadDetected) continue;

      campaign.sent += 1;
      campaign.nextIndex = i + 1;
      campaign.results[i] = { to: String(identifier), status, error: errorReason, timestamp: new Date().toISOString() };
      this._persist(campaign);
      if (this.onActivity) this.onActivity();

      i += 1;

      if (i < recipients.length && !shouldAbort()) {
        const baseDelayMs = Number.isFinite(campaign.delaySeconds) && campaign.delaySeconds > 0
          ? campaign.delaySeconds * 1000
          : randomDelay(campaign.minDelayMs, campaign.maxDelayMs);
        const batch = Number.isInteger(campaign.batchSize) && campaign.batchSize > 0 ? campaign.batchSize : recipients.length;
        const endOfBatch = i % batch === 0;
        const batchPauseMs = Number.isFinite(campaign.batchPauseSeconds) && campaign.batchPauseSeconds > 0
          ? campaign.batchPauseSeconds * 1000
          : baseDelayMs * 3;
        await this._interruptibleSleep(endOfBatch ? batchPauseMs : baseDelayMs, shouldAbort);
      }
    }

    if (shouldAbort()) return;

    if (campaign.status === 'running') {
      campaign.status = 'completed';
      campaign.finishedAt = new Date().toISOString();
      if (this.activeCampaignId === campaign.id) this.activeCampaignId = null;
      this._persist(campaign);
      this._pruneOldCampaigns();
    }

    removeMedia(campaign.media);
    this.resolvedMediaById.delete(campaign.id);
    console.log(`Campagne Telegram (tenant "${this.tenantId}", "${campaign.name}"): terminée.`);
  }

  // Voir queues/campaignEngine.js#start (même principe) : crée une NOUVELLE
  // campagne. `options.enqueueIfBusy: true` (nouveau Gestionnaire
  // Multi-Campagnes) la stocke 'queued' (EN ATTENTE) au lieu de lever
  // CAMPAIGN_IN_PROGRESS quand une autre campagne est déjà active — sans
  // cette option (appelants historiques : programmation multi-canal),
  // comportement inchangé.
  async start(recipients, message, options = {}) {
    const activeCampaign = this.activeCampaignId ? this.campaigns.get(this.activeCampaignId) : null;
    const busy = Boolean(activeCampaign) && activeCampaign.status === 'running';
    if (busy && !options.enqueueIfBusy) {
      throw new Error('CAMPAIGN_IN_PROGRESS');
    }

    const id = crypto.randomUUID();
    const name = (options.name && String(options.name).trim()) || `Campagne du ${new Date().toLocaleString('fr-FR')}`;
    const willRunImmediately = !busy;

    // Aucune troncature du fichier importé, quelle que soit sa taille :
    // "batchSize"/"batchPauseSeconds" ne bornent que la taille d'une VAGUE
    // d'envoi (voir _runLoop()), pas le nombre total de destinataires
    // traités — la boucle continue automatiquement vague après vague.
    const { media, delaySeconds, batchSize, batchPauseSeconds } = options;
    const recipientType = options.recipientType === 'groups' ? 'groups' : 'contacts';

    const minDelayMs = clampDelayMs(options.minDelayMs) || MIN_DELAY_MS;
    const maxDelayMs = Math.max(clampDelayMs(options.maxDelayMs) || MAX_DELAY_MS, minDelayMs);

    const persistedMedia = await persistMedia(this.tenantId, id, media);
    this.resolvedMediaById.set(id, media ? { buffer: media.buffer, mimetype: media.mimetype, filename: media.filename } : null);

    const messageHash = messageHistory.hashTemplate(messageHashParts(message, persistedMedia));
    const duplicateWindowHours = messageHistory.clampWindowHours(options.duplicateWindowHours);
    if (!this._historyEntries) {
      this._historyEntries = await messageHistory.loadHistory('telegram', this.tenantId);
    }
    const results = this._buildInitialResults(recipients, duplicateWindowHours * 3_600_000, this._historyEntries, messageHash);

    const nowIso = new Date().toISOString();
    const campaign = {
      id,
      name,
      total: recipients.length,
      sent: 0,
      success: 0,
      failed: 0,
      skippedDuplicates: 0,
      messageHash,
      duplicateWindowHours,
      status: willRunImmediately ? 'running' : 'queued',
      paused: !willRunImmediately,
      userPaused: false,
      stopRequested: false,
      superseded: false,
      createdAt: nowIso,
      startedAt: willRunImmediately ? nowIso : null,
      finishedAt: null,
      lastProgressAt: nowIso,
      nextIndex: 0,
      lastProcessedIndex: -1,
      recipients,
      recipientType,
      message,
      results,
      sentContactIds: [],
      pendingContactIds: [],
      delaySeconds: Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds : undefined,
      minDelayMs,
      maxDelayMs,
      batchSize: Number.isInteger(batchSize) && batchSize > 0 ? batchSize : undefined,
      batchPauseSeconds: Number.isFinite(batchPauseSeconds) && batchPauseSeconds > 0 ? batchPauseSeconds : undefined,
      media: persistedMedia,
    };

    this.campaigns.set(id, campaign);
    this._persist(campaign);
    this._pruneOldCampaigns();

    if (willRunImmediately) {
      this.activeCampaignId = id;
      this._launch(campaign, 0);
    } else {
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): "${name}" ajoutée EN ATTENTE (${recipients.length} destinataires) — une autre campagne est déjà active.`);
    }

    return this._publicStatus(campaign);
  }

  async _releaseActive() {
    const current = this.activeCampaignId ? this.campaigns.get(this.activeCampaignId) : null;
    if (!current) {
      this.activeCampaignId = null;
      return;
    }

    if (current.status === 'running') {
      current.userPaused = true;
      current.paused = true;
      current.superseded = true;
      current.status = 'paused';
      this._persist(current);
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): "${current.name}" mise en PAUSE (bascule vers une autre campagne).`);
    }

    const deadline = Date.now() + RELEASE_TIMEOUT_MS;
    while (this._runActive && Date.now() < deadline) {
      await sleep(100);
    }
    this.activeCampaignId = null;
  }

  pause(id) {
    const campaign = id ? this.campaigns.get(id) : this._resolveDefaultCampaign();
    if (!campaign || campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    campaign.userPaused = true;
    campaign.paused = true;
    campaign.superseded = true;
    campaign.status = 'paused';
    if (this.activeCampaignId === campaign.id) this.activeCampaignId = null;
    this._persist(campaign);
    console.log(`Campagne Telegram (tenant "${this.tenantId}"): "${campaign.name}" mise en PAUSE — session disponible pour une autre campagne.`);
  }

  // Voir queues/campaignEngine.js#resume (même principe de bascule).
  async resume(id) {
    const campaign = id ? this.campaigns.get(id) : this._resolveDefaultCampaign();
    if (!campaign || (campaign.status !== 'queued' && campaign.status !== 'paused' && campaign.status !== 'running')) {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }

    if (campaign.status === 'running' && this.activeCampaignId === campaign.id) {
      return this._publicStatus(campaign);
    }

    if (this.activeCampaignId && this.activeCampaignId !== campaign.id) {
      await this._releaseActive();
    }

    campaign.userPaused = false;
    campaign.superseded = false;
    campaign.stopRequested = false;
    campaign.status = 'running';
    campaign.paused = false;
    if (!campaign.startedAt) campaign.startedAt = new Date().toISOString();
    this.activeCampaignId = campaign.id;
    this._persist(campaign);

    if (!this._runActive) {
      this._launch(campaign, campaign.nextIndex);
    }

    console.log(`Campagne Telegram (tenant "${this.tenantId}"): "${campaign.name}" reprise/lancée au destinataire ${campaign.nextIndex + 1}/${campaign.total}.`);
    return this._publicStatus(campaign);
  }

  stop(id) {
    const campaign = id ? this.campaigns.get(id) : this._resolveDefaultCampaign();
    if (!campaign || (campaign.status !== 'running' && campaign.status !== 'paused' && campaign.status !== 'queued')) {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    campaign.stopRequested = true;
    this._markRemainingInterrupted(campaign);
    campaign.superseded = true;
    if (this.activeCampaignId === campaign.id) {
      this.activeCampaignId = null;
      this.networkHealth = new circuitBreaker.CircuitBreakerState();
    }
    this._persist(campaign);
    removeMedia(campaign.media);
    this.resolvedMediaById.delete(campaign.id);
  }

  pauseForShutdown() {
    const campaign = this.activeCampaignId ? this.campaigns.get(this.activeCampaignId) : null;
    if (!campaign || campaign.status !== 'running') return;
    campaign.userPaused = true;
    campaign.paused = true;
    campaign.superseded = true;
    campaign.status = 'paused';
    this.activeCampaignId = null;
    this._persist(campaign);
    console.log(`Campagne Telegram (tenant "${this.tenantId}"): "${campaign.name}" mise en pause (session libérée) — reprise possible ultérieurement.`);
  }

  // Appelée dès que le COMPTE Telegram connecté sous ce tenant change :
  // l'ancien ET le nouveau compte n'ont RIEN en commun — toutes les
  // campagnes non terminales (running/paused/queued) sont annulées.
  reset() {
    for (const campaign of this.campaigns.values()) {
      if (campaign.status === 'running' || campaign.status === 'paused' || campaign.status === 'queued') {
        this._markRemainingInterrupted(campaign);
        campaign.superseded = true;
        campaign.status = 'cancelled';
        campaign.cancelReason = 'Compte Telegram déconnecté ou changé — campagne annulée.';
        removeMedia(campaign.media);
        this.resolvedMediaById.delete(campaign.id);
        console.log(`Campagne Telegram (tenant "${this.tenantId}"): "${campaign.name}" annulée — le compte Telegram connecté a changé.`);
      }
    }
    this._persist();
    this.campaigns.clear();
    this.activeCampaignId = null;
    this.incomingPauseUntil = 0;
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._lastHeartbeatAt = 0;
    this._runActive = false;
    this._historyEntries = null;
    this.resolvedMediaById.clear();
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

  // Voir queues/campaignEngine.js#resumeIfPending (même principe) : restaure
  // TOUTES les campagnes persistées, sans jamais relancer l'envoi
  // automatiquement.
  async resumeIfPending() {
    if (this.campaigns.size > 0) return false;

    const record = await this._loadRecord();
    if (!record || !Array.isArray(record.campaigns) || record.campaigns.length === 0) return false;

    let restoredAny = false;

    for (const saved of record.campaigns) {
      if (saved.status !== 'running' && saved.status !== 'paused' && saved.status !== 'queued') {
        this.campaigns.set(saved.id, saved);
        continue;
      }

      const migratedResults = this._migrateResults(saved.results, saved.recipients);

      try {
        this.resolvedMediaById.set(saved.id, await resolveMedia(saved.media));
      } catch (err) {
        console.error(
          `Campagne Telegram (tenant "${this.tenantId}", "${saved.name}"): reprise impossible — ${err.message}. ` +
          'Pièce jointe irrécupérable — campagne marquée "stopped", à relancer manuellement.',
        );
        this.campaigns.set(saved.id, {
          ...saved,
          results: migratedResults,
          status: 'stopped',
          paused: false,
          userPaused: false,
          stopRequested: true,
          superseded: false,
          finishedAt: new Date().toISOString(),
          resumeError: 'Pièce jointe introuvable après redéploiement — relancez la campagne.',
        });
        continue;
      }

      const restoredStatus = saved.status === 'queued' ? 'queued' : 'paused';
      this.campaigns.set(saved.id, {
        ...saved,
        results: migratedResults,
        status: restoredStatus,
        paused: true,
        userPaused: restoredStatus === 'paused',
        stopRequested: false,
        superseded: false,
      });
      if (restoredStatus === 'paused') restoredAny = true;
    }

    this.activeCampaignId = null;
    this.networkHealth = record.networkHealth
      ? circuitBreaker.CircuitBreakerState.fromJSON(record.networkHealth)
      : new circuitBreaker.CircuitBreakerState();
    this._persist();

    if (restoredAny) {
      console.log(`Campagne(s) Telegram (tenant "${this.tenantId}"): restaurée(s) en PAUSE après redémarrage/reconnexion — cliquez "Reprendre" sur la campagne voulue.`);
    }

    return restoredAny;
  }
}

// Voir queues/campaignEngine.js#listTenantsWithPendingCampaigns (même
// principe, dupliqué côté Telegram).
async function listTenantsWithPendingCampaigns() {
  const tenantsFromLocal = [];
  let localFiles = [];
  try {
    localFiles = fs.readdirSync(CAMPAIGNS_DIR);
  } catch (err) {
    // Dossier absent : rien en local, on continue quand même vers GitHub.
  }

  const hasPending = (record) => Array.isArray(record.campaigns)
    && record.campaigns.some((c) => c.status === 'running' || c.status === 'paused');

  for (const file of localFiles) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, file), 'utf8'));
      const tenantId = record.tenantId || file.replace(/\.json$/, '');
      if (hasPending(record)) {
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
      if (hasPending(record)) {
        tenantsFromRemote.push(tenantId);
      }
    } catch (err) {
      console.error(`État de campagne Telegram distant illisible (${filename}) :`, err.message);
    }
  }

  return [...tenantsFromLocal, ...tenantsFromRemote];
}

// Voir queues/campaignEngine.js#purgeStaleCampaigns (même principe et mêmes
// garanties, appliquées campagne par campagne).
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
    if (!Array.isArray(record.campaigns)) continue;

    const tenantId = record.tenantId || file.replace(/\.json$/, '');
    let changed = false;

    for (const campaign of record.campaigns) {
      if (campaign.status !== 'running' && campaign.status !== 'paused' && campaign.status !== 'queued') continue;

      const referenceTime = campaign.lastProgressAt || campaign.createdAt || campaign.startedAt;
      if (!referenceTime) continue;
      const ageMs = now - new Date(referenceTime).getTime();
      if (!Number.isFinite(ageMs) || ageMs < maxAgeMs) continue;

      const ageHours = Math.round(ageMs / 3_600_000);
      campaign.status = 'cancelled';
      campaign.paused = false;
      campaign.userPaused = false;
      campaign.stopRequested = true;
      campaign.finishedAt = new Date().toISOString();
      campaign.cancelReason = `Campagne inactive depuis plus de ${ageHours}h (aucun process ne l'a suivie) — annulée automatiquement.`;

      removeMedia(campaign.media);

      console.log(`Campagne Telegram (tenant "${tenantId}", "${campaign.name}") : annulée automatiquement après ${ageHours}h sans aucun signe de vie.`);
      purged.push({ tenantId, campaignId: campaign.id, name: campaign.name });
      changed = true;
    }

    if (!changed) continue;

    try {
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
    } catch (err) {
      console.error(`Purge campagnes Telegram (tenant "${tenantId}") : échec d'écriture locale —`, err.message);
      continue;
    }

    if (githubStore.enabled) {
      githubStore.createStore(remoteFilePath(tenantId)).pushRemote(JSON.stringify(record, null, 2)).catch((err) => {
        console.error(`Purge campagnes Telegram (tenant "${tenantId}") : échec de synchronisation GitHub —`, err.message);
      });
    }
  }

  return purged;
}

module.exports = {
  TelegramCampaignEngine,
  listTenantsWithPendingCampaigns,
  purgeStaleCampaigns,
  DEFAULT_STALE_MS,
};
