const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');
const { normalizeRecipientEntry } = require('../lib/whatsappRecipients');
const { personalizeMessage } = require('../lib/personalization');
const circuitBreaker = require('../lib/circuitBreaker');
const messageHistory = require('../lib/messageHistory');

// Persistance de la progression d'une campagne WhatsApp, tenant par tenant
// (voir adapters/whatsappManager.js) : sur un environnement Docker/Render où
// le conteneur est éphémère, un redéploiement/crash ne doit ni perdre la
// progression déjà envoyée, ni renvoyer les messages déjà livrés au
// redémarrage. Chaque tenant a son propre fichier d'état local
// (CAMPAIGNS_DIR/<tenantId>.json), ET son propre fichier sur GitHub
// (REMOTE_CAMPAIGNS_DIR/<tenantId>.json, même principe que licenses.js et
// adapters/whatsappAuthStore.js) — jamais partagés, comme le reste de la
// session WhatsApp de ce tenant. Le disque local reste la source rapide pour
// une reprise après crash SANS redéploiement (même conteneur, même fichiers) ;
// GitHub prend le relais quand le disque local a été vidé par un vrai
// redéploiement Render (aucun disque persistant n'est requis).
//
// Les pièces jointes (buffers média) sont sauvegardées sur GitHub elles
// aussi, mais PAS via l'API "Contents" (limitée à 1 Mo) : voir
// githubStore.js#pushLargeFile/fetchLargeFile, qui passent par l'API Git Data
// (blobs) de GitHub — jusqu'à ~100 Mo par fichier, largement suffisant pour
// une vidéo compressée à ~15 Mo (voir adapters/videoCompressor.js). Le sha du
// blob est conservé dans l'état de la campagne pour pouvoir le relire même
// depuis un conteneur qui n'a jamais vu ce fichier localement.
//
// IMPORTANT (limite connue, indépendante de GitHub) : l'état est persisté
// APRÈS l'envoi effectif de chaque destinataire, pas avant — un crash
// survenant pile entre l'envoi réel et l'écriture du fichier peut donc faire
// renvoyer UN SEUL message (celui en cours au moment du crash) à la reprise.
// Un envoi WhatsApp ne pouvant pas être annulé une fois parti, une garantie
// "exactement une fois" est impossible sans changer la sémantique de
// livraison elle-même ; cette fenêtre de risque est réduite au minimum (un
// seul message, pas toute la file) plutôt qu'ignorée.
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
// _heartbeat), aussi longue que soit son attente. Recommandation explicite
// de l'utilisateur : les restrictions temporaires WhatsApp/Telegram peuvent
// durer 24 à 48h, la purge ne doit donc jamais intervenir avant ce délai.
const DEFAULT_STALE_MS = (parseFloat(process.env.CAMPAIGN_STALE_HOURS) || 48) * 3_600_000;

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
// campagne peut durer des heures (des milliers de destinataires avec délai),
// il faut que ces fichiers survivent à un redémarrage du process pour que la
// reprise (resumeIfPending) puisse les relire sans redemander l'upload
// original à l'utilisateur. Poussé aussi sur GitHub (mediaBlobSha) quand
// activé, pour survivre à un redéploiement qui viderait le disque local —
// fait une seule fois par pièce jointe (pas par destinataire), le coût
// (upload potentiellement de quelques Mo) est donc négligeable sur la durée
// totale d'une campagne.
async function persistSequenceMedia(tenantId, sequence) {
  const result = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const step = sequence[index];
    if (step.type !== 'media') {
      result.push(step);
      continue;
    }

    const mediaFile = `${tenantId}_${index}.bin`;
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

// Inverse de persistSequenceMedia : relit les buffers pour l'envoi, à
// l'initialisation d'une campagne (immédiat, toujours depuis le disque local
// qu'on vient d'écrire) ou à la reprise après redémarrage (resumeIfPending).
// Essaie le disque local en premier (rapide) ; si le fichier est absent
// (redéploiement ayant vidé le disque éphémère) et qu'un mediaBlobSha existe,
// le retélécharge depuis GitHub et le réécrit localement avant de continuer.
// Lève une erreur explicite seulement si aucune des deux sources ne
// fonctionne (pièce jointe irrécupérable).
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
      // Réécrit en local pour que les prochains accès (même process) restent
      // rapides et ne retéléchargent pas à chaque fois.
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
// pour l'anti-doublons (voir lib/messageHistory.js#hashTemplate) — le texte
// brut de chaque étape "text" et le nom/type de chaque étape "media",
// jamais le buffer lui-même (coûteux et inutile : deux campagnes envoyant la
// même pièce jointe sous le même nom sont déjà considérées comme le même
// modèle).
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
  // minutes du tenant pendant qu'une campagne tourne en tâche de fond, sans
  // qu'aucune requête HTTP n'arrive entre deux destinataires.
  constructor(tenantId, session, onActivity) {
    this.tenantId = tenantId;
    this.session = session;
    this.onActivity = onActivity;
    this.campaign = null; // état en mémoire de la campagne en cours/dernière
    this.persistableSequence = null; // forme sérialisable (mediaFile au lieu de buffer)
    this.resolvedSequence = null; // forme utilisable pour l'envoi (buffer réel)
    this.remoteStore = githubStore.createStore(remoteFilePath(tenantId));
    // Horodatage (Date.now()) jusqu'auquel la file d'attente doit rester en
    // pause suite à une réponse entrante — 0 tant qu'aucune réponse n'a été
    // reçue. Propriété de l'instance (pas de campaign) : elle n'a pas besoin
    // de survivre à un redémarrage du process, contrairement au reste de
    // l'état de campagne.
    this.incomingPauseUntil = 0;
    if (typeof session.onIncomingMessage === 'function') {
      session.onIncomingMessage(() => this._pauseForIncomingReply());
    }
    // Supervision de santé réseau et coupe-circuit (voir lib/circuitBreaker.js) :
    // même raison que incomingPauseUntil ci-dessus pour ne pas persister cet
    // état — c'est un signal de santé réseau "live", pas une donnée de
    // progression de campagne.
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    // Voir _heartbeat() : dernier rafraîchissement de lastProgressAt pendant
    // une attente longue, pour ne le faire au plus qu'une fois toutes les
    // HEARTBEAT_INTERVAL_MS plutôt qu'à chaque tick de 300ms-1s des boucles
    // d'attente.
    this._lastHeartbeatAt = 0;
    // true tant qu'un appel à _run() est en vie (envoi ou attente) pour CETTE
    // instance — voir resume(), qui ne redémarre une boucle que si aucune
    // n'est déjà active (campagne restaurée via resumeIfPending() mais
    // jamais relancée) plutôt que d'en faire tourner deux en parallèle sur
    // le même campaign.
    this._runActive = false;
    // Historique des envois (voir lib/messageHistory.js), chargé une fois par
    // start()/premier envoi après reprise — jamais rechargé à chaque
    // destinataire. null tant qu'il n'a pas encore été chargé (voir
    // _recordHistorySent, appelé après resumeIfPending()).
    this._historyEntries = null;
    this._messageHash = null;
  }

  // Rafraîchit lastProgressAt (voir _persist) pendant une attente
  // potentiellement longue (pause manuelle, coupure réseau, palier
  // FLOOD_WAIT de plusieurs heures...), au plus une fois toutes les
  // HEARTBEAT_INTERVAL_MS : prouve qu'un process suit toujours activement
  // cette campagne — voir purgeStaleCampaigns(), qui n'annule jamais une
  // campagne dont le "pouls" est resté récent, aussi longue que soit son
  // attente.
  _heartbeat() {
    const now = Date.now();
    if (now - this._lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    this._lastHeartbeatAt = now;
    this._persist();
  }

  // Mesure le temps de réponse d'UN envoi et alimente le détecteur de
  // latence — voir CircuitBreakerState#recordLatency. Deux requêtes
  // consécutives dépassant le seuil suspendent la file 15 minutes
  // ('degraded_network') avant de reprendre normalement (l'envoi, lui, a
  // réussi : ce n'est pas un échec, juste un signal de dégradation).
  _recordSendLatency(elapsedMs) {
    if (this.networkHealth.recordLatency(elapsedMs)) {
      console.log(
        `Campagne (tenant "${this.tenantId}"): latence élevée (${elapsedMs}ms) sur 2 requêtes consécutives — ` +
        `statut 'degraded_network', pause de ${circuitBreaker.DEGRADED_NETWORK_PAUSE_MS / 60000} min.`,
      );
    }
  }

  // Construit le tableau `results` PRÉ-REMPLI dès start() (voir _runLoop, qui
  // le mute en place plutôt que d'y accumuler des entrées) : chaque
  // destinataire reçoit immédiatement son statut définitif 'pending' ou
  // 'skipped_duplicate' (Smart Screening anti-doublons), jamais recalculé
  // ensuite — seul le passage de la boucle sur cet index peut le faire
  // évoluer vers 'sent'/'failed', ou le laisser 'skipped_duplicate' avec un
  // simple horodatage. Un contact apparaissant plusieurs fois dans LA MÊME
  // liste importée est lui aussi dédoublonné (seule la première occurrence
  // reste 'pending').
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

  // Complète un `results` persisté AVANT ce déploiement (append-only,
  // potentiellement plus court que `recipients`) avec des entrées 'pending'
  // pour les destinataires jamais atteints, et aligne les anciens libellés
  // ('delivered'/'interrupted') sur le nouveau vocabulaire — appelé
  // uniquement depuis resumeIfPending(), pour qu'une campagne en cours pile
  // au moment du redéploiement ne se retrouve jamais dans un état
  // incohérent.
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
  // (voir lib/messageHistory.js) : chargé une seule fois (au premier envoi
  // après start()/resumeIfPending()), tenu à jour en mémoire ensuite pour ne
  // jamais relire le disque à chaque destinataire. Écriture locale
  // synchrone + sauvegarde GitHub fire-and-forget (voir saveHistory),
  // jamais bloquant au-delà du disque local.
  async _recordHistorySent(contactKey) {
    if (!contactKey) return;
    if (!this._historyEntries) {
      this._historyEntries = await messageHistory.loadHistory('whatsapp', this.tenantId);
    }
    this._historyEntries.push({ contactKey, messageHash: this._messageHash, sentAt: new Date().toISOString() });
    this._historyEntries = messageHistory.saveHistory('whatsapp', this.tenantId, this._historyEntries);
  }

  // Bloque la file d'attente tant que le coupe-circuit est ouvert
  // ('degraded_network' ou 'circuit_open' — voir lib/circuitBreaker.js), puis
  // effectue un test de connexion passif (session.isConnected(), déjà tenu à
  // jour par les écouteurs de connexion de l'adaptateur) avant de rendre la
  // main : si le signal n'est pas nominal à l'expiration du délai, la
  // vérification est retentée périodiquement plutôt que de reprendre
  // l'envoi aveuglément.
  async _waitForNetworkHold() {
    const campaign = this.campaign;
    const health = this.networkHealth;
    if (!health.isHeld()) return;

    campaign.paused = true;
    this._persist();
    console.log(
      `Campagne (tenant "${this.tenantId}"): file en pause — statut réseau '${health.networkStatus}', ` +
      `reprise prévue vers ${new Date(health.holdUntil).toISOString()}.`,
    );

    while (!campaign.stopRequested && !campaign.superseded && health.isHeld()) {
      this._heartbeat();
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    while (!campaign.stopRequested && !campaign.superseded && !this.session.isConnected()) {
      console.log(`Campagne (tenant "${this.tenantId}"): health check négatif — nouvelle vérification dans 30s avant reprise.`);
      this._heartbeat();
      await sleep(circuitBreaker.HEALTH_RECHECK_INTERVAL_MS);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    const wasCircuitOpen = health.networkStatus === 'circuit_open';
    health.networkStatus = 'normal';
    campaign.paused = false;
    this._persist();
    console.log(
      `Campagne (tenant "${this.tenantId}"): health check nominal — reprise de l'envoi` +
      `${wasCircuitOpen ? ' au destinataire précédemment en échec de surcharge' : ''}.`,
    );
  }

  // Appelé par l'adaptateur WhatsApp (voir adapters/whatsapp.js) dès qu'un
  // message entrant (hors ceux qu'on envoie soi-même) est reçu, que ce soit
  // pendant ou en dehors d'une campagne — ne fait rien si aucune campagne
  // n'est active. `Math.max` évite qu'une deuxième réponse arrivant pendant la
  // pause ne la RACCOURCISSE si elle était déjà plus longue.
  _pauseForIncomingReply() {
    if (!this.campaign || this.campaign.status !== 'running') return;
    const until = Date.now() + INCOMING_REPLY_PAUSE_MS;
    if (until > this.incomingPauseUntil) {
      this.incomingPauseUntil = until;
      console.log(`Campagne (tenant "${this.tenantId}"): réponse entrante détectée — pause de ${INCOMING_REPLY_PAUSE_MS / 1000}s avant de reprendre l'envoi.`);
    }
  }

  async _waitForIncomingPause() {
    const campaign = this.campaign;
    while (Date.now() < this.incomingPauseUntil) {
      if (campaign.stopRequested || campaign.superseded) return;
      await sleep(300);
    }
  }

  // Pause manuelle demandée via POST /api/messages/pause (voir pause()
  // ci-dessous) — même principe que TelegramCampaignEngine#_waitWhileBlocked
  // pour la partie "pause utilisateur". Une campagne restaurée après un
  // redémarrage/une éviction de session démarre déjà avec userPaused=true
  // (voir resumeIfPending) : elle reste ici tant que l'utilisateur ne clique
  // pas explicitement sur "Reprendre", même si l'attente dure plusieurs
  // jours — _heartbeat() rafraîchit lastProgressAt entre-temps pour que
  // purgeStaleCampaigns() sache qu'elle est toujours suivie.
  async _waitForUserPause() {
    const campaign = this.campaign;
    if (!campaign.userPaused) return;

    campaign.paused = true;
    this._persist();
    console.log(`Campagne (tenant "${this.tenantId}"): en pause (demandée par l'utilisateur ou restaurée après redémarrage).`);

    while (campaign.userPaused && !campaign.stopRequested && !campaign.superseded) {
      this._heartbeat();
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    campaign.paused = false;
    console.log(`Campagne (tenant "${this.tenantId}"): reprise après pause utilisateur.`);
  }

  _buildRecord() {
    return {
      tenantId: this.tenantId,
      status: this.campaign.status,
      paused: this.campaign.paused,
      userPaused: this.campaign.userPaused,
      stopRequested: this.campaign.stopRequested,
      total: this.campaign.total,
      sent: this.campaign.sent,
      success: this.campaign.success,
      failed: this.campaign.failed,
      // Voir lib/messageHistory.js : contacts sautés instantanément (sans
      // requête réseau) car ils ont déjà reçu ce même modèle de message dans
      // la fenêtre anti-doublons (duplicateWindowHours) — comptabilisés à
      // part des échecs/réussites.
      skippedDuplicates: this.campaign.skippedDuplicates,
      messageHash: this.campaign.messageHash,
      duplicateWindowHours: this.campaign.duplicateWindowHours,
      startedAt: this.campaign.startedAt,
      finishedAt: this.campaign.finishedAt,
      // Voir _heartbeat()/purgeStaleCampaigns() : dernier signe de vie d'un
      // process qui suit activement cette campagne (envoi réel ou simple
      // rafraîchissement pendant une attente longue) — jamais l'horodatage
      // du dernier ENVOI seul, pour qu'une pause légitime de plusieurs jours
      // ne soit jamais confondue avec un abandon.
      lastProgressAt: this.campaign.lastProgressAt,
      cancelReason: this.campaign.cancelReason || null,
      nextIndex: this.campaign.nextIndex,
      recipients: this.campaign.recipients,
      results: this.campaign.results,
      // Voir lib/circuitBreaker.js#toJSON : persisté pour qu'une pause de
      // sécurité ('degraded_network'/'circuit_open') survive à un
      // redéploiement plutôt que d'être silencieusement oubliée.
      networkHealth: this.networkHealth.toJSON(),
      options: {
        delaySeconds: this.campaign.options.delaySeconds,
        batchSize: this.campaign.options.batchSize,
        batchPauseSeconds: this.campaign.options.batchPauseSeconds,
        sequenceDelayMinMs: this.campaign.options.sequenceDelayMinMs,
        sequenceDelayMaxMs: this.campaign.options.sequenceDelayMaxMs,
        sequence: this.persistableSequence,
      },
    };
  }

  _persist() {
    if (!this.campaign) return;
    this.campaign.lastProgressAt = new Date().toISOString();
    const record = this._buildRecord();
    const content = JSON.stringify(record, null, 2);
    // Écriture locale synchrone volontaire : le volume (une campagne à la
    // fois par tenant, un seul destinataire toutes les quelques secondes)
    // reste négligeable, et ça garantit que l'état sur disque est à jour
    // avant que la boucle d'envoi ne poursuive vers le destinataire suivant.
    fs.writeFileSync(statePath(this.tenantId), content, 'utf8');
    // Sauvegarde GitHub en fire-and-forget (comme whatsappAuthStore.js) :
    // jamais bloquant pour la boucle d'envoi, un échec ponctuel n'interrompt
    // pas la campagne — seule la reprise après un vrai redéploiement en
    // pâtirait, pas l'envoi en cours.
    this.remoteStore.pushRemote(content).catch((err) => {
      console.error(`Échec de la sauvegarde de la campagne sur GitHub pour le tenant "${this.tenantId}" :`, err.message);
    });
  }

  // Forme volontairement alignée sur l'ancien objet "currentCampaign" global
  // (avant l'isolation par tenant) : recipients/options/nextIndex restent
  // internes (utiles pour _persist()/resumeIfPending()) mais ne sont pas
  // renvoyés ici — /api/messages/status est interrogé toutes les quelques
  // secondes par le dashboard, et une liste de destinataires potentiellement
  // longue n'a rien à y faire.
  getStatus() {
    if (!this.campaign) return null;
    const {
      total, sent, success, failed, skippedDuplicates, duplicateWindowHours,
      status, paused, userPaused, stopRequested, startedAt, finishedAt, results, resumeError, cancelReason,
    } = this.campaign;
    const base = {
      total, sent, success, failed, skippedDuplicates, duplicateWindowHours,
      status, paused, userPaused, stopRequested, startedAt, finishedAt, results,
      networkStatus: this.networkHealth.networkStatus,
      // Délai exact (secondes) avant reprise automatique — alimente le
      // décompte dynamique du dashboard tant que le coupe-circuit est actif
      // ('degraded_network'/'circuit_open'), 0 sinon.
      retryAfterSeconds: this.networkHealth.getRetryAfterSeconds(),
    };
    if (resumeError) base.resumeError = resumeError;
    if (cancelReason) base.cancelReason = cancelReason;
    return base;
  }

  // En cas de coupure réseau/Baileys en pleine campagne, on ne marque pas les
  // destinataires restants comme échoués : on met la campagne en pause (le
  // statut public reste "running" pour ne pas casser le suivi côté client) et
  // on attend que la connexion revienne avant de reprendre l'envoi.
  async _waitForConnection() {
    const campaign = this.campaign;
    if (this.session.isConnected()) {
      return;
    }

    campaign.paused = true;
    this._persist();
    console.log(`Campagne (tenant "${this.tenantId}"): mise en pause — connexion WhatsApp perdue, en attente de reconnexion...`);

    while (!this.session.isConnected() && !campaign.stopRequested && !campaign.superseded) {
      this._heartbeat();
      await sleep(1000);
    }
    if (campaign.stopRequested || campaign.superseded) return;

    campaign.paused = false;
    console.log(`Campagne (tenant "${this.tenantId}"): reprise après reconnexion WhatsApp.`);
  }

  // Arrêt DÉFINITIF (voir stop()) : les destinataires non encore traités
  // restent en statut 'pending' (ou 'skipped_duplicate' s'ils avaient déjà
  // été identifiés comme doublons au Smart Screening — voir
  // _buildInitialResults() dans start()) — `results[]` est pré-rempli dès
  // start() et reflète déjà l'état correct de chaque contact, il n'y a donc
  // plus rien à y écrire ici. Un Stop reste définitif (jamais de reprise
  // automatique), mais un contact 'pending' au moment du Stop garde une
  // trace honnête : il n'a jamais été contacté.
  _markRemainingInterrupted(fromIndex) {
    const campaign = this.campaign;
    campaign.nextIndex = campaign.recipients.length;
    campaign.status = 'stopped';
    campaign.paused = false;
    campaign.finishedAt = new Date().toISOString();
  }

  // sequence (tableau) porte la campagne à envoyer : chaque étape est soit
  // { type: 'text', text } soit { type: 'media', buffer, mimetype, filename },
  // envoyée dans l'ordre à chaque destinataire avec un court délai (2-5s par
  // défaut, paramétrable) entre chaque étape — pour simuler une frappe
  // naturelle, distinct du délai (8-15s) appliqué entre deux destinataires.
  // _runActive suit le cycle de vie de CET appel précis (voir resume(), qui
  // ne redémarre une boucle que si aucune n'est déjà active) : try/finally
  // couvre tous les points de sortie (chaque `return` de shouldAbort(), la
  // fin normale de la boucle) sans avoir à dupliquer la remise à zéro.
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
    const { delaySeconds, batchSize, batchPauseSeconds, sequenceDelayMinMs, sequenceDelayMaxMs } = campaign.options;
    const recipients = campaign.recipients;
    const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : recipients.length;
    const seqMinMs = Number.isFinite(sequenceDelayMinMs) ? sequenceDelayMinMs : 2000;
    const seqMaxMs = Number.isFinite(sequenceDelayMaxMs) ? Math.max(seqMinMs, sequenceDelayMaxMs) : Math.max(seqMinMs, 5000);
    const sequence = this.resolvedSequence;

    // Abandonne silencieusement ce passage de boucle SANS retoucher
    // `campaign` : soit stop() a déjà tout finalisé de façon synchrone (voir
    // stop() ci-dessous — marquage des destinataires restants, statut
    // "stopped", persistance), soit pauseForShutdown() a déjà marqué la
    // campagne "paused" pour une reprise ultérieure — dans les deux cas,
    // re-persister ou re-marquer ici écraserait un état déjà correct (et
    // potentiellement celui d'une TOUTE NOUVELLE campagne démarrée entre
    // temps, le verrou ayant été libéré immédiatement par stop()).
    const shouldAbort = () => campaign.stopRequested || campaign.superseded;

    let i = startIndex;
    while (i < recipients.length) {
      if (shouldAbort()) return;

      await this._waitForConnection();
      if (shouldAbort()) return;

      await this._waitForIncomingPause();
      if (shouldAbort()) return;

      await this._waitForUserPause();
      if (shouldAbort()) return;

      await this._waitForNetworkHold();
      if (shouldAbort()) return;

      // Smart Screening (voir start()) : ce contact a déjà reçu ce même
      // modèle de message dans la fenêtre anti-doublons (ou apparaît en
      // double dans la liste importée) — statut déjà déterminé dans
      // campaign.results[i], on saute INSTANTANÉMENT, sans la moindre
      // requête réseau ni délai inter-destinataire (contrairement à un envoi
      // normal). Placé APRÈS les attentes ci-dessus : une pause/un arrêt
      // gèle aussi le traitement des doublons, comme un envoi normal.
      if (campaign.results[i].status === 'skipped_duplicate') {
        campaign.results[i].timestamp = new Date().toISOString();
        campaign.sent += 1;
        campaign.skippedDuplicates += 1;
        campaign.nextIndex = i + 1;
        this._persist();
        if (this.onActivity) this.onActivity();
        console.log(`Campagne (tenant "${this.tenantId}"): destinataire ${campaign.results[i].to} ignoré (doublon détecté, ${i + 1}/${recipients.length}).`);
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
            // Spintax résolu PUIS variables de personnalisation substituées
            // (voir lib/personalization.js#personalizeMessage) — dans cet
            // ordre, et À CHAQUE destinataire (pas une seule fois pour toute
            // la campagne) : deux destinataires reçoivent alors rarement le
            // texte identique mot pour mot, même à partir du même modèle.
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
        await this._recordHistorySent(messageHistory.normalizeContactKey(to));
        console.log(`Campagne (tenant "${this.tenantId}"): séquence envoyée à ${to} (${i + 1}/${recipients.length}).`);
      } catch (err) {
        if (circuitBreaker.isOverloadError(err)) {
          // Signal de surcharge du service distant (429, timeout d'ACK,
          // reset de socket...) : ce n'est pas un échec du destinataire —
          // on conserve son index tel quel (campaign.nextIndex reste à i)
          // pour le RETENTER après le délai de mise en veille et un health
          // check positif (voir _waitForNetworkHold), sans le compter ni
          // avancer la file.
          overloadDetected = true;
          const backoffMs = this.networkHealth.recordOverloadFailure(err);
          if (!shouldAbort()) this._persist();
          console.log(
            `Campagne (tenant "${this.tenantId}"): signal de surcharge détecté (${err.message}) — ` +
            `statut 'circuit_open', nouvelle tentative pour ${to} dans ${Math.round(backoffMs / 60000)} min (index ${i} conservé).`,
          );
        } else {
          campaign.failed += 1;
          console.error(`Campagne (tenant "${this.tenantId}"): échec de l'envoi à ${to}:`, err);
        }
      }

      // stop()/pauseForShutdown() a pu finaliser `campaign` PENDANT l'envoi
      // ci-dessus (attente réseau non interruptible) : ne pas laisser cet
      // envoi qui vient de se terminer réécrire un état déjà clos — voir le
      // commentaire sur shouldAbort() plus haut.
      if (shouldAbort()) return;

      if (overloadDetected) {
        // Ne pas incrémenter i : le prochain passage dans la boucle
        // retentera CE MÊME destinataire, après _waitForNetworkHold().
        continue;
      }

      campaign.sent += 1;
      campaign.nextIndex = i + 1;
      campaign.results[i] = { to, status, timestamp: new Date().toISOString() };
      this._persist();
      if (this.onActivity) this.onActivity();

      i += 1;

      if (i < recipients.length && !shouldAbort()) {
        // Délai fixe et configurable (standard, sans randomisation) : à
        // défaut de valeur fournie, 15s reste une valeur raisonnable pour un
        // usage normal de l'API WhatsApp.
        const baseDelayMs = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds * 1000 : 15_000;
        // i a déjà été incrémenté ci-dessus : il représente ici le nombre de
        // destinataires traités jusqu'ici (compte 1-based), pas un index.
        const endOfBatch = i % batch === 0;
        // batchPauseSeconds : pause après un lot, configurable indépendamment
        // du délai par message — à défaut, on retombe sur l'ancien
        // comportement (3x le délai par message) pour rester cohérent avec
        // une campagne qui ne préciserait pas ce paramètre.
        const batchPauseMs = Number.isFinite(batchPauseSeconds) && batchPauseSeconds > 0
          ? batchPauseSeconds * 1000
          : baseDelayMs * 3;
        const delayMs = endOfBatch ? batchPauseMs : baseDelayMs;
        await interruptibleSleep(delayMs, shouldAbort);
      }
    }

    if (shouldAbort()) return;

    if (campaign.status === 'running') {
      campaign.status = 'completed';
      campaign.finishedAt = new Date().toISOString();
      this._persist();
    }

    removeSequenceMedia(this.persistableSequence);
    console.log(`Campagne (tenant "${this.tenantId}"): terminée.`);
  }

  // async : le lancement attend que chaque pièce jointe soit sauvegardée sur
  // GitHub (voir persistSequenceMedia) avant de considérer la campagne comme
  // démarrée — évite qu'un crash survenant juste après le lancement laisse
  // une campagne "en cours" dont la pièce jointe ne serait pas encore
  // durable. Négligeable en pratique : upload unique par pièce jointe, pas
  // par destinataire.
  async start(recipients, options = {}) {
    if (this.campaign && this.campaign.status === 'running') {
      throw new Error('CAMPAIGN_IN_PROGRESS');
    }

    this.persistableSequence = await persistSequenceMedia(this.tenantId, options.sequence || []);
    this.resolvedSequence = await resolveSequenceMedia(this.persistableSequence);

    // Smart Screening anti-doublons (voir lib/messageHistory.js) : calculé
    // UNE FOIS ici, avant le premier envoi — jamais réévalué en cours de
    // route (voir _buildInitialResults). duplicateWindowHours par défaut à
    // 48h (recommandation explicite de l'utilisateur), réglable de 1h à
    // 720h (30 jours) par campagne.
    const messageHash = messageHistory.hashTemplate(sequenceHashParts(this.persistableSequence));
    const duplicateWindowHours = messageHistory.clampWindowHours(options.duplicateWindowHours);
    const historyEntries = await messageHistory.loadHistory('whatsapp', this.tenantId);
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
      results,
      options: {
        delaySeconds: options.delaySeconds,
        batchSize: options.batchSize,
        batchPauseSeconds: options.batchPauseSeconds,
        sequenceDelayMinMs: options.sequenceDelayMinMs,
        sequenceDelayMaxMs: options.sequenceDelayMaxMs,
      },
    };
    this.incomingPauseUntil = 0;
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._lastHeartbeatAt = 0;
    this._persist();

    const campaign = this.campaign;
    this._run(0).catch((err) => {
      console.error(`Erreur pendant la campagne (tenant "${this.tenantId}"):`, err);
      // Ne touche à rien si cette campagne a déjà été finalisée entre-temps
      // (stop()/pauseForShutdown()) ou remplacée par un nouveau lancement —
      // voir le commentaire sur shouldAbort() dans _run().
      if (this.campaign !== campaign || campaign.stopRequested || campaign.superseded) return;
      campaign.status = 'stopped';
      campaign.paused = false;
      campaign.finishedAt = new Date().toISOString();
      this._persist();
    });

    return this.campaign;
  }

  // Arrêt DÉFINITIF demandé par l'utilisateur (POST /api/messages/stop) :
  // finalise la campagne de façon SYNCHRONE (destinataires restants marqués
  // "interrupted", statut "stopped", persistance) au lieu d'attendre que la
  // boucle d'envoi en tâche de fond (_run) ne remarque stopRequested à son
  // prochain point de contrôle — le verrou (this.campaign.status
  // !== 'running') est donc libéré IMMÉDIATEMENT, permettant de lancer une
  // nouvelle campagne sans attendre. superseded=true fait taire la boucle en
  // tâche de fond si elle est encore en train d'attendre/d'envoyer, sans
  // qu'elle ne retouche cet objet déjà finalisé (voir shouldAbort() dans
  // _run()).
  stop() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.stopRequested = true;
    this._markRemainingInterrupted(this.campaign.nextIndex);
    this.campaign.superseded = true;
    // Réinitialise IMMÉDIATEMENT le coupe-circuit pour ce tenant (isolation
    // stricte par [licence + numéro connecté] — voir reset()) : un Stop
    // manuel doit déverrouiller le formulaire tout de suite, même si le
    // réseau était en pleine pause de sécurité ('degraded_network' ou
    // 'circuit_open') au moment de l'arrêt — sans attendre qu'un nouveau
    // start() n'en recrée un de toute façon.
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._persist();
  }

  // Pause manuelle demandée par l'utilisateur (POST /api/messages/pause) :
  // contrairement à stop(), ne finalise rien — la liste des destinataires
  // restants et nextIndex restent intacts pour une reprise via resume().
  pause() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.userPaused = true;
    this._persist();
  }

  // Reprend une campagne en pause (manuelle ou restaurée après un
  // redémarrage/une éviction de session — voir resumeIfPending). Si la
  // boucle d'envoi (_run) est toujours en vie (cas d'une pause manuelle en
  // cours d'exécution), elle est simplement débloquée par userPaused=false ;
  // sinon (campagne restaurée, jamais relancée depuis), une nouvelle boucle
  // est démarrée à partir de nextIndex.
  resume() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.userPaused = false;
    if (!this._runActive) {
      // Aucune boucle en vie à débloquer (campagne restaurée via
      // resumeIfPending() puis reprise directement) : _waitForUserPause() ne
      // sera jamais atteint avec userPaused déjà à false, donc ce n'est pas
      // elle qui remettra `paused` à false — on le fait ici.
      this.campaign.paused = false;
    }
    this._persist();
    if (!this._runActive) {
      const campaign = this.campaign;
      this._run(campaign.nextIndex).catch((err) => {
        console.error(`Erreur pendant la reprise de campagne (tenant "${this.tenantId}"):`, err);
        if (this.campaign !== campaign || campaign.stopRequested || campaign.superseded) return;
        campaign.status = 'stopped';
        campaign.paused = false;
        campaign.finishedAt = new Date().toISOString();
        this._persist();
      });
    }
  }

  // Appelée par le régulateur de sessions (voir adapters/sessionRegulator.js
  // et whatsappManager.js) juste avant de disposer la session WhatsApp d'un
  // tenant (éviction pour libérer un slot, inactivité...) : NE JAMAIS annuler
  // la campagne — elle passe en pause pour conserver la liste des
  // destinataires restants et permettre une reprise ultérieure (via
  // resumeIfPending() au prochain getOrCreate() de ce tenant, ou un
  // resume() manuel). superseded=true fait taire la boucle en tâche de fond
  // sans qu'elle ne retouche cet état déjà mis en pause.
  pauseForShutdown() {
    if (!this.campaign || this.campaign.status !== 'running') return;
    this.campaign.userPaused = true;
    this.campaign.paused = true;
    this.campaign.superseded = true;
    this._persist();
    console.log(`Campagne (tenant "${this.tenantId}"): mise en pause (session libérée) — reprise possible ultérieurement.`);
  }

  // Appelée par adapters/whatsappManager.js dès que le NUMÉRO WhatsApp
  // connecté sous ce tenant change (déconnexion manuelle, ré-appairage d'un
  // autre numéro, ou révocation détectée par WhatsApp — voir
  // adapters/whatsapp.js#onAccountReset) : contrairement à pauseForShutdown()
  // ci-dessus (même compte, session juste libérée temporairement), l'ancien
  // ET le nouveau compte n'ont ici RIEN en commun — une campagne
  // "running"/"paused" de l'ancien numéro ne doit JAMAIS verrouiller le
  // lancement d'une campagne pour le nouveau. Contrairement à stop() (arrêt
  // demandé PAR l'utilisateur SUR le compte actif), celle-ci finalise
  // "cancelled" (pas "stopped") pour distinguer clairement les deux causes
  // dans l'historique/le rapport.
  reset() {
    if (this.campaign && this.campaign.status === 'running') {
      this._markRemainingInterrupted(this.campaign.nextIndex);
      this.campaign.superseded = true;
      this.campaign.status = 'cancelled';
      this.campaign.cancelReason = 'Compte WhatsApp déconnecté ou changé — campagne annulée.';
      this._persist();
      console.log(`Campagne (tenant "${this.tenantId}"): annulée — le compte WhatsApp connecté a changé.`);
      removeSequenceMedia(this.persistableSequence || []);
    }
    this.campaign = null;
    this.persistableSequence = null;
    this.resolvedSequence = null;
    this.incomingPauseUntil = 0;
    this.networkHealth = new circuitBreaker.CircuitBreakerState();
    this._lastHeartbeatAt = 0;
    this._runActive = false;
    this._historyEntries = null;
    this._messageHash = null;
  }

  // Essaie le disque local en premier (rapide, source normale après un
  // simple crash/redémarrage du même conteneur), puis GitHub si le fichier
  // local est absent (cas d'un vrai redéploiement Render ayant vidé le
  // disque éphémère) — restaure alors une copie locale avant de continuer.
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

  // Appelée pour chaque tenant au démarrage du process (voir
  // adapters/whatsappManager.js#bootResumePendingCampaigns) ET désormais à
  // chaque (re)création d'instance en cours de fonctionnement (voir
  // getOrCreate() dans whatsappManager.js) si un état persisté (local ou
  // distant) indique une campagne encore "running"/"paused"/"cancelled" au
  // moment où le process/la session précédente s'est arrêtée (redéploiement,
  // crash, éviction de session pour libérer un slot...).
  //
  // Ne relance JAMAIS l'envoi automatiquement : la campagne est restaurée en
  // pause (userPaused=true), destinataires restants et nextIndex intacts —
  // c'est à l'utilisateur de cliquer "Reprendre" (voir resume()) une fois
  // certain que le compte n'est plus restreint, plutôt que de risquer de le
  // remettre en cause dès le redémarrage. `if (this.campaign) return false`
  // rend l'appel idempotent : un boot et une requête HTTP concurrente
  // peuvent tous deux déclencher cette méthode pour le même tenant sans
  // risque de double reprise.
  async resumeIfPending() {
    if (this.campaign) return false;

    const record = await this._loadRecord();
    if (!record) return false;

    if (record.status !== 'running' && record.status !== 'paused') {
      return false;
    }

    this.persistableSequence = record.options.sequence || [];
    // Historique anti-doublons : jamais rechargé ici (voir
    // _recordHistorySent, qui le charge paresseusement au premier envoi
    // réel après la reprise) — seul messageHash doit survivre, restauré
    // depuis le disque ou, à défaut (état persisté avant ce déploiement),
    // recalculé depuis la séquence.
    this._historyEntries = null;
    this._messageHash = record.messageHash || messageHistory.hashTemplate(sequenceHashParts(this.persistableSequence));
    const migratedResults = this._migrateResults(record.results, record.recipients);

    try {
      this.resolvedSequence = await resolveSequenceMedia(this.persistableSequence);
    } catch (err) {
      // Pièce jointe irrécupérable : ni le disque local (vidé par le
      // redéploiement) ni GitHub (blob manquant/échec de restauration, ou
      // sauvegarde désactivée) n'ont pu la fournir — voir resolveSequenceMedia.
      // On arrête proprement plutôt que de planter ou d'envoyer sans média —
      // le tenant devra relancer sa campagne en réimportant la pièce jointe.
      console.error(
        `Campagne (tenant "${this.tenantId}"): reprise impossible — ${err.message}. ` +
        'Pièce jointe irrécupérable — campagne marquée "stopped", à relancer manuellement.',
      );
      this.campaign = {
        total: record.total,
        sent: record.sent,
        success: record.success,
        failed: record.failed,
        skippedDuplicates: record.skippedDuplicates || 0,
        messageHash: this._messageHash,
        duplicateWindowHours: record.duplicateWindowHours || messageHistory.DEFAULT_WINDOW_HOURS,
        status: 'stopped',
        paused: false,
        userPaused: false,
        stopRequested: true,
        superseded: false,
        startedAt: record.startedAt,
        finishedAt: new Date().toISOString(),
        nextIndex: record.nextIndex,
        recipients: record.recipients,
        results: migratedResults,
        options: record.options,
        resumeError: 'Pièce jointe introuvable après redéploiement — relancez la campagne.',
      };
      this._persist();
      return false;
    }

    this.campaign = {
      total: record.total,
      sent: record.sent,
      success: record.success,
      failed: record.failed,
      skippedDuplicates: record.skippedDuplicates || 0,
      messageHash: this._messageHash,
      duplicateWindowHours: record.duplicateWindowHours || messageHistory.DEFAULT_WINDOW_HOURS,
      status: 'running',
      paused: true,
      userPaused: true,
      stopRequested: false,
      superseded: false,
      startedAt: record.startedAt,
      finishedAt: null,
      nextIndex: record.nextIndex,
      recipients: record.recipients,
      results: migratedResults,
      options: record.options,
    };
    // Restaure la pause de sécurité en cours (voir lib/circuitBreaker.js) le
    // cas échéant, plutôt que de repartir sur un compteur d'échecs à zéro :
    // un redéploiement survenant en pleine pause 'circuit_open' ne doit pas
    // faire retenter l'envoi immédiatement alors que le service distant
    // pourrait être toujours surchargé — sans effet ici tant que
    // userPaused reste true, mais restauré pour rester cohérent une fois
    // resume() appelé.
    this.networkHealth = circuitBreaker.CircuitBreakerState.fromJSON(record.networkHealth);
    this._persist();

    console.log(
      `Campagne (tenant "${this.tenantId}"): restaurée en PAUSE après redémarrage/reconnexion, ` +
      `au destinataire ${record.nextIndex + 1}/${record.total} — cliquez "Reprendre" pour continuer l'envoi.`,
    );

    return true;
  }
}

