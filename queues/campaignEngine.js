const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const githubStore = require('../githubStore');
const { normalizeRecipientEntry, jidToE164 } = require('../lib/whatsappRecipients');
const { personalizeMessage } = require('../lib/personalization');
const circuitBreaker = require('../lib/circuitBreaker');
const messageHistory = require('../lib/messageHistory');

// GESTIONNAIRE MULTI-CAMPAGNES (Play / Pause / Reprise intelligente) — un
// tenant peut désormais posséder PLUSIEURS campagnes stockées simultanément
// (this.campaigns : Map<id, campaign>), mais une seule à la fois est
// AUTORISÉE À ENVOYER sur la session WhatsApp partagée de ce tenant
// (this.activeCampaignId + this._runActive) : basculer vers une autre
// campagne (resume(id) sur une campagne différente de l'active) met
// d'abord l'ancienne en PAUSE et attend que sa boucle d'envoi ait
// réellement quitté avant de lancer la nouvelle — jamais deux boucles
// d'envoi concurrentes sur la même session.
//
// Cycle de vie d'une campagne : 'queued' (créée pendant qu'une autre
// campagne est active — EN ATTENTE, jamais démarrée) -> 'running' (EN
// COURS) <-> 'paused' (EN PAUSE, via pause()/resume() ou une bascule vers
// une autre campagne) -> 'completed' (TERMINÉE) | 'stopped' | 'cancelled'
// (arrêt définitif). Voir CampaignEngine#resume pour la bascule.
//
// Persistance de la progression, tenant par tenant (voir
// adapters/whatsappManager.js) : sur un environnement Docker/Render où le
// conteneur est éphémère, un redéploiement/crash ne doit ni perdre la
// progression déjà envoyée, ni renvoyer les messages déjà livrés au
// redémarrage. Chaque tenant a désormais UN SEUL fichier d'état local
// (CAMPAIGNS_DIR/<tenantId>.json) qui porte TOUTES ses campagnes (tableau
// "campaigns"), ET son équivalent sur GitHub (REMOTE_CAMPAIGNS_DIR/<tenantId>.json,
// même principe que licenses.js et adapters/whatsappAuthStore.js) — jamais
// partagés, comme le reste de la session WhatsApp de ce tenant.
//
// Chaque campagne conserve explicitement `lastProcessedIndex`,
// `sentContactIds` et `pendingContactIds` (voir _refreshContactIdSets,
// recalculés à chaque persistance) — dérivés de `results[]`/`nextIndex`,
// mais exposés tels quels pour que la reprise ("PLAY") puisse toujours
// repartir exactement à `lastProcessedIndex + 1` SANS jamais renvoyer un
// destinataire déjà présent dans `sentContactIds` (garantie ZÉRO DOUBLON,
// renforcée par le Smart Screening anti-doublons ci-dessous).
//
// Les pièces jointes (buffers média) sont sauvegardées sur GitHub elles
// aussi, mais PAS via l'API "Contents" (limitée à 1 Mo) : voir
// githubStore.js#pushLargeFile/fetchLargeFile, qui passent par l'API Git Data
// (blobs) de GitHub — jusqu'à ~100 Mo par fichier. Le sha du blob est
// conservé dans l'état de la campagne pour pouvoir le relire même depuis un
// conteneur qui n'a jamais vu ce fichier localement. Nommage
// "<tenantId>_<campaignId>_<index>.bin" (préfixé par campaignId) pour que
// deux campagnes du même tenant n'entrent jamais en collision sur disque.
//
// IMPORTANT (limite connue, indépendante de GitHub) : l'état est persisté
// APRÈS l'envoi effectif de chaque destinataire, pas avant — un crash
// survenant pile entre l'envoi réel et l'écriture du fichier peut donc faire
// renvoyer UN SEUL message (celui en cours au moment du crash) à la reprise.
const CAMPAIGNS_DIR = process.env.CAMPAIGNS_DIR || path.join(__dirname, '..', 'campaigns_state');
const MEDIA_DIR = path.join(CAMPAIGNS_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const REMOTE_CAMPAIGNS_DIR = process.env.GITHUB_CAMPAIGNS_DIR || 'campaigns_state';
const MEDIA_REMOTE_DIR = `${REMOTE_CAMPAIGNS_DIR}/media`;

if (!process.env.CAMPAIGNS_DIR && !githubStore.enabled) {
  console.warn(
    `CAMPAIGNS_DIR non défini et sauvegarde GitHub désactivée : la progression des campagnes WhatsApp est stockée dans "${CAMPAIGNS_DIR}" sur le disque local uniquement. ` +
    'Sur Render/Docker, ce dossier est effacé à chaque redéploiement/redémarrage sauf disque persistant (volume Docker monté sur ce chemin) ou GITHUB_TOKEN/GITHUB_DATA_REPO configurés.',
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

// Cadencement naturel par défaut (feuille de route "Régulation et délais
// naturels d'envoi") : intervalle aléatoire entre deux destinataires, et
// pause de courtoisie régulière au-delà d'un certain nombre de messages —
// non contournable depuis le frontend, seulement ajustable dans une
// fourchette raisonnable via options.minDelayMs/maxDelayMs.
const MIN_DELAY_MS = 45_000;
const MAX_DELAY_MS = 120_000;
const COURTESY_BATCH_SIZE = 10;
const COURTESY_PAUSE_MS = 15 * 60_000;

function clampDelayMs(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, MIN_DELAY_MS), MAX_DELAY_MS);
}

// Durée de la pause appliquée à la file d'attente dès qu'un contact répond
// pendant l'envoi d'une campagne (voir CampaignEngine#_pauseForIncomingReply) :
// laisse le temps à l'opérateur de lire/traiter la réponse avant que la
// campagne ne reprenne l'envoi au destinataire suivant.
const INCOMING_REPLY_PAUSE_MS = 30_000;

// Fréquence à laquelle une attente potentiellement longue (pause manuelle,
// coupure réseau, palier FLOOD_WAIT de plusieurs heures...) rafraîchit
// lastProgressAt (voir CampaignEngine#_heartbeat) : prouve qu'un process
// suit toujours activement la campagne, même sans envoi réel depuis un
// moment, pour que purgeStaleCampaigns() ne l'annule jamais à tort.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

// Seuil par défaut au-delà duquel purgeStaleCampaigns() annule une campagne
// dont plus personne (aucun process actif) ne fait progresser ni ne
// rafraîchit l'état — jamais une campagne activement suivie (voir
// _heartbeat), aussi longue que soit son attente. S'applique aussi aux
// campagnes 'queued' jamais démarrées (référence : leur date de création).
const DEFAULT_STALE_MS = (parseFloat(process.env.CAMPAIGN_STALE_HOURS) || 48) * 3_600_000;

// Attente bornée, lors d'une bascule vers une autre campagne (voir
// CampaignEngine#_releaseActive), de la sortie effective de la boucle
// d'envoi actuellement active avant de lancer la nouvelle campagne — évite
// que deux boucles n'envoient concurremment sur la même session le temps
// que la première remarque qu'on lui a demandé de céder la main.
const RELEASE_TIMEOUT_MS = 20_000;

// Nombre maximal de campagnes TERMINALES (completed/stopped/cancelled)
// conservées par tenant (voir CampaignEngine#_pruneOldCampaigns) : les
// campagnes actives (running/paused/queued) ne sont jamais purgées ici,
// seul l'historique le plus ancien est élagué — évite qu'un fichier d'état
// ne grossisse indéfiniment au fil des mois (limite de l'API Contents
// GitHub à 1 Mo pour ce fichier, voir githubStore.js).
const MAX_RETAINED_CAMPAIGNS = 20;

// Délai non-bloquant, interrompable dès que shouldStop() devient vrai (ex:
// STOP demandé par l'utilisateur en pleine attente entre deux destinataires).
async function interruptibleSleep(ms, shouldStop) {
  const tickMs = 300;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldStop()) return;
    const step = Math.min(tickMs, ms - elapsed);
    await sleep(step);
    elapsed += step;
  }
}

