// Cloud Functions appelées par les clients (VPS, local-client/, futur
// client mobile). Deux régimes différents selon la fonctionnalité — voir
// lib/firebaseSync.js pour le détail :
// - Licences (verifyLicenseOffline, createLicenseOffline, etc.) : Firestore
//   est une base PARTAGÉE avec le VPS (licenses.js), pas un simple secours
//   — les deux côtés peuvent créer/vérifier une licence en autorité, et
//   convergent l'un vers l'autre en temps réel (voir local-client/lib/license.js,
//   qui appelle désormais Firebase en PREMIER, VPS en repli).
// - IA (generateTextFallback, generateImageFallback) : décision du
//   2026-09-10 — porte désormais la MÊME cascade multi-fournisseurs que le
//   VPS (lib/ai/llmFallbackEngine.js pour le texte, lib/media/imageAiEngine.js
//   pour l'image), pas un seul fournisseur MVP comme avant. Objectif exprimé
//   par l'utilisateur : que le VPS puisse disparaître (impayé, résiliation)
//   sans que ça n'affecte la génération IA sur PC/téléphone — local-client/
//   appelle déjà Firebase en PREMIER pour l'IA (voir
//   local-client/lib/aiGateway.js), le VPS n'étant plus qu'un repli.
//   Texte : Groq -> Gemini -> OpenRouter -> Hugging Face -> Pollinations
//   (public, sans clé, garantit toujours une réponse).
//   Image : fal.ai (FLUX) -> Pollinations (public, sans clé).
//   Chaque niveau est optionnel (secret absent = niveau sauté), voir
//   callGroq/callGemini/etc. ci-dessous — copie volontairement dupliquée de
//   la logique VPS (runtime Cloud Functions séparé, pas d'import
//   cross-projet possible), à resynchroniser manuellement si la cascade VPS
//   évolue (nouveau modèle, nouveau fournisseur).
//
// Déploiement (à faire une fois, depuis ce dossier, avec le CLI Firebase de
// l'utilisateur — jamais depuis une session Claude Code qui n'a pas accès à
// son compte Google) :
//   firebase login
//   firebase use <votre-project-id>
//   firebase functions:secrets:set GROQ_API_KEY
//   firebase functions:secrets:set GEMINI_API_KEY
//   firebase functions:secrets:set OPENROUTER_API_KEY
//   firebase functions:secrets:set HUGGINGFACE_API_KEY
//   firebase functions:secrets:set REPLICATE_API_TOKEN
//   firebase functions:secrets:set FAL_KEY
//   firebase functions:secrets:set ADMIN_SECRET
//   (chaque secret est FACULTATIF — un niveau de la cascade sans secret est
//   simplement sauté, jamais d'échec du déploiement ni de l'appel)
//   firebase deploy --only functions:verifyLicenseOffline,functions:createLicenseOffline,functions:listLicensesOffline,functions:setLicenseActiveOffline,functions:updateLicenseOffline,functions:deleteLicenseOffline,functions:generateTextFallback,functions:generateImageFallback,functions:startVideoFallback,functions:pollVideoFallback
// JAMAIS "firebase deploy --only functions" (sans noms précis) ni
// ",firestore:rules" — voir README.md : ce projet Firebase est PARTAGÉ avec
// une autre application (RIEA AFRIQUE), un déploiement non scopé a déjà
// causé un incident (règles Firestore écrasées le 2026-09-09).
const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const videoAiEngine = require('./videoAiEngine');

admin.initializeApp();
const db = admin.firestore();
// getStorage() utilise l'Admin SDK, qui CONTOURNE les règles Storage (comme
// pour Firestore) — aucune modification de storage.rules n'est donc jamais
// nécessaire ni ne doit être tentée depuis ce dossier (même risque que
// firestore.rules, voir README.md). "cyrus-failover/" préfixe CLAIREMENT
// distinct des chemins déjà utilisés par RIEA AFRIQUE (ex: "videos/{uid}/"
// — voir storage.rules de cette app, gérée ailleurs) pour zéro collision.
const bucket = admin.storage().bucket();
const STORAGE_PREFIX = 'cyrus-failover';

