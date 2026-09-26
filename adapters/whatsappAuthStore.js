const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');

// Baileys credentials and Signal keys are one indivisible session. Keep the
// full AUTH_DIR tenant folder on persistent storage; never restore creds.json
// from a credentials-only remote backup.
const CREDS_FILENAME = 'creds.json';
const REMOTE_DIR = process.env.GITHUB_WHATSAPP_AUTH_DIR || 'whatsapp_auth';

function readCreds(authDir) {
  const full = path.join(authDir, CREDS_FILENAME);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}


// tenantId doit déjà être normalisé/assaini par l'appelant (voir
// whatsappManager.sanitizeTenantId) — ce module ne fait que construire le
// chemin distant à partir de la valeur reçue.
function createAuthStore(tenantId) {
  const remotePath = `${REMOTE_DIR}/${tenantId}.json`;
  const store = githubStore.createStore(remotePath);

  async function restoreSessionFromRemote(authDir) {
    // GitHub ne contient que creds.json, jamais les cles Signal associees.
    // Ce snapshot ne peut donc pas restaurer une session Baileys coherente.
    // Garder l'AUTH_DIR local complet ou demander un nouvel appairage.
    if (store.enabled && !readCreds(authDir)) {
      console.warn(`Sauvegarde WhatsApp distante ignoree pour le tenant "${tenantId}" : cles Signal absentes; restaurer AUTH_DIR complet ou reappairer le compte.`);
    }
    return false;
  }

  async function pushSnapshot() {
    // A credentials-only backup is not a recoverable Baileys auth state.
    // Do not upload secrets that cannot safely restore the Signal sessions.
  }

  function startPeriodicSync() {
    // Retained for engine API compatibility; there is no partial remote sync.
  }
  function stopPeriodicSync() {}

  // Delete obsolete credentials-only backups on explicit logout.
  async function clearRemote() {
    if (!store.enabled) return;
    try {
      await store.pushRemote('');
    } catch (err) {
      console.error(`Échec de la suppression de la session WhatsApp sur GitHub pour le tenant "${tenantId}" :`, err.message);
    }
  }

  return {
    enabled: false,
    restoreSessionFromRemote,
    pushSnapshot,
    startPeriodicSync,
    stopPeriodicSync,
    clearRemote,
    getStatus: () => ({
      enabled: false,
      storage: 'AUTH_DIR',
      restoreSupported: false,
      reason: 'Session Baileys complete (creds.json + Signal keys) requires a persistent AUTH_DIR volume.',
    }),
  };
}

module.exports = {
  createAuthStore,
};
