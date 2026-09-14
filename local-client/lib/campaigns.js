// Moteur de campagnes local — version allégée de queues/campaignEngine.js
// (racine du dépôt), adaptée à un usage mono-poste sur SQLite plutôt que
// disque JSON/GitHub multi-tenant. Réutilise deux petites fonctions PURES du
// dépôt racine (aucun secret, aucune dépendance réseau) : normalizeRecipientEntry
// et personalizeMessage. Copiées ici (avec leur dépendance spintax.js) plutôt
// que requises via '../../lib/...' pour que local-client reste un dossier
// autonome, copiable tel quel et packageable en .exe (pkg ne peut pas
// résoudre statiquement un require qui sort de ce dossier) — à resynchroniser
// manuellement avec lib/whatsappRecipients.js, lib/personalization.js et
// lib/spintax.js à la racine si ces fonctions pures évoluent côté backend.
const crypto = require('crypto');
const { db, getContactName, isBlocked } = require('./db');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');
const { normalizeRecipientEntry } = require('./whatsappRecipients');
const { normalizeRecipientEntry: normalizeTelegramRecipientEntry } = require('./telegramRecipients');
const { personalizeMessage } = require('./personalization');

// Dispatch WhatsApp/Telegram par canal - `channel` vit dans config_json (pas
// de colonne dediee, voir rowToCampaign) : aucune migration de schema requise
// pour ajouter Telegram aux campagnes deja persistees (une campagne existante
// sans `channel` explicite est traitee comme 'whatsapp', comportement
// historique inchange).
function adapterFor(channel) {
  return channel === 'telegram' ? telegram : whatsapp;
}

function normalizerFor(channel) {
  return channel === 'telegram' ? normalizeTelegramRecipientEntry : normalizeRecipientEntry;
}

// Évite qu'un double-clic "Démarrer" (ou un redémarrage rapide du serveur
// pendant qu'une boucle précédente tourne encore) ne lance deux boucles
// d'envoi concurrentes pour la même campagne.
const runningLoops = new Set();

function randomDelay(minMs, maxMs) {
  const min = Math.max(1000, minMs || 8000);
  const max = Math.max(min, maxMs || 20000);
  return min + Math.floor(Math.random() * (max - min));
}

function rowToCampaign(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: JSON.parse(row.config_json),
    results: JSON.parse(row.results_json),
  };
}

function getCampaign(id) {
  return rowToCampaign(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id));
}

function listCampaigns() {
  return db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all().map(rowToCampaign);
}

