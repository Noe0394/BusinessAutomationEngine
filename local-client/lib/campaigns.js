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
const { db, getContactName } = require('./db');
const whatsapp = require('./whatsapp');
const { normalizeRecipientEntry } = require('./whatsappRecipients');
const { personalizeMessage } = require('./personalization');

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
function createCampaign(name, recipients, { text, delayMinMs, delayMaxMs } = {}) {
  if (!name || !name.trim()) throw new Error('Nom de campagne manquant.');
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('Liste de destinataires vide.');
  if (!text || !text.trim()) throw new Error('Message manquant.');

  const normalized = recipients.map((r) => normalizeRecipientEntry(r, getContactName));
  const results = normalized.map((r) => ({ to: r.to, nom: r.nom, status: 'pending', error: null, sentAt: null }));
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO campaigns (id, name, status, config_json, results_json)
    VALUES (?, ?, 'draft', ?, ?)
  `).run(
    id,
    name.trim(),
    JSON.stringify({ text, delayMinMs: delayMinMs || 8000, delayMaxMs: delayMaxMs || 20000, recipients: normalized }),
    JSON.stringify(results),
  );

  return getCampaign(id);
}

async function runLoop(id) {
  if (runningLoops.has(id)) return;
  runningLoops.add(id);
  try {
    for (;;) {
      const campaign = getCampaign(id);
      if (!campaign || campaign.status !== 'running') break;

      const nextIndex = campaign.results.findIndex((r) => r.status === 'pending');
      if (nextIndex === -1) {
        setStatus(id, 'completed');
        break;
      }

      // Ne consomme jamais de destinataire si la session WhatsApp est
      // coupée — met en pause plutôt que de perdre silencieusement un envoi
      // ou d'accumuler des erreurs pour toute la liste restante.
      if (!whatsapp.isConnected()) {
        setStatus(id, 'paused');
        break;
      }

      const recipient = campaign.config.recipients[nextIndex];
      const results = campaign.results;
      try {
        await whatsapp.sendMessage(recipient.to, personalizeMessage(campaign.config.text, recipient.vars));
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

      await new Promise((resolve) => {
        setTimeout(resolve, randomDelay(campaign.config.delayMinMs, campaign.config.delayMaxMs));
      });
    }
  } finally {
    runningLoops.delete(id);
  }
}

function startCampaign(id) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error('Campagne introuvable.');
  if (campaign.status === 'completed') throw new Error('Cette campagne est déjà terminée.');

  setStatus(id, 'running');
  runLoop(id).catch((err) => {
    console.error(`Erreur dans la boucle de la campagne "${id}" :`, err.message);
    setStatus(id, 'error');
  });
}

function pauseCampaign(id) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error('Campagne introuvable.');
  setStatus(id, 'paused');
}

function cancelCampaign(id) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error('Campagne introuvable.');
  setStatus(id, 'cancelled');
}

// Si la session WhatsApp se reconnecte alors qu'une campagne a été mise en
// pause PAR ce moteur (déconnexion, pas par l'utilisateur), on la reprend
// automatiquement — sans ça une coupure réseau temporaire immobiliserait
// une campagne jusqu'à une action manuelle. Une campagne mise en pause
// explicitement par l'utilisateur redémarrerait aussi ici : compromis
// accepté pour un usage mono-poste (voir README.md, pas de distinction
// pause-auto/pause-manuelle dans ce premier jet).
whatsapp.onStateChange(({ connected }) => {
  if (!connected) return;
  for (const campaign of listCampaigns()) {
    if (campaign.status === 'paused' && campaign.results.some((r) => r.status === 'pending')) {
      startCampaign(campaign.id);
    }
  }
});

module.exports = {
  createCampaign,
  getCampaign,
  listCampaigns,
  startCampaign,
  pauseCampaign,
  cancelCampaign,
};
