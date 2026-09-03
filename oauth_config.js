const fs = require('fs');
const path = require('path');

// Permet à l'exploitant de coller ses identifiants d'application OAuth
// (Google/Facebook/TikTok) depuis le portail admin plutôt que de devoir les
// définir comme variables d'environnement Render — même mise en garde que
// pour licenses.json/telegram_session.txt : sans disque persistant Render,
// ce fichier est effacé à chaque redéploiement.
const OAUTH_CONFIG_PATH = process.env.OAUTH_CONFIG_PATH || path.join(__dirname, 'oauth_config.json');

if (!process.env.OAUTH_CONFIG_PATH) {
  console.warn(
    `OAUTH_CONFIG_PATH non défini : les identifiants OAuth saisis depuis le portail admin sont stockés dans ` +
    `"${OAUTH_CONFIG_PATH}" sur le disque local. Sur Render, ce fichier est effacé à chaque redéploiement sauf ` +
    'disque persistant monté sur ce chemin.',
  );
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(OAUTH_CONFIG_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(OAUTH_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function get(platform) {
  return loadConfig()[platform] || null;
}

function set(platform, credentials) {
  const config = loadConfig();
  config[platform] = { ...credentials, updatedAt: new Date().toISOString() };
  saveConfig(config);
  return config[platform];
}

function getStatus() {
  const config = loadConfig();
  return {
    google: Boolean(config.google?.clientId && config.google?.clientSecret),
    facebook: Boolean(config.facebook?.appId && config.facebook?.appSecret),
    tiktok: Boolean(config.tiktok?.clientKey && config.tiktok?.clientSecret),
  };
}

module.exports = { get, set, getStatus };
