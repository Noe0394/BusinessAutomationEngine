const axios = require('axios');
const FormData = require('form-data');
const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');

// PROCESSEUR VOCAL AUTONOME — ai-engine/voiceProcessor.js
// ---------------------------------------------------------------------------
// Décode/synthétise l'audio pour le Chat-Driven Agent Orchestrator :
//   - transcribeAudio() : note vocale (WhatsApp/Telegram/tchat vendeur) ->
//     texte, quelle que soit la langue parlée.
//   - translateToFrench() : traduit vers le français SEULEMENT si
//     nécessaire, en conservant l'intention/le ton — réutilise la cascade
//     LLM texte existante (lib/ai/llmFallbackEngine.js), jamais un second
//     moteur de traduction dédié.
//   - synthesizeSpeech() : texte -> audio (réponse vocale), best-effort —
//     AUCUN fournisseur TTS gratuit-sans-clé n'existe (contrairement au
//     texte, voir Pollinations dans llmFallbackEngine.js) : un échec total
//     retourne `null`, jamais une erreur qui bloquerait l'appelant — la
//     conversation continue en texte.
// Le texte transcrit/traduit est ensuite traité EXACTEMENT comme un message
// texte normal par ai-engine/chatOrchestrator.js ou ai-engine/emotionalCloser.js
// (aucune logique métier dupliquée ici — ce module ne fait QUE de la
// conversion audio<->texte).

const AUDIO_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// File d'attente à concurrence limitée (§3 "Traitement en file d'attente" —
// pics d'envoi simultanés de notes vocales lors des grandes campagnes) :
// simple sémaphore en mémoire, aucune dépendance externe. N'affecte QUE les
// appels passés à travers ce module (transcription/synthèse), jamais le
// reste de la plateforme.
const MAX_CONCURRENT_VOICE_JOBS = parseInt(process.env.MAX_CONCURRENT_VOICE_JOBS, 10) || 3;
let activeJobs = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeJobs < MAX_CONCURRENT_VOICE_JOBS) {
    activeJobs += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}
function releaseSlot() {
  const next = waitQueue.shift();
  if (next) next();
  else activeJobs = Math.max(0, activeJobs - 1);
}
async function withQueue(fn) {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

// ---------------------------------------------------------------------------
// STT — cascade multi-fournisseurs (même philosophie que
// lib/ai/llmFallbackEngine.js : une clé absente saute silencieusement le
// niveau, un échec bascule au suivant, jamais un crash de l'appelant).
// ---------------------------------------------------------------------------

// Groq expose Whisper (whisper-large-v3) via un endpoint compatible OpenAI
// Audio — renvoie le texte dans la LANGUE D'ORIGINE (pas de traduction ici,
// voir translateToFrench ci-dessous, volontairement séparée : un appel STT
// dédié à la traduction (endpoint /audio/translations de Groq) ne traduit
// QUE vers l'anglais, jamais le français — inutile ici).
async function transcribeWithGroqWhisper(buffer, mimetype, filename) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'audio.ogg', contentType: mimetype || 'audio/ogg' });
  form.append('model', process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3');
  form.append('response_format', 'json');

  const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
    timeout: AUDIO_REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
  });
  const text = res.data && res.data.text;
  if (!text) throw new Error('Réponse Groq Whisper vide ou de forme inattendue.');
  return { text: text.trim(), language: res.data.language || null };
}

// Gemini (multimodal) : transcription directe en un seul appel — utile
// comme 2e niveau indépendant de Groq (clé/quota séparés).
async function transcribeWithGemini(buffer, mimetype) {
  if (!process.env.GEMINI_API_KEY) return null;
  // Passe par l'AI Gateway (lib/ai/llmFallbackEngine.js) : la capacité « audio » est routée vers un modèle qui l'accepte réellement,
  // sans nom de modèle ni clé dans ce module.
  const r = await llmFallbackEngine.generateAIResponse(
    "Transcris cet audio mot pour mot, dans sa langue d'origine (ne traduis rien). Réponds UNIQUEMENT avec la transcription brute, aucun commentaire ni formatage.",
    [], null, undefined, null,
    { purpose: 'voice_transcription', media: [{ mimeType: mimetype || 'audio/ogg', data: buffer }] },
  );
  return { text: String(r.text || '').trim(), language: null };
}

const STT_PROVIDERS = [
  { name: 'groq-whisper', call: transcribeWithGroqWhisper },
  { name: 'gemini-audio', call: transcribeWithGemini },
];

