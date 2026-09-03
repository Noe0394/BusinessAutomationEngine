const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const githubStore = require('./githubStore');

// Sans disque persistant Render monté sur ce chemin, ce fichier local est
// effacé à chaque redéploiement. Si githubStore est activé (GITHUB_TOKEN +
// GITHUB_DATA_REPO définis), les clés sont aussi sauvegardées dans un repo
// GitHub privé dédié et restaurées au démarrage (voir initFromRemote) — le
// fichier local reste la seule chose lue/écrite au fil de l'eau, pour rester
// rapide et synchrone.
const LICENSES_PATH = process.env.LICENSES_PATH || path.join(__dirname, 'licenses.json');

if (!process.env.LICENSES_PATH && !githubStore.enabled) {
  console.warn(
    `LICENSES_PATH non défini et githubStore désactivé : les clés de licence sont stockées dans "${LICENSES_PATH}" sur le disque local uniquement. ` +
    'Sur Render, ce fichier est effacé à chaque redéploiement sauf disque persistant ou GITHUB_TOKEN/GITHUB_DATA_REPO configurés.',
  );
}

// Les clés sont toujours générées en majuscules (generateKeyString), mais un
// client peut les retaper à la main ou les copier depuis un champ qui les
// reformate (ex: clavier mobile avec majuscule automatique désactivée) — sans
// cette normalisation, une clé pourtant valide ressort comme "inconnue".
function normalizeKey(key) {
  return typeof key === 'string' ? key.trim().toUpperCase() : key;
}

function loadLicenses() {
  try {
    return JSON.parse(fs.readFileSync(LICENSES_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

// File d'attente séquentielle pour les envois vers GitHub : évite les
// conflits de sha si deux sauvegardes locales arrivent rapprochées (ex:
// création de plusieurs clés en lot).
let pushQueue = Promise.resolve();

// Attend la fin de l'envoi vers GitHub avant de rendre la main : sans ça, un
// redémarrage du serveur (crash WhatsApp, veille Render...) survenant entre
// l'écriture locale et la fin de l'envoi distant fait perdre la clé — au
// redémarrage suivant, initFromRemote() écrase le fichier local (qui avait
// la clé) avec la version distante (qui ne l'a pas encore). Écrire en
// synchrone puis attendre le push rend cette fenêtre de perte négligeable.
async function saveLicenses(licenses) {
  const content = JSON.stringify(licenses, null, 2);
  fs.writeFileSync(LICENSES_PATH, content, 'utf8');

  if (githubStore.enabled) {
    pushQueue = pushQueue
      .then(() => githubStore.pushRemote(content))
      .catch((err) => {
        console.error('Échec de la sauvegarde des licences sur GitHub :', err.message);
      });
    await pushQueue;
  }
}

// À appeler une fois au démarrage du serveur, avant d'accepter des requêtes :
// restaure licenses.json depuis le repo GitHub dédié s'il y en a une version
// là-bas (survit aux redéploiements Render sans disque persistant).
async function initFromRemote() {
  if (!githubStore.enabled) return;

  try {
    const remote = await githubStore.fetchRemote();
    if (remote) {
      fs.writeFileSync(LICENSES_PATH, remote.content, 'utf8');
      console.log('Licences restaurées depuis le repo GitHub dédié.');
    }
  } catch (err) {
    console.error('Impossible de récupérer les licences depuis GitHub au démarrage :', err.message);
  }
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

async function createLicense({ expiresAt, note, allowedModules } = {}) {
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
  await saveLicenses(licenses);
  return license;
}

// Suppression définitive d'une clé (ex: erreur de saisie, client remboursé).
// Contrairement à la désactivation (setLicenseActive), la clé disparaît
// entièrement de la liste — irréversible.
async function deleteLicense(key) {
  const licenses = loadLicenses();
  const normalizedKey = normalizeKey(key);
  const index = licenses.findIndex((l) => l.key === normalizedKey);

  if (index === -1) {
    throw new Error('LICENSE_NOT_FOUND');
  }

  const [removed] = licenses.splice(index, 1);
  await saveLicenses(licenses);
  return removed;
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

async function setLicenseActive(key, active) {
  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === normalizeKey(key));

  if (!license) {
    throw new Error('LICENSE_NOT_FOUND');
  }

  license.active = Boolean(active);
  await saveLicenses(licenses);
  return license;
}

async function verifyKey(key, deviceId) {
  if (!key) {
    return { valid: false, reason: 'MISSING_KEY' };
  }

  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === normalizeKey(key));

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
    await saveLicenses(licenses);
  } else if (license.boundDeviceId !== deviceId) {
    return { valid: false, reason: 'DEVICE_MISMATCH' };
  }

  // Clés créées avant l'introduction des modules : accès complet par défaut
  // (pas de restriction rétroactive sur des clés déjà distribuées).
  const allowedModules = normalizeModules(license.allowedModules ?? ALL_MODULES);

  return { valid: true, license: { ...license, allowedModules } };
}

async function unbindDevice(key) {
  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === normalizeKey(key));

  if (!license) {
    throw new Error('LICENSE_NOT_FOUND');
  }

  license.boundDeviceId = null;
  license.boundAt = null;
  await saveLicenses(licenses);
  return license;
}

// Permet au panneau admin de vérifier que la persistance GitHub fonctionne
// réellement (repo/branche configurés, dernier push/lecture réussis) au lieu
// de le découvrir seulement après un redéploiement qui a effacé des clés
// jamais synchronisées.
function getStorageStatus() {
  return {
    localPath: LICENSES_PATH,
    ...githubStore.getStatus(),
  };
}

module.exports = {
  ALL_MODULES,
  initFromRemote,
  createLicense,
  deleteLicense,
  listLicenses,
  listLicensesWithUsage,
  setLicenseActive,
  verifyKey,
  unbindDevice,
  recordUsage,
  getUsageForKey,
  getOverview,
  getStorageStatus,
};
