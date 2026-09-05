const fs = require('fs');
const githubStore = require('../githubStore');

// Même principe que adapters/whatsappAuthStore.js, mais bien plus simple :
// une session Telegram (GramJS) tient dans une seule chaîne opaque
// (StringSession.save()), pas dans plusieurs fichiers de clés — pas de
// souci de limite de taille de l'API Contents de GitHub ici.
const REMOTE_PATH = process.env.GITHUB_TELEGRAM_SESSION_PATH || 'telegram_session.json';
const store = githubStore.createStore(REMOTE_PATH);

const SNAPSHOT_INTERVAL_MS = 20_000;
let lastPushedContent = null;
let snapshotTimer = null;

// À appeler une seule fois, au tout premier démarrage du processus, avant
// TelegramAdapter.init() — restaure la session depuis le repo GitHub dédié
// s'il y en a une là-bas, en écrivant le fichier local que loadSessionString()
// lit ensuite. Ne doit jamais être appelée après une perte de session en
// cours de vie du process (elle écraserait un état local potentiellement
// plus récent avec un instantané GitHub plus ancien).
async function restoreSessionFromRemote(sessionPath) {
  if (!store.enabled) return false;

  try {
    const remote = await store.fetchRemote();
    if (remote && remote.content) {
      fs.writeFileSync(sessionPath, remote.content, 'utf8');
      lastPushedContent = remote.content;
      console.log('Session Telegram restaurée depuis le repo GitHub dédié.');
      return true;
    }
  } catch (err) {
    console.error('Impossible de restaurer la session Telegram depuis GitHub :', err.message);
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
    console.error('Échec de la sauvegarde de la session Telegram sur GitHub :', err.message);
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

module.exports = {
  enabled: store.enabled,
  restoreSessionFromRemote,
  pushSnapshot,
  startPeriodicSync,
  getStatus: store.getStatus,
};
