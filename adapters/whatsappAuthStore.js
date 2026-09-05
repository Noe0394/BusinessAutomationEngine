const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');

// Même principe que licenses.js : sur Render sans disque persistant, le
// dossier de session Baileys (AUTH_DIR) est effacé à chaque redémarrage.
//
// La session Baileys est répartie sur plusieurs fichiers : creds.json (une
// fois, l'identité du compte) puis un fichier par clé Signal (pré-clés,
// sessions par contact, clés d'envoi de groupe...), qui se comptent vite par
// dizaines/centaines et changent en continu pendant l'usage. On ne persiste
// QUE creds.json : c'est le seul fichier nécessaire pour rouvrir la
// connexion sans rescanner un QR code (il porte l'identité et
// l'enregistrement du compte) ; les fichiers de clés Signal manquants sont
// régénérés/renégociés automatiquement et sans intervention par le
// protocole à la reprise (juste une poignée de main un peu plus longue sur
// les premières conversations). Les persister tous ferait dépasser la
// limite de 1 Mo de contenu inline de l'API Contents de GitHub (déjà
// observé en production), qui casse alors aussi bien la lecture que
// l'écriture.
const CREDS_FILENAME = 'creds.json';
const REMOTE_PATH = process.env.GITHUB_WHATSAPP_AUTH_PATH || 'whatsapp_auth.json';
const store = githubStore.createStore(REMOTE_PATH);

const SNAPSHOT_INTERVAL_MS = 20_000;
let lastPushedContent = null;
let snapshotTimer = null;

function readCreds(authDir) {
  const full = path.join(authDir, CREDS_FILENAME);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

function writeCreds(authDir, content) {
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, CREDS_FILENAME), content, 'utf8');
}

// À appeler une seule fois, au tout premier démarrage du processus, avant le
// premier connect() — restaure creds.json depuis le repo GitHub dédié s'il y
// a une version là-bas. Ne doit jamais être appelée lors d'une reconnexion en
// cours de vie du process (perte de session, coupure réseau...) : ça
// écraserait l'état local, potentiellement plus récent, avec un instantané
// GitHub plus ancien.
async function restoreSessionFromRemote(authDir) {
  if (!store.enabled) return false;

  try {
    const remote = await store.fetchRemote();
    if (remote && remote.content) {
      writeCreds(authDir, remote.content);
      lastPushedContent = remote.content;
      console.log('Session WhatsApp (creds) restaurée depuis le repo GitHub dédié.');
      return true;
    }
    if (remote && remote.tooLarge) {
      // Cas de transition : l'ancien format (tout AUTH_DIR empaqueté) dépassait
      // la limite de 1 Mo. Rien à restaurer cette fois, mais fetchRemote a
      // capturé le sha existant — le prochain pushSnapshot() le remplacera par
      // le nouveau format (creds.json seul), qui se lira normalement ensuite.
      console.warn('Session WhatsApp distante illisible (ancien format trop volumineux) — sera remplacée au prochain envoi.');
    }
  } catch (err) {
    console.error('Impossible de restaurer la session WhatsApp depuis GitHub :', err.message);
  }
  return false;
}

async function pushSnapshot(authDir) {
  if (!store.enabled) return;

  const content = readCreds(authDir);
  if (!content || content === lastPushedContent) return; // rien de nouveau depuis le dernier envoi

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

// Déconnexion manuelle (voir whatsapp.logout()) : vide le fichier distant tout
// de suite plutôt que d'attendre que le prochain connect() régénère des creds
// et écrase naturellement l'ancien contenu via creds.update — évite qu'une
// session révoquée reste lisible dans le repo GitHub le temps de ce prochain
// cycle (ex: si le process redémarre juste après la déconnexion, avant le
// prochain appairage).
async function clearRemote() {
  if (!store.enabled) return;
  try {
    await store.pushRemote('');
    lastPushedContent = '';
  } catch (err) {
    console.error('Échec de la suppression de la session WhatsApp sur GitHub :', err.message);
  }
}

module.exports = {
  enabled: store.enabled,
  restoreSessionFromRemote,
  pushSnapshot,
  startPeriodicSync,
  clearRemote,
  getStatus: store.getStatus,
};
