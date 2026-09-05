const fs = require('fs');
const path = require('path');

// Persistance temporaire de l'extraction de groupes (Group Scraper, voir
// lib/groupScraper.js) : même principe de "base de données" par fichier JSON
// que le reste du projet (contacts.json, scheduled_messages.json...), mais
// ici chaque extraction écrit ses lignes au fur et à mesure qu'un groupe est
// traité plutôt que de les garder dans une variable JS le temps de toute la
// requête HTTP — sur une grosse extraction (plusieurs dizaines de groupes,
// parfois des milliers de membres cumulés), garder tout en mémoire vive
// jusqu'à la fin est ce qui sature la RAM sur une instance Render à faible
// mémoire et provoque des timeouts réseau. Le "run" est supprimé une fois la
// requête HTTP terminée (voir clearRun) : ce fichier n'est qu'un tampon de
// travail, pas un historique permanent des extractions.
const STORE_PATH = process.env.SCRAPED_NUMBERS_PATH || path.join(__dirname, '..', 'scraped_numbers.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeAll(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data), 'utf8');
}

function createRun() {
  const runId = `scrape_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const all = readAll();
  all[runId] = {};
  writeAll(all);
  return runId;
}

// Fusionne les lignes d'UN groupe dans le run (dédoublonnage par clé, ex: le
// JID téléphone) sans jamais garder l'ensemble du run en mémoire au-delà de
// cet appel — relu puis réécrit sur disque à chaque groupe traité.
function appendRows(runId, rows) {
  const all = readAll();
  const run = all[runId] || {};
  Object.assign(run, rows);
  all[runId] = run;
  writeAll(all);
}

function listRun(runId) {
  const all = readAll();
  return Object.values(all[runId] || {});
}

function clearRun(runId) {
  const all = readAll();
  delete all[runId];
  writeAll(all);
}

module.exports = { createRun, appendRows, listRun, clearRun };
