// Métadonnées de mise à jour servies par Cloudflare. Le téléchargement et
// l'application du binaire sont gérés par selfUpdate.js après vérification
// SHA-256; ce module ne contacte aucun serveur Firebase ou VPS.
const axios = require('axios');
const localVersion = require('../package.json').version;
const CLOUDFLARE_UPDATE_URL = `${String(process.env.CLOUDFLARE_LICENSE_URL || 'https://cyrus-license.ezechielatannidje.workers.dev').replace(/\/+$/, '')}/checkUpdateOffline`;

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(Number); const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchUpdateInfo() {
  const { data } = await axios.get(CLOUDFLARE_UPDATE_URL, { timeout: 10_000 });
  return data;
}

async function checkForUpdate() {
  try {
    const data = await fetchUpdateInfo();
    const updateAvailable = compareVersions(data.latestVersion, localVersion) > 0;
    return { updateAvailable, currentVersion: localVersion, ...data };
  } catch (err) {
    console.warn('Vérification de mise à jour Cloudflare impossible (ignorée) :', err.message);
    return { updateAvailable: false, currentVersion: localVersion };
  }
}

module.exports = { checkForUpdate, compareVersions, fetchUpdateInfo };
