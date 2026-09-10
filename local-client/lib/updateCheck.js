// Vérification de version — Firebase EN PREMIER (voir
// firebase-functions/index.js#checkUpdateOffline, métadonnées dans Firestore
// config/local-client), VPS (GET /api/check-update) en repli, même principe
// que lib/license.js et lib/aiGateway.js. Ce module ne fait QUE la
// comparaison de version et renvoyer les métadonnées (downloadUrl, sha256) —
// le TÉLÉCHARGEMENT + L'APPLICATION réels (remplacement de l'exe,
// redémarrage) sont gérés par launcher.js, qui tourne AVANT l'app elle-même
// (jamais de remplacement d'un exécutable en cours d'exécution, verrouillé
// sous Windows tant que le process tourne). Utilisé ici uniquement pour un
// avertissement informatif au démarrage de l'app elle-même — voir index.js —
// qui, par construction, tourne déjà en dernière version puisque le launcher
// a fait la mise à jour juste avant.
const axios = require('axios');
const { client } = require('./vpsClient');
const localVersion = require('../package.json').version;

const FIREBASE_UPDATE_URL = process.env.FIREBASE_UPDATE_URL || '';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchUpdateInfo() {
  if (FIREBASE_UPDATE_URL) {
    try {
      const { data } = await axios.get(FIREBASE_UPDATE_URL, { timeout: 10_000 });
      return data;
    } catch (err) {
      console.warn('Firebase injoignable pour la vérification de mise à jour — repli sur le VPS :', err.message);
    }
  }
  const { data } = await client.get('/api/check-update');
  return data;
}

async function checkForUpdate() {
  try {
    const data = await fetchUpdateInfo();
    const updateAvailable = compareVersions(data.latestVersion, localVersion) > 0;
    return { updateAvailable, currentVersion: localVersion, ...data };
  } catch (err) {
    // Ne bloque jamais le démarrage pour une simple vérification de version.
    console.warn('Vérification de mise à jour impossible (ignorée) :', err.message);
    return { updateAvailable: false, currentVersion: localVersion };
  }
}

module.exports = { checkForUpdate, compareVersions, fetchUpdateInfo };