// Convertit les étapes { type: 'media', buffer, ... } en références disque
// (mediaFile) écrites une seule fois au lancement de la campagne — la
// campagne peut durer des heures, il faut que ces fichiers survivent à un
// redémarrage du process pour que la reprise (resumeIfPending) puisse les
// relire sans redemander l'upload original à l'utilisateur. Poussé aussi sur
// GitHub (mediaBlobSha) quand activé, pour survivre à un redéploiement qui
// viderait le disque local.
async function persistSequenceMedia(tenantId, campaignId, sequence) {
  const result = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const step = sequence[index];
    if (step.type !== 'media') {
      result.push(step);
      continue;
    }

    const mediaFile = `${tenantId}_${campaignId}_${index}.bin`;
    fs.writeFileSync(path.join(MEDIA_DIR, mediaFile), step.buffer);

    let mediaBlobSha = null;
    if (githubStore.enabled) {
      try {
        mediaBlobSha = await githubStore.pushLargeFile(`${MEDIA_REMOTE_DIR}/${mediaFile}`, step.buffer);
      } catch (err) {
        console.error(`Échec de la sauvegarde GitHub de la pièce jointe "${mediaFile}" :`, err.message);
      }
    }

    result.push({
      type: 'media',
      mediaFile,
      mediaBlobSha,
      mimetype: step.mimetype,
      filename: step.filename,
      forceDocument: Boolean(step.forceDocument),
    });
  }
  return result;
}

// Inverse de persistSequenceMedia : relit les buffers pour l'envoi. Essaie le
// disque local en premier (rapide) ; si le fichier est absent (redéploiement
// ayant vidé le disque éphémère) et qu'un mediaBlobSha existe, le
// retélécharge depuis GitHub et le réécrit localement avant de continuer.
async function resolveSequenceMedia(sequence) {
  const result = [];
  for (const step of sequence) {
    if (step.type !== 'media') {
      result.push(step);
      continue;
    }

    const filePath = path.join(MEDIA_DIR, step.mediaFile);
    let buffer;
    if (fs.existsSync(filePath)) {
      buffer = fs.readFileSync(filePath);
    } else if (step.mediaBlobSha && githubStore.enabled) {
      try {
        buffer = await githubStore.fetchLargeFile(step.mediaBlobSha);
      } catch (err) {
        throw new Error(`MEDIA_FILE_MISSING: ${step.mediaFile} (échec de restauration GitHub : ${err.message})`);
      }
      if (!buffer) {
        throw new Error(`MEDIA_FILE_MISSING: ${step.mediaFile} (introuvable sur GitHub)`);
      }
      fs.writeFileSync(filePath, buffer);
      console.log(`Pièce jointe "${step.mediaFile}" restaurée depuis GitHub (disque local vidé par un redéploiement).`);
    } else {
      throw new Error(`MEDIA_FILE_MISSING: ${step.mediaFile}`);
    }

    result.push({
      type: 'media',
      buffer,
      mimetype: step.mimetype,
      filename: step.filename,
      forceDocument: step.forceDocument,
    });
  }
  return result;
}

