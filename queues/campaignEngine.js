const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');
const { normalizeRecipientEntry } = require('../lib/whatsappRecipients');
const { personalizeMessage } = require('../lib/personalization');
const circuitBreaker = require('../lib/circuitBreaker');

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

    while (!campaign.stopRequested && health.isHeld()) {
      await sleep(1000);
    }
    if (campaign.stopRequested) return;

    while (!campaign.stopRequested && !this.session.isConnected()) {
      console.log(`Campagne (tenant "${this.tenantId}"): health check négatif — nouvelle vérification dans 30s avant reprise.`);
      await sleep(circuitBreaker.HEALTH_RECHECK_INTERVAL_MS);
    }
    if (campaign.stopRequested) return;

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
      if (campaign.stopRequested) return;
      await sleep(300);
    }
  }

  _buildRecord() {
    return {
      tenantId: this.tenantId,
      status: this.campaign.status,
      paused: this.campaign.paused,
      stopRequested: this.campaign.stopRequested,
      total: this.campaign.total,
      sent: this.campaign.sent,
      success: this.campaign.success,
      failed: this.campaign.failed,
      startedAt: this.campaign.startedAt,
      finishedAt: this.campaign.finishedAt,
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
    const { total, sent, success, failed, status, paused, stopRequested, startedAt, finishedAt, results, resumeError } = this.campaign;
    const base = {
      total, sent, success, failed, status, paused, stopRequested, startedAt, finishedAt, results,
      networkStatus: this.networkHealth.networkStatus,
    };
    return resumeError ? { ...base, resumeError } : base;
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

    while (!this.session.isConnected() && !campaign.stopRequested) {
      await sleep(1000);
    }

    campaign.paused = false;
    if (!campaign.stopRequested) {
      console.log(`Campagne (tenant "${this.tenantId}"): reprise après reconnexion WhatsApp.`);
    }
  }

  _markRemainingInterrupted(fromIndex) {
    const campaign = this.campaign;
    for (let j = fromIndex; j < campaign.recipients.length; j += 1) {
      campaign.results.push({
        to: normalizeRecipientEntry(campaign.recipients[j], this.session.getContactName).to,
        status: 'interrupted',
        timestamp: new Date().toISOString(),
      });
    }
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
  async _run(startIndex) {
    const campaign = this.campaign;
    const { delaySeconds, batchSize, batchPauseSeconds, sequenceDelayMinMs, sequenceDelayMaxMs } = campaign.options;
    const recipients = campaign.recipients;
    const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : recipients.length;
    const seqMinMs = Number.isFinite(sequenceDelayMinMs) ? sequenceDelayMinMs : 2000;
    const seqMaxMs = Number.isFinite(sequenceDelayMaxMs) ? Math.max(seqMinMs, sequenceDelayMaxMs) : Math.max(seqMinMs, 5000);
    const sequence = this.resolvedSequence;

    let i = startIndex;
    while (i < recipients.length) {
      if (campaign.stopRequested) {
        this._markRemainingInterrupted(i);
        this._persist();
        console.log(`Campagne (tenant "${this.tenantId}"): interrompue par l'utilisateur.`);
        return;
      }

      await this._waitForConnection();

      if (campaign.stopRequested) {
        this._markRemainingInterrupted(i);
        this._persist();
        console.log(`Campagne (tenant "${this.tenantId}"): interrompue par l'utilisateur.`);
        return;
      }

      await this._waitForIncomingPause();

      if (campaign.stopRequested) {
        this._markRemainingInterrupted(i);
        this._persist();
        console.log(`Campagne (tenant "${this.tenantId}"): interrompue par l'utilisateur.`);
        return;
      }

      await this._waitForNetworkHold();

      if (campaign.stopRequested) {
        this._markRemainingInterrupted(i);
        this._persist();
        console.log(`Campagne (tenant "${this.tenantId}"): interrompue par l'utilisateur.`);
        return;
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
        status = 'delivered';
        campaign.success += 1;
        this.networkHealth.recordSuccess();
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
          this._persist();
          console.log(
            `Campagne (tenant "${this.tenantId}"): signal de surcharge détecté (${err.message}) — ` +
            `statut 'circuit_open', nouvelle tentative pour ${to} dans ${Math.round(backoffMs / 60000)} min (index ${i} conservé).`,
          );
        } else {
          campaign.failed += 1;
          console.error(`Campagne (tenant "${this.tenantId}"): échec de l'envoi à ${to}:`, err);
        }
      }

      if (overloadDetected) {
        // Ne pas incrémenter i : le prochain passage dans la boucle
        // retentera CE MÊME destinataire, après _waitForNetworkHold().
        continue;
      }

      campaign.sent += 1;
      campaign.nextIndex = i + 1;
      campaign.results.push({ to, status, timestamp: new Date().toISOString() });
      this._persist();
      if (this.onActivity) this.onActivity();

      i += 1;

      if (i < recipients.length && !campaign.stopRequested) {
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
        await interruptibleSleep(delayMs, () => campaign.stopRequested);
      }
    }

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

    this.campaign = {
      total: recipients.length,
      sent: 0,
      success: 0,
      failed: 0,
      status: 'running',
      paused: false,
      stopRequested: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      nextIndex: 0,
      recipients,
      results: [],
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
    this._persist();

    this._run(0).catch((err) => {
      console.error(`Erreur pendant la campagne (tenant "${this.tenantId}"):`, err);
      this.campaign.status = 'stopped';
      this.campaign.paused = false;
      this.campaign.finishedAt = new Date().toISOString();
      this._persist();
    });

    return this.campaign;
  }

  stop() {
    if (!this.campaign || this.campaign.status !== 'running') {
      throw new Error('NO_CAMPAIGN_RUNNING');
    }
    this.campaign.stopRequested = true;
    this._persist();
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

  // Appelée une fois par tenant au démarrage du process (voir
  // adapters/whatsappManager.js#bootResumePendingCampaigns) si un état
  // persisté (local ou distant) indique une campagne encore
  // "running"/"paused" au moment où le conteneur s'est arrêté (redéploiement,
  // crash) — reprend l'envoi exactement au destinataire suivant (nextIndex),
  // sans redemander à l'utilisateur de relancer quoi que ce soit.
  async resumeIfPending() {
    const record = await this._loadRecord();
    if (!record) return false;

    if (record.status !== 'running' && record.status !== 'paused') {
      return false;
    }

    this.persistableSequence = record.options.sequence || [];

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
        status: 'stopped',
        paused: false,
        stopRequested: true,
        startedAt: record.startedAt,
        finishedAt: new Date().toISOString(),
        nextIndex: record.nextIndex,
        recipients: record.recipients,
        results: record.results,
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
      status: 'running',
      paused: false,
      stopRequested: record.stopRequested,
      startedAt: record.startedAt,
      finishedAt: null,
      nextIndex: record.nextIndex,
      recipients: record.recipients,
      results: record.results,
      options: record.options,
    };
    // Restaure la pause de sécurité en cours (voir lib/circuitBreaker.js) le
    // cas échéant, plutôt que de repartir sur un compteur d'échecs à zéro :
    // un redéploiement survenant en pleine pause 'circuit_open' ne doit pas
    // faire retenter l'envoi immédiatement alors que le service distant
    // pourrait être toujours surchargé.
    this.networkHealth = circuitBreaker.CircuitBreakerState.fromJSON(record.networkHealth);
    this._persist();

    console.log(
      `Campagne (tenant "${this.tenantId}"): reprise après redémarrage à partir du destinataire ${record.nextIndex + 1}/${record.total}` +
      `${this.networkHealth.isHeld() ? ` (statut réseau '${this.networkHealth.networkStatus}' restauré, en pause jusqu'à ${new Date(this.networkHealth.holdUntil).toISOString()})` : ''}.`,
    );

    this._run(record.nextIndex).catch((err) => {
      console.error(`Erreur pendant la reprise de campagne (tenant "${this.tenantId}"):`, err);
      this.campaign.status = 'stopped';
      this.campaign.paused = false;
      this.campaign.finishedAt = new Date().toISOString();
      this._persist();
    });

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

module.exports = {
  CampaignEngine,
  listTenantsWithPendingCampaigns,
};
