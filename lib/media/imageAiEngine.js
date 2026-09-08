const axios = require('axios');

// GÉNÉRATION D'IMAGES IA — FLUX réel via fal.ai, appelé côté SERVEUR (la clé
// fal.ai ne doit jamais être exposée au navigateur, voir POST
// /api/media/generate-image dans index.js).
//
// CONTEXTE (vérifié en direct, sept. 2026) : le pipeline précédent appelait
// Pollinations directement depuis le navigateur avec `model=flux` — ce
// paramètre est désormais IGNORÉ par Pollinations (confirmé : leur endpoint
// https://image.pollinations.ai/models ne liste plus que ["sana"], et toute
// réponse d'erreur renvoie "model":"sana" dans requestParameters quel que
// soit le paramètre envoyé). Flux a été retiré du catalogue Pollinations,
// pas un bug de notre côté — la qualité "floue et hors sujet" rapportée
// venait de là : l'app croyait utiliser FLUX mais recevait systématiquement
// des rendus "sana" (modèle nettement moins bon). Ce fichier introduit un
// vrai rendu FLUX (fal.ai, fal-ai/flux/schnell) comme source PRINCIPALE ;
// Pollinations reste un repli gratuit si FAL_KEY n'est pas configuré (voir
// public/dashboard.html#mediaFetchViaPollinations), honnêtement documenté
// comme moins bon plutôt que de prétendre utiliser Flux.
const FAL_IMAGE_MODEL = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell';
const REQUEST_TIMEOUT_MS = 30_000;

function isConfigured() {
  return { fal: !!process.env.FAL_KEY };
}

// Schéma vérifié en direct (fal.ai/models/fal-ai/flux/schnell/api) : prompt
// requis, image_size accepte soit un préréglage soit {width,height}. PAS de
// negative_prompt pour ce modèle distillé (schnell) — FLUX schnell n'utilise
// pas le guidage par prompt négatif classique (peu/pas de CFG), d'où
// l'absence volontaire de ce paramètre ici : les exigences de qualité sont
// exprimées de façon POSITIVE dans le prompt lui-même (voir
// MEDIA_QUALITY_SUFFIX côté dashboard).
async function generateImageViaFal(prompt, width, height) {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return null;

  const res = await axios.post(
    `https://fal.run/${FAL_IMAGE_MODEL}`,
    {
      prompt,
      image_size: { width, height },
      num_images: 1,
      output_format: 'jpeg',
    },
    { headers: { Authorization: `Key ${apiKey}` }, timeout: REQUEST_TIMEOUT_MS },
  );
  const imageUrl = res.data && res.data.images && res.data.images[0] && res.data.images[0].url;
  if (!imageUrl) throw new Error('Réponse fal.ai inattendue lors de la génération image (aucune URL trouvée).');
  return imageUrl;
}

// Repli gratuit SERVEUR (Chat-First, voir index.js#handleImageIntent) — même
// principe que public/dashboard.html#mediaFetchViaPollinations, mais côté
// serveur (axios) plutôt que côté navigateur (<img>), pour un flux déclenché
// depuis le chat plutôt que depuis le formulaire Studio Média. Modèle
// "sana" imposé par Pollinations (voir en-tête ci-dessus) — qualité
// inférieure à fal.ai/FLUX, utilisé UNIQUEMENT si FAL_KEY est absent ou en
// échec.
async function generateImageViaPollinations(prompt, width, height) {
  const seed = Math.floor(Math.random() * 1_000_000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&seed=${seed}&enhance=true&safe=true`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: REQUEST_TIMEOUT_MS });
  const contentType = res.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) {
    throw new Error('Pollinations a renvoyé une réponse non-image (probablement une erreur JSON — service saturé).');
  }
  return { buffer: Buffer.from(res.data), mimetype: contentType, provider: 'pollinations' };
}

async function generateImage({ prompt, width, height }) {
  try {
    const falUrl = await generateImageViaFal(prompt, width, height);
    if (falUrl) {
      const imgRes = await axios.get(falUrl, { responseType: 'arraybuffer', timeout: 60_000 });
      return {
        buffer: Buffer.from(imgRes.data),
        mimetype: imgRes.headers['content-type'] || 'image/jpeg',
        provider: 'fal',
      };
    }
  } catch (err) {
    console.warn('Génération image fal.ai échouée, repli Pollinations :', err.message);
  }

  return generateImageViaPollinations(prompt, width, height);
}

module.exports = {
  isConfigured,
  generateImage,
};