// Énumère les tenants ayant un fichier d'état persisté indiquant une
// campagne interrompue ("running" au moment de l'arrêt — un process qui
// tourne encore n'écrirait jamais "paused" ou "running" sans continuer à
// avancer nextIndex, donc voir ce statut au démarrage signifie forcément que
// le process précédent s'est arrêté en pleine campagne) — utilisé une seule
// fois au démarrage du serveur pour savoir quelles instances WhatsApp
// relancer automatiquement. Cherche d'abord sur le disque local (rapide,
// couvre un simple crash/redémarrage du même conteneur), puis complète avec
// GitHub pour les tenants absents localement (cas d'un vrai redéploiement
// Render ayant vidé le disque éphémère) — sans ce second passage, un
// redéploiement perdrait la trace de toute campagne en cours dès que le
// disque local ne la porte plus.
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
      // Fichier corrompu/illisible : ignoré plutôt que de bloquer le
      // démarrage du serveur pour les autres tenants.
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
    // Déjà couvert par le disque local (source plus rapide et forcément à
    // jour dans ce cas) : inutile d'aller vérifier GitHub pour ce tenant.
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
      console.error(`État de campagne distant illisible (${filename}) :`, err.message);
    }
  }

  return [...tenantsFromLocal, ...tenantsFromRemote];
}

