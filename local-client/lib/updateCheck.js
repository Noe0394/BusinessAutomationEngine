// Vérification de version (point 3 de la feuille de route) — réutilise
// GET /api/check-update, déjà ajouté côté VPS (voir index.js racine). Ce
// module fait la comparaison de version et journalise un avertissement ;
// le TÉLÉCHARGEMENT + L'APPLICATION en arrière-plan d'une mise à jour
// (remplacement de l'exe packagé, redémarrage) est une étape volontairement
// non implémentée ici : remplacer un exécutable en cours d'exécution demande
// un soin particulier (fichier verrouillé sous Windows tant que le process
// tourne, risque de binaire corrompu si le téléchargement est interrompu) et
// mérite d'être traité séparément, une fois le packaging (voir
// package.local-client.json / README.md) en place.
const { client } = require('./vpsClient');
const localVersion = require('../package.json').version;

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const { data } = await client.get('/api/check-update');
    const updateAvailable = compareVersions(data.latestVersion, localVersion) > 0;
    return { updateAvailable, currentVersion: localVersion, ...data };
  } catch (err) {
    // Ne bloque jamais le démarrage pour une simple vérification de version.
    console.warn('Vérification de mise à jour impossible (ignorée) :', err.message);
    return { updateAvailable: false, currentVersion: localVersion };
  }
}

module.exports = { checkForUpdate };
