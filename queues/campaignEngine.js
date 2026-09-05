const fs = require('fs');
const path = require('path');
const { replaceVariables, normalizeRecipientEntry } = require('../lib/whatsappRecipients');

// Persistance de la progression d'une campagne WhatsApp, tenant par tenant
// (voir adapters/whatsappManager.js) : sur un environnement Docker/Render où
// le conteneur est éphémère, un redéploiement/crash ne doit ni perdre la
// progression déjà envoyée, ni renvoyer les messages déjà livrés au
// redémarrage. Chaque tenant a son propre fichier d'état
// (CAMPAIGNS_DIR/<tenantId>.json) — jamais partagé, comme le reste de la
// session WhatsApp de ce tenant.
//
// IMPORTANT (limite connue) : l'état est persisté sur disque APRÈS l'envoi
// effectif de chaque destinataire, pas avant — un crash survenant pile entre
// l'envoi réel et l'écriture du fichier peut donc faire renvoyer UN SEUL
// message (celui en cours au moment du crash) à la reprise. Un envoi WhatsApp
// ne pouvant pas être annulé une fois parti, une garantie "exactement une
// fois" est impossible sans changer la sémantique de livraison elle-même ;
// cette fenêtre de risque est réduite au minimum (un seul message, pas toute
// la file) plutôt qu'ignorée.
const CAMPAIGNS_DIR = process.env.CAMPAIGNS_DIR || path.join(__dirname, '..', 'campaigns_state');
const MEDIA_DIR = path.join(CAMPAIGNS_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

if (!process.env.CAMPAIGNS_DIR) {
  console.warn(
    `CAMPAIGNS_DIR non défini : la progression des campagnes WhatsApp est stockée dans "${CAMPAIGNS_DIR}" sur le disque local uniquement. ` +
    'Sur Render/Docker, ce dossier est effacé à chaque redéploiement/redémarrage sauf disque persistant (volume Docker monté sur ce chemin).',
  );
}

function statePath(tenantId) {
  return path.join(CAMPAIGNS_DIR, `${tenantId}.json`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

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
// original à l'utilisateur.
function persistSequenceMedia(tenantId, sequence) {
  return sequence.map((step, index) => {
    if (step.type !== 'media') return step;
    const mediaFile = `${tenantId}_${index}.bin`;
    fs.writeFileSync(path.join(MEDIA_DIR, mediaFile), step.buffer);
    return {
      type: 'media',
      mediaFile,
      mimetype: step.mimetype,
      filename: step.filename,
      forceDocument: Boolean(step.forceDocument),
    };
  });
}

// Inverse de persistSequenceMedia : relit les buffers depuis le disque, à
// l'initialisation d'une campagne (immédiat) ou à la reprise après
// redémarrage (resumeIfPending) — dans les deux cas, le moteur d'envoi a
// besoin des vrais buffers, jamais du chemin de fichier.
function resolveSequenceMedia(sequence) {
  return sequence.map((step) => {
    if (step.type !== 'media') return step;
    const buffer = fs.readFileSync(path.join(MEDIA_DIR, step.mediaFile));
    return {
      type: 'media',
      buffer,
      mimetype: step.mimetype,
      filename: step.filename,
      forceDocument: step.forceDocument,
    };
  });
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
  constructor(tenantId, session) {
    this.tenantId = tenantId;
    this.session = session;
    this.campaign = null; // état en mémoire de la campagne en cours/dernière
    this.persistableSequence = null; // forme sérialisable (mediaFile au lieu de buffer)
    this.resolvedSequence = null; // forme utilisable pour l'envoi (buffer réel)
  }

  _persist() {
    if (!this.campaign) return;
    const record = {
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
      options: {
        delaySeconds: this.campaign.options.delaySeconds,
        batchSize: this.campaign.options.batchSize,
        sequenceDelayMinMs: this.campaign.options.sequenceDelayMinMs,
        sequenceDelayMaxMs: this.campaign.options.sequenceDelayMaxMs,
        sequence: this.persistableSequence,
      },
    };
    // Écriture synchrone volontaire : le volume (une campagne à la fois par
    // tenant, un seul destinataire toutes les quelques secondes) reste
    // négligeable, et ça garantit que l'état sur disque est à jour avant que
    // la boucle d'envoi ne poursuive vers le destinataire suivant.
    fs.writeFileSync(statePath(this.tenantId), JSON.stringify(record, null, 2), 'utf8');
  }

  // Forme volontairement alignée sur l'ancien objet "currentCampaign" global
  // (avant l'isolation par tenant) : recipients/options/nextIndex restent
  // internes (utiles pour _persist()/resumeIfPending()) mais ne sont pas
  // renvoyés ici — /api/messages/status est interrogé toutes les quelques
  // secondes par le dashboard, et une liste de destinataires potentiellement
  // longue n'a rien à y faire.
  getStatus() {
    if (!this.campaign) return null;
    const { total, sent, success, failed, status, paused, stopRequested, startedAt, finishedAt, results } = this.campaign;
    return { total, sent, success, failed, status, paused, stopRequested, startedAt, finishedAt, results };
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
    const { delaySeconds, batchSize, sequenceDelayMinMs, sequenceDelayMaxMs } = campaign.options;
    const recipients = campaign.recipients;
    const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : recipients.length;
    const seqMinMs = Number.isFinite(sequenceDelayMinMs) ? sequenceDelayMinMs : 2000;
    const seqMaxMs = Number.isFinite(sequenceDelayMaxMs) ? Math.max(seqMinMs, sequenceDelayMaxMs) : Math.max(seqMinMs, 5000);
    const sequence = this.resolvedSequence;

    for (let i = startIndex; i < recipients.length; i += 1) {
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

      const { to, nom } = normalizeRecipientEntry(recipients[i], this.session.getContactName);
      let status = 'failed';

      try {
        for (let s = 0; s < sequence.length; s += 1) {
          const step = sequence[s];
          if (step.type === 'media') {
            await this.session.sendMedia(to, step);
          } else {
            await this.session.sendMessage(to, replaceVariables(step.text, { nom }));
          }
          if (s < sequence.length - 1) {
            await sleep(randomDelay(seqMinMs, seqMaxMs));
          }
        }
        status = 'delivered';
        campaign.success += 1;
        console.log(`Campagne (tenant "${this.tenantId}"): séquence envoyée à ${to} (${i + 1}/${recipients.length}).`);
      } catch (err) {
        campaign.failed += 1;
        console.error(`Campagne (tenant "${this.tenantId}"): échec de l'envoi à ${to}:`, err);
      }

      campaign.sent += 1;
      campaign.nextIndex = i + 1;
      campaign.results.push({ to, status, timestamp: new Date().toISOString() });
      this._persist();

      if (i < recipients.length - 1 && !campaign.stopRequested) {
        const baseDelayMs = delaySeconds ? delaySeconds * 1000 : randomDelay(8000, 15000);
        const endOfBatch = (i + 1) % batch === 0;
        const delayMs = endOfBatch ? baseDelayMs * 3 : baseDelayMs;
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

  start(recipients, options = {}) {
    if (this.campaign && this.campaign.status === 'running') {
      throw new Error('CAMPAIGN_IN_PROGRESS');
    }

    this.persistableSequence = persistSequenceMedia(this.tenantId, options.sequence || []);
    this.resolvedSequence = resolveSequenceMedia(this.persistableSequence);

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
        sequenceDelayMinMs: options.sequenceDelayMinMs,
        sequenceDelayMaxMs: options.sequenceDelayMaxMs,
      },
    };
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

  // Appelée une fois par tenant au démarrage du process (voir
  // adapters/whatsappManager.js#bootResumePendingCampaigns) si un fichier
  // d'état persisté indique une campagne encore "running"/"paused" au moment
  // où le conteneur s'est arrêté (redéploiement, crash) — reprend l'envoi
  // exactement au destinataire suivant (nextIndex), sans redemander à
  // l'utilisateur de relancer quoi que ce soit.
  resumeIfPending() {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(statePath(this.tenantId), 'utf8'));
    } catch (err) {
      return false;
    }

    if (record.status !== 'running' && record.status !== 'paused') {
      return false;
    }

    this.persistableSequence = record.options.sequence || [];
    this.resolvedSequence = resolveSequenceMedia(this.persistableSequence);

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
    this._persist();

    console.log(
      `Campagne (tenant "${this.tenantId}"): reprise après redémarrage à partir du destinataire ${record.nextIndex + 1}/${record.total}.`,
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
// relancer automatiquement.
function listTenantsWithPendingCampaigns() {
  let files;
  try {
    files = fs.readdirSync(CAMPAIGNS_DIR);
  } catch (err) {
    return [];
  }

  const tenants = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, file), 'utf8'));
      if (record.status === 'running' || record.status === 'paused') {
        tenants.push(record.tenantId || file.replace(/\.json$/, ''));
      }
    } catch (err) {
      // Fichier corrompu/illisible : ignoré plutôt que de bloquer le
      // démarrage du serveur pour les autres tenants.
      console.error(`État de campagne illisible (${file}) :`, err.message);
    }
  }
  return tenants;
}

module.exports = {
  CampaignEngine,
  listTenantsWithPendingCampaigns,
};
