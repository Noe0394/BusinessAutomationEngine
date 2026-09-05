const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');
const { resolveSpintax } = require('../lib/spintax');

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
      truncated: c.truncated,
      sent: c.sent,
      success: c.success,
      failed: c.failed,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      nextIndex: c.nextIndex,
      recipients: c.recipients,
      message: c.message,
      results: c.results,
      minDelayMs: c.minDelayMs,
      maxDelayMs: c.maxDelayMs,
      media: this.persistedMedia,
    };
  }

  _persist() {
    if (!this.campaign) return;
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
    const { total, truncated, sent, success, failed, status, paused, userPaused, stopRequested, startedAt, finishedAt, results, resumeError } = this.campaign;
    const base = { total, truncated, sent, success, failed, status, paused, userPaused, stopRequested, startedAt, finishedAt, results };
    return resumeError ? { ...base, resumeError } : base;
  }

  // Gère à la fois la pause volontaire (boutons Pause/Reprendre) et la perte
  // de connexion (auto-pause le temps que Telegram se reconnecte, voir le
  // heartbeat de adapters/telegram.js qui relance la connexion tout seul en
  // arrière-plan) — les deux cas se traduisent de la même façon pour la file
  // d'attente : on attend avant de continuer, sans marquer les destinataires
  // restants comme échoués.
  async _waitWhileBlocked() {
    const campaign = this.campaign;
    if (!campaign.userPaused && this.session.isConnected()) {
      return;
    }

    campaign.paused = true;
    this._persist();
    if (campaign.userPaused) {
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): en pause (demandée par l'utilisateur).`);
    } else {
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): mise en pause — connexion perdue, en attente de reconnexion...`);
    }

    while (!campaign.stopRequested && (campaign.userPaused || !this.session.isConnected())) {
      await sleep(1000);
    }

    campaign.paused = false;
    if (!campaign.stopRequested) {
      console.log(`Campagne Telegram (tenant "${this.tenantId}"): reprise.`);
    }
  }

  // Comme interruptibleSleep (WhatsApp), mais réagit aussi à une pause
  // utilisateur déclenchée en pleine attente entre deux envois.
  async _interruptibleSleep(ms) {
    const campaign = this.campaign;
    const tickMs = 300;
    let elapsed = 0;
    while (elapsed < ms) {
      if (campaign.stopRequested) return;
      if (campaign.userPaused) {
        campaign.paused = true;
        await sleep(tickMs);
        continue;
      }
      campaign.paused = false;
      const step = Math.min(tickMs, ms - elapsed);
      await sleep(step);
      elapsed += step;
    }
  }

  _markRemainingInterrupted(fromIndex) {
    const campaign = this.campaign;
    for (let j = fromIndex; j < campaign.recipients.length; j += 1) {
      campaign.results.push({ to: String(campaign.recipients[j]), status: 'interrupted', timestamp: new Date().toISOString() });
    }
    campaign.nextIndex = campaign.recipients.length;
    campaign.status = 'stopped';
    campaign.paused = false;
    campaign.finishedAt = new Date().toISOString();
  }

  async _run(startIndex) {
    const campaign = this.campaign;
    const recipients = campaign.recipients;

    for (let i = startIndex; i < recipients.length; i += 1) {
      if (campaign.stopRequested) {
        this._markRemainingInterrupted(i);
        this._persist();
        console.log(`Campagne Telegram (tenant "${this.tenantId}"): interrompue par l'utilisateur.`);
        return;
      }

      await this._waitWhileBlocked();

      if (campaign.stopRequested) {
        this._markRemainingInterrupted(i);
        this._persist();
        console.log(`Campagne Telegram (tenant "${this.tenantId}"): interrompue par l'utilisateur.`);
        return;
      }

      const identifier = recipients[i];
      let status = 'failed';
      let errorReason = null;

      try {
        const entity = await this.session.resolveRecipient(identifier);
        // Résolu à chaque destinataire (voir lib/spintax.js) : deux
        // destinataires reçoivent alors rarement le texte identique mot pour
        // mot, même à partir du même modèle.
        const personalizedMessage = resolveSpintax(campaign.message);
        if (this.resolvedMedia) {
          await this.session.sendMedia(entity, { ...this.resolvedMedia, caption: personalizedMessage });
        } else {
          await this.session.sendMessage(entity, personalizedMessage);
        }
        status = 'delivered';
        campaign.success += 1;
        console.log(`Campagne Telegram (tenant "${this.tenantId}"): message envoyé à ${identifier} (${i + 1}/${recipients.length}).`);
      } catch (err) {
        campaign.failed += 1;
        errorReason = err.message || String(err);
        console.error(`Campagne Telegram (tenant "${this.tenantId}"): échec de l'envoi à ${identifier}:`, errorReason);
      }

      campaign.sent += 1;
      campaign.nextIndex = i + 1;
      campaign.results.push({ to: String(identifier), status, error: errorReason, timestamp: new Date().toISOString() });
      this._persist();
      if (this.onActivity) this.onActivity();

      if (i < recipients.length - 1 && !campaign.stopRequested) {
        await this._interruptibleSleep(randomDelay(campaign.minDelayMs, campaign.maxDelayMs));
      }
    }

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

    const { maxPerCycle, media } = options;
    const limitedRecipients = Number.isInteger(maxPerCycle) && maxPerCycle > 0
      ? recipients.slice(0, maxPerCycle)
      : recipients;

    const minDelayMs = clampDelayMs(options.minDelayMs) || MIN_DELAY_MS;
    const maxDelayMs = Math.max(clampDelayMs(options.maxDelayMs) || MAX_DELAY_MS, minDelayMs);

    this.persistedMedia = await persistMedia(this.tenantId, media);
    this.resolvedMedia = media ? { buffer: media.buffer, mimetype: media.mimetype, filename: media.filename } : null;

    this.campaign = {
      total: limitedRecipients.length,
      truncated: limitedRecipients.length < recipients.length,
      sent: 0,
      success: 0,
      failed: 0,
      status: 'running',
      paused: false,
      userPaused: false,
      stopRequested: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      nextIndex: 0,
      recipients: limitedRecipients,
      message,
      results: [],
      minDelayMs,
      maxDelayMs,
    };
    this._persist();

    this._run(0).catch((err) => {
      console.error(`Erreur pendant la campagne Telegram (tenant "${this.tenantId}"):`, err);
      this.campaign.status = 'stopped';
      this.campaign.paused = false;
      this.campaign.finishedAt = new Date().toISOString();
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

  resume() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.userPaused = false;
    this._persist();
  }

  stop() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.stopRequested = true;
    this.campaign.userPaused = false;
    this._persist();
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
  async resumeIfPending() {
    const record = await this._loadRecord();
    if (!record) return false;

    if (record.status !== 'running' && record.status !== 'paused') {
      return false;
    }

    this.persistedMedia = record.media || null;

    try {
      this.resolvedMedia = await resolveMedia(this.persistedMedia);
    } catch (err) {
      console.error(
        `Campagne Telegram (tenant "${this.tenantId}"): reprise impossible — ${err.message}. ` +
        'Pièce jointe irrécupérable — campagne marquée "stopped", à relancer manuellement.',
      );
      this.campaign = {
        ...record,
        status: 'stopped',
        paused: false,
        userPaused: false,
        stopRequested: true,
        finishedAt: new Date().toISOString(),
        resumeError: 'Pièce jointe introuvable après redéploiement — relancez la campagne.',
      };
      this._persist();
      return false;
    }

    this.campaign = {
      ...record,
      status: 'running',
      paused: false,
      finishedAt: null,
    };
    this._persist();

    console.log(
      `Campagne Telegram (tenant "${this.tenantId}"): reprise après redémarrage à partir du destinataire ${record.nextIndex + 1}/${record.total}.`,
    );

    this._run(record.nextIndex).catch((err) => {
      console.error(`Erreur pendant la reprise de campagne Telegram (tenant "${this.tenantId}"):`, err);
      this.campaign.status = 'stopped';
      this.campaign.paused = false;
      this.campaign.finishedAt = new Date().toISOString();
      this._persist();
    });

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

module.exports = {
  TelegramCampaignEngine,
  listTenantsWithPendingCampaigns,
};