const GROQ_API_KEY = defineSecret('GROQ_API_KEY');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');
const HUGGINGFACE_API_KEY = defineSecret('HUGGINGFACE_API_KEY');
const REPLICATE_API_TOKEN = defineSecret('REPLICATE_API_TOKEN');
const FAL_KEY = defineSecret('FAL_KEY');
const ADMIN_SECRET = defineSecret('ADMIN_SECRET');

// Même liste que licenses.js#ALL_MODULES (racine) — dupliquée ici
// volontairement : ce fichier tourne dans un runtime séparé (Cloud
// Functions), pas d'import cross-projet possible.
const ALL_MODULES = ['whatsapp', 'telegram', 'studio_video'];
function normalizeModules(allowedModules) {
  if (!Array.isArray(allowedModules)) return ALL_MODULES.slice();
  return allowedModules.filter((m) => ALL_MODULES.includes(m));
}
function generateKeyString() {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `KEY-${random}-${new Date().getFullYear()}`;
}

// ---------- Vérification de licence en mode dégradé ----------
// Décision du 2026-09-09 (demande explicite, risque assumé) : Firestore est
// désormais une base de vérité PARTAGÉE avec le VPS (voir
// ../lib/firebaseSync.js), pas une simple copie de secours — cette fonction
// peut donc lier un TOUT NOUVEAU appareil (pas seulement continuer un
// appareil déjà lié), pour que l'activation de nouveaux clients reste
// possible même si le VPS a disparu durablement. Le VPS convergera
// automatiquement vers cette liaison dès qu'il redevient joignable (écoute
// temps réel, voir licenses.js#watchLicenses).
//
// Compromis de sécurité ASSUMÉ : une clé compromise/partagée pourrait être
// activée sur un nouvel appareil pendant que le VPS est down et ne peut pas
// s'y opposer. Le verrou "un appareil par clé UNE FOIS lié" reste actif
// (DEVICE_MISMATCH ci-dessous) — seule la PREMIÈRE liaison est désormais
// permise hors-ligne.
// Dernier refus de vérification par clé, en mémoire d'instance uniquement
// (survit tant que cette instance Cloud Function reste "chaude" entre deux
// requêtes, perdu sur cold start) — même rôle que licenses.js#failureStats
// côté VPS : alimente uniquement la colonne "Cause" de l'admin-ui, jamais
// l'autorité de la licence elle-même (qui reste Firestore).
const failureStats = new Map(); // key -> { reason: string, at: number(ms) }
function recordFailure(key, reason) {
  failureStats.set(key, { reason, at: Date.now() });
}

exports.verifyLicenseOffline = onRequest(async (req, res) => {
  const { key, deviceId } = req.body || {};
  if (!key) return res.status(400).json({ valid: false, reason: 'MISSING_KEY' });
  if (!deviceId) return res.status(400).json({ valid: false, reason: 'MISSING_DEVICE_ID' });

  const normalizedKey = String(key).trim().toUpperCase();
  const ref = db.collection('licenses').doc(normalizedKey);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ valid: false, reason: 'NOT_FOUND' });

  const license = doc.data();
  if (!license.active) {
    recordFailure(normalizedKey, 'INACTIVE');
    return res.status(403).json({ valid: false, reason: 'INACTIVE' });
  }
  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) {
    recordFailure(normalizedKey, 'EXPIRED');
    return res.status(403).json({ valid: false, reason: 'EXPIRED' });
  }

  if (!license.boundDeviceId) {
    // Première utilisation de cette clé : liaison faite ICI, directement
    // dans Firestore — voir le raisonnement de sécurité ci-dessus.
    const boundAt = new Date().toISOString();
    await ref.update({ boundDeviceId: deviceId, boundAt });
    license.boundDeviceId = deviceId;
    license.boundAt = boundAt;
  } else if (license.boundDeviceId !== deviceId) {
    recordFailure(normalizedKey, 'DEVICE_MISMATCH');
    return res.status(403).json({ valid: false, reason: 'DEVICE_MISMATCH' });
  }

  res.status(200).json({
    valid: true,
    degraded: true, // signale au client qu'il fonctionne en mode secours
    expiresAt: license.expiresAt,
    allowedModules: license.allowedModules,
  });
});

