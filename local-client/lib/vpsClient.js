// Client HTTP unique vers le VPS central — RIEN d'autre dans ce projet ne
// doit détenir de clé de fournisseur IA (Groq/Gemini/OpenRouter/fal.ai) ni de
// logique de vérification de licence : tout passe par ici, en réutilisant
// exactement les routes déjà exposées par le backend racine (index.js) —
// requireAccess y accepte l'en-tête x-license-key/x-device-id, aucune route
// spécifique au client local n'était donc nécessaire côté serveur pour
// l'IA/la licence (voir /api/auth/verify-key, /api/media/generate-image,
// /api/ai/generate-text, /api/check-update dans index.js à la racine).
const axios = require('axios');
const { getDeviceId } = require('./deviceId');

const VPS_BASE_URL = (process.env.VPS_BASE_URL || '').replace(/\/+$/, '');
const LICENSE_KEY = process.env.LICENSE_KEY || '';

if (!VPS_BASE_URL) {
  throw new Error('VPS_BASE_URL manquant dans local-client/.env — voir .env.example.');
}
if (!LICENSE_KEY) {
  throw new Error('LICENSE_KEY manquant dans local-client/.env — voir .env.example.');
}

const client = axios.create({
  baseURL: VPS_BASE_URL,
  timeout: 30_000,
  headers: {
    'x-license-key': LICENSE_KEY,
    'x-device-id': getDeviceId(),
  },
});

// Détection de panne pour le failover (voir lib/license.js et
// lib/aiGateway.js) — timeout COURT et volontairement séparé du client
// principal ci-dessus : on ne veut pas attendre 30s avant de basculer sur
// Firebase, ni faire dépendre cette vérification d'une éventuelle
// authentification (route /health toujours publique, voir index.js racine).
async function isVpsReachable() {
  try {
    await axios.get(`${VPS_BASE_URL}/health`, { timeout: 4_000 });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { client, VPS_BASE_URL, LICENSE_KEY, isVpsReachable };
