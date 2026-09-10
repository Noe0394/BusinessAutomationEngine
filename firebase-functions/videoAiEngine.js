// Copie volontairement dupliquée de lib/media/videoAiEngine.js (VPS,
// racine) — fichier IDENTIQUE, sans dépendance VPS (axios + @gradio/client
// optionnel), voir index.js#startVideoFallback/pollVideoFallback pour le
// wrapper Cloud Functions (job persisté dans Firestore entre soumission et
// polling, deux invocations pouvant tomber sur des instances différentes).
// À resynchroniser manuellement si la cascade VPS évolue (nouveau modèle,
// nouveau fournisseur) — voir CLAUDE.md.
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
// BUG CORRIGÉ (constaté en production : "Space metadata could not be
// loaded") — "Lightricks/LTX-Video-Playground" (ancien défaut) n'existe
// plus sur Hugging Face (404 "Repository not found", vérifié directement
// via l'API HF). Remplacé par "Lightricks/ltx-video-distilled" (1500+
// likes, runtime confirmé "RUNNING" sur ZeroGPU au moment de cette
// correction) — mais un Space communautaire gratuit reste par nature sujet
// à disparaître/changer sans préavis (voir callGradioSpace ci-dessous,
// commentaire sur le "best effort").
const HF_LTX_SPACE_ID = process.env.HF_LTX_SPACE_ID || 'Lightricks/ltx-video-distilled';

// Générateur supplémentaire sélectionnable EXPLICITEMENT par l'utilisateur
// (voir index.js/dashboard.html, sélecteur "Moteur" du Studio Vidéo IA) —
// génère nativement une vidéo ET son audio synchronisé en un seul modèle,
// contrairement à tous les autres niveaux ci-dessus (silencieux). Space
// injoignable ("Could not resolve app config") au moment de l'écriture de
// ce fichier — appel non vérifiable en direct, même schéma "/predict" que
// callGradioSpace ci-dessous par convention, à corriger si le schéma réel
// diffère une fois le Space de nouveau accessible.
//
// NOTE (important) : Wan-AI/Wan2.1 a été envisagé comme second choix
// explicite mais a été ABANDONNÉ après vérification en direct — son API
// réelle ("/i2v_generation_async" + polling "/status_refresh" sur un état
// de session Gradio interne, gr.State) est incompatible avec le modèle
// "un appel = un résultat" utilisé partout ailleurs dans ce fichier ; un
// simple appel "/predict" comme ci-dessous échouerait à 100% (pas un
// "best effort", un échec certain) — ne pas la réintroduire sans réécrire
// un client Gradio dédié qui maintienne la session ouverte entre la
// soumission et le polling.
const LTX2_SPACE_ID = process.env.LTX2_SPACE_ID || 'Lightricks/ltx-2';

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

  // BUG CORRIGÉ (constaté en production : 404 "resource could not be found"
  // alors que le modèle existe bel et bien) — l'endpoint raccourci
  // "/v1/models/{owner}/{name}/predictions" n'est disponible QUE pour les
  // modèles explicitement configurés par Replicate pour le supporter (pas
  // le cas de lightricks/ltx-video, entre autres) ; l'endpoint classique
  // "/v1/predictions" + "version" (hash de la dernière version du modèle,
  // récupéré dynamiquement plutôt que codé en dur — il change à chaque mise
  // à jour du modèle) fonctionne universellement, quel que soit le modèle.
  const modelRes = await axios.get(
    `https://api.replicate.com/v1/models/${REPLICATE_MODEL}`,
    { headers: { Authorization: `Bearer ${apiToken}` }, timeout: REQUEST_TIMEOUT_MS },
  );
  const versionId = modelRes.data && modelRes.data.latest_version && modelRes.data.latest_version.id;
  if (!versionId) {
    throw new Error(`Impossible de récupérer la dernière version du modèle Replicate "${REPLICATE_MODEL}".`);
  }

  const res = await axios.post(
    'https://api.replicate.com/v1/predictions',
    { version: versionId, input },
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
// BUG CORRIGÉ (constaté en production) : l'ancienne signature positionnelle
// "/predict" avec [image, prompt] était une supposition jamais vérifiée en
// direct — inspection réelle de l'API du Space par défaut (voir
// HF_LTX_SPACE_ID, client.view_api()) : son VRAI endpoint est
// "/image_to_video", avec des paramètres NOMMÉS (prompt, input_image_filepath,
// + une dizaine d'autres tous dotés de valeurs par défaut raisonnables,
// laissées telles quelles ici). Reste NON GARANTI pour autant : un Space
// communautaire gratuit peut disparaître/changer de schéma sans préavis
// (déjà arrivé une fois, voir le commentaire sur HF_LTX_SPACE_ID) — un autre
// Space passé en paramètre (ex: LTX2_SPACE_ID) peut très bien exposer un
// schéma différent, auquel cas l'appel échoue proprement (message
// explicite) sans jamais faire planter l'appelant.
async function callGradioSpace(spaceId, imageUrl, prompt) {
  const { Client } = require('@gradio/client');
  const hfToken = process.env.HUGGINGFACE_API_KEY;

  const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: REQUEST_TIMEOUT_MS });
  const imageBlob = new Blob([imageRes.data], { type: imageRes.headers['content-type'] || 'image/png' });

  const client = await Client.connect(spaceId, hfToken ? { hf_token: hfToken } : undefined);
  const result = await client.predict('/image_to_video', {
    prompt: prompt || DEFAULT_MOTION_PROMPT,
    input_image_filepath: imageBlob,
  });

  const data = result && result.data;
  const first = Array.isArray(data) ? data[0] : data;
  const videoUrl = (first && first.video && first.video.url) || (first && first.url) || (typeof first === 'string' ? first : null);
  if (!videoUrl) {
    throw new Error(`le Space Gradio "${spaceId}" a répondu dans un format inattendu (schéma d'API non reconnu)`);
  }

  const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120_000 });
  return { done: true, videoBuffer: Buffer.from(videoRes.data), videoMimetype: videoRes.headers['content-type'] || 'video/mp4' };
}

