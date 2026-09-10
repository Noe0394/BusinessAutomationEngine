const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const githubStore = require('./githubStore');
const firebaseSync = require('./lib/firebaseSync');

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

// Écoute temps réel Firestore (voir lib/firebaseSync.js) : si une licence
// est créée/liée directement côté Firebase (firebase-functions/
// verifyLicenseOffline, createLicenseOffline — utilisées quand CE VPS est
// injoignable), ce cache local se met à jour tout seul dès que ce process
// redevient joignable vers Firestore, sans redémarrage. Ferme la boucle
// dans le sens Firestore -> VPS (saveLicenses ci-dessous gère déjà le sens
// VPS -> Firestore) : les deux côtés convergent vers la même donnée.
if (firebaseSync.enabled) {
  firebaseSync.watchLicenses((licenses) => {
    try {
      fs.writeFileSync(LICENSES_PATH, JSON.stringify(licenses, null, 2), 'utf8');
    } catch (err) {
      console.error('Échec de mise à jour du cache local de licences depuis Firestore :', err.message);
    }
  });
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

  // Mirroir Firestore pour le failover client (voir lib/firebaseSync.js) —
  // délibérément NON attendu : ce n'est qu'une copie de secours pour le mode
  // dégradé, jamais l'opération de licence elle-même ne doit attendre ou
  // échouer à cause de la latence/disponibilité de Firebase.
  if (firebaseSync.enabled) {
    firebaseSync.syncLicensesToFirestore(licenses);
  }
}

// À appeler une fois au démarrage du serveur, avant d'accepter des requêtes :
// restaure licenses.json depuis le repo GitHub dédié s'il y en a une version
// là-bas (survit aux redéploiements Render sans disque persistant).
async function initFromRemote() {
  if (!githubStore.enabled) return;

  try {
    const remote = await githubStore.fetchRemote();
    if (remote && remote.content) {
      fs.writeFileSync(LICENSES_PATH, remote.content, 'utf8');
      console.log('Licences restaurées depuis le repo GitHub dédié.');
    }
  } catch (err) {
    console.error('Impossible de récupérer les licences depuis GitHub au démarrage :', err.message);
  }
}

// À appeler une fois au démarrage (voir index.js, juste après
// initFromRemote()) : réattribue 'studio_video' à toute licence créée avant
// STUDIO_VIDEO_MIGRATION_CUTOFF qui ne l'a pas déjà dans son
// allowedModules stocké — idempotent (ne réécrit rien si déjà migré), donc
// sans risque à réexécuter à chaque redémarrage.
async function migrateStudioVideoModule() {
  const licensesList = loadLicenses();
  const cutoffMs = new Date(STUDIO_VIDEO_MIGRATION_CUTOFF).getTime();
  let changed = false;

  licensesList.forEach((license) => {
    const isPreExisting = license.createdAt && new Date(license.createdAt).getTime() < cutoffMs;
    if (!isPreExisting) return;

    const modules = Array.isArray(license.allowedModules) ? license.allowedModules : ALL_MODULES.slice();
    if (!modules.includes('studio_video')) {
      license.allowedModules = [...modules, 'studio_video'];
      changed = true;
    }
  });

  if (changed) {
    await saveLicenses(licensesList);
    console.log('Migration licences : module "studio_video" réattribué aux clés existantes (créées avant réintroduction du verrouillage).');
  }
}

function generateKeyString() {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  const year = new Date().getFullYear();
  return `KEY-${random}-${year}`;
}

// Modules disponibles à la vente/à l'attribution. Facebook/Instagram/YouTube/
// TikTok sont restés hors du système de licences (accès libre, voir
// requireModule('facebook') dans index.js). "studio_video" (Studio IA :
// Copywriter IA, Studio Média, générateur de livres, vidéo IA) a été
// réintroduit ici sur demande explicite (verrouillage du Studio IA derrière
// une licence) — voir STUDIO_VIDEO_MIGRATION_CUTOFF et migrateStudioVideoModule()
// ci-dessous, qui réattribue automatiquement ce module à toute clé créée
// AVANT cette réintroduction pour ne jamais couper l'accès d'un client déjà
// équipé (ce module était forcé ouvert pour tous jusqu'ici, voir l'historique
// de requireModule dans index.js).
const ALL_MODULES = ['whatsapp', 'telegram', 'studio_video'];

// Toute licence créée avant cette date a par définition accès à
// 'studio_video' de fait (le module était forcé ouvert pour tout le monde
// jusqu'à cette réintroduction) — migrateStudioVideoModule() s'appuie
// dessus pour réattribuer le module UNIQUEMENT à ces clés-là, sans jamais
// l'accorder automatiquement à une clé créée après (qui suit désormais la
// sélection normale du formulaire admin).
const STUDIO_VIDEO_MIGRATION_CUTOFF = '2026-09-08T00:00:00.000Z';

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
  migrateStudioVideoModule,
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
