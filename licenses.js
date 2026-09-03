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

// Modules disponibles à la vente/à l'attribution. Facebook/Instagram/YouTube/
// TikTok (ex-module "studio_video") ont été retirés du système de licences —
// seuls WhatsApp et Telegram restent proposables. Toute clé existante qui
// portait encore "facebook"/"studio_video" perd silencieusement ces modules
// dès la prochaine vérification (normalizeModules filtre sur ALL_MODULES).
const ALL_MODULES = ['whatsapp', 'telegram'];

function normalizeModules(allowedModules) {
  if (!Array.isArray(allowedModules)) {
    return ALL_MODULES.slice();
  }
  return allowedModules.filter((m) => ALL_MODULES.includes(m));
}

function createLicense({ expiresAt, note, allowedModules } = {}) {
  const licenses = loadLicenses();

  const license = {
    key: generateKeyString(),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    active: true,
    note: note || '',
    // Une clé créée sans "allowedModules" explicite obtient tous les
    // modules — comportement de secours, pas le cas normal côté formulaire
    // admin qui envoie toujours une sélection (même vide).
    allowedModules: normalizeModules(allowedModules),
    // Verrouillage un-appareil-par-clé : vide à la création, rempli au tout
    // premier usage réussi (voir verifyKey). Un client qui veut utiliser
    // l'outil sur plusieurs appareils doit acheter une clé par appareil ;
    // l'admin peut libérer manuellement un appareil (unbindDevice) si besoin
    // (changement de téléphone, etc.).
    boundDeviceId: null,
    boundAt: null,
  };

  licenses.push(license);
  saveLicenses(licenses);
  return license;
}

function listLicenses() {
  return loadLicenses();
}

// Suivi de consommation en mémoire (pas persisté sur disque) : une clé
// "connectée" est purement une notion de session vivante ("a fait une
// requête récemment"), ça n'a pas vocation à survivre à un redémarrage —
// contrairement aux clés elles-mêmes. Évite aussi une écriture disque à
// chaque requête authentifiée (les routes de statut sont pollées toutes les
// quelques secondes par les clients connectés).
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const usageStats = new Map(); // key -> { lastSeenAt: number(ms), requestCount: number }

function recordUsage(key) {
  const entry = usageStats.get(key) || { lastSeenAt: 0, requestCount: 0 };
  entry.lastSeenAt = Date.now();
  entry.requestCount += 1;
  usageStats.set(key, entry);
}

function getUsageForKey(key) {
  return usageStats.get(key) || null;
}

function listLicensesWithUsage() {
  const now = Date.now();
  return loadLicenses().map((license) => {
    const usage = usageStats.get(license.key);
    return {
      ...license,
      requestCount: usage ? usage.requestCount : 0,
      lastSeenAt: usage ? new Date(usage.lastSeenAt).toISOString() : null,
      online: Boolean(usage && (now - usage.lastSeenAt) < ONLINE_WINDOW_MS),
    };
  });
}

function getOverview() {
  const licensesList = loadLicenses();
  const now = Date.now();
  let onlineNow = 0;
  let totalRequests = 0;

  for (const entry of usageStats.values()) {
    if (now - entry.lastSeenAt < ONLINE_WINDOW_MS) onlineNow += 1;
    totalRequests += entry.requestCount;
  }

  return {
    totalKeys: licensesList.length,
    activeKeys: licensesList.filter((l) => l.active).length,
    onlineNow,
    totalRequests,
  };
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

function verifyKey(key, deviceId) {
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

  if (!deviceId) {
    return { valid: false, reason: 'MISSING_DEVICE_ID' };
  }

  if (!license.boundDeviceId) {
    // Premier usage réussi de cette clé : on la lie définitivement à cet
    // appareil (jusqu'à libération manuelle par l'admin).
    license.boundDeviceId = deviceId;
    license.boundAt = new Date().toISOString();
    saveLicenses(licenses);
  } else if (license.boundDeviceId !== deviceId) {
    return { valid: false, reason: 'DEVICE_MISMATCH' };
  }

  // Clés créées avant l'introduction des modules : accès complet par défaut
  // (pas de restriction rétroactive sur des clés déjà distribuées).
  const allowedModules = normalizeModules(license.allowedModules ?? ALL_MODULES);

  return { valid: true, license: { ...license, allowedModules } };
}

function unbindDevice(key) {
  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === key);

  if (!license) {
    throw new Error('LICENSE_NOT_FOUND');
  }

  license.boundDeviceId = null;
  license.boundAt = null;
  saveLicenses(licenses);
  return license;
}

module.exports = {
  ALL_MODULES,
  createLicense,
  listLicenses,
  listLicensesWithUsage,
  setLicenseActive,
  verifyKey,
  unbindDevice,
  recordUsage,
  getUsageForKey,
  getOverview,
};
