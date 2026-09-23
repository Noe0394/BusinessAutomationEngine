// Vérification de licence au démarrage (point 3 de la feuille de route) —
// bloque l'accès à l'interface si la clé est invalide/expirée/désactivée ou
// déjà liée à un autre appareil.
//
// Décision du 2026-09-09 : Firebase (verifyLicenseOffline, voir
// ../../firebase-functions/) est désormais la voie PRINCIPALE — Firestore
// est une base de licences PARTAGÉE avec le VPS (voir ../../lib/
// firebaseSync.js), plus une simple copie de secours : les deux sens sont
// synchronisés en temps réel, donc vérifier via Firebase d'abord est tout
// aussi à jour que via le VPS, et n'a pas la fragilité "VPS éphémère". Le
// VPS (POST /api/auth/verify-key) devient le REPLI si Firebase est
// injoignable. Sans FIREBASE_LICENSE_URL configuré, comportement inchangé
// (VPS direct uniquement).
const axios = require('axios');
const { client, LICENSE_KEY } = require('./vpsClient');
const { getDeviceId } = require('./deviceId');
const offlineLicense = require('./offlineLicense');

const FIREBASE_LICENSE_URL = process.env.FIREBASE_LICENSE_URL || '';
// Cloudflare (Worker + D1, gratuit) : voie principale quand configurée. Même
// contrat que Firebase ; Firebase puis le VPS restent des replis.
const CLOUDFLARE_LICENSE_URL = String(process.env.CLOUDFLARE_LICENSE_URL || '').replace(/\/+$/, '');

async function verifyViaCloudflare() {
  return verifyViaUrl(`${CLOUDFLARE_LICENSE_URL}/verify`);
}

async function verifyViaFirebase() {
  return verifyViaUrl(FIREBASE_LICENSE_URL);
}

async function verifyViaUrl(url) {
  const { data } = await axios.post(url, {
    key: LICENSE_KEY,
    deviceId: getDeviceId(),
  }, { timeout: 10_000, validateStatus: (st) => st < 500 });

  if (!data.valid) {
    return { valid: false, reason: data.reason };
  }
  if (data.offlineToken) offlineLicense.writeToken(data.offlineToken);
  return { valid: true, degraded: true, expiresAt: data.expiresAt, allowedModules: data.allowedModules };
}

async function verifyViaVps() {
  const { data } = await client.post('/api/auth/verify-key', {
    key: LICENSE_KEY,
    deviceId: getDeviceId(),
  });
  return { valid: true, degraded: false, expiresAt: data.expiresAt, allowedModules: data.allowedModules };
}

const REFUSALS = {
  NOT_FOUND: 'Clé de licence inconnue.',
  INACTIVE: 'Cette clé de licence a été désactivée.',
  EXPIRED: 'Cette clé de licence a expiré.',
  DEVICE_MISMATCH: 'Cette clé est déjà utilisée sur un autre appareil.',
};

async function verifyLicense() {
  const deviceId = getDeviceId();
  const cachedClaims = await offlineLicense.verifyToken(offlineLicense.readToken(), { key: LICENSE_KEY, deviceId });
  if (cachedClaims) {
    // Le cache signé suffit à démarrer hors-ligne. La révocation est vérifiée
    // ensuite en arrière-plan ; une réponse métier négative efface le cache.
    refreshOnlineLicense().catch((err) => console.warn('Rafraîchissement de licence indisponible :', err.message));
    return { valid: true, offline: true, expiresAt: cachedClaims.licenseExpiresAt ? new Date(cachedClaims.licenseExpiresAt).toISOString() : null, allowedModules: cachedClaims.allowedModules };
  }

  const providers = [];
  if (CLOUDFLARE_LICENSE_URL) providers.push(['Cloudflare', verifyViaCloudflare]);
  if (FIREBASE_LICENSE_URL) providers.push(['Firebase', verifyViaFirebase]);

  for (const [name, verify] of providers) {
    try {
      const result = await verify();
      // Un refus MÉTIER vient d'une base à jour : inutile de retenter ailleurs.
      if (!result.valid) {
        offlineLicense.clearToken();
        return { valid: false, error: REFUSALS[result.reason] || 'Clé de licence invalide.' };
      }
      return result;
    } catch (err) {
      console.warn(`${name} injoignable pour la vérification de licence — repli suivant :`, err.message);
    }
  }

  try {
    return await verifyViaVps();
  } catch (err) {
    const message = err.response?.data?.error || err.message;
    return { valid: false, error: `${providers.length ? 'Fournisseurs de licence et VPS tous inaccessibles' : 'Échec'} (${message}).` };
  }
}

let refreshInFlight = null;
async function refreshOnlineLicense() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const providers = [];
    if (CLOUDFLARE_LICENSE_URL) providers.push(['Cloudflare', verifyViaCloudflare]);
    if (FIREBASE_LICENSE_URL) providers.push(['Firebase', verifyViaFirebase]);
    for (const [name, verify] of providers) {
      try {
        const result = await verify();
        if (!result.valid) {
          offlineLicense.clearToken();
          process.emit('cyrus-license-revoked', result.reason);
          return;
        }
        return result;
      } catch (err) {
        console.warn(`${name} indisponible pour le renouvellement de licence :`, err.message);
      }
    }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

const refreshTimer = setInterval(() => {
  refreshOnlineLicense().catch((err) => console.warn('Rafraîchissement périodique indisponible :', err.message));
}, 6 * 60 * 60 * 1000);
refreshTimer.unref?.();

module.exports = { verifyLicense, refreshOnlineLicense };