function removeSequenceMedia(sequence) {
  for (const step of sequence) {
    if (step.type === 'media' && step.mediaFile) {
      fs.rmSync(path.join(MEDIA_DIR, step.mediaFile), { force: true });
    }
  }
}

// Empreinte du MODÈLE de séquence (avant personnalisation par destinataire),
// pour l'anti-doublons (voir lib/messageHistory.js#hashTemplate).
function sequenceHashParts(sequence) {
  return (sequence || []).map((step) => (
    step.type === 'media'
      ? `media:${step.filename || ''}:${step.mimetype || ''}`
      : `text:${step.text || ''}`
  ));
}

// Un moteur par tenant (voir adapters/whatsappManager.js), lié à l'instance
// WhatsApp de ce même tenant : aucune campagne, aucun destinataire, aucun
// résultat n'est jamais partagé entre deux clés de licence.
class CampaignEngine {
  // onActivity : callback optionnel (voir adapters/sessionRegulator.js)
  // invoqué après chaque envoi réel — repousse l'échéance d'inactivité de 15
  // minutes du tenant pendant qu'une campagne tourne en tâche de fond.
  constructor(tenantId, session, onActivity) {
    this.tenantId = tenantId;
    this.session = session;
    this.onActivity = onActivity;
    // Toutes les campagnes connues de ce tenant (en cours, en pause, en
    // attente, ou terminées — voir MAX_RETAINED_CAMPAIGNS pour l'élagage de
    // l'historique). Clé = campaign.id.
    this.campaigns = new Map();
    // Séquences résolues (buffers réels, jamais sérialisées) — une par
    // campagne, tenue à part de `campaigns` qui ne contient que des données
    // persistables (voir persistableSequence dans campaign.options.sequence).
    this.resolvedSequences = new Map();
    // Id de la SEULE campagne actuellement autorisée à envoyer sur cette
    // session — null si aucune campagne n'envoie activement (toutes en
    // pause/attente/terminées). Voir resume()/_releaseActive() pour la
    // bascule d'une campagne à l'autre.
    this.activeCampaignId = null;
    this.remoteStore = githubStore.createStore(remoteFilePath(tenantId));
    // Horodatage (Date.now()) jusqu'auquel la file d'attente doit rester en
    // pause suite à une réponse entrante — 0 tant qu'aucune réponse n'a été
    // reçue. Propriété de l'instance : elle n'a pas besoin de survivre à un
    // redémarrage du process, contrairement au reste de l'état de campagne.
    this.incomingPauseUntil = 0;
    if (typeof session.onIncomingMessage === 'function') {
      session.onIncomingMessage(() => this._pauseForIncomingReply());
    }
    // Supervision de santé réseau et coupe-circuit (voir lib/circuitBreaker.js) :
    // partagée entre toutes les campagnes du tenant (même connexion
    // WhatsApp sous-jacente), jamais persistée par campagne individuelle.
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._lastHeartbeatAt = 0;
    // true tant qu'une boucle d'envoi (_run) est en vie pour CE tenant — un
    // seul _run actif à la fois, quelle que soit la campagne concernée (voir
    // _releaseActive, qui attend que ce booléen repasse à false avant de
    // lancer une autre campagne).
    this._runActive = false;
    // Historique des envois (voir lib/messageHistory.js), chargé une fois
    // par tenant (pas par campagne) — partagé par toutes les campagnes de ce
    // tenant puisque l'anti-doublons doit rester valable même en changeant
    // de campagne. null tant qu'il n'a pas encore été chargé.
    this._historyEntries = null;
  }

