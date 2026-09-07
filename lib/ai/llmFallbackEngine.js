const axios = require('axios');

// LLM MULTI-PROVIDER FALLBACK — cascade de secours automatique entre
// plusieurs API de raisonnement gratuites, pour offrir une réponse bien
// plus intelligente/adaptative que le moteur 100% local à base de règles
// (voir lib/ai/localCopywriterEngine.js) sans jamais dépendre d'un seul
// fournisseur ni introduire de coût. Chaque niveau est optionnel — une clé
// API absente saute silencieusement l'étape, sans jamais faire planter
// l'appelant — sauf le dernier (Pollinations Text API, public, sans clé)
// qui garantit un retour texte dans 100% des cas.
//
// Depuis l'activation de cette cascade, c'est désormais la réponse
// PRINCIPALE du Copywriter Studio IA pour CHAQUE message (voir index.js) —
// plus seulement un complément pour les messages non reconnus par le moteur
// local. L'assistant doit pouvoir répondre à n'importe quelle question, dans
// n'importe quel domaine, exactement comme un assistant IA généraliste (voir
// SYSTEM_PROMPT) — jamais limité aux seuls sujets CYRUS/marketing. Le moteur
// local historique (lib/ai/localCopywriterEngine.js) garde néanmoins deux
// rôles : (1) sa réponse déjà composée est transmise en CONTEXTE (paramètre
// `context` ci-dessous) quand un sujet CYRUS précis a été identifié, pour
// que le LLM reste factuellement exact sur le fonctionnement de la
// plateforme elle-même plutôt que d'halluciner ; (2) elle sert de filet de
// sécurité si les 4 niveaux ci-dessous échouent tous (panne réseau totale).
const REQUEST_TIMEOUT_MS = 15_000;

// Prompt système injecté sur CHAQUE niveau de la cascade (adapté par
// fournisseur ci-dessous — Groq/Hugging Face via un message role:"system",
// Gemini via son champ systemInstruction dédié, Pollinations via un
// préambule textuel, faute de rôle système dans son API de complétion
// brute) : impose une analyse d'intention avant génération plutôt qu'une
// réponse générique, ET autorise/impose explicitement de répondre à
// N'IMPORTE QUELLE question — c'est le principal levier de réponses
// précises, jamais hors-sujet ni limitées à un domaine, indépendamment du
// modèle réellement interrogé.
const SYSTEM_PROMPT = [
  'Tu es l\'assistant IA de CYRUS SUPER ASSISTANT.',
  'Tu es un assistant IA généraliste à part entière, exactement comme ChatGPT ou Claude : tu réponds à N\'IMPORTE QUELLE question, dans N\'IMPORTE QUEL domaine (culture générale, sciences, code, actualité, vie quotidienne, marketing, ou tout autre sujet) — jamais de refus, jamais de "ce n\'est pas mon domaine", jamais de réponse hors-sujet qui ignore la vraie question posée.',
  'Avant de répondre, analyse SYSTÉMATIQUEMENT l\'intention réelle du message pour cerner précisément ce qui est attendu comme réponse.',
  'Réponds toujours avec un ton humain, chaleureux et direct — jamais robotique, jamais générique.',
  'Sois concis et concret : une réponse qui répond vraiment à la question posée, jamais vague ni purement théorique.',
  'Si le message concerne un besoin marketing/business, sois orienté conversion (concret, actionnable) ; sinon, réponds simplement et complètement comme le ferait n\'importe quel assistant IA généraliste.',
].join(' ');

// Ajoute, uniquement quand elle existe, la référence CYRUS déjà composée
// par le moteur local — le LLM décide lui-même si elle est pertinente pour
// la question posée (sujet CYRUS précis) ou s'il doit l'ignorer et répondre
// avec ses connaissances générales (toute autre question).
function buildSystemPrompt(context) {
  if (!context) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}\n\nÉlément de référence sur CYRUS SUPER ASSISTANT, à réutiliser fidèlement UNIQUEMENT si la question porte précisément là-dessus (sinon ignore-le complètement et réponds normalement, sur n'importe quel autre sujet) :\n${context}`;
}

// Convertit (prompt, history) en tableau de messages au format
// {role, content} commun à Groq/Gemini/Hugging Face — `history` reprend le
// format déjà utilisé par lib/aiStudioStore.js ({role, text, createdAt}).
function toChatMessages(prompt, history) {
  const messages = [];
  (Array.isArray(history) ? history : []).forEach((turn) => {
    if (!turn || !turn.text) return;
    messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: String(turn.text) });
  });
  messages.push({ role: 'user', content: String(prompt || '') });
  return messages;
}

