// Passerelle IA (point 2 de la feuille de route) : ce client n'appelle
// JAMAIS un fournisseur IA directement, uniquement des passerelles qui
// détiennent les clés à sa place (Groq/Gemini/OpenRouter/Hugging
// Face/fal.ai) — jamais présentes ici.
//
// Décision du 2026-09-09 : Firebase (firebase-functions/) est désormais la
// voie PRINCIPALE, le VPS (POST /api/ai/generate-text,
// POST /api/media/generate-image) devient le REPLI — inversion du modèle
// précédent (VPS principal, Firebase secours). Raison : le VPS est
// considéré éphémère (risque d'impayé/résiliation), Firebase (Google) ne
// l'est pas de la même façon pour ce genre d'appel sans état.
// Sans FIREBASE_TEXT_URL/FIREBASE_IMAGE_URL configurés, comportement
// inchangé (VPS direct, comme avant l'introduction du failover).
const axios = require('axios');
const { client, LICENSE_KEY } = require('./vpsClient');
const { getDeviceId } = require('./deviceId');

const FIREBASE_TEXT_URL = process.env.FIREBASE_TEXT_URL || '';
const FIREBASE_IMAGE_URL = process.env.FIREBASE_IMAGE_URL || '';
// Pas d'équivalent VPS pour la vidéo (jamais exposée côté VPS à ce client) —
// Firebase uniquement, voir firebase-functions/index.js#startVideoFallback/
// pollVideoFallback. Job asynchrone : startVideo() soumet et renvoie un
// jobId, pollVideo(jobId) doit être rappelé périodiquement par l'appelant
// jusqu'à { done: true }, sur le même principe que
// lib/media/videoAiEngine.js côté VPS/Firebase.
const FIREBASE_VIDEO_START_URL = process.env.FIREBASE_VIDEO_START_URL || '';
const FIREBASE_VIDEO_POLL_URL = process.env.FIREBASE_VIDEO_POLL_URL || '';

function firebaseHeaders() {
  return { 'x-license-key': LICENSE_KEY, 'x-device-id': getDeviceId() };
}

async function generateText(prompt, { history, mode, skillKey } = {}) {
  if (FIREBASE_TEXT_URL) {
    try {
      const { data } = await axios.post(FIREBASE_TEXT_URL, { prompt }, { headers: firebaseHeaders(), timeout: 30_000 });
      return data; // { text, provider }
    } catch (err) {
      console.warn('Firebase injoignable pour la génération de texte — repli sur le VPS :', err.message);
      // On retente via le VPS ci-dessous plutôt que de faire échouer l'appel.
    }
  }

  const { data } = await client.post('/api/ai/generate-text', { prompt, history, mode, skillKey });
  return data;
}

async function generateImage(prompt, { width, height } = {}) {
  if (FIREBASE_IMAGE_URL) {
    try {
      const { data } = await axios.post(FIREBASE_IMAGE_URL, { prompt }, { headers: firebaseHeaders(), timeout: 30_000 });
      return data; // { url, provider }
    } catch (err) {
      console.warn('Firebase injoignable pour la génération d\'image — repli sur le VPS :', err.message);
    }
  }

  const { data } = await client.post('/api/media/generate-image', { prompt, width, height });
  return data;
}

async function startVideo(imageUrl, { prompt, seed, preferredProvider } = {}) {
  if (!FIREBASE_VIDEO_START_URL) {
    throw new Error('Génération vidéo IA non configurée (FIREBASE_VIDEO_START_URL absent du .env) — aucun repli VPS pour cette fonctionnalité.');
  }
  const { data } = await axios.post(
    FIREBASE_VIDEO_START_URL,
    { imageUrl, prompt, seed, preferredProvider },
    { headers: firebaseHeaders(), timeout: 30_000 },
  );
  return data; // { jobId, provider }
}

async function pollVideo(jobId) {
  if (!FIREBASE_VIDEO_POLL_URL) {
    throw new Error('Génération vidéo IA non configurée (FIREBASE_VIDEO_POLL_URL absent du .env).');
  }
  const { data } = await axios.post(
    FIREBASE_VIDEO_POLL_URL,
    { jobId },
    { headers: firebaseHeaders(), timeout: 30_000 },
  );
  return data; // { done: false } ou { done: true, url, provider }
}

module.exports = { generateText, generateImage, startVideo, pollVideo };