async function pollHuggingFaceJob(job) {
  // Sélection explicite d'un des deux générateurs "au choix" (voir
  // LTX2_SPACE_ID/WAN21_SPACE_ID ci-dessus) : appel Gradio direct, aucune
  // cascade interne dans ce cas — un échec ici est l'échec final de ce
  // niveau (l'utilisateur a explicitement demandé CE générateur précis).
  if (job.hfMode === 'ltx2') return callGradioSpace(LTX2_SPACE_ID, job.imageUrl, job.prompt);

  try {
    return await callHfClassicInferenceApi(job.imageUrl, job.prompt);
  } catch (classicErr) {
    try {
      return await callGradioSpace(HF_LTX_SPACE_ID, job.imageUrl, job.prompt);
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
// preferredProvider ('ltx2' | 'wan21', optionnel) : choix EXPLICITE de
// l'utilisateur (voir dashboard.html, sélecteur "Moteur") — court-circuite
// la cascade automatique habituelle (fal/replicate/huggingface auto) pour
// n'essayer QUE le générateur demandé, avec son propre échec explicite si
// indisponible (jamais de repli silencieux sur un AUTRE moteur que celui
// choisi, ce qui trahirait le choix explicite de l'utilisateur).
async function startVideoAiJob(imageUrl, prompt, seed, preferredProvider) {
  if (preferredProvider === 'ltx2') {
    return { provider: 'huggingface', hfMode: preferredProvider, imageUrl, prompt: prompt || DEFAULT_MOTION_PROMPT };
  }

  // BUG CORRIGÉ (constaté en production : compte fal.ai à recharger, "User
  // is locked. Reason: TOP_UP.") — startFalJob ne renvoie null QUE si
  // FAL_KEY est absent (non configuré) ; si la clé est présente mais l'appel
  // échoue réellement (403 crédit épuisé, panne fal.ai, quota...), il lève
  // une exception qui remontait direct jusqu'à l'appelant SANS jamais
  // essayer Replicate/Hugging Face ensuite — alors même que ces autres
  // fournisseurs étaient configurés et fonctionnels. Chaque niveau de la
  // cascade est désormais protégé individuellement : une erreur réelle d'UN
  // fournisseur ne bloque plus les suivants, sur le même principe que
  // lib/ai/llmFallbackEngine.js.
  try {
    const falJob = await startFalJob(imageUrl, prompt, seed);
    if (falJob) return falJob;
  } catch (err) {
    console.warn('Soumission du job vidéo fal.ai échouée, repli Replicate :', err.message);
  }

  try {
    const replicateJob = await startReplicateJob(imageUrl, prompt, seed);
    if (replicateJob) return replicateJob;
  } catch (err) {
    console.warn('Soumission du job vidéo Replicate échouée, repli Hugging Face :', err.message);
  }

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
