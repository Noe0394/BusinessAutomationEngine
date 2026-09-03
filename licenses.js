const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Même mise en garde que pour les sessions WhatsApp/Telegram : sans disque
// persistant Render monté sur ce chemin, les clés générées sont perdues au
// prochain redéploiement.
const LICENSES_PATH = process.env.LICENSES_PATH || path.join(__dirname, 'licenses.json');

if (!process.env.LICENSES_PATH) {
  console.warn(
    `LICENSES_PATH non défini : les clés de licence sont stockées dans "${LICENSES_PATH}" sur le disque local. ` +
    'Sur Render, ce fichier est effacé à chaque redéploiement sauf disque persistant monté sur ce chemin.',
  );
}

function loadLicenses() {
  try {
    return JSON.parse(fs.readFileSync(LICENSES_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

function saveLicenses(licenses) {
  fs.writeFileSync(LICENSES_PATH, JSON.stringify(licenses, null, 2), 'utf8');
}

function generateKeyString() {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  const year = new Date().getFullYear();
  return `KEY-${random}-${year}`;
}

function createLicense({ expiresAt, note } = {}) {
  const licenses = loadLicenses();

  const license = {
    key: generateKeyString(),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    active: true,
    note: note || '',
  };

  licenses.push(license);
  saveLicenses(licenses);
  return license;
}

function listLicenses() {
  return loadLicenses();
}

function setLicenseActive(key, active) {
  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === key);

  if (!license) {
    throw new Error('LICENSE_NOT_FOUND');
  }

  license.active = Boolean(active);
  saveLicenses(licenses);
  return license;
}

function verifyKey(key) {
  if (!key) {
    return { valid: false, reason: 'MISSING_KEY' };
  }

  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === key);

  if (!license) {
    return { valid: false, reason: 'NOT_FOUND' };
  }

  if (!license.active) {
    return { valid: false, reason: 'INACTIVE' };
  }

  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: 'EXPIRED' };
  }

  return { valid: true, license };
}

module.exports = {
  createLicense,
  listLicenses,
  setLicenseActive,
  verifyKey,
};