// Annule automatiquement (statut "cancelled") UNIQUEMENT les campagnes dont
// AUCUN process n'a donné signe de vie (lastProgressAt — voir
// CampaignEngine#_persist/_heartbeat) depuis plus de maxAgeMs : ni un envoi
// réel, ni le simple battement de cœur d'une attente longue (pause
// manuelle, coupure réseau, palier FLOOD_WAIT de plusieurs heures...).
// Une campagne activement suivie par un process — même en pause depuis des
// jours à attendre une restriction de compte — n'est donc JAMAIS annulée
// ici, conformément à la demande explicite de ne jamais purger une
// campagne "juste parce que du temps a passé" : seule une campagne
// réellement abandonnée (process disparu après une éviction de session
// jamais suivie de reconnexion, ou un crash sans redémarrage) finit par
// dépasser ce délai. Opère directement sur les fichiers (pas sur des
// instances CampaignEngine en mémoire, injoignables depuis ce module côté
// WhatsApp) : appelée périodiquement par index.js, elle couvre aussi bien
// les tenants encore actifs (dont le fichier reste à jour, donc jamais
// purgés) que les tenants dont l'instance a été libérée depuis longtemps.
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
      console.error(`Purge campagne WhatsApp (tenant "${tenantId}") : échec d'écriture locale —`, err.message);
      continue;
    }

    removeSequenceMedia((record.options && record.options.sequence) || []);

    if (githubStore.enabled) {
      githubStore.createStore(remoteFilePath(tenantId)).pushRemote(JSON.stringify(record, null, 2)).catch((err) => {
        console.error(`Purge campagne WhatsApp (tenant "${tenantId}") : échec de synchronisation GitHub —`, err.message);
      });
    }

    console.log(`Campagne WhatsApp (tenant "${tenantId}") : annulée automatiquement après ${ageHours}h sans aucun signe de vie.`);
    purged.push(tenantId);
  }

  return purged;
}

module.exports = {
  CampaignEngine,
  listTenantsWithPendingCampaigns,
  purgeStaleCampaigns,
  DEFAULT_STALE_MS,
};
