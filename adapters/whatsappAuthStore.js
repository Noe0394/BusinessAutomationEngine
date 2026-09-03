const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');

// Même principe que licenses.js : sur Render sans disque persistant, le
// dossier de session Baileys (AUTH_DIR) est effacé à chaque redémarrage.
// Contrairement aux licences (un seul fichier JSON), la session Baileys est
// répartie sur plusieurs fichiers (creds.json + un fichier par clé Signal),
// qui apparaissent/disparaissent en continu pendant l'usage normal. On les
// regroupe donc dans un seul objet {nomDeFichier: contenu} avant de les
// envoyer vers GitHub, sous un chemin dédié dans le même repo privé que les
// licences.
const REMOTE_PATH = process.env.GITHUB_WHATSAPP_AUTH_PATH || 'whatsapp_auth.json';
const store = githubStore.createStore(REMOTE_PATH);

// Les fichiers de session Signal (pré-clés, sessions, clés d'envoi...)
// changent en continu pendant l'usage (chaque message peut en modifier),
// bien plus souvent que les créds elles-mêmes. Pousser vers GitHub à chaque
// écriture inonderait l'API GitHub ; un instantané périodique suffit
// largement à limiter la fenêtre de perte en cas de redémarrage.
const SNAPSHOT_INTERVAL_MS = 20_000;
let lastPushedContent = null;
let snapshotTimer = null;

function readAuthDirSnapshot(authDir) {
  const files = {};
  if (!fs.existsSync(authDir)) return files;

  for (const name of fs.readdirSync(authDir)) {
    const full = path.join(authDir, name);
    if (fs.statSync(full).isFile()) {
      files[name] = fs.readFileSync(full, 'utf8');
    }
  }
  return files;
}

function writeAuthDirSnapshot(authDir, files) {
  fs.mkdirSync(authDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(authDir, name), content, 'utf8');
  }
}

// À appeler une seule fois, au tout premier démarrage du processus, avant le
// premier connect() — restaure AUTH_DIR depuis le repo GitHub dédié s'il y a
// une version là-bas. Ne doit jamais être appelée lors d'une reconnexion en
// cours de vie du process (perte de session, coupure réseau...) : ça
// écraserait l'état local, potentiellement plus récent, avec un instantané
// GitHub plus ancien.
async function restoreSessionFromRemote(authDir) {
  if (!store.enabled) return false;

  try {
    const remote = await store.fetchRemote();
    if (remote) {
      const files = JSON.parse(remote.content);
      writeAuthDirSnapshot(authDir, files);
      lastPushedContent = remote.content;
      console.log('Session WhatsApp restaurée depuis le repo GitHub dédié.');
      return true;
    }
  } catch (err) {
    console.error('Impossible de restaurer la session WhatsApp depuis GitHub :', err.message);
  }
  return false;
}

async function pushSnapshot(authDir) {
  if (!store.enabled) return;

  const content = JSON.stringify(readAuthDirSnapshot(authDir));
  if (content === lastPushedContent) return; // rien de nouveau depuis le dernier envoi

  try {
    await store.pushRemote(content);
    lastPushedContent = content;
  } catch (err) {
    console.error('Échec de la sauvegarde de la session WhatsApp sur GitHub :', err.message);
  }
}

function startPeriodicSync(authDir) {
  if (!store.enabled || snapshotTimer) return;
  snapshotTimer = setInterval(() => {
    pushSnapshot(authDir);
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
