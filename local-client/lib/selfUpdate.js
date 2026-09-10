// Mise à jour silencieuse — UN SEUL exécutable distribué (cyrus-local-client.exe),
// contrairement à l'architecture précédente à deux binaires (launcher.js +
// CyrusLauncher.exe, abandonnée sur retour explicite de l'utilisateur :
// "ne pas obliger les utilisateurs à installer [launcher + app]
// séparément"). Le contournement du verrou Windows (un .exe ne peut jamais
// être remplacé pendant qu'il tourne) ne nécessite pas un second programme
// installé — un script système JETABLE (généré à la volée dans un dossier
// temporaire, jamais distribué) suffit : il attend que CE process se
// termine, remplace le fichier, puis relance l'exe. C'est le même principe
// que d'innombrables outils auto-updatables (ex: la plupart des CLIs qui se
// mettent à jour elles-mêmes) — jamais un fichier à distribuer/installer en
// plus.
//
// Ne s'active QUE si ce process tourne comme exécutable packagé (`process.pkg`,
// injecté automatiquement par pkg) — en développement (`node index.js`),
// remplacer process.execPath remplacerait le binaire `node` lui-même,
// jamais souhaité : checkAndSelfUpdate() ne fait alors qu'un simple
// avertissement informatif, sans tenter quoi que ce soit.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fetchUpdateInfo, compareVersions } = require('./updateCheck');

const localVersion = require('../package.json').version;

// À appeler tout en tout début de démarrage (avant verifyLicense/whatsapp.connect)
// — si une mise à jour est appliquée, cette fonction ne redonne JAMAIS la
// main : le process courant se termine (process.exit) et le script généré
// relance une instance à jour, qui retraverse ce même point (sans mise à
// jour à appliquer cette fois, la fonction retourne normalement). Ne bloque
// JAMAIS le démarrage en cas d'échec à n'importe quelle étape (réseau,
// disque, permissions) — l'app continue avec la version actuelle.
async function checkAndSelfUpdate() {
  if (!process.pkg) {
    // Mode développement : jamais de remplacement de binaire, juste un
    // avertissement informatif si une mise à jour existe (même logique
    // qu'avant l'introduction de ce module).
    try {
      const info = await fetchUpdateInfo();
      if (compareVersions(info.latestVersion, localVersion) > 0) {
        console.log(`\nMise à jour disponible : v${info.latestVersion} (actuelle : v${localVersion}) — non appliquée en mode développement.\n`);
      }
    } catch (err) {
      // silencieux : simple confort en dev, jamais bloquant.
    }
    return;
  }

  let info;
  try {
    info = await fetchUpdateInfo();
  } catch (err) {
    console.warn('Vérification de mise à jour impossible (ignorée) :', err.message);
    return;
  }

  if (!info.downloadUrl || compareVersions(info.latestVersion, localVersion) <= 0) return;

  console.log(`Mise à jour disponible : v${info.latestVersion} (actuelle : v${localVersion}) — téléchargement...`);

  const axios = require('axios');
  const exePath = process.execPath;
  const stagingPath = `${exePath}.new`;

  try {
    const res = await axios.get(info.downloadUrl, { responseType: 'arraybuffer', timeout: 10 * 60 * 1000 });
    const buffer = Buffer.from(res.data);

    if (info.sha256) {
      const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (actualHash.toLowerCase() !== String(info.sha256).toLowerCase()) {
        throw new Error('Somme de contrôle SHA-256 invalide — fichier téléchargé rejeté.');
      }
    }
    fs.writeFileSync(stagingPath, buffer);
  } catch (err) {
    console.warn('Échec du téléchargement de la mise à jour (ignorée, version actuelle conservée) :', err.message);
    try { fs.unlinkSync(stagingPath); } catch (cleanupErr) { /* rien à nettoyer */ }
    return;
  }

  // Script jetable (PAS un exécutable distribué — généré ici, exécuté une
  // fois, supprimé par lui-même) : le seul verrou réel à attendre est celui
  // qu'exePath tient tant que CE process n'a pas appelé process.exit()
  // ci-dessous — "move" échoue tant que ce verrou est actif, d'où la
  // boucle de tentatives espacées (jusqu'à 20 × ~1s = 20s avant d'abandonner
  // et de relancer tel quel, ce qui relance alors simplement l'ancienne
  // version si le remplacement n'a jamais abouti — jamais d'échec silencieux
  // total). "ping -n 2 127.0.0.1" fait office de délai portable : "timeout"
  // échoue quand stdin n'est pas un vrai terminal (cas normal ici, process
  // détaché).
  const helperPath = path.join(os.tmpdir(), `cyrus-update-${Date.now()}.bat`);
  const helperScript = [
    '@echo off',
    'setlocal',
    `set "TARGET=${exePath}"`,
    `set "SOURCE=${stagingPath}"`,
    'set /a ATTEMPTS=0',
    ':retry',
    'set /a ATTEMPTS+=1',
    'move /y "%SOURCE%" "%TARGET%" >nul 2>&1',
    'if exist "%SOURCE%" if %ATTEMPTS% LSS 20 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto retry',
    ')',
    'start "" "%TARGET%"',
    'del "%~f0"',
  ].join('\r\n');
  fs.writeFileSync(helperPath, helperScript, 'utf8');

  const child = spawn('cmd.exe', ['/c', helperPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  console.log(`Mise à jour v${info.latestVersion} téléchargée — redémarrage...`);
  if (info.notes) console.log(info.notes);
  process.exit(0);
}

module.exports = { checkAndSelfUpdate };
