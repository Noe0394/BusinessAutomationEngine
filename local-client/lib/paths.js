// Résolution du dossier de données persistantes de ce client, HORS du
// dossier d'installation : un exe packagé (pkg) est souvent réinstallé/mis à
// jour en écrasant son propre dossier, et Program Files est en lecture seule
// pour un utilisateur standard — la session WhatsApp, la base SQLite et
// l'identifiant d'appareil doivent survivre à ça. Sur Windows,
// %APPDATA% = C:\Users\<utilisateur>\AppData\Roaming (demandé explicitement).
// Sur macOS/Linux (développement), repli sur le dossier home.
const os = require('os');
const path = require('path');
const fs = require('fs');

function resolveDataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  const dir = path.join(base, 'CyrusLocalClient');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DATA_DIR = resolveDataDir();

module.exports = {
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'local.db'),
  WHATSAPP_AUTH_DIR: path.join(DATA_DIR, 'whatsapp_auth'),
  DEVICE_ID_PATH: path.join(DATA_DIR, 'device-id.txt'),
};