// ---------- Création de licence en mode dégradé ----------
// Pendant du portail admin du VPS (POST /api/admin/licenses côté racine) —
// même rôle, autre porte d'entrée : protégée par un secret ADMIN dédié
// (ADMIN_SECRET, VOLONTAIREMENT distinct de ADMIN_PASSWORD du VPS pour ne
// jamais coupler leur rotation), pas par une licence client.
// cors: true sur les 4 fonctions admin ci-dessous : appelées depuis
// cyrus-license-admin.web.app (page admin, voir admin-ui/), une origine
// DIFFÉRENTE de cloudfunctions.net — sans ça le navigateur bloquerait la
// requête. Sans risque : l'autorisation réelle vient du header
// x-admin-secret vérifié dans chaque fonction, pas de CORS lui-même.
function requireAdminSecret(req, res) {
  const provided = req.get('x-admin-secret');
  if (!provided || provided !== ADMIN_SECRET.value()) {
    res.status(401).json({ error: 'Secret admin invalide.' });
    return false;
  }
  return true;
}

exports.createLicenseOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const { expiresAt, note, allowedModules } = req.body || {};
  const license = {
    key: generateKeyString(),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    active: true,
    note: note || '',
    allowedModules: normalizeModules(allowedModules),
    boundDeviceId: null,
    boundAt: null,
  };

  await db.collection('licenses').doc(license.key).set(license);
  res.status(201).json(license);
});

// Pendant du GET /api/admin/licenses côté VPS — liste triée par date de
// création (la plus récente d'abord), comme le portail admin du VPS. Injecte
// aussi la dernière cause de refus connue de CETTE instance (voir
// failureStats ci-dessus) pour que l'admin-ui puisse afficher la même
// colonne "Cause" que le portail VPS.
exports.listLicensesOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const snapshot = await db.collection('licenses').orderBy('createdAt', 'desc').get();
  res.json(snapshot.docs.map((doc) => {
    const license = doc.data();
    const failure = failureStats.get(doc.id);
    return {
      ...license,
      lastFailureReason: failure ? failure.reason : null,
      lastFailureAt: failure ? new Date(failure.at).toISOString() : null,
    };
  }));
});

// Pendant du POST /api/admin/licenses/:key/update côté VPS — modules
// autorisés et/ou date d'expiration (renouvellement) en un seul appel, sans
// toucher `active` (voir setLicenseActiveOffline pour ça).
exports.updateLicenseOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const { key, allowedModules, expiresAt } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Clé manquante.' });

  const ref = db.collection('licenses').doc(String(key).trim().toUpperCase());
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Licence introuvable.' });

  const updates = {};
  if (allowedModules !== undefined) updates.allowedModules = normalizeModules(allowedModules);
  if (expiresAt !== undefined) updates.expiresAt = expiresAt || null;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Rien à mettre à jour (allowedModules et/ou expiresAt requis).' });
  }

  await ref.update(updates);
  res.json({ ...doc.data(), ...updates });
});

// Pendant de POST /api/admin/licenses/:key/active côté VPS.
exports.setLicenseActiveOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const { key, active } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Clé manquante.' });

  const ref = db.collection('licenses').doc(String(key).trim().toUpperCase());
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Licence introuvable.' });

  await ref.update({ active: Boolean(active) });
  res.json({ ...doc.data(), active: Boolean(active) });
});

// Pendant de DELETE /api/admin/licenses/:key côté VPS.
exports.deleteLicenseOffline = onRequest({ secrets: [ADMIN_SECRET], cors: true }, async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Clé manquante.' });

  const ref = db.collection('licenses').doc(String(key).trim().toUpperCase());
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Licence introuvable.' });

  await ref.delete();
  res.json({ ok: true });
});

