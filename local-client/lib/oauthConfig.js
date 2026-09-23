// Configuration OAuth conservée dans le dossier de données local, hors du
// répertoire d'installation. Les secrets ne sont jamais renvoyés au navigateur.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const FILE = process.env.LOCAL_OAUTH_CONFIG_PATH || path.join(DATA_DIR, 'oauth_config.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; }
}
function get(platform) { return read()[platform] || null; }
function set(platform, credentials) {
  const config = read();
  config[platform] = Object.assign({}, credentials, { updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, FILE);
  return { configured: Boolean(config[platform].appId && config[platform].appSecret), updatedAt: config[platform].updatedAt };
}
module.exports = { get, set };