// Retourne `null` (niveau à sauter, clé absente) plutôt que de lever une
// erreur — generateAIResponse() distingue ainsi "pas configuré" de "a
// échoué", même si les deux aboutissent au même passage au niveau suivant.
async function callGroq(prompt, history, context) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const messages = [{ role: 'system', content: buildSystemPrompt(context) }, ...toChatMessages(prompt, history)];
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: REQUEST_TIMEOUT_MS },
  );
  const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content
    : null;
  if (!text) throw new Error('Réponse Groq vide ou de forme inattendue.');
  return text.trim();
}

async function callGemini(prompt, history, context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const contents = toChatMessages(prompt, history).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    { contents, systemInstruction: { parts: [{ text: buildSystemPrompt(context) }] } },
    { timeout: REQUEST_TIMEOUT_MS },
  );
  const candidate = res.data && res.data.candidates && res.data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]
    ? candidate.content.parts[0].text
    : null;
  if (!text) throw new Error('Réponse Gemini vide ou de forme inattendue.');
  return text.trim();
}

async function callHuggingFace(prompt, history, context) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) return null;

  // Endpoint "router" compatible OpenAI de Hugging Face (même forme de
  // requête/réponse que Groq ci-dessus) — évite de gérer un format de
  // réponse distinct par modèle d'inférence.
  const messages = [{ role: 'system', content: buildSystemPrompt(context) }, ...toChatMessages(prompt, history)];
  const res = await axios.post(
    'https://router.huggingface.co/v1/chat/completions',
    { model: 'Qwen/Qwen2.5-72B-Instruct', messages },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: REQUEST_TIMEOUT_MS },
  );
  const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content
    : null;
  if (!text) throw new Error('Réponse Hugging Face vide ou de forme inattendue.');
  return text.trim();
}

// Fallback ultime SANS clé API — endpoint public gratuit, garantit un
// retour texte dans 100% des cas (voir feuille de route). Le prompt est
// enrichi avec le court historique récent pour garder un minimum de
// contexte conversationnel malgré une API très simple (GET + texte brut,
// pas de vrai format de conversation).
async function callPollinations(prompt, history, context) {
  const recent = (Array.isArray(history) ? history : []).slice(-6)
    .filter((t) => t && t.text)
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Utilisateur'}: ${t.text}`)
    .join('\n');
  const conversation = recent ? `${recent}\nUtilisateur: ${prompt}\nAssistant:` : `Utilisateur: ${prompt}\nAssistant:`;
  const enrichedPrompt = `${buildSystemPrompt(context)}\n\n${conversation}`;

  const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(enrichedPrompt)}`, {
    timeout: REQUEST_TIMEOUT_MS,
    responseType: 'text',
    transformResponse: (data) => data,
  });
  const text = typeof res.data === 'string' ? res.data : '';
  if (!text.trim()) throw new Error('Réponse Pollinations vide.');
  return text.trim();
}

const PROVIDERS = [
  { name: 'groq', call: callGroq },
  { name: 'gemini', call: callGemini },
  { name: 'huggingface', call: callHuggingFace },
  { name: 'pollinations', call: callPollinations },
];

// Teste chaque fournisseur dans l'ordre de la cascade. Une clé API absente
// saute silencieusement le niveau (retour `null`, aucun appel réseau) ;
// toute autre erreur (429 rate limit, quota dépassé, timeout, 5xx, clé
// invalide...) passe au niveau suivant SANS jamais remonter jusqu'à
// l'appelant à ce stade — seul un échec des 4 niveaux (Pollinations compris,
// qui ne peut réalistement échouer que par panne réseau totale) lève une
// erreur, à charge de l'appelant de retomber sur le moteur local.
async function generateAIResponse(prompt, history, context) {
  const errors = [];
  for (const provider of PROVIDERS) {
    try {
      const text = await provider.call(prompt, history, context);
      if (text === null) continue; // clé API absente : niveau sauté intelligemment
      return { text, provider: provider.name };
    } catch (err) {
      const reason = (err.response && err.response.status)
        ? `HTTP ${err.response.status}`
        : (err.message || String(err));
      errors.push(`${provider.name}: ${reason}`);
      console.warn(`LLM Fallback — échec du fournisseur "${provider.name}" (${reason}), passage au suivant.`);
    }
  }
  throw new Error(`Tous les fournisseurs LLM ont échoué : ${errors.join(' | ') || 'aucune clé API configurée'}.`);
}

module.exports = {
  generateAIResponse,
};