async function checkLicenseForFallback(req) {
  const key = req.get('x-license-key');
  const deviceId = req.get('x-device-id');
  if (!key || !deviceId) return { ok: false, error: 'Authentification manquante.' };

  const doc = await db.collection('licenses').doc(String(key).trim().toUpperCase()).get();
  if (!doc.exists) return { ok: false, error: 'Clé de licence inconnue.' };
  const license = doc.data();
  if (!license.active || (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now())) {
    return { ok: false, error: 'Licence inactive ou expirée.' };
  }
  if (license.boundDeviceId !== deviceId) {
    return { ok: false, error: 'Appareil non reconnu pour cette clé.' };
  }
  return { ok: true };
}

// ---------- Passerelle IA — cascade multi-fournisseurs (texte) ----------
// Portage de lib/ai/llmFallbackEngine.js (VPS), simplifié : pas de contexte
// CYRUS ni de détection de compétence marketing (marketingSkills.js,
// skillsRegistry) — ce sont des dépendances propres au Studio IA du VPS,
// hors sujet ici puisque local-client/lib/aiGateway.js n'envoie que
// `{ prompt }`, jamais history/mode/skillKey. Chaque call* retourne `null`
// (secret absent, niveau sauté) plutôt que de lever une erreur.
const TEXT_REQUEST_TIMEOUT_MS = 15_000;
const TEXT_SYSTEM_PROMPT = [
  'Tu es l\'assistant IA de CYRUS SUPER ASSISTANT.',
  'Tu es un assistant IA généraliste à part entière : tu réponds à N\'IMPORTE QUELLE question, dans N\'IMPORTE QUEL domaine — jamais de refus, jamais de réponse hors-sujet.',
  'Réponds toujours avec un ton humain, chaleureux et direct — jamais robotique.',
  'Sois concis et concret.',
].join(' ');

async function callGroqText(prompt) {
  const apiKey = GROQ_API_KEY.value();
  if (!apiKey) return null;
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'openai/gpt-oss-120b', messages: [{ role: 'system', content: TEXT_SYSTEM_PROMPT }, { role: 'user', content: prompt }] },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: TEXT_REQUEST_TIMEOUT_MS },
  );
  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse Groq vide ou de forme inattendue.');
  return text.trim();
}

async function callGeminiText(prompt) {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) return null;
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
    { contents: [{ role: 'user', parts: [{ text: prompt }] }], systemInstruction: { parts: [{ text: TEXT_SYSTEM_PROMPT }] } },
    { timeout: TEXT_REQUEST_TIMEOUT_MS },
  );
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Réponse Gemini vide ou de forme inattendue.');
  return text.trim();
}

async function callOpenRouterText(prompt) {
  const apiKey = OPENROUTER_API_KEY.value();
  if (!apiKey) return null;
  const model = process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free';
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    { model, messages: [{ role: 'system', content: TEXT_SYSTEM_PROMPT }, { role: 'user', content: prompt }] },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: TEXT_REQUEST_TIMEOUT_MS },
  );
  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse OpenRouter vide ou de forme inattendue.');
  return text.trim();
}

async function callHuggingFaceText(prompt) {
  const apiKey = HUGGINGFACE_API_KEY.value();
  if (!apiKey) return null;
  const res = await axios.post(
    'https://router.huggingface.co/v1/chat/completions',
    { model: 'Qwen/Qwen2.5-72B-Instruct', messages: [{ role: 'system', content: TEXT_SYSTEM_PROMPT }, { role: 'user', content: prompt }] },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: TEXT_REQUEST_TIMEOUT_MS },
  );
  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse Hugging Face vide ou de forme inattendue.');
  return text.trim();
}