  // Rafraîchit lastProgressAt de la campagne fournie (voir _persist) pendant
  // une attente potentiellement longue, au plus une fois toutes les
  // HEARTBEAT_INTERVAL_MS.
  _heartbeat(campaign) {
    const now = Date.now();
    if (now - this._lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    this._lastHeartbeatAt = now;
    this._persist(campaign);
  }

  _recordSendLatency(elapsedMs) {
    if (this.networkHealth.recordLatency(elapsedMs)) {
      console.log(
        `Campagne (tenant "${this.tenantId}"): latence élevée (${elapsedMs}ms) sur 2 requêtes consécutives — ` +
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
      const { to } = normalizeRecipientEntry(recipient, this.session.getContactName);
      const key = messageHistory.normalizeContactKey(to);
      const isDuplicate = Boolean(key) && (historySeen.has(key) || seenInThisCampaign.has(key));
      if (key) seenInThisCampaign.add(key);
      return { to, status: isDuplicate ? 'skipped_duplicate' : 'pending', timestamp: null };
    });
  }

  _migrateResults(results, recipients) {
    const list = Array.isArray(results) ? results.slice() : [];
    for (let i = list.length; i < recipients.length; i += 1) {
      const { to } = normalizeRecipientEntry(recipients[i], this.session.getContactName);
      list.push({ to, status: 'pending', timestamp: null });
    }
    return list.map((r) => {
      if (r.status === 'delivered') return { ...r, status: 'sent' };
      if (r.status === 'interrupted') return { ...r, status: 'pending' };
      return r;
    });
  }

  // Enregistre un envoi réellement effectué dans l'historique anti-doublons
  // (voir lib/messageHistory.js) — partagé par toutes les campagnes du
  // tenant (voir this._historyEntries).
  async _recordHistorySent(contactKey, messageHash) {
    if (!contactKey) return;
    if (!this._historyEntries) {
      this._historyEntries = await messageHistory.loadHistory('whatsapp', this.tenantId);
    }
    this._historyEntries.push({ contactKey, messageHash, sentAt: new Date().toISOString() });
    this._historyEntries = messageHistory.saveHistory('whatsapp', this.tenantId, this._historyEntries);
  }

  async _waitForNetworkHold(campaign) {
    const health = this.networkHealth;
    if (!health.isHeld()) return;

    campaign.paused = true;
    this._persist(campaign);
    console.log(
      `Campagne (tenant "${this.tenantId}", "${campaign.name}"): file en pause — statut réseau '${health.networkStatus}', ` +
      `reprise prévue vers ${new Date(health.holdUntil).toISOString()}.`,
    );

    while (!campaign.stopRequested && !campaign.superseded && health.isHeld()) {
      this._heartbeat(campaign);
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    while (!campaign.stopRequested && !campaign.superseded && !this.session.isConnected()) {
      console.log(`Campagne (tenant "${this.tenantId}", "${campaign.name}"): health check négatif — nouvelle vérification dans 30s avant reprise.`);
      this._heartbeat(campaign);
      await sleep(circuitBreaker.HEALTH_RECHECK_INTERVAL_MS);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    const wasCircuitOpen = health.networkStatus === 'circuit_open';
    health.networkStatus = 'normal';
    campaign.paused = false;
    this._persist(campaign);
    console.log(
      `Campagne (tenant "${this.tenantId}", "${campaign.name}"): health check nominal — reprise de l'envoi` +
      `${wasCircuitOpen ? ' au destinataire précédemment en échec de surcharge' : ''}.`,
    );
  }

  // Appelé par l'adaptateur WhatsApp dès qu'un message entrant est reçu —
  // ne fait rien si aucune campagne n'est activement en train d'envoyer.
  _pauseForIncomingReply() {
    const campaign = this.activeCampaignId ? this.campaigns.get(this.activeCampaignId) : null;
    if (!campaign || campaign.status !== 'running') return;
    const until = Date.now() + INCOMING_REPLY_PAUSE_MS;
    if (until > this.incomingPauseUntil) {
      this.incomingPauseUntil = until;
      console.log(`Campagne (tenant "${this.tenantId}"): réponse entrante détectée — pause de ${INCOMING_REPLY_PAUSE_MS / 1000}s avant de reprendre l'envoi.`);
    }
  }

  async _waitForIncomingPause(campaign) {
    while (Date.now() < this.incomingPauseUntil) {
      if (campaign.stopRequested || campaign.superseded) return;
      await sleep(300);
    }
  }

  // Recalcule les listes explicites des prospects déjà traités
  // (sentContactIds : envoyés OU ignorés en doublon OU relancés
  // manuellement — dans tous ces cas, ce contact ne doit plus jamais
  // recevoir ce message) et restants (pendingContactIds), ainsi que
  // lastProcessedIndex (= nextIndex - 1) — appelé à chaque persistance pour
  // que ces champs restent toujours exacts dans le fichier d'état ET dans
  // la réponse de l'API de statut.
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
      // Voir lib/circuitBreaker.js#toJSON : persisté pour qu'une pause de
      // sécurité ('degraded_network'/'circuit_open') survive à un
      // redéploiement plutôt que d'être silencieusement oubliée.
      networkHealth: this.networkHealth.toJSON(),
      campaigns: Array.from(this.campaigns.values()),
    };
  }

  // campaign (optionnel) : quand fourni, son lastProgressAt et ses listes de
  // contacts (voir _refreshContactIdSets) sont rafraîchis avant l'écriture —
  // sinon (ex: après reset()), seul l'état déjà en mémoire est réécrit tel
  // quel.
  _persist(campaign) {
    if (campaign) {
      campaign.lastProgressAt = new Date().toISOString();
      this._refreshContactIdSets(campaign);
    }
    const content = JSON.stringify(this._buildFileRecord(), null, 2);
    // Écriture locale synchrone volontaire : garantit que l'état sur disque
    // est à jour avant que la boucle d'envoi ne poursuive vers le
    // destinataire suivant.
    fs.writeFileSync(statePath(this.tenantId), content, 'utf8');
    // Sauvegarde GitHub en fire-and-forget : jamais bloquant pour la boucle
    // d'envoi, un échec ponctuel n'interrompt pas la campagne.
    this.remoteStore.pushRemote(content).catch((err) => {
      console.error(`Échec de la sauvegarde des campagnes sur GitHub pour le tenant "${this.tenantId}" :`, err.message);
    });
  }

  // Élague l'historique des campagnes TERMINALES (completed/stopped/
  // cancelled) au-delà de MAX_RETAINED_CAMPAIGNS, les plus anciennes
  // d'abord — ne touche jamais une campagne active (running/paused/queued).
  _pruneOldCampaigns() {
    const terminal = Array.from(this.campaigns.values())
      .filter((c) => c.status === 'completed' || c.status === 'stopped' || c.status === 'cancelled')
      .sort((a, b) => new Date(a.finishedAt || a.createdAt) - new Date(b.finishedAt || b.createdAt));
    const nonTerminalCount = this.campaigns.size - terminal.length;
    const keepTerminal = Math.max(0, MAX_RETAINED_CAMPAIGNS - nonTerminalCount);
    const toRemove = terminal.slice(0, Math.max(0, terminal.length - keepTerminal));
    for (const campaign of toRemove) {
      this.campaigns.delete(campaign.id);
      this.resolvedSequences.delete(campaign.id);
    }
  }

  // Choisit la campagne visée par un appel n'indiquant pas explicitement
  // d'id (compat avec l'ancien dashboard mono-campagne, voir
  // /api/messages/status, pause, resume, stop) : la campagne active si elle
  // existe, sinon la campagne non terminée la plus récemment mise à jour,
  // sinon (aucune campagne active) la plus récente tout court.
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

  // Forme publique d'une campagne (API/dashboard) : recipients reste
  // interne (utile pour _persist()/resumeIfPending()/relance manuelle) mais
  // n'est jamais renvoyé — une liste de destinataires potentiellement
  // longue n'a rien à faire dans une réponse HTTP interrogée toutes les
  // quelques secondes. `isActive` indique si CETTE campagne est celle
  // actuellement autorisée à envoyer sur la session (utile au dashboard pour
  // distinguer, parmi plusieurs campagnes 'running' historiques, laquelle
  // envoie réellement en ce moment).
  _publicStatus(campaign) {
    const {
      id, name, total, sent, success, failed, skippedDuplicates, duplicateWindowHours,
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

  // Statut d'UNE campagne (id fourni) ou de la campagne "par défaut" (voir
  // _resolveDefaultCampaign) — utilisé par /api/messages/status (dashboard
  // mono-campagne existant) et par la nouvelle vue multi-campagnes.
  getStatus(id) {
    const campaign = id ? this.campaigns.get(id) : this._resolveDefaultCampaign();
    if (!campaign) return null;
    return this._publicStatus(campaign);
  }

  // Liste complète des campagnes du tenant (EN COURS/EN PAUSE/TERMINÉE/EN
  // ATTENTE), les plus récentes d'abord — alimente le tableau de bord
  // "Gestionnaire Multi-Campagnes".
  listCampaigns() {
    return Array.from(this.campaigns.values())
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((c) => this._publicStatus(c));
  }

  getManualRelaunchQueue(id) {
    const campaign = id ? this.campaigns.get(id) : this._resolveDefaultCampaign();
    if (!campaign) return [];
    const textStep = (campaign.options.sequence || []).find((step) => step && step.type !== 'media' && step.text);
    const template = textStep ? textStep.text : '';
    const items = [];
    campaign.results.forEach((result, index) => {
      if (result.status !== 'pending' && result.status !== 'failed') return;
      const { nom, vars } = normalizeRecipientEntry(campaign.recipients[index], this.session.getContactName);
      items.push({
        index,
        to: result.to,
        phone: jidToE164(result.to),
        name: nom,
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

  async _waitForConnection(campaign) {
    if (this.session.isConnected()) return;

    campaign.paused = true;
    this._persist(campaign);
    console.log(`Campagne (tenant "${this.tenantId}", "${campaign.name}"): mise en pause — connexion WhatsApp perdue, en attente de reconnexion...`);

    while (!this.session.isConnected() && !campaign.stopRequested && !campaign.superseded) {
      this._heartbeat(campaign);
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    campaign.paused = false;
    console.log(`Campagne (tenant "${this.tenantId}", "${campaign.name}"): reprise après reconnexion WhatsApp.`);
  }

  // `results[]` est pré-rempli dès start() : chaque destinataire non encore
  // traité au moment d'un STOP reste honnêtement 'pending' (ou
  // 'skipped_duplicate'), rien à y réécrire ici.
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
      console.error(`Erreur pendant la campagne (tenant "${this.tenantId}", "${campaign.name}"):`, err);
      if (campaign.stopRequested || campaign.superseded) return;
      campaign.status = 'stopped';
      campaign.paused = false;
      campaign.finishedAt = new Date().toISOString();
      if (this.activeCampaignId === campaign.id) this.activeCampaignId = null;
      this._persist(campaign);
    });
  }

  async _runLoop(campaign, startIndex) {
    const { delaySeconds, minDelayMs, maxDelayMs, batchSize, batchPauseSeconds, sequenceDelayMinMs, sequenceDelayMaxMs } = campaign.options;
    const recipients = campaign.recipients;
    const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : COURTESY_BATCH_SIZE;
    const seqMinMs = Number.isFinite(sequenceDelayMinMs) ? sequenceDelayMinMs : 2000;
    const seqMaxMs = Number.isFinite(sequenceDelayMaxMs) ? Math.max(seqMinMs, sequenceDelayMaxMs) : Math.max(seqMinMs, 5000);
    const sequence = this.resolvedSequences.get(campaign.id) || [];

    // Abandonne silencieusement ce passage de boucle SANS retoucher
    // `campaign` : soit stop()/pause() a déjà tout finalisé de façon
    // synchrone, soit une bascule vers une autre campagne (_releaseActive) a
    // déjà marqué celle-ci "paused" pour une reprise ultérieure — dans les
    // deux cas, re-persister ici écraserait un état déjà correct.
    const shouldAbort = () => campaign.stopRequested || campaign.superseded;

    let i = startIndex;
    while (i < recipients.length) {
      if (shouldAbort()) return;

      await this._waitForConnection(campaign);
      if (shouldAbort()) return;

      await this._waitForIncomingPause(campaign);
      if (shouldAbort()) return;

      await this._waitForNetworkHold(campaign);
      if (shouldAbort()) return;

      // Smart Screening (voir start()) : ce contact a déjà reçu ce même
      // modèle de message dans la fenêtre anti-doublons (ou apparaît en
      // double dans la liste importée) — statut déjà déterminé, on saute
      // INSTANTANÉMENT, sans requête réseau ni délai inter-destinataire.
      if (campaign.results[i].status === 'skipped_duplicate') {
        campaign.results[i].timestamp = new Date().toISOString();
        campaign.sent += 1;
        campaign.skippedDuplicates += 1;
        campaign.nextIndex = i + 1;
        this._persist(campaign);
        if (this.onActivity) this.onActivity();
        console.log(`Campagne (tenant "${this.tenantId}", "${campaign.name}"): destinataire ${campaign.results[i].to} ignoré (doublon détecté, ${i + 1}/${recipients.length}).`);
        i += 1;
        continue;
      }

      // Synchronisation Auto <-> Manuel (Relance Manuelle Express) : ce
      // destinataire a déjà été traité à la main pendant que la campagne
      // était en pause/à l'arrêt (voir markManualSent) — jamais de doublon.
      if (campaign.results[i].status === 'sent_manual') {
        campaign.sent += 1;
        campaign.nextIndex = i + 1;
        this._persist(campaign);
        if (this.onActivity) this.onActivity();
        console.log(`Campagne (tenant "${this.tenantId}", "${campaign.name}"): destinataire ${campaign.results[i].to} ignoré (déjà relancé manuellement, ${i + 1}/${recipients.length}).`);
        i += 1;
        continue;
      }

      const { to, vars } = normalizeRecipientEntry(recipients[i], this.session.getContactName);
      let status = 'failed';
      let overloadDetected = false;

      try {
        for (let s = 0; s < sequence.length; s += 1) {
          const step = sequence[s];
          const sendStartedAt = Date.now();
          if (step.type === 'media') {
            await this.session.sendMedia(to, step);
          } else {
            await this.session.sendMessage(to, personalizeMessage(step.text, vars));
          }
          this._recordSendLatency(Date.now() - sendStartedAt);
          if (s < sequence.length - 1) {
            await sleep(randomDelay(seqMinMs, seqMaxMs));
          }
        }
        status = 'sent';
        campaign.success += 1;
        this.networkHealth.recordSuccess();
        await this._recordHistorySent(messageHistory.normalizeContactKey(to), campaign.messageHash);
        console.log(`Campagne (tenant "${this.tenantId}", "${campaign.name}"): séquence envoyée à ${to} (${i + 1}/${recipients.length}).`);
      } catch (err) {
        if (circuitBreaker.isOverloadError(err)) {
          overloadDetected = true;
          const backoffMs = this.networkHealth.recordOverloadFailure(err);
          if (!shouldAbort()) this._persist(campaign);
          console.log(
            `Campagne (tenant "${this.tenantId}", "${campaign.name}"): signal de surcharge détecté (${err.message}) — ` +
            `statut 'circuit_open', nouvelle tentative pour ${to} dans ${Math.round(backoffMs / 60000)} min (index ${i} conservé).`,
          );
        } else {
          campaign.failed += 1;
          console.error(`Campagne (tenant "${this.tenantId}", "${campaign.name}"): échec de l'envoi à ${to}:`, err);
        }
      }

      if (shouldAbort()) return;

      if (overloadDetected) {
        continue;
      }

      campaign.sent += 1;
      campaign.nextIndex = i + 1;
      campaign.results[i] = { to, status, timestamp: new Date().toISOString() };
      this._persist(campaign);
      if (this.onActivity) this.onActivity();

      i += 1;

      if (i < recipients.length && !shouldAbort()) {
        const baseDelayMs = Number.isFinite(delaySeconds) && delaySeconds > 0
          ? delaySeconds * 1000
          : randomDelay(minDelayMs || MIN_DELAY_MS, maxDelayMs || MAX_DELAY_MS);
        const endOfBatch = i % batch === 0;
        const batchPauseMs = Number.isFinite(batchPauseSeconds) && batchPauseSeconds > 0
          ? batchPauseSeconds * 1000
          : COURTESY_PAUSE_MS;
        const delayMs = endOfBatch ? batchPauseMs : baseDelayMs;
        await interruptibleSleep(delayMs, shouldAbort);
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

    removeSequenceMedia(campaign.options.sequence || []);
    this.resolvedSequences.delete(campaign.id);
    console.log(`Campagne (tenant "${this.tenantId}", "${campaign.name}"): terminée.`);
  }

  // Crée une NOUVELLE campagne et la stocke dans la file du tenant.
  // - Si aucune campagne n'est actuellement active sur la session, elle
  //   démarre immédiatement (status 'running').
  // - Sinon : par défaut (compat avec les appelants historiques —
  //   programmation multi-canal, commandes IA en langage naturel), lève
  //   CAMPAIGN_IN_PROGRESS comme avant. Avec `options.enqueueIfBusy: true`
  //   (nouveau Gestionnaire Multi-Campagnes du dashboard), elle est stockée
  //   'queued' (EN ATTENTE) au lieu d'échouer — à démarrer plus tard via
  //   resume(id).
  async start(recipients, options = {}) {
    const activeCampaign = this.activeCampaignId ? this.campaigns.get(this.activeCampaignId) : null;
    const busy = Boolean(activeCampaign) && activeCampaign.status === 'running';
    if (busy && !options.enqueueIfBusy) {
      throw new Error('CAMPAIGN_IN_PROGRESS');
    }

    const id = crypto.randomUUID();
    const name = (options.name && String(options.name).trim()) || `Campagne du ${new Date().toLocaleString('fr-FR')}`;
    const willRunImmediately = !busy;

    const persistableSequence = await persistSequenceMedia(this.tenantId, id, options.sequence || []);
    this.resolvedSequences.set(id, await resolveSequenceMedia(persistableSequence));

    // Smart Screening anti-doublons (voir lib/messageHistory.js) : calculé
    // UNE FOIS ici, avant le premier envoi. duplicateWindowHours par défaut
    // à 48h, réglable de 1h à 720h (30 jours) par campagne.
    const messageHash = messageHistory.hashTemplate(sequenceHashParts(persistableSequence));
    const duplicateWindowHours = messageHistory.clampWindowHours(options.duplicateWindowHours);
    if (!this._historyEntries) {
      this._historyEntries = await messageHistory.loadHistory('whatsapp', this.tenantId);
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
      results,
      sentContactIds: [],
      pendingContactIds: [],
      options: {
        delaySeconds: options.delaySeconds,
        minDelayMs: clampDelayMs(options.minDelayMs) || MIN_DELAY_MS,
        maxDelayMs: Math.max(clampDelayMs(options.maxDelayMs) || MAX_DELAY_MS, clampDelayMs(options.minDelayMs) || MIN_DELAY_MS),
        batchSize: options.batchSize,
        batchPauseSeconds: options.batchPauseSeconds,
        sequenceDelayMinMs: options.sequenceDelayMinMs,
        sequenceDelayMaxMs: options.sequenceDelayMaxMs,
        sequence: persistableSequence,
      },
    };

    this.campaigns.set(id, campaign);
    this._persist(campaign);
    this._pruneOldCampaigns();

    if (willRunImmediately) {
      this.activeCampaignId = id;
      this._launch(campaign, 0);
    } else {
      console.log(`Campagne (tenant "${this.tenantId}"): "${name}" ajoutée EN ATTENTE (${recipients.length} destinataires) — une autre campagne est déjà active.`);
    }

    return this._publicStatus(campaign);
  }

  // Met en pause la campagne active (ou celle actuellement en train de
  // basculer) et attend, dans une limite de RELEASE_TIMEOUT_MS, que sa
  // boucle d'envoi ait réellement quitté — pour ne jamais laisser deux
  // boucles envoyer concurremment sur la même session au moment de basculer
  // vers une autre campagne (voir resume()).
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
      console.log(`Campagne (tenant "${this.tenantId}"): "${current.name}" mise en PAUSE (bascule vers une autre campagne).`);
    }

    const deadline = Date.now() + RELEASE_TIMEOUT_MS;
    while (this._runActive && Date.now() < deadline) {
      await sleep(100);
    }
    this.activeCampaignId = null;
  }

  // Pause manuelle (bouton "Mettre en Pause") — id optionnel (compat avec
  // l'ancien dashboard mono-campagne, voir _resolveDefaultCampaign). Ne
  // finalise rien : nextIndex/results restent intacts pour une reprise via
  // resume(). superseded=true fait sortir la boucle d'envoi PROPREMENT,
  // après le message en cours, et libère IMMÉDIATEMENT la session pour
  // qu'une autre campagne puisse démarrer sans attendre.
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
    console.log(`Campagne (tenant "${this.tenantId}"): "${campaign.name}" mise en PAUSE — session disponible pour une autre campagne.`);
  }

  // Reprend/lance une campagne ('queued', 'paused', ou déjà 'running' — no-op
  // dans ce dernier cas) et la rend ACTIVE sur la session : si une AUTRE
  // campagne est actuellement active, elle est d'abord mise en pause (voir
  // _releaseActive) — c'est la bascule "Play/Pause & Reprise intelligente"
  // demandée : basculer d'une campagne à l'autre en un seul appel, sans
  // jamais faire tourner deux boucles d'envoi en même temps. Reprend
  // toujours exactement à campaign.nextIndex (dernier index traité + 1),
  // garantissant qu'aucun destinataire déjà dans sentContactIds ne reçoit le
  // message une seconde fois.
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

    console.log(`Campagne (tenant "${this.tenantId}"): "${campaign.name}" reprise/lancée au destinataire ${campaign.nextIndex + 1}/${campaign.total}.`);
    return this._publicStatus(campaign);
  }

  // Arrêt DÉFINITIF (id optionnel, voir pause()) : finalise la campagne de
  // façon SYNCHRONE (destinataires restants marqués honnêtement 'pending',
  // statut 'stopped') — le verrou est donc libéré IMMÉDIATEMENT.
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
      // Réinitialise IMMÉDIATEMENT le coupe-circuit (isolation stricte par
      // tenant) : un Stop manuel doit déverrouiller la session tout de
      // suite, même en pleine pause de sécurité réseau.
      this.networkHealth = new circuitBreaker.CircuitBreakerState();
    }
    this._persist(campaign);
    removeSequenceMedia(campaign.options.sequence || []);
    this.resolvedSequences.delete(campaign.id);
  }

  // Appelée par le régulateur de sessions juste avant de disposer la
  // session WhatsApp d'un tenant : ne jamais annuler la campagne active —
  // elle passe en pause pour une reprise ultérieure (via resumeIfPending()
  // ou un resume() manuel), exactement comme pause() ci-dessus.
  pauseForShutdown() {
    const campaign = this.activeCampaignId ? this.campaigns.get(this.activeCampaignId) : null;
    if (!campaign || campaign.status !== 'running') return;
    campaign.userPaused = true;
    campaign.paused = true;
    campaign.superseded = true;
    campaign.status = 'paused';
    this.activeCampaignId = null;
    this._persist(campaign);
    console.log(`Campagne (tenant "${this.tenantId}"): "${campaign.name}" mise en pause (session libérée) — reprise possible ultérieurement.`);
  }

  // Appelée dès que le NUMÉRO WhatsApp connecté sous ce tenant change
  // (déconnexion manuelle, ré-appairage, révocation) : l'ancien ET le
  // nouveau compte n'ont RIEN en commun — TOUTES les campagnes non
  // terminales (running/paused/queued) de l'ancien compte sont annulées,
  // jamais reprises sous le nouveau numéro.
  reset() {
    for (const campaign of this.campaigns.values()) {
      if (campaign.status === 'running' || campaign.status === 'paused' || campaign.status === 'queued') {
        this._markRemainingInterrupted(campaign);
        campaign.superseded = true;
        campaign.status = 'cancelled';
        campaign.cancelReason = 'Compte WhatsApp déconnecté ou changé — campagne annulée.';
        removeSequenceMedia(campaign.options.sequence || []);
        this.resolvedSequences.delete(campaign.id);
        console.log(`Campagne (tenant "${this.tenantId}"): "${campaign.name}" annulée — le compte WhatsApp connecté a changé.`);
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
    this.resolvedSequences.clear();
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
      console.log(`Campagne (tenant "${this.tenantId}"): état restauré depuis GitHub (disque local vidé par un redéploiement).`);
      return JSON.parse(remote.content);
    } catch (err) {
      console.error(`Campagne (tenant "${this.tenantId}"): échec de restauration depuis GitHub :`, err.message);
      return null;
    }
  }

  // Restaure TOUTES les campagnes persistées de ce tenant au (re)démarrage
  // du process ou à la (re)création de l'instance. Ne relance JAMAIS
  // l'envoi automatiquement : toute campagne 'running' au moment de
  // l'arrêt est restaurée 'paused' (à reprendre via resume()) ; une
  // campagne 'queued' le reste telle quelle ; les campagnes déjà
  // terminales (completed/stopped/cancelled) sont restaurées telles
  // quelles pour l'historique du dashboard. `if (this.campaigns.size > 0)
  // return false` rend l'appel idempotent (boot + requête HTTP concurrente
  // sans risque de double reprise).
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

      const persistableSequence = (saved.options && saved.options.sequence) || [];
      const migratedResults = this._migrateResults(saved.results, saved.recipients);

      try {
        this.resolvedSequences.set(saved.id, await resolveSequenceMedia(persistableSequence));
      } catch (err) {
        console.error(
          `Campagne (tenant "${this.tenantId}", "${saved.name}"): reprise impossible — ${err.message}. ` +
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

    // Aucune campagne n'est relancée automatiquement au redémarrage — la
    // session repart toujours "libre" (activeCampaignId=null), à
    // l'utilisateur de cliquer "Reprendre" sur la campagne voulue.
    this.activeCampaignId = null;
    this.networkHealth = record.networkHealth
      ? circuitBreaker.CircuitBreakerState.fromJSON(record.networkHealth)
      : new circuitBreaker.CircuitBreakerState();
    this._persist();

    if (restoredAny) {
      console.log(`Campagne(s) (tenant "${this.tenantId}"): restaurée(s) en PAUSE après redémarrage/reconnexion — cliquez "Reprendre" sur la campagne voulue.`);
    }

    return restoredAny;
  }
}

// Énumère les tenants ayant, dans leur fichier d'état persisté, au moins une
// campagne "running" ou "paused" au moment de l'arrêt — utilisé une seule
// fois au démarrage du serveur pour savoir quelles instances WhatsApp
// relancer automatiquement. Cherche d'abord sur le disque local, puis
// complète avec GitHub pour les tenants absents localement (redéploiement
// Render ayant vidé le disque éphémère).
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
      console.error(`État de campagne local illisible (${file}) :`, err.message);
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
      console.error(`État de campagne distant illisible (${filename}) :`, err.message);
    }
  }

  return [...tenantsFromLocal, ...tenantsFromRemote];
}

// Annule automatiquement (statut "cancelled") UNIQUEMENT les campagnes
// individuelles dont AUCUN process n'a donné signe de vie depuis plus de
// maxAgeMs (running/paused : voir lastProgressAt : ni un envoi réel, ni le
// simple battement de cœur d'une attente longue ; queued : depuis leur
// création, jamais démarrées). Une campagne activement suivie — même en
// pause depuis des jours à attendre une restriction de compte — n'est donc
// JAMAIS annulée ici. Opère directement sur les fichiers, campagne par
// campagne au sein du tableau `campaigns` de chaque tenant.
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

      removeSequenceMedia((campaign.options && campaign.options.sequence) || []);

      console.log(`Campagne WhatsApp (tenant "${tenantId}", "${campaign.name}") : annulée automatiquement après ${ageHours}h sans aucun signe de vie.`);
      purged.push({ tenantId, campaignId: campaign.id, name: campaign.name });
      changed = true;
    }

    if (!changed) continue;

    try {
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
    } catch (err) {
      console.error(`Purge campagnes WhatsApp (tenant "${tenantId}") : échec d'écriture locale —`, err.message);
      continue;
    }

    if (githubStore.enabled) {
      githubStore.createStore(remoteFilePath(tenantId)).pushRemote(JSON.stringify(record, null, 2)).catch((err) => {
        console.error(`Purge campagnes WhatsApp (tenant "${tenantId}") : échec de synchronisation GitHub —`, err.message);
      });
    }
  }

  return purged;
}

module.exports = {
  CampaignEngine,
  listTenantsWithPendingCampaigns,
  purgeStaleCampaigns,
  DEFAULT_STALE_MS,
};
