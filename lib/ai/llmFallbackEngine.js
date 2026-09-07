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
// IMPORTANT : ce module reste un COMPLÉMENT au moteur local historique, pas
// un remplacement. Il n'est appelé par index.js QUE quand composeReply()
// renvoie category === 'UNKNOWN' (aucun sujet CYRUS/marketing précis
// identifié) — les réponses de support/produit et marketing structurées
// restent toujours servies par le moteur local déterministe, jamais par un
// modèle externe susceptible d'halluciner une information sur la
// plateforme elle-même. Si les 4 niveaux ci-dessous échouent tous (panne
// réseau totale), l'appelant retombe sur le texte déjà généré par le
// moteur local plutôt que de laisser planter la requête.
const REQUEST_TIMEOUT_MS = 15_000;

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
async function callGroq(prompt, history) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: toChatMessages(prompt, history) },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: REQUEST_TIMEOUT_MS },
  );
  const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content
    : null;
  if (!text) throw new Error('Réponse Groq vide ou de forme inattendue.');
  return text.trim();
}

async function callGemini(prompt, history) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const contents = toChatMessages(prompt, history).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    { contents },
    { timeout: REQUEST_TIMEOUT_MS },
  );
  const candidate = res.data && res.data.candidates && res.data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]
    ? candidate.content.parts[0].text
    : null;
  if (!text) throw new Error('Réponse Gemini vide ou de forme inattendue.');
  return text.trim();
}

async function callHuggingFace(prompt, history) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) return null;

  // Endpoint "router" compatible OpenAI de Hugging Face (même forme de
  // requête/réponse que Groq ci-dessus) — évite de gérer un format de
  // réponse distinct par modèle d'inférence.
  const res = await axios.post(
    'https://router.huggingface.co/v1/chat/completions',
    { model: 'Qwen/Qwen2.5-72B-Instruct', messages: toChatMessages(prompt, history) },
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
async function callPollinations(prompt, history) {
  const recent = (Array.isArray(history) ? history : []).slice(-6)
    .filter((t) => t && t.text)
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Utilisateur'}: ${t.text}`)
    .join('\n');
  const enrichedPrompt = recent ? `${recent}\nUtilisateur: ${prompt}\nAssistant:` : String(prompt || '');

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
async function generateAIResponse(prompt, history) {
  const errors = [];
  for (const provider of PROVIDERS) {
    try {
      const text = await provider.call(prompt, history);
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
