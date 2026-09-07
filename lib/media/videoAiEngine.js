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
const HF_LTX_MODEL_ID = process.env.HF_LTX_MODEL_ID || 'Lightricks/LTX-Video';
// Space Gradio public officiel Lightricks (voir callHfGradioSpace) — signalé
// par moments indisponible en pratique (mise en veille/503, constaté lors de
// l'écriture de ce fichier) : c'est le repli le MOINS fiable de toute la
// cascade, jamais le seul fournisseur à configurer sérieusement.
const HF_LTX_SPACE_ID = process.env.HF_LTX_SPACE_ID || 'Lightricks/LTX-Video-Playground';

const DEFAULT_MOTION_PROMPT = 'smooth cinematic camera motion, subtle parallax and depth, natural movement, high quality, no distortion';

function isConfigured() {
  return {
    fal: !!process.env.FAL_KEY,
    replicate: !!process.env.REPLICATE_API_TOKEN,
    huggingface: !!process.env.HUGGINGFACE_API_KEY,
  };
}

// fal.ai — API "queue" (voir docs officielles : POST https://queue.fal.run/{model-id}
// renvoie request_id + status_url + response_url, à interroger nous-mêmes
// plutôt que de coder en dur un schéma d'URL qui pourrait changer).
// Authentification par en-tête "Authorization: Key ..." — PAS "Bearer",
// particularité propre à fal.ai (vérifié dans sa documentation officielle).
async function startFalJob(imageUrl, prompt, seed) {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return null;

  // seed (optionnel) : confirmé comme paramètre réellement supporté par les
  // modèles LTX de fal.ai (résolution/aspect ratio/seed/frame rate/steps
  // configurables, voir documentation fal.ai) — utilisé par
  // lib/media/storyboardEngine.js pour garder un style visuel cohérent
  // entre les scènes d'un même storyboard.
  const input = { image_url: imageUrl, prompt: prompt || DEFAULT_MOTION_PROMPT };
  if (Number.isFinite(seed)) input.seed = seed;

  const res = await axios.post(
    `https://queue.fal.run/${FAL_MODEL_ID}`,
    input,
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
async function startReplicateJob(imageUrl, prompt, seed) {
  const apiToken = process.env.REPLICATE_API_TOKEN;
  if (!apiToken) return null;

  // seed (optionnel, voir startFalJob ci-dessus pour le contexte) : moins
  // formellement confirmé côté Replicate que côté fal.ai, mais "seed" est un
  // nom de paramètre standard pour ce type de modèle — best effort, sans
  // risque en cas de rejet (l'appelant retombe simplement sur le fournisseur
  // suivant de la cascade, voir startVideoAiJob).
  const input = { image: imageUrl, prompt: prompt || DEFAULT_MOTION_PROMPT };
  if (Number.isFinite(seed)) input.seed = seed;

  const res = await axios.post(
    `https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`,
    { input },
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

// Hugging Face — tentative "best effort" en dernier recours, NON GARANTIE
// (ajoutée sur demande explicite malgré cette réserve connue) : contrairement
// à Groq/Gemini/Hugging Face pour le TEXTE (voir llmFallbackEngine.js), le
// système "Inference Providers" de Hugging Face n'expose officiellement QUE
// la tâche "Text to Video" (routée vers des fournisseurs tiers comme fal.ai/
// Replicate/Novita) — aucune tâche "Image to Video" documentée à ce jour, et
// rien ne garantit que Lightricks/LTX-Video soit réellement déployé sur le
// palier serverless gratuit (peu probable vu sa taille). Cette tentative
// utilise donc l'API Inference "classique" par modèle
// (api-inference.huggingface.co), qui échoue proprement (erreur JSON
// explicite, jamais un crash) si le modèle n'y est pas disponible — dans ce
// cas, l'export Ken Burns 100% client reste la seule option vidéo
// fonctionnelle. Contrairement à fal.ai/Replicate ci-dessus (API
// asynchrone), cet appel est synchrone et potentiellement long (chargement
// à froid du modèle) : startHuggingFaceJob() ne fait donc que mémoriser les
// paramètres, l'appel réseau réel n'a lieu qu'au premier pollHuggingFaceJob()
// (voir index.js, la requête de polling correspondante attend simplement
// plus longtemps cette fois-là).
async function startHuggingFaceJob(imageUrl, prompt) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) return null;
  return { provider: 'huggingface', imageUrl, prompt: prompt || DEFAULT_MOTION_PROMPT };
}

async function callHfClassicInferenceApi(imageUrl, prompt) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: REQUEST_TIMEOUT_MS });

  const res = await axios.post(
    `https://api-inference.huggingface.co/models/${HF_LTX_MODEL_ID}?prompt=${encodeURIComponent(prompt)}`,
    imageRes.data,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': imageRes.headers['content-type'] || 'image/png',
        // Étend l'attente si le modèle doit d'abord être chargé à froid côté
        // Hugging Face (comportement documenté de l'API Inference classique)
        // plutôt que de recevoir un 503 immédiat à chaque premier appel.
        'X-Wait-For-Model': 'true',
      },
      responseType: 'arraybuffer',
      timeout: 120_000,
    },
  );

  const contentType = res.headers['content-type'] || '';
  if (!contentType.startsWith('video/')) {
    let message = "l'API Inference classique n'a pas renvoyé de vidéo (modèle probablement indisponible sur le palier serverless gratuit pour l'image-to-video)";
    try {
      const parsed = JSON.parse(Buffer.from(res.data).toString('utf8'));
      if (parsed && parsed.error) message = parsed.error;
    } catch (err) { /* corps de réponse non-JSON : message générique conservé */ }
    throw new Error(message);
  }
  return { done: true, videoBuffer: Buffer.from(res.data), videoMimetype: contentType };
}

