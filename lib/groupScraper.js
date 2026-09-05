// Optimisation de l'extraction de groupes (Group Scraper) — utilisé par
// l'export de membres (voir POST /api/groups/export-members dans index.js).
// Ne touche à aucune logique du Queue Engine (queues/campaignEngine.js,
// queues/telegramCampaignEngine.js) : ce module ne fait que lire des
// métadonnées de groupe, il n'envoie aucun message.
//
// Sur une grosse sélection (plusieurs dizaines de groupes, parfois des
// milliers de membres cumulés), traiter tous les groupes d'affilée sans
// pause ni écriture intermédiaire est ce qui sature la RAM d'une instance
// Render à faible mémoire et déclenche des timeouts réseau côté WhatsApp.
// Cette fonction découpe donc le traitement par tranches de GROUP_CHUNK_SIZE
// groupes, attend GROUP_READ_DELAY_MS entre la lecture de chaque groupe (délai
// non bloquant, via setTimeout — la boucle d'événements Node reste libre
// pendant l'attente), et persiste les numéros extraits groupe par groupe
// (voir models/scrapedNumbers.js) plutôt que de les accumuler dans une
// variable JS le temps de toute l'extraction.

const scrapedNumbers = require('../models/scrapedNumbers');

const GROUP_CHUNK_SIZE = 20;
const GROUP_READ_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// extractRows(groupId, participants) -> { [clé]: ligne } : fourni par
// l'appelant, propre au format de sortie attendu (voir index.js pour
// l'extraction telephone/nom à partir des participants WhatsApp).
//
// Retourne { runId, processedCount, errors } — errors : un groupe en échec
// (ex: rate-overlimit WhatsApp) est consigné puis on passe au suivant, sans
// jamais interrompre le reste de l'extraction.
async function scrapeGroupsToStore(groupIds, getParticipants, extractRows) {
  const runId = scrapedNumbers.createRun();
  const chunks = chunkArray(groupIds, GROUP_CHUNK_SIZE);
  const errors = [];
  let processedCount = 0;

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const groupId = chunk[i];
      try {
        const participants = await getParticipants(groupId);
        const rows = extractRows(groupId, participants || []);
        if (rows && Object.keys(rows).length > 0) {
          scrapedNumbers.appendRows(runId, rows);
        }
        processedCount += 1;
      } catch (err) {
        console.error(`Group Scraper: échec sur le groupe "${groupId}", passage au suivant —`, err.message || err);
        errors.push({ groupId, error: err.message || String(err) });
      }

      const isLast = chunk === chunks[chunks.length - 1] && i === chunk.length - 1;
      if (!isLast) {
        await sleep(GROUP_READ_DELAY_MS);
      }
    }
  }

  return { runId, processedCount, errors };
}

module.exports = {
  scrapeGroupsToStore,
  GROUP_CHUNK_SIZE,
  GROUP_READ_DELAY_MS,
};
