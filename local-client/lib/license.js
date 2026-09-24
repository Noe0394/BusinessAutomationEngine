// Vérification de licence du client PC. Cloudflare est le seul fournisseur
// distant; le jeton Ed25519 signé permet le démarrage hors-ligne temporaire.
const axios = require('axios');
const { LICENSE_KEY } = require('./licenseConfig');
const { getDeviceId } = require('./deviceId');
const offlineLicense = require('./offlineLicense');

const CLOUDFLARE_BASE = String(process.env.CLOUDFLARE_LICENSE_URL || 'https://cyrus-license.ezechielatannidje.workers.dev').replace(/\/+$/, '');
const REFUSALS = {
  NOT_FOUND: 'Clé de licence inconnue.', INACTIVE: 'Cette clé de licence a été désactivée.',
  EXPIRED: 'Cette clé de licence a expiré.', DEVICE_MISMATCH: 'Cette clé est déjà utilisée sur un autre appareil.',
};

async function verifyViaCloudflare() {
  const { data } = await axios.post(`${CLOUDFLARE_BASE}/verify`, { key: LICENSE_KEY, deviceId: getDeviceId() }, {
    timeout: 10_000, validateStatus: status => status < 500,
  });
  if (!data.valid) return { valid: false, reason: data.reason };
  if (data.offlineToken) offlineLicense.writeToken(data.offlineToken);
  return { valid: true, degraded: true, expiresAt: data.expiresAt, allowedModules: data.allowedModules };
}

async function verifyLicense() {
  if (!LICENSE_KEY) return { valid: false, error: 'LICENSE_KEY manquant dans local-client/.env.' };
  const deviceId = getDeviceId();
  const cachedClaims = await offlineLicense.verifyToken(offlineLicense.readToken(), { key: LICENSE_KEY, deviceId });
  if (cachedClaims) {
    refreshOnlineLicense().catch(err => console.warn('Rafraîchissement de licence Cloudflare indisponible :', err.message));
    return { valid: true, offline: true, expiresAt: cachedClaims.licenseExpiresAt ? new Date(cachedClaims.licenseExpiresAt).toISOString() : null, allowedModules: cachedClaims.allowedModules };
  }
  try {
    const result = await verifyViaCloudflare();
    if (result.valid) return result;
    offlineLicense.clearToken();
    return { valid: false, error: REFUSALS[result.reason] || 'Clé de licence invalide.' };
  } catch (err) {
    const message = err.response?.data?.error || err.message;
    return { valid: false, error: `Vérification Cloudflare impossible (${message}).` };
  }
}

let refreshInFlight = null;
async function refreshOnlineLicense() {
  if (refreshInFlight) return refreshInFlight;
  if (!LICENSE_KEY) return null;
  refreshInFlight = (async () => {
    try {
      const result = await verifyViaCloudflare();
      if (!result.valid) {
        offlineLicense.clearToken();
        process.emit('cyrus-license-revoked', result.reason);
      }
      return result;
    } catch (err) {
      console.warn('Cloudflare indisponible pour le renouvellement de licence :', err.message);
      return null;
    }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

const refreshTimer = setInterval(() => {
  refreshOnlineLicense().catch(err => console.warn('Rafraîchissement de licence ignoré :', err.message));
}, 6 * 60 * 60 * 1000);
refreshTimer.unref?.();

module.exports = { verifyLicense, refreshOnlineLicense };