// Repli sur un Space Gradio public (feuille de route : client @gradio/client)
// — beaucoup de modèles vidéo lourds comme LTX-Video ne sont accessibles
// GRATUITEMENT que via la démo Gradio officielle d'un Space, jamais via
// l'API Inference classique ci-dessus (réservée aux modèles réellement
// déployés sur le palier serverless). Chargé paresseusement (require
// dynamique) : @gradio/client ne doit jamais faire planter le démarrage du
// serveur si le paquet est absent d'une installation existante.
//
// NON GARANTI, et documenté comme tel : l'ordre exact des paramètres
// positionnels ci-dessous ("/predict" avec [image, prompt]) suit la
// convention Gradio la plus courante pour ce type de démo (image + prompt
// en entrée, vidéo en sortie), mais n'a pas pu être vérifiée en direct sur
// CE Space précis (503 constaté sur un Space candidat, 404 sur un autre lors
// de l'écriture de ce fichier — les démos communautaires/officielles
// n'offrent aucune garantie de disponibilité ni de stabilité de schéma). Une
// erreur de signature échoue proprement (message explicite), sans jamais
// faire planter l'appelant.
async function callHfGradioSpace(imageUrl, prompt) {
  const { Client } = require('@gradio/client');
  const hfToken = process.env.HUGGINGFACE_API_KEY;

  const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: REQUEST_TIMEOUT_MS });
  const imageBlob = new Blob([imageRes.data], { type: imageRes.headers['content-type'] || 'image/png' });

  const client = await Client.connect(HF_LTX_SPACE_ID, hfToken ? { hf_token: hfToken } : undefined);
  const result = await client.predict('/predict', [imageBlob, prompt]);

  const data = result && result.data;
  const first = Array.isArray(data) ? data[0] : data;
  const videoUrl = (first && first.video && first.video.url) || (first && first.url) || (typeof first === 'string' ? first : null);
  if (!videoUrl) {
    throw new Error(`le Space Gradio "${HF_LTX_SPACE_ID}" a répondu dans un format inattendu (schéma d'API non reconnu)`);
  }

  const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120_000 });
  return { done: true, videoBuffer: Buffer.from(videoRes.data), videoMimetype: videoRes.headers['content-type'] || 'video/mp4' };
}

async function pollHuggingFaceJob(job) {
  try {
    return await callHfClassicInferenceApi(job.imageUrl, job.prompt);
  } catch (classicErr) {
    try {
      return await callHfGradioSpace(job.imageUrl, job.prompt);
    } catch (gradioErr) {
      throw new Error(
        `Hugging Face indisponible pour la vidéo IA (API classique : ${classicErr.message} — Space Gradio : ${gradioErr.message}). `
        + 'Utilisez FAL_KEY/REPLICATE_API_TOKEN pour un résultat fiable, ou l\'export Ken Burns local (gratuit, garanti).',
      );
    }
  }
}

// Point d'entrée UNIQUE pour soumettre un job — essaie fal.ai puis Replicate
// puis Hugging Face (best effort, voir ci-dessus) dans l'ordre, sur le même
// principe de cascade "clé absente = niveau sauté" que
// lib/ai/llmFallbackEngine.js. Lève une erreur explicite seulement si AUCUNE
// clé n'est configurée : à charge de l'appelant (voir index.js) de la
// traduire en message actionnable côté dashboard, l'export Ken Burns local
// restant disponible sans aucune configuration.
async function startVideoAiJob(imageUrl, prompt, seed) {
  const falJob = await startFalJob(imageUrl, prompt, seed);
  if (falJob) return falJob;

  const replicateJob = await startReplicateJob(imageUrl, prompt, seed);
  if (replicateJob) return replicateJob;

  const hfJob = await startHuggingFaceJob(imageUrl, prompt);
  if (hfJob) return hfJob;

  const err = new Error("Aucun fournisseur vidéo IA n'est configuré côté serveur (FAL_KEY, REPLICATE_API_TOKEN et HUGGINGFACE_API_KEY absents dans .env).");
  err.kind = 'not_configured';
  throw err;
}

async function pollVideoAiJob(job) {
  if (job.provider === 'fal') return pollFalJob(job);
  if (job.provider === 'replicate') return pollReplicateJob(job);
  if (job.provider === 'huggingface') return pollHuggingFaceJob(job);
  throw new Error(`Fournisseur vidéo IA inconnu : ${job.provider}`);
}

module.exports = {
  isConfigured,
  startVideoAiJob,
  pollVideoAiJob,
};
