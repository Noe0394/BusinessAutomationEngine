require('dotenv').config();

// Lanceur CYRUS — s'exécute AVANT l'application elle-même (index.js), dans
// un exécutable SÉPARÉ (CyrusLauncher.exe), pour permettre une mise à jour
// totalement invisible pour l'utilisateur : un exécutable Windows ne peut
// jamais être remplacé pendant qu'il tourne (fichier verrouillé) — en
// séparant "ce qui vérifie/télécharge/remplace" de "ce que l'utilisateur
// exécute au quotidien", l'app elle-même n'est JAMAIS en cours d'exécution
// au moment où son propre fichier est remplacé. C'est ce lanceur, et non
// l'app, que l'utilisateur installe/épingle/lance — voir README.md.
//
// Le lanceur lui-même n'est volontairement PAS auto-mis-à-jour (trop rare
// d'avoir besoin de changer sa propre logique, et ça éviterait le même
// problème de fichier verrouillé un cran plus haut) : seule l'app qu'il
// gère (cyrus-local-client.exe, dans son dossier de données) l'est.
//
// Comportement en cas d'échec à n'importe quelle étape (réseau coupé,
// Firebase ET VPS injoignables, téléchargement interrompu, somme de
// contrôle invalide) : ne bloque JAMAIS le démarrage — l'app existante
// (précédemment installée, ou la copie embarquée au tout premier lancement)
// démarre telle quelle, silencieusement, sans jamais faire échouer le
// lancement pour une mise à jour ratée.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fetchUpdateInfo, compareVersions } = require('./lib/updateCheck');

const APPDATA_DIR = process.env.APPDATA || path.join(os.homedir(), '.config');
const DATA_DIR = path.join(APPDATA_DIR, 'CyrusLocalClient');
const APP_DIR = path.join(DATA_DIR, 'app');
const APP_EXE_PATH = path.join(APP_DIR, 'cyrus-local-client.exe');
const VERSION_FILE = path.join(APP_DIR, 'version.txt');

// Copie embarquée dans le lanceur lui-même (voir package.json#pkg.assets) —
// utilisée UNIQUEMENT si aucune app n'est encore installée (tout premier
// lancement sur ce PC) : pkg expose les fichiers listés dans "assets" au
// même chemin relatif que dans le projet source, y compris une fois
// packagé, donc ce chemin fonctionne aussi bien en dev (`node launcher.js`)
// qu'une fois compilé en CyrusLauncher.exe.
const BUNDLED_APP_EXE = path.join(__dirname, 'dist', 'cyrus-local-client.exe');

function getInstalledVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim() || null;
  } catch (err) {
    return null;
  }
}

function setInstalledVersion(version) {
  fs.writeFileSync(VERSION_FILE, String(version), 'utf8');
}

function ensureAppInstalled() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  if (fs.existsSync(APP_EXE_PATH)) return;

  if (!fs.existsSync(BUNDLED_APP_EXE)) {
    throw new Error(`Aucune app installée et aucune copie embarquée trouvée (${BUNDLED_APP_EXE}) — build incomplet.`);
  }
  fs.copyFileSync(BUNDLED_APP_EXE, APP_EXE_PATH);
  // Version de la copie embarquée = celle de ce lanceur au moment de sa
  // compilation (voir package.json#version, synchronisée manuellement avec
  // dist/cyrus-local-client.exe au moment du build — voir README.md).
  setInstalledVersion(require('./package.json').version);
  console.log(`Première installation : app déployée en v${require('./package.json').version}.`);
}

// Téléchargement en 2 temps (fichier temporaire PUIS renommage) plutôt
// qu'une écriture directe sur APP_EXE_PATH : un fs.renameSync sur le même
// volume est atomique — une interruption réseau/disque en cours de
// téléchargement laisse l'ancienne version intacte plutôt qu'un exe à
// moitié écrit et corrompu.
async function downloadAndApplyUpdate(info) {
  const axios = require('axios');
  const stagingPath = `${APP_EXE_PATH}.new`;

  const res = await axios.get(info.downloadUrl, { responseType: 'arraybuffer', timeout: 10 * 60 * 1000 });
  const buffer = Buffer.from(res.data);

  if (info.sha256) {
    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualHash.toLowerCase() !== String(info.sha256).toLowerCase()) {
      throw new Error('Somme de contrôle SHA-256 invalide — fichier téléchargé rejeté (corruption ou interruption réseau probable).');
    }
  }

  fs.writeFileSync(stagingPath, buffer);
  fs.renameSync(stagingPath, APP_EXE_PATH);
  setInstalledVersion(info.latestVersion);
}

async function checkAndApplyUpdate() {
  const currentVersion = getInstalledVersion() || '0.0.0';
  let info;
  try {
    info = await fetchUpdateInfo();
  } catch (err) {
    console.warn('Vérification de mise à jour impossible (ignorée, app existante conservée) :', err.message);
    return;
  }

  if (!info.downloadUrl || compareVersions(info.latestVersion, currentVersion) <= 0) return;

  console.log(`Mise à jour disponible : v${info.latestVersion} (actuelle : v${currentVersion}) — téléchargement...`);
  try {
    await downloadAndApplyUpdate(info);
    console.log(`Mise à jour appliquée : v${info.latestVersion}.`);
    if (info.notes) console.log(info.notes);
  } catch (err) {
    console.warn('Échec de la mise à jour (ignorée, version précédente conservée) :', err.message);
    try { fs.unlinkSync(`${APP_EXE_PATH}.new`); } catch (cleanupErr) { /* rien à nettoyer */ }
  }
}

async function main() {
  ensureAppInstalled();
  await checkAndApplyUpdate();

  // stdio 'inherit' : la fenêtre de l'app (console + future UI) reste
  // visible normalement pour l'utilisateur, comme s'il avait lancé l'exe
  // directement — le lanceur est invisible dans ce flux, pas une étape
  // supplémentaire perceptible.
  const child = spawn(APP_EXE_PATH, [], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code === null ? 0 : code));
  child.on('error', (err) => {
    console.error('Impossible de démarrer l\'application :', err.message);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Erreur fatale du lanceur :', err.message);
  process.exit(1);
});