// transcribeAudio(buffer, mimetype, filename) -> { text, language, provider }
// Lève une erreur SEULEMENT si TOUS les fournisseurs échouent/sont absents —
// à charge de l'appelant de dégrader proprement (ex: informer le client que
// la note vocale n'a pas pu être traitée).
async function transcribeAudio(buffer, mimetype, filename) {
  return withQueue(async () => {
    const errors = [];
    for (const provider of STT_PROVIDERS) {
      try {
        const result = await provider.call(buffer, mimetype, filename);
        if (result === null) continue; // clé absente : niveau sauté
        return { ...result, provider: provider.name };
      } catch (err) {
        const reason = require('../lib/ai/aiErrors').redact((err.response && err.response.status) ? `HTTP ${err.response.status}` : (err.internalDetail || err.message || String(err)));
        errors.push(`${provider.name}: ${reason}`);
        console.warn(`voiceProcessor — échec STT "${provider.name}" (${reason}), passage au suivant.`);
      }
    }
    throw new (require('../lib/ai/aiErrors').AiUnavailableError)(`transcription audio : ${errors.join(' | ') || 'aucune clé API configurée'}`);
  });
}

// ---------------------------------------------------------------------------
// Traduction vers le français — réutilise la cascade texte existante
// (lib/ai/llmFallbackEngine.js), jamais un moteur dédié. Heuristique rapide
// (mots-outils français très fréquents) pour éviter un aller-retour LLM
// inutile quand le texte est déjà manifestement en français.
// ---------------------------------------------------------------------------
const FRENCH_HINT_RE = /\b(le|la|les|un|une|des|et|est|je|tu|vous|nous|bonjour|merci|pour|avec|c'est|d'accord)\b/i;

function looksLikelyFrench(text) {
  return FRENCH_HINT_RE.test(text);
}

async function translateToFrench(text, detectedLanguage) {
  const t = String(text || '').trim();
  if (!t || looksLikelyFrench(t)) return t;

  const prompt = [
    'Traduis EXACTEMENT le texte suivant vers un français standard, en conservant fidèlement l\'intention, le ton et le niveau d\'émotion d\'origine (urgence, hésitation, enthousiasme...) — jamais de reformulation créative.',
    'Réponds UNIQUEMENT avec la traduction, aucun commentaire.',
    `Texte à traduire${detectedLanguage ? ` (langue détectée : ${detectedLanguage})` : ''} : "${t}"`,
  ].join('\n');

  try {
    const { text: translated } = await llmFallbackEngine.generateAIResponse(prompt, []);
    return translated.trim() || t;
  } catch (err) {
    // Filet de sécurité : jamais bloquer une conversation sur un échec de
    // traduction — le texte original (non traduit) reste exploitable par
    // le LLM en aval, qui comprend nativement de nombreuses langues.
    console.warn('voiceProcessor — traduction indisponible, texte original conservé :', err.message);
    return t;
  }
}

// ---------------------------------------------------------------------------
// TTS — cascade multi-fournisseurs. AUCUN niveau gratuit-sans-clé garanti :
// un échec total retourne `null` (pas une erreur), à charge de l'appelant
// de renvoyer du texte simple plutôt que de bloquer la conversation.
// ---------------------------------------------------------------------------
async function synthesizeWithElevenLabs(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // voix par défaut ElevenLabs ("Rachel")

  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    { text, model_id: 'eleven_multilingual_v2' },
    {
      headers: { 'xi-api-key': apiKey, Accept: 'audio/mpeg', 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: AUDIO_REQUEST_TIMEOUT_MS,
    },
  );
  return { buffer: Buffer.from(res.data), mimetype: 'audio/mpeg' };
}

// Google Cloud Text-to-Speech REST (clé API simple, pas de compte de
// service — cohérent avec le reste des intégrations de ce dépôt).
async function synthesizeWithGoogleTTS(text) {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) return null;

  const res = await axios.post(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      input: { text },
      voice: { languageCode: 'fr-FR', ssmlGender: 'FEMALE' },
      audioConfig: { audioEncoding: 'MP3' },
    },
    { timeout: AUDIO_REQUEST_TIMEOUT_MS },
  );
  const b64 = res.data && res.data.audioContent;
  if (!b64) throw new Error('Réponse Google TTS vide ou de forme inattendue.');
  return { buffer: Buffer.from(b64, 'base64'), mimetype: 'audio/mpeg' };
}

const TTS_PROVIDERS = [
  { name: 'elevenlabs', call: synthesizeWithElevenLabs },
  { name: 'google-tts', call: synthesizeWithGoogleTTS },
];

// synthesizeSpeech(text) -> { buffer, mimetype, provider } | null
async function synthesizeSpeech(text) {
  return withQueue(async () => {
    const errors = [];
    for (const provider of TTS_PROVIDERS) {
      try {
        const result = await provider.call(text);
        if (result === null) continue;
        return { ...result, provider: provider.name };
      } catch (err) {
        const reason = (err.response && err.response.status) ? `HTTP ${err.response.status}` : (err.message || String(err));
        errors.push(`${provider.name}: ${reason}`);
        console.warn(`voiceProcessor — échec TTS "${provider.name}" (${reason}), passage au suivant.`);
      }
    }
    console.warn(`voiceProcessor — synthèse vocale indisponible (${errors.join(' | ') || 'aucune clé API configurée'}), repli texte.`);
    return null;
  });
}

module.exports = { transcribeAudio, translateToFrench, synthesizeSpeech, looksLikelyFrench };