// Fallback ultime sans clé — garantit une réponse dans 100% des cas.
async function callPollinationsText(prompt) {
  const enrichedPrompt = `${TEXT_SYSTEM_PROMPT}\n\nUtilisateur: ${prompt}\nAssistant:`;
  const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(enrichedPrompt)}`, {
    timeout: TEXT_REQUEST_TIMEOUT_MS, responseType: 'text', transformResponse: (data) => data,
  });
  const text = typeof res.data === 'string' ? res.data : '';
  if (!text.trim()) throw new Error('Réponse Pollinations vide.');
  return text.trim();
}

const TEXT_PROVIDERS = [
  { name: 'groq', call: callGroqText },
  { name: 'gemini', call: callGeminiText },
  { name: 'openrouter', call: callOpenRouterText },
  { name: 'huggingface', call: callHuggingFaceText },
  { name: 'pollinations', call: callPollinationsText },
];

exports.generateTextFallback = onRequest(
  { secrets: [GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, HUGGINGFACE_API_KEY] },
  async (req, res) => {
    const auth = await checkLicenseForFallback(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const prompt = String((req.body || {}).prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Prompt manquant.' });

    const errors = [];
    for (const provider of TEXT_PROVIDERS) {
      try {
        const text = await provider.call(prompt);
        if (text === null) continue; // secret absent : niveau sauté
        return res.json({ text, provider: `${provider.name} (Firebase)` });
      } catch (err) {
        const reason = err.response?.status ? `HTTP ${err.response.status}` : (err.message || String(err));
        errors.push(`${provider.name}: ${reason}`);
        console.warn(`Cascade texte Firebase — échec "${provider.name}" (${reason}), passage au suivant.`);
      }
    }
    console.error('Échec génération texte (tous fournisseurs) :', errors.join(' | '));
    res.status(502).json({ error: 'Échec de la génération de texte IA (tous les fournisseurs ont échoué).' });
  },
);

// ---------- Passerelle IA — cascade multi-fournisseurs (image) ----------
// Portage de lib/media/imageAiEngine.js (VPS) : fal.ai (FLUX) -> Pollinations
// (public, sans clé). L'image est toujours rapatriée dans Firebase Storage
// (voir STORAGE_PREFIX) plutôt que de renvoyer l'URL du fournisseur brute.
async function generateImageViaFal(prompt) {
  const apiKey = FAL_KEY.value();
  if (!apiKey) return null;
  const { data } = await axios.post(
    'https://fal.run/fal-ai/flux/schnell',
    { prompt, num_images: 1, output_format: 'jpeg' },
    { headers: { Authorization: `Key ${apiKey}` }, timeout: 30_000 },
  );
  const falUrl = data?.images?.[0]?.url;
  if (!falUrl) throw new Error('Réponse fal.ai sans URL d\'image.');
  const imgRes = await axios.get(falUrl, { responseType: 'arraybuffer', timeout: 60_000 });
  return { buffer: Buffer.from(imgRes.data), mimetype: imgRes.headers['content-type'] || 'image/jpeg', provider: 'fal' };
}

// Repli gratuit sans clé — modèle "sana" imposé par Pollinations (qualité
// inférieure à FLUX/fal.ai), utilisé uniquement si fal.ai est absent/échoue.
async function generateImageViaPollinations(prompt) {
  const seed = Math.floor(Math.random() * 1_000_000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}&enhance=true&safe=true`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30_000 });
  const contentType = res.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) {
    throw new Error('Pollinations a renvoyé une réponse non-image (service saturé).');
  }
  return { buffer: Buffer.from(res.data), mimetype: contentType, provider: 'pollinations' };
}