function setStatus(id, status) {
  db.prepare("UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

function saveResults(id, results) {
  db.prepare("UPDATE campaigns SET results_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(results), id);
}

// recipients : tableau de chaînes ("2250700000000" ou déjà un JID) ou
// d'objets { telephone, nom } — même format accepté que le backend
// principal (voir lib/whatsappRecipients.js#normalizeRecipientEntry).
// `media` (optionnel) : { base64, mimetype, filename } — la pièce jointe est
// stockée telle quelle dans config_json (comme le reste de la config de
// campagne), envoyée en légende (`caption`) avec le texte personnalisé à
// chaque destinataire plutôt qu'en message texte séparé.
function createCampaign(name, recipients, { text, delayMinMs, delayMaxMs, channel, media, batchSize, batchPauseMs } = {}) {
  if (!name || !name.trim()) throw new Error('Nom de campagne manquant.');
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('Liste de destinataires vide.');
  if (!text || !text.trim()) throw new Error('Message manquant.');
  if (media && (!media.base64 || !media.mimetype)) throw new Error('Pièce jointe invalide (base64/mimetype requis).');

  const resolvedChannel = channel === 'telegram' ? 'telegram' : 'whatsapp';
  const normalizedAll = recipients.map((r) => normalizerFor(resolvedChannel)(r, getContactName));
  // Liste noire (voir lib/db.js#isBlocked) - appliquée ici, point d'entrée
  // UNIQUE de toute campagne quelle que soit la source des destinataires
  // (saisie manuelle ou extraction de groupe, voir index.js) : un contact
  // bloqué n'entre jamais dans `results`, donc jamais dans la boucle d'envoi.
  const normalized = normalizedAll.filter((r) => !isBlocked(resolvedChannel, r.to));
  const blockedCount = normalizedAll.length - normalized.length;
  if (normalized.length === 0) {
    throw new Error(blockedCount > 0 ? 'Tous les destinataires sont dans la liste noire.' : 'Liste de destinataires vide.');
  }
  const results = normalized.map((r) => ({ to: r.to, nom: r.nom, status: 'pending', error: null, sentAt: null }));
  const id = crypto.randomUUID();

  // Telegram impose un délai strict 30-60s entre chaque DM (limite
  // anti-spam de la plateforme, pas un choix produit) — clampé ici quel que
  // soit ce que l'appelant a demandé, même comportement que le VPS
  // (public/dashboard.html, champs tg-dm-min-delay/tg-dm-max-delay bornés
  // 30-60 côté UI ET revérifiés ici côté données persistées).
  let effectiveMin = delayMinMs || 8000;
  let effectiveMax = delayMaxMs || 20000;
  if (resolvedChannel === 'telegram') {
    effectiveMin = Math.min(60000, Math.max(30000, effectiveMin));
    effectiveMax = Math.min(60000, Math.max(effectiveMin, effectiveMax));
  }

  db.prepare(`
    INSERT INTO campaigns (id, name, status, config_json, results_json)
    VALUES (?, ?, 'draft', ?, ?)
  `).run(
    id,
    name.trim(),
    JSON.stringify({
      text, channel: resolvedChannel, delayMinMs: effectiveMin, delayMaxMs: effectiveMax, recipients: normalized,
      media: media ? { base64: media.base64, mimetype: media.mimetype, filename: media.filename || '' } : null,
      batchSize: Math.max(1, batchSize || 0) || null,
      batchPauseMs: Math.max(1000, batchPauseMs || 0) || null,
    }),
    JSON.stringify(results),
  );

  // blockedCount est une propriété TRANSIENTE (pas persistée en base) sur la
  // valeur de retour de cet appel précis - juste de quoi informer l'appelant
  // HTTP (voir index.js) du nombre de destinataires exclus par la liste
  // noire, sans changer la forme de l'objet campagne stocké/relu ailleurs.
  const created = getCampaign(id);
  created.blockedCount = blockedCount;
  return created;
}

async function runLoop(id) {
  if (runningLoops.has(id)) return;
  runningLoops.add(id);
  // Compteur de lot (voir createCampaign#batchSize/batchPauseMs) — reset à
  // chaque (re)démarrage de la boucle (pause manuelle, reconnexion) plutôt
  // que persisté : une repise redémarre simplement un nouveau lot, jamais un
  // comportement incorrect, juste moins précis qu'un compteur en base.
  let sentInBatch = 0;
  try {
    for (;;) {
      const campaign = getCampaign(id);
      if (!campaign || campaign.status !== 'running') break;

      const nextIndex = campaign.results.findIndex((r) => r.status === 'pending');
      if (nextIndex === -1) {
        setStatus(id, 'completed');
        break;
      }

      const adapter = adapterFor(campaign.config.channel);

      // Ne consomme jamais de destinataire si la session du canal est
      // coupée — met en pause plutôt que de perdre silencieusement un envoi
      // ou d'accumuler des erreurs pour toute la liste restante.
      if (!adapter.isConnected()) {
        setStatus(id, 'paused');
        break;
      }

      const recipient = campaign.config.recipients[nextIndex];
      const results = campaign.results;
      try {
        const caption = personalizeMessage(campaign.config.text, recipient.vars);
        if (campaign.config.media) {
          await adapter.sendMedia(recipient.to, {
            buffer: Buffer.from(campaign.config.media.base64, 'base64'),
            mimetype: campaign.config.media.mimetype,
            filename: campaign.config.media.filename,
            caption,
          });
        } else {
          await adapter.sendMessage(recipient.to, caption);
        }
        results[nextIndex] = { ...results[nextIndex], status: 'sent', sentAt: new Date().toISOString() };
      } catch (err) {
        results[nextIndex] = { ...results[nextIndex], status: 'error', error: err.message };
      }
      saveResults(id, results);

      // Re-vérifie le statut (pause/annulation demandée pendant l'envoi
      // ci-dessus) AVANT d'attendre le délai — une campagne mise en pause ne
      // doit pas rester bloquée à attendre pour rien.
      const fresh = getCampaign(id);
      if (!fresh || fresh.status !== 'running') break;

      sentInBatch += 1;
      const { batchSize, batchPauseMs } = campaign.config;
      const waitMs = (batchSize && sentInBatch >= batchSize)
        ? Math.max(randomDelay(campaign.config.delayMinMs, campaign.config.delayMaxMs), batchPauseMs || 0)
        : randomDelay(campaign.config.delayMinMs, campaign.config.delayMaxMs);
      if (batchSize && sentInBatch >= batchSize) sentInBatch = 0;

      await new Promise((resolve) => { setTimeout(resolve, waitMs); });
    }
  } finally {
    runningLoops.delete(id);
    // File d'attente multi-campagnes (parité dashboard.html) : une seule
    // campagne à la fois envoie réellement par canal - toute autre campagne
    // démarrée pendant ce temps a été mise en 'queued' (voir startCampaign)
    // plutôt que lancée en parallèle sur la même session WhatsApp/Telegram
    // (concurrent = envois entrelacés non maîtrisés, jamais souhaitable).
    advanceQueue(id);
  }
}

// Démarre la plus ancienne campagne 'queued' du même canal que `finishedId`
// vient de libérer, s'il y en a une - no-op sinon. Appelé à la fin de
// CHAQUE boucle (complétée, mise en pause, erreur, annulée), jamais
// seulement en cas de succès : une campagne en pause doit libérer la place
// pour la suivante en attente, pas la bloquer indéfiniment.
function advanceQueue(finishedId) {
  const finished = getCampaign(finishedId);
  const channel = finished ? (finished.config.channel || 'whatsapp') : null;
  if (!channel) return;
  const next = listCampaigns()
    .filter((c) => c.status === 'queued' && (c.config.channel || 'whatsapp') === channel)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  if (next) startCampaign(next.id);
}

function startCampaign(id) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error('Campagne introuvable.');
  if (campaign.status === 'completed') throw new Error('Cette campagne est déjà terminée.');

  const channel = campaign.config.channel || 'whatsapp';
  const anotherActive = listCampaigns().some((c) => c.id !== id && c.status === 'running' && (c.config.channel || 'whatsapp') === channel);
  if (anotherActive) {
    setStatus(id, 'queued');
    return;
  }

  setStatus(id, 'running');
  runLoop(id).catch((err) => {
    console.error(`Erreur dans la boucle de la campagne "${id}" :`, err.message);
    setStatus(id, 'error');
  });
}

function pauseCampaign(id) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error('Campagne introuvable.');
  const wasRunning = campaign.status === 'running';
  setStatus(id, 'paused');
  if (wasRunning) advanceQueue(id);
}

function cancelCampaign(id) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error('Campagne introuvable.');
  const wasRunning = campaign.status === 'running';
  setStatus(id, 'cancelled');
  if (wasRunning) advanceQueue(id);
}

