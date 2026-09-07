const axios = require('axios');

// IMAGE-TO-VIDEO IA (LTX-Video) — cascade Fal.ai -> Replicate, sur le même
// principe que lib/ai/llmFallbackEngine.js : chaque fournisseur est
// FACULTATIF (clé absente = fournisseur sauté, jamais d'erreur), et
// l'appelant (voir index.js, routes /api/studio/video-ai/*) doit gérer le
// cas "aucun fournisseur configuré" en laissant l'export Ken Burns 100%
// client (voir public/dashboard.html#mediaGenerateVideo, gratuit et déjà en
// prod) comme repli — jamais de simulation d'un appel à une API vidéo
// gratuite qui n'existe pas réellement (Pollinations n'expose aucune API
// vidéo publique à ce jour).
//
// Les deux fournisseurs exposent une API asynchrone (génération vidéo =
// 30s à quelques minutes, incompatible avec une requête HTTP bloquante sur
// Render) : startVideoAiJob() ne fait que SOUMETTRE le job et renvoie une
// référence sérialisable (job), pollVideoAiJob(job) doit être rappelé
// périodiquement par l'appelant jusqu'à { done: true }.
const REQUEST_TIMEOUT_MS = 30_000;

// Slugs de modèle exposés en variable d'environnement plutôt que codés en
// dur : les identifiants de modèles tiers changent avec le temps (déjà vécu
// avec Groq/Gemini, voir lib/ai/llmFallbackEngine.js, et avec Pollinations
// côté fal.ai — "ltx-video-v097" a par exemple été retiré au profit de
// "ltx-video-13b-distilled") — un changement futur ne doit pas nécessiter
// de modifier ce fichier.
const FAL_MODEL_ID = process.env.FAL_LTX_MODEL_ID || 'fal-ai/ltx-video-13b-distilled/image-to-video';
const REPLICATE_MODEL = process.env.REPLICATE_LTX_MODEL || 'lightricks/ltx-video';

const DEFAULT_MOTION_PROMPT = 'smooth cinematic camera motion, subtle parallax and depth, natural movement, high quality, no distortion';

function isConfigured() {
  return {
    fal: !!process.env.FAL_KEY,
    replicate: !!process.env.REPLICATE_API_TOKEN,
  };
}

// fal.ai — API "queue" (voir docs officielles : POST https://queue.fal.run/{model-id}
// renvoie request_id + status_url + response_url, à interroger nous-mêmes
// plutôt que de coder en dur un schéma d'URL qui pourrait changer).
// Authentification par en-tête "Authorization: Key ..." — PAS "Bearer",
// particularité propre à fal.ai (vérifié dans sa documentation officielle).
async function startFalJob(imageUrl, prompt) {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return null;

  const res = await axios.post(
    `https://queue.fal.run/${FAL_MODEL_ID}`,
    { image_url: imageUrl, prompt: prompt || DEFAULT_MOTION_PROMPT },
    { headers: { Authorization: `Key ${apiKey}` }, timeout: REQUEST_TIMEOUT_MS },
  );
  const { request_id: requestId, status_url: statusUrl, response_url: responseUrl } = res.data || {};
  if (!requestId || !statusUrl || !responseUrl) {
    throw new Error('Réponse fal.ai inattendue lors de la soumission du job vidéo (champs request_id/status_url/response_url manquants).');
  }
  return { provider: 'fal', statusUrl, responseUrl };
}

async function pollFalJob(job) {
  const apiKey = process.env.FAL_KEY;
  const headers = { Authorization: `Key ${apiKey}` };
  const statusRes = await axios.get(job.statusUrl, { headers, timeout: REQUEST_TIMEOUT_MS });
  const status = statusRes.data && statusRes.data.status;

  if (status === 'COMPLETED') {
    const resultRes = await axios.get(job.responseUrl, { headers, timeout: REQUEST_TIMEOUT_MS });
    const videoUrl = resultRes.data && resultRes.data.video && resultRes.data.video.url;
    if (!videoUrl) throw new Error('fal.ai a terminé le job mais aucune URL vidéo trouvée dans la réponse.');
    return { done: true, videoUrl };
  }
  if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') return { done: false };
  throw new Error(`fal.ai a échoué : ${(statusRes.data && statusRes.data.error) || status || 'statut inconnu'}`);
}

// Replicate — API REST officielle générique (voir docs) : POST
// /v1/models/{owner}/{name}/predictions avec { input: {...} }, à interroger
// ensuite via l'URL "urls.get" renvoyée (jamais reconstruite nous-mêmes).
// Authentification "Authorization: Bearer ...", contrairement à fal.ai.
async function startReplicateJob(imageUrl, prompt) {
  const apiToken = process.env.REPLICATE_API_TOKEN;
  if (!apiToken) return null;

  const res = await axios.post(
    `https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`,
    { input: { image: imageUrl, prompt: prompt || DEFAULT_MOTION_PROMPT } },
    { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, timeout: REQUEST_TIMEOUT_MS },
  );
  const prediction = res.data;
  if (!prediction || !prediction.id || !prediction.urls || !prediction.urls.get) {
    throw new Error('Réponse Replicate inattendue lors de la soumission du job vidéo.');
  }
  return { provider: 'replicate', getUrl: prediction.urls.get };
}

async function pollReplicateJob(job) {
  const apiToken = process.env.REPLICATE_API_TOKEN;
  const res = await axios.get(job.getUrl, { headers: { Authorization: `Bearer ${apiToken}` }, timeout: REQUEST_TIMEOUT_MS });
  const prediction = res.data || {};

  if (prediction.status === 'succeeded') {
    const videoUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!videoUrl) throw new Error('Replicate a terminé le job mais aucune URL vidéo trouvée dans la réponse.');
    return { done: true, videoUrl };
  }
  if (prediction.status === 'starting' || prediction.status === 'processing') return { done: false };
  throw new Error(`Replicate a échoué : ${prediction.error || prediction.status || 'statut inconnu'}`);
}

// Point d'entrée UNIQUE pour soumettre un job — essaie fal.ai puis Replicate
// dans l'ordre, sur le même principe de cascade "clé absente = niveau sauté"
// que lib/ai/llmFallbackEngine.js. Lève une erreur explicite seulement si
// AUCUNE clé n'est configurée : à charge de l'appelant (voir index.js) de la
// traduire en message actionnable côté dashboard, l'export Ken Burns local
// restant disponible sans aucune configuration.
async function startVideoAiJob(imageUrl, prompt) {
  const falJob = await startFalJob(imageUrl, prompt);
  if (falJob) return falJob;

  const replicateJob = await startReplicateJob(imageUrl, prompt);
  if (replicateJob) return replicateJob;

  const err = new Error("Aucun fournisseur vidéo IA n'est configuré côté serveur (FAL_KEY ou REPLICATE_API_TOKEN absents dans .env).");
  err.kind = 'not_configured';
  throw err;
}

async function pollVideoAiJob(job) {
  if (job.provider === 'fal') return pollFalJob(job);
  if (job.provider === 'replicate') return pollReplicateJob(job);
  throw new Error(`Fournisseur vidéo IA inconnu : ${job.provider}`);
}

module.exports = {
  isConfigured,
  startVideoAiJob,
  pollVideoAiJob,
};
