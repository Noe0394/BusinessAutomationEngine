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

const FIREBASE_LICENSE_URL = process.env.FIREBASE_LICENSE_URL || '';

async function verifyViaFirebase() {
  const { data } = await axios.post(FIREBASE_LICENSE_URL, {
    key: LICENSE_KEY,
    deviceId: getDeviceId(),
  }, { timeout: 10_000 });

  if (!data.valid) {
    return { valid: false, reason: data.reason };
  }
  return { valid: true, degraded: true, expiresAt: data.expiresAt, allowedModules: data.allowedModules };
}

async function verifyViaVps() {
  const { data } = await client.post('/api/auth/verify-key', {
    key: LICENSE_KEY,
    deviceId: getDeviceId(),
  });
  return { valid: true, degraded: false, expiresAt: data.expiresAt, allowedModules: data.allowedModules };
}

async function verifyLicense() {
  if (FIREBASE_LICENSE_URL) {
    try {
      const result = await verifyViaFirebase();
      // Un refus METIER (clé inconnue/expirée/désactivée/appareil différent)
      // vient d'une base à jour (partagée avec le VPS) : pas la peine de
      // retenter côté VPS, ce serait le même refus.
      if (!result.valid) {
        const messages = {
          NOT_FOUND: 'Clé de licence inconnue.',
          INACTIVE: 'Cette clé de licence a été désactivée.',
          EXPIRED: 'Cette clé de licence a expiré.',
          DEVICE_MISMATCH: 'Cette clé est déjà utilisée sur un autre appareil.',
        };
        return { valid: false, error: messages[result.reason] || 'Clé de licence invalide.' };
      }
      return result;
    } catch (err) {
      console.warn('Firebase injoignable pour la vérification de licence — repli sur le VPS :', err.message);
      // Panne réseau/Firebase (pas un refus métier) : on retente via le VPS.
    }
  }

  try {
    return await verifyViaVps();
  } catch (err) {
    const message = err.response?.data?.error || err.message;
    return { valid: false, error: `${FIREBASE_LICENSE_URL ? 'Firebase et VPS tous deux inaccessibles' : 'Échec'} (${message}).` };
  }
}

module.exports = { verifyLicense };