// Trace un envoi déclenché par la Relance Manuelle Express (deep link ouvert
// manuellement, voir public/relance.js) plutôt que par la boucle automatique
// ci-dessus — même tableau `results`, pour que ce contact n'apparaisse plus
// comme pending/error dans la file au prochain chargement.
function markManualSent(id, to) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error('Campagne introuvable.');
  const results = campaign.results.map((r) => (r.to === to ? { ...r, status: 'sent', sentAt: new Date().toISOString() } : r));
  saveResults(id, results);
}

// Si la session d'un canal se reconnecte alors qu'une campagne DE CE CANAL a
// été mise en pause PAR ce moteur (déconnexion, pas par l'utilisateur), on la
// reprend automatiquement — sans ça une coupure réseau temporaire
// immobiliserait une campagne jusqu'à une action manuelle. Une campagne mise
// en pause explicitement par l'utilisateur redémarrerait aussi ici : compromis
// accepté pour un usage mono-poste (voir README.md, pas de distinction
// pause-auto/pause-manuelle dans ce premier jet). Filtré par canal : la
// reconnexion WhatsApp ne doit jamais réveiller une campagne Telegram en
// pause faute de session Telegram, et inversement.
function resumePausedCampaigns(channel) {
  for (const campaign of listCampaigns()) {
    const campaignChannel = campaign.config.channel || 'whatsapp';
    if (campaignChannel === channel && campaign.status === 'paused' && campaign.results.some((r) => r.status === 'pending')) {
      startCampaign(campaign.id);
    }
  }
}

whatsapp.onStateChange(({ connected }) => { if (connected) resumePausedCampaigns('whatsapp'); });
telegram.onStateChange(({ connected }) => { if (connected) resumePausedCampaigns('telegram'); });

module.exports = {
  createCampaign,
  getCampaign,
  listCampaigns,
  startCampaign,
  pauseCampaign,
  cancelCampaign,
  markManualSent,
};
