// Persistance simple (deviceId genere une fois, cle de licence saisie par
// l'utilisateur) pour les appels aux passerelles Firebase (voir
// AiEngine.tsx) - mêmes headers x-license-key/x-device-id que
// local-client/lib/aiGateway.js + deviceId.js, adaptes au runtime Node
// embarque plutot qu'a AsyncStorage (evite une dependance native RN
// supplementaire).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rn_bridge = require('rn-bridge');

const CONFIG_PATH = path.join(rn_bridge.app.datadir(), 'cyrus_config.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function save(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config), 'utf8');
}

function getDeviceId() {
  const config = load();
  if (config.deviceId) return config.deviceId;
  const deviceId = crypto.randomUUID();
  save({ ...config, deviceId });
  return deviceId;
}

function getLicenseKey() {
  return load().licenseKey || '';
}

function setLicenseKey(licenseKey) {
  save({ ...load(), licenseKey });
}

module.exports = { getDeviceId, getLicenseKey, setLicenseKey };
