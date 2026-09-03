// Script de secours à exécuter en dehors du service Render lui-même (cron
// externe, GitHub Actions planifiée, machine locale...) : si le service ne
// répond plus à /ping, on demande à l'API Render de le redémarrer. Utile
// pour couvrir les pannes que le heartbeat interne (index.js) ne peut pas
// détecter/corriger lui-même — un process bloqué ne peut pas se relancer.
//
// Variables d'environnement attendues :
//   RENDER_API_KEY   - clé API Render (Account Settings > API Keys), jamais
//                       codée en dur ici : ne commitez jamais cette valeur.
//   RENDER_SERVICE_ID- id du service Render (par défaut celui de ce projet).
//   PING_URL         - URL complète du endpoint /ping à vérifier.
//
// Usage : node scripts/keep_alive_recovery.js
const axios = require('axios');

const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || 'srv-daca0jqfngtc73cl005g';
const PING_URL = process.env.PING_URL || 'https://business-automation-engine.onrender.com/ping';
const PING_TIMEOUT_MS = 15_000;

async function isServiceHealthy() {
  try {
    const res = await axios.get(PING_URL, { timeout: PING_TIMEOUT_MS });
    return res.status === 200 && res.data && res.data.status === 'active';
  } catch (err) {
    console.error(`Ping échoué (${PING_URL}) :`, err.message);
    return false;
  }
}

async function restartService() {
  if (!RENDER_API_KEY) {
    throw new Error(
      'RENDER_API_KEY non définie : impossible de demander le redémarrage. ' +
      'Définissez cette variable d\'environnement (jamais en dur dans ce fichier) avant d\'exécuter ce script.',
    );
  }

  await axios.post(
    `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/restart`,
    {},
    { headers: { Authorization: `Bearer ${RENDER_API_KEY}` }, timeout: PING_TIMEOUT_MS },
  );
}

async function main() {
  const healthy = await isServiceHealthy();

  if (healthy) {
    console.log(`Service OK (${PING_URL}).`);
    return;
  }

  console.warn(`Service injoignable ou dégradé (${PING_URL}) — demande de redémarrage à Render...`);

  try {
    await restartService();
    console.log(`Redémarrage demandé avec succès pour ${RENDER_SERVICE_ID}.`);
  } catch (err) {
    console.error('Échec de la demande de redémarrage :', err.response?.data || err.message);
    process.exitCode = 1;
  }
}

main();
