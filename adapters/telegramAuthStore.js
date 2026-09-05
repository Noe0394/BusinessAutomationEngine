const fs = require('fs');
const githubStore = require('../githubStore');

// Isolation stricte par tenant (une clé de licence = un tenant = un compte
// Telegram indépendant, voir adapters/telegramManager.js) : chaque tenant a
// son propre fichier distant (REMOTE_DIR/<tenantId>.json) plutôt qu'un
// unique telegram_session.json partagé par tout le serveur — sans ça,
// restaurer la session au démarrage écraserait la session de tout le monde
// avec les identifiants d'un seul compte, exactement le bug corrigé côté
// WhatsApp par adapters/whatsappAuthStore.js sur le même principe.
//
// Une session Telegram (GramJS) tient dans une seule chaîne opaque
// (StringSession.save()), pas dans plusieurs fichiers de clés — pas de
// souci de limite de taille de l'API Contents de GitHub ici.
const REMOTE_DIR = process.env.GITHUB_TELEGRAM_SESSION_DIR || 'telegram_sessions';

const SNAPSHOT_INTERVAL_MS = 20_000;

// tenantId doit déjà être normalisé/assaini par l'appelant (voir
// telegramManager.sanitizeTenantId) — ce module ne fait que construire le
// chemin distant à partir de la valeur reçue.
function createAuthStore(tenantId) {
  const remotePath = `${REMOTE_DIR}/${tenantId}.json`;
  const store = githubStore.createStore(remotePath);

  let lastPushedContent = null;
  let snapshotTimer = null;

  // À appeler une seule fois, au tout premier démarrage du processus, avant
  // le premier init() de ce tenant — restaure la session depuis le repo
  // GitHub dédié si elle y est présente. Ne doit jamais être appelée après
  // une perte de session en cours de vie du process (elle écraserait un état
  // local potentiellement plus récent avec un instantané GitHub plus ancien).
  async function restoreSessionFromRemote(sessionPath) {
    if (!store.enabled) return false;

    try {
      const remote = await store.fetchRemote();
      if (remote && remote.content) {
        fs.writeFileSync(sessionPath, remote.content, 'utf8');
        lastPushedContent = remote.content;
        console.log(`Session Telegram restaurée depuis GitHub pour le tenant "${tenantId}".`);
        return true;
      }
    } catch (err) {
      console.error(`Impossible de restaurer la session Telegram depuis GitHub pour le tenant "${tenantId}" :`, err.message);
    }
    return false;
  }

  async function pushSnapshot(sessionPath) {
    if (!store.enabled) return;

    let content;
    try {
      content = fs.readFileSync(sessionPath, 'utf8');
    } catch (err) {
      return; // pas encore de session locale à sauvegarder
    }
    if (!content || content === lastPushedContent) return;

    try {
      await store.pushRemote(content);
      lastPushedContent = content;
    } catch (err) {
      console.error(`Échec de la sauvegarde de la session Telegram sur GitHub pour le tenant "${tenantId}" :`, err.message);
    }
  }

  function startPeriodicSync(sessionPath) {
    if (!store.enabled || snapshotTimer) return;
    snapshotTimer = setInterval(() => {
      pushSnapshot(sessionPath);
    }, SNAPSHOT_INTERVAL_MS);
    // Ne bloque pas l'arrêt du process (ex: redéploiement) en attendant ce timer.
    if (snapshotTimer.unref) snapshotTimer.unref();
  }

  // À appeler quand le régulateur de sessions (voir sessionRegulator.js)
  // libère ce tenant par inactivité : sans ça, ce timer garderait la closure
  // vivante en mémoire même après la suppression du tenant de
  // telegramManager.tenants.
  function stopPeriodicSync() {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
  }

  // Déconnexion manuelle (voir TelegramAdapter.logout()) : vide le fichier
  // distant tout de suite, sur le même principe que
  // whatsappAuthStore.clearRemote().
  async function clearRemote() {
    if (!store.enabled) return;
    try {
      await store.pushRemote('');
      lastPushedContent = '';
    } catch (err) {
      console.error(`Échec de la suppression de la session Telegram sur GitHub pour le tenant "${tenantId}" :`, err.message);
    }
  }

  return {
    enabled: store.enabled,
    restoreSessionFromRemote,
    pushSnapshot,
    startPeriodicSync,
    stopPeriodicSync,
    clearRemote,
    getStatus: store.getStatus,
  };
}

module.exports = {
  createAuthStore,
};