exports.generateImageFallback = onRequest({ secrets: [FAL_KEY] }, async (req, res) => {
  const auth = await checkLicenseForFallback(req);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const prompt = String((req.body || {}).prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Prompt manquant.' });

  let image;
  try {
    image = await generateImageViaFal(prompt);
  } catch (err) {
    console.warn('Génération image fal.ai échouée (Firebase), repli Pollinations :', err.message);
  }
  if (!image) {
    try {
      image = await generateImageViaPollinations(prompt);
    } catch (err) {
      console.error('Échec génération image (tous fournisseurs, Firebase) :', err.message);
      return res.status(502).json({ error: 'Échec de la génération image IA (tous les fournisseurs ont échoué).' });
    }
  }

  try {
    // Rapatrie l'image chez nous (Firebase Storage) plutôt que de renvoyer
    // l'URL du fournisseur brute, dont la durée de rétention n'est pas
    // garantie — voir STORAGE_PREFIX plus haut (chemin dédié, aucune règle
    // Storage à toucher, Admin SDK uniquement).
    const filePath = `${STORAGE_PREFIX}/${crypto.randomUUID()}.jpg`;
    const file = bucket.file(filePath);
    await file.save(image.buffer, { contentType: image.mimetype });
    // URL signée plutôt que makePublic() : fonctionne quel que soit le mode
    // d'accès du bucket (l'"accès uniforme au niveau du bucket", courant sur
    // les buckets récents, désactive les ACL par objet et ferait échouer
    // makePublic()) — et évite de rendre un fichier public dans un bucket
    // partagé sans savoir si son mode d'accès le permet.
    const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    res.json({ url, provider: `${image.provider} (Firebase)` });
  } catch (err) {
    console.error('Échec upload Storage de l\'image générée (Firebase) :', err.message);
    res.status(502).json({ error: 'Échec de la sauvegarde de l\'image générée.' });
  }
});

// ---------- Passerelle IA — vidéo (image-to-video), job asynchrone ----------
// Portage de lib/media/videoAiEngine.js (VPS, voir ./videoAiEngine.js ici,
// copie identique) : fal.ai -> Replicate -> Hugging Face (best effort). API
// asynchrone en 2 temps (soumission + interrogation), le job lui-même est
// persisté dans Firestore (collection "videoJobs") entre les deux appels —
// deux invocations HTTP successives d'une Cloud Function peuvent tomber sur
// des instances différentes, contrairement à failureStats/usageStats
// ci-dessus qui restent volontairement en mémoire (diagnostic seulement, pas
// une donnée dont la perte casserait un flux en cours).
const VIDEO_JOB_COLLECTION = 'videoJobs';
const VIDEO_JOB_SECRETS = [FAL_KEY, REPLICATE_API_TOKEN, HUGGINGFACE_API_KEY];

exports.startVideoFallback = onRequest({ secrets: VIDEO_JOB_SECRETS }, async (req, res) => {
  const auth = await checkLicenseForFallback(req);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const { imageUrl, prompt, seed, preferredProvider } = req.body || {};
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl manquant.' });

  try {
    const job = await videoAiEngine.startVideoAiJob(imageUrl, prompt, Number.isFinite(seed) ? seed : undefined, preferredProvider);
    const jobId = crypto.randomUUID();
    await db.collection(VIDEO_JOB_COLLECTION).doc(jobId).set({ job, createdAt: Date.now() });
    res.json({ jobId, provider: `${job.provider} (Firebase)` });
  } catch (err) {
    console.error('Échec soumission job vidéo (Firebase) :', err.message);
    res.status(err.kind === 'not_configured' ? 501 : 502).json({ error: err.message });
  }
});

exports.pollVideoFallback = onRequest({ secrets: VIDEO_JOB_SECRETS }, async (req, res) => {
  const auth = await checkLicenseForFallback(req);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId manquant.' });

  const ref = db.collection(VIDEO_JOB_COLLECTION).doc(jobId);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Job vidéo introuvable (expiré ou déjà terminé).' });

  try {
    const result = await videoAiEngine.pollVideoAiJob(doc.data().job);
    if (!result.done) return res.json({ done: false });

    // Rapatrie la vidéo dans Firebase Storage (même principe que l'image
    // ci-dessus) — soit une URL à télécharger (fal.ai/Replicate), soit déjà
    // un buffer en mémoire (Hugging Face, voir callHfClassicInferenceApi/
    // callGradioSpace dans videoAiEngine.js).
    let buffer;
    let mimetype;
    if (result.videoBuffer) {
      buffer = result.videoBuffer;
      mimetype = result.videoMimetype || 'video/mp4';
    } else {
      const videoRes = await axios.get(result.videoUrl, { responseType: 'arraybuffer', timeout: 120_000 });
      buffer = Buffer.from(videoRes.data);
      mimetype = videoRes.headers['content-type'] || 'video/mp4';
    }

    const filePath = `${STORAGE_PREFIX}/${crypto.randomUUID()}.mp4`;
    const file = bucket.file(filePath);
    await file.save(buffer, { contentType: mimetype });
    const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });

    await ref.delete();
    res.json({ done: true, url, provider: `${doc.data().job.provider} (Firebase)` });
  } catch (err) {
    console.error('Échec du job vidéo (Firebase) :', err.message);
    await ref.delete();
    res.status(502).json({ error: err.message });
  }
});
