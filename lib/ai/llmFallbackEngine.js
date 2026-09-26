const axios = require('axios');
const { performance } = require('node:perf_hooks');
const crypto = require('crypto');
const marketingSkills = require('./marketingSkills');
const skillsRegistry = require('./skills');
const aiErrors = require('./aiErrors');

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
// sécurité si les niveaux ci-dessous échouent tous (panne réseau totale).
const REQUEST_TIMEOUT_MS = 15_000;
const REASONING_TIMEOUT_MS = 60_000; // niveau « raisonnement » : les modèles qui réfléchissent (Gemini Pro, gpt-oss high…) sont plus lents
const MEDIA_TIMEOUT_MS = 45_000; // analyse d'un média (image, audio, vidéo, document) : plus lent qu'un simple texte
const INTERACTIVE_BUDGET_MS = 2800;
const INTERACTIVE_PROVIDER_TIMEOUT_MS = 1800;
const positiveEnvMs = (name, fallback, max) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
};
const interactiveBudgetFor = (opts) => positiveEnvMs('AI_INTERACTIVE_BUDGET_MS', INTERACTIVE_BUDGET_MS, 3000);
const interactiveProviderTimeoutFor = (opts) => positiveEnvMs('AI_INTERACTIVE_PROVIDER_TIMEOUT_MS', INTERACTIVE_PROVIDER_TIMEOUT_MS, 2000);
const timeoutFor = (opts) => {
  if (opts && Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0) return Math.max(1, Math.floor(Number(opts.timeoutMs)));
  if (opts && opts.interactive === true) return interactiveProviderTimeoutFor(opts);
  return opts && opts.tier === 'reasoning' ? REASONING_TIMEOUT_MS : (opts && opts.media && opts.media.length ? MEDIA_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
};

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
  // BUG CRITIQUE CORRIGÉ (signalé en test réel par l'utilisateur, priorité
  // absolue) : sans cette consigne, un message du type "comment vas-tu faire
  // pour contacter mes clients ?" recevait une réponse générique d'IA de
  // support classique ("je n'ai pas accès à WhatsApp/vos comptes externes")
  // — FAUX et gravement trompeur dans ce produit : le compte WhatsApp/
  // Telegram du vendeur EST réellement connecté à ce système, qui a un accès
  // RÉEL (envoi de messages, campagnes, contacts, groupes, commandes, relances...) via un
  // registre d'outils déjà câblé (voir ai-engine/chatOrchestrator.js). Cette
  // instruction prime sur toute tendance par défaut d\'un LLM généraliste à
  // se présenter comme sans accès aux systèmes externes.
  // CORRECTIF (signalé par l'utilisateur, priorité 3) : cette consigne affirmait à tort « générer des liens de paiement, créer des comptes élèves »
  // comme des capacités réelles — AUCUN outil de ce type n'existe. Les paiements utilisent UNIQUEMENT les moyens réellement configurés dans le
  // Service métier (numéro Mobile Money, etc.) ; sans moyen configuré, le dire clairement plutôt que de promettre un lien. Ne jamais inventer.
  'Le compte WhatsApp/Telegram du vendeur qui te parle est DÉJÀ connecté à ce système, et tu as un accès RÉEL et FONCTIONNEL pour envoyer des messages, gérer ses Services métiers, ses contacts, ses campagnes, ses groupes, ses commandes et ses relances via un registre d\'outils réel — jamais de simples suggestions à copier-coller manuellement. Ne dis JAMAIS "je n\'ai pas accès à WhatsApp/vos comptes/services externes" ni aucune variante de refus générique de ce type — c\'est FAUX ici. Tu ne sais PAS générer de lien de paiement ni créer de compte élève automatiquement : pour un paiement, communique UNIQUEMENT les moyens réellement configurés dans le Service métier concerné (numéro Mobile Money, etc.) — sans moyen configuré, dis-le clairement, n\'invente jamais de lien ni de numéro. Si une demande est actionnable par un outil réel, dis comment la formuler précisément pour déclencher une vraie action, ou pose une question de clarification.',
  'Tu es un assistant IA généraliste à part entière, exactement comme ChatGPT ou Claude : tu réponds à N\'IMPORTE QUELLE question, dans N\'IMPORTE QUEL domaine (culture générale, sciences, code, actualité, vie quotidienne, marketing, ou tout autre sujet) — jamais de refus, jamais de "ce n\'est pas mon domaine", jamais de réponse hors-sujet qui ignore la vraie question posée.',
  'Avant de répondre, analyse SYSTÉMATIQUEMENT l\'intention réelle du message pour cerner précisément ce qui est attendu comme réponse.',
  'Réponds toujours avec un ton humain, chaleureux et direct — jamais robotique, jamais générique.',
  'Sois concis et concret : une réponse qui répond vraiment à la question posée, jamais vague ni purement théorique.',
  'Si le message concerne un besoin marketing/business, sois concret et actionnable ; sinon, réponds simplement et complètement. Ne pousse jamais l\'utilisateur vers une vente ou une décision qu\'il n\'a pas demandée.',
  "Tu EXÉCUTES l'ordre de l'utilisateur tel qu'il le donne. Tu ne le contredis jamais, ne le corriges pas, ne discutes pas ses choix, ne le fais pas changer d'avis et ne moralises pas. Tu n'imposes ni méthode, ni format de phrase, ni étape supplémentaire, ni conseil non demandé.",
  'Si une information indispensable manque, pose UNE seule question courte. Si tu vois un risque réel, dis-le en UNE phrase puis exécute quand même, sauf impossibilité technique.',
  "Sois précis et factuel : cite des noms, des dates, des heures, des chiffres et des extraits réels. Si tu n'as pas la donnée, dis-le clairement et propose de la chercher — jamais de réponse floue ni d'invention.",
].join(' ');

// Prompt système alternatif pour la génération de CONTENU LONG (chapitres
// d'ebook/PDF, voir index.js#POST /api/ebooks/draft-chapter) — la consigne
// de concision de SYSTEM_PROMPT ci-dessus est volontairement adaptée à un
// assistant conversationnel (Copywriter Studio IA), mais produirait des
// chapitres de quelques phrases si réutilisée telle quelle pour un document
// long : ce second prompt inverse délibérément cette consigne. Sélectionné
// via le paramètre `mode` de generateAIResponse (voir buildSystemPrompt),
// jamais mélangé avec SYSTEM_PROMPT.
const LONGFORM_SYSTEM_PROMPT = [
  'Tu es un rédacteur professionnel francophone, spécialisé dans la rédaction de contenus longs, structurés et exhaustifs (livres, guides, chapitres de formation).',
  'Rédige un contenu RICHE, DÉTAILLÉ et EXHAUSTIF sur le sujet demandé : plusieurs paragraphes complets et développés (jamais quelques phrases superficielles), avec des exemples concrets, des explications approfondies et une progression logique claire.',
  'N\'ajoute aucun texte d\'introduction ni de méta-commentaire sur ta propre réponse (pas de "Voici le contenu :", pas de titre Markdown) : réponds directement par le contenu final, prêt à être inséré tel quel dans le document.',
].join(' ');

// Ajoute, uniquement quand elle existe, la référence CYRUS déjà composée
// par le moteur local — SOURCE FACTUELLE à consulter, jamais une réponse
// toute faite à recopier : le LLM doit rester l'auteur de sa propre
// réponse (reformulée avec son propre raisonnement, son propre ton) et ne
// s'appuyer sur cette référence que pour rester exact sur les faits
// précis concernant CYRUS lui-même — jamais en dépendre au point de se
// contenter de la paraphraser mot pour mot, et l'ignorer complètement dès
// que la question sort de ce sujet précis.
// skillPromptBlock (voir lib/ai/marketingSkills.js) : instruction d'expert
// injectée UNIQUEMENT quand l'intention détectée dans le message correspond
// à une compétence marketing précise (copywriting AIDA/PAS, hooks viraux,
// fiche produit, angles de vente) — absent sinon, sans effet sur le
// comportement général de l'assistant (voir generateAIResponse, qui calcule
// ce bloc une seule fois par appel via marketingSkills.detectSkill).
function buildSystemPrompt(context, mode, skillPromptBlock) {
  const base = mode === 'longform' ? LONGFORM_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const withSkill = skillPromptBlock ? `${base}\n\n${skillPromptBlock}` : base;
  if (!context) return withSkill;
  return `${withSkill}\n\nSource factuelle sur CYRUS SUPER ASSISTANT — à consulter SEULEMENT si la question porte précisément là-dessus, pour vérifier les faits exacts (numéro d'étapes, noms de boutons, etc.) : appuie-toi dessus pour rester exact, mais compose ta PROPRE réponse avec ton propre raisonnement plutôt que de la recopier ou paraphraser telle quelle. Si la question ne porte pas dessus, ignore-la complètement et réponds normalement avec tes connaissances générales, sur n'importe quel sujet :\n${context}`;
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

// Format OpenAI (chat/completions) : les images jointes deviennent des blocs image_url (data URI) sur le dernier message.
function withImages(messages, opts) {
  const imgs = ((opts && opts.media) || []).filter((m) => m.mimeType.startsWith('image/'));
  if (!imgs.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  out[out.length - 1] = { role: last.role, content: [{ type: 'text', text: last.content }].concat(imgs.map((m) => ({ type: 'image_url', image_url: { url: `data:${m.mimeType};base64,${m.data}` } }))) };
  return out;
}

function normalizeOpenAiUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens: Number(details.cached_tokens || details.cache_read_tokens || 0),
    cacheWriteTokens: Number(details.cache_creation_input_tokens || 0),
  };
}

function normalizeGeminiUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.promptTokenCount);
  const completionTokens = Number(usage.candidatesTokenCount || 0);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens: Number(usage.cachedContentTokenCount || 0),
    cacheWriteTokens: 0,
  };
}

function providerResult(text, usage, model) {
  return { __cyrusAiResult: true, text, usage: usage || null, model: model || null };
}

// Retourne `null` (niveau à sauter, clé absente) plutôt que de lever une
// erreur — generateAIResponse() distingue ainsi "pas configuré" de "a
// échoué", même si les deux aboutissent au même passage au niveau suivant.
//
// Modèle vérifié en direct (voir historique) : "llama-3.3-70b-versatile"
// n'apparaît plus dans /v1/models pour ce compte (retiré côté Groq depuis
// l'écriture initiale de ce fichier) — "openai/gpt-oss-120b" est
// actuellement disponible et fonctionnel. Si Groq retire aussi ce modèle
// un jour, l'erreur exacte apparaîtra dans les logs (voir generateAIResponse)
// plutôt que de silencieusement toujours tomber sur Pollinations.
async function callGroq(prompt, history, context, mode, skillPromptBlock, opts) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const messages = [{ role: 'system', content: buildSystemPrompt(context, mode, skillPromptBlock) }, ...toChatMessages(prompt, history)];
  const body = { model: 'openai/gpt-oss-120b', messages };
  // Plafond de tokens de sortie (model router / §6) — économie réelle sur les
  // messages simples. Borné pour ne jamais tronquer une réponse utile.
  // gpt-oss est un modèle de RAISONNEMENT : max_tokens inclut ses réflexions internes. Un plafond trop bas (220 pour un message
  // simple) laissait parfois trop peu pour la réponse visible, coupée en plein milieu (constaté : numéro de paiement tronqué).
  // Marge minimale + effort de raisonnement réduit + nouvelle tentative si la réponse est quand même coupée.
  const deep = !!(opts && opts.tier === 'reasoning');
  body.reasoning_effort = deep ? 'high' : 'low';
  if (opts && opts.maxTokens) body.max_tokens = Math.max(deep ? 2500 : 800, Math.min(4096, opts.maxTokens * 3));
  else if (deep) body.max_tokens = 3000;
  const post = (b) => axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    b,
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: timeoutFor(opts) },
  );
  let res = await post(body);
  const cut = (r) => r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].finish_reason === 'length';
  if (cut(res) && !(opts && opts.interactive === true)) res = await post(Object.assign({}, body, { max_tokens: 4096 }));
  if (cut(res)) throw new Error('Réponse Groq tronquée (finish_reason=length) : niveau suivant.');
  const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content
    : null;
  if (!text) throw new Error('Réponse Groq vide ou de forme inattendue.');
  return providerResult(text.trim(), normalizeOpenAiUsage(res.data && res.data.usage), (res.data && res.data.model) || body.model);
}

// FAMILLE GEMINI (clé GEMINI_API_KEY, API Google AI) — trois modèles internes, dans cet ordre :
//   1. Gemma 4 31B IT   : modèle PRINCIPAL de Cyrus (GEMINI_PRIMARY_MODEL) ;
//   2. Gemma 4 26B A4B  : autre modèle Gemma 4 compatible, secours interne (GEMINI_SECONDARY_MODEL) ;
//   3. Gemini Flash     : secours quand les modèles Gemma ne peuvent pas traiter la demande (GEMINI_FLASH_MODEL, alias
//                         « gemini-flash-latest »).
// Gemini PRO n'est JAMAIS utilisé automatiquement (GEMINI_PRO_MODEL n'est lu que si l'appelant passe meta.allowPro === true,
// ce que le code de Cyrus ne fait nulle part). Le reste de Cyrus ne connaît AUCUN de ces noms : il demande des capacités
// (texte, image, audio, vidéo, document, outils, tâche complexe), la sélection se fait ici.
// Les modèles Gemma 4 renvoient leur raisonnement interne dans des parties « thought » : jamais affichées à l'utilisateur.
// Capacités vérifiées en direct (2026-09-21) : Gemma 4 refuse l'audio (« Audio input modality is not enabled ») ; l'audio, la
// vidéo et les documents passent par Gemini Flash.
function geminiCall(modelEnv, defaultModel) {
  return async function call(prompt, history, context, mode, skillPromptBlock, opts) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const model = (opts && opts.allowPro === true && process.env.GEMINI_PRO_MODEL) ? process.env.GEMINI_PRO_MODEL : (process.env[modelEnv] || defaultModel);
    const contents = toChatMessages(prompt, history).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    // Médias joints au dernier message utilisateur (image, audio, vidéo, document) : envoyés en données intégrées.
    const media = (opts && Array.isArray(opts.media)) ? opts.media : [];
    for (const m of media) contents[contents.length - 1].parts.push({ inlineData: { mimeType: m.mimeType, data: m.data } });
    const body = { contents, systemInstruction: { parts: [{ text: buildSystemPrompt(context, mode, skillPromptBlock) }] } };
    if (opts && opts.jsonOutput) body.generationConfig = { responseMimeType: 'application/json' };
    // Recherche externe RÉELLE (outil de recherche du modèle) : uniquement demandée explicitement (meta.grounding) ; les sources effectivement
    // consultées sont renvoyées à l'appelant — sans source, aucune recherche n'est présentée comme effectuée.
    if (opts && opts.grounding) body.tools = [{ google_search: {} }];
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      body,
      { headers: { 'x-goog-api-key': apiKey }, timeout: timeoutFor(opts) },
    );
    const candidate = res.data && res.data.candidates && res.data.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const text = parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
    if (!text) throw Object.assign(new Error('Réponse Gemini vide ou de forme inattendue.'), { aiEmpty: true });
    if (opts && opts.grounding && Array.isArray(opts.sourcesOut)) {
      const chunks = (candidate && candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks) || [];
      for (const c of chunks) if (c && c.web && c.web.uri) opts.sourcesOut.push({ title: String(c.web.title || c.web.uri).slice(0, 160), uri: String(c.web.uri) });
    }
    return providerResult(text, normalizeGeminiUsage(res.data && res.data.usageMetadata), model);
  };
}
const callGeminiPrimary = geminiCall('GEMINI_PRIMARY_MODEL', 'gemma-4-31b-it');
const callGeminiSecondary = geminiCall('GEMINI_SECONDARY_MODEL', 'gemma-4-26b-a4b-it');
const callGeminiFlash = geminiCall('GEMINI_FLASH_MODEL', 'gemini-flash-latest');

// OpenRouter — API compatible OpenAI (même forme de requête/réponse que
// Groq/Hugging Face ci-dessous). Modèle par défaut avec suffixe ":free"
// (niveau gratuit OpenRouter, subventionné, quotas limités par jour/minute)
// — configurable via OPENROUTER_MODEL, ces slugs gratuits changeant
// régulièrement côté OpenRouter (voir openrouter.ai/models pour la liste à
// jour), sur le même principe que FAL_LTX_MODEL_ID/REPLICATE_LTX_MODEL dans
// lib/media/videoAiEngine.js. "meta-llama/llama-3.3-70b-instruct:free"
// (choix initial) a été retiré du palier gratuit par OpenRouter (constaté en
// direct : 404 "no longer available for free") — remplacé par
// "google/gemma-4-31b-it:free" (existence et routage confirmés en direct,
// sujet comme tout modèle gratuit partagé à des 429 occasionnels en cas de
// forte demande — la cascade passe alors simplement au niveau suivant).
async function callOpenRouter(prompt, history, context, mode, skillPromptBlock, opts) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  // La cascade automatique n'utilise que l'offre explicitement gratuite.
  // Un OPENROUTER_MODEL payant ne doit jamais être appelé comme secours.
  const configuredModel = String(process.env.OPENROUTER_MODEL || '').trim();
  const model = configuredModel.endsWith(':free') ? configuredModel : 'openrouter/free';
  const messages = [{ role: 'system', content: buildSystemPrompt(context, mode, skillPromptBlock) }, ...withImages(toChatMessages(prompt, history), opts)];
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    { model, messages },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: timeoutFor(opts) },
  );
  const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content
    : null;
  if (!text) throw new Error('Réponse OpenRouter vide ou de forme inattendue.');
  return providerResult(text.trim(), normalizeOpenAiUsage(res.data && res.data.usage), (res.data && res.data.model) || model);
}

// DeepSeek — API compatible OpenAI (même forme de requête/réponse que
// Groq/OpenRouter/Hugging Face ci-dessus). "deepseek-chat" est le modèle
// conversationnel standard du compte (palier gratuit avec quota journalier
// limité côté DeepSeek — un dépassement de quota renvoie un 429/402, la
// cascade passe alors simplement au niveau suivant comme n'importe quel
// autre fournisseur).
async function callDeepSeek(prompt, history, context, mode, skillPromptBlock, opts) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const messages = [{ role: 'system', content: buildSystemPrompt(context, mode, skillPromptBlock) }, ...toChatMessages(prompt, history)];
  const res = await axios.post(
    'https://api.deepseek.com/chat/completions',
    { model: (opts && opts.tier === 'reasoning') ? (process.env.DEEPSEEK_REASONING_MODEL || 'deepseek-reasoner') : (process.env.DEEPSEEK_MODEL || 'deepseek-chat'), messages },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: timeoutFor(opts) },
  );
  const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content
    : null;
  if (!text) throw new Error('Réponse DeepSeek vide ou de forme inattendue.');
  const model = (opts && opts.tier === 'reasoning') ? (process.env.DEEPSEEK_REASONING_MODEL || 'deepseek-reasoner') : (process.env.DEEPSEEK_MODEL || 'deepseek-chat');
  return providerResult(text.trim(), normalizeOpenAiUsage(res.data && res.data.usage), (res.data && res.data.model) || model);
}

async function callHuggingFace(prompt, history, context, mode, skillPromptBlock) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) return null;

  // Endpoint "router" compatible OpenAI de Hugging Face (même forme de
  // requête/réponse que Groq ci-dessus) — évite de gérer un format de
  // réponse distinct par modèle d'inférence.
  const messages = [{ role: 'system', content: buildSystemPrompt(context, mode, skillPromptBlock) }, ...toChatMessages(prompt, history)];
  const res = await axios.post(
    'https://router.huggingface.co/v1/chat/completions',
    { model: 'Qwen/Qwen2.5-72B-Instruct', messages },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: REQUEST_TIMEOUT_MS },
  );
  const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content
    : null;
  if (!text) throw new Error('Réponse Hugging Face vide ou de forme inattendue.');
  return providerResult(text.trim(), normalizeOpenAiUsage(res.data && res.data.usage), (res.data && res.data.model) || 'Qwen/Qwen2.5-72B-Instruct');
}

// Fallback ultime SANS clé API — endpoint public gratuit, garantit un
// retour texte dans 100% des cas (voir feuille de route). Le prompt est
// enrichi avec le court historique récent pour garder un minimum de
// contexte conversationnel malgré une API très simple (GET + texte brut,
// pas de vrai format de conversation).
async function callPollinations(prompt, history, context, mode, skillPromptBlock, opts) {
  const recent = (Array.isArray(history) ? history : []).slice(-6)
    .filter((t) => t && t.text)
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Utilisateur'}: ${t.text}`)
    .join('\n');
  const conversation = recent ? `${recent}\nUtilisateur: ${prompt}\nAssistant:` : `Utilisateur: ${prompt}\nAssistant:`;
  const enrichedPrompt = `${buildSystemPrompt(context, mode, skillPromptBlock)}\n\n${conversation}`;

  const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(enrichedPrompt)}`, {
    timeout: timeoutFor(opts),
    responseType: 'text',
    transformResponse: (data) => data,
  });
  const text = typeof res.data === 'string' ? res.data : '';
  if (!text.trim()) throw new Error('Réponse Pollinations vide.');
  return text.trim();
}

// Certains fournisseurs (Pollinations...) répondent HTTP 200 avec un message d'erreur en guise de texte :
// jamais à traiter comme une réponse valide.
const PROVIDER_ERROR_RE = /(doesn't have enough credits|does not have enough credits|top up|complete a quest|insufficient (?:credit|quota|balance)|rate.?limit|too many requests|quota (?:exceeded|exhausted)|invalid api key|unauthorized|authentication (?:failed|required)|model .{0,40}not found|service unavailable|internal server error)/i;
function looksLikeProviderError(text) {
  const t = String(text || '');
  return t.length < 600 && PROVIDER_ERROR_RE.test(t);
}

// Fournisseurs additionnels (couche AIProvider) : OpenAI et Mistral (API compatible chat/completions) et Claude
// (Anthropic Messages API). Chaque niveau est ignoré tant que sa clé n'est pas définie ; l'ordre de la cascade
// existante est inchangé (ces niveaux passent juste avant le repli public Pollinations).
function openAiCompatible(name, keyEnv, url, modelEnv, defaultModel, reasoningModelEnv, defaultReasoningModel) {
  return async function call(prompt, history, context, mode, skillPromptBlock, opts) {
    const apiKey = process.env[keyEnv];
    if (!apiKey) return null;
    const messages = [{ role: 'system', content: buildSystemPrompt(context, mode, skillPromptBlock) }, ...withImages(toChatMessages(prompt, history), opts)];
    const deep = !!(opts && opts.tier === 'reasoning');
    const model = deep ? (process.env[reasoningModelEnv] || defaultReasoningModel) : (process.env[modelEnv] || defaultModel);
    const res = await axios.post(url, { model, messages },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: timeoutFor(opts) });
    const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message ? res.data.choices[0].message.content : null;
    if (!text) throw new Error(`Réponse ${name} vide ou de forme inattendue.`);
    return providerResult(text.trim(), normalizeOpenAiUsage(res.data && res.data.usage), (res.data && res.data.model) || model);
  };
}
const callOpenAI = openAiCompatible('OpenAI', 'OPENAI_API_KEY', 'https://api.openai.com/v1/chat/completions', 'OPENAI_MODEL', 'gpt-4o-mini', 'OPENAI_REASONING_MODEL', 'gpt-4o');
const callMistral = openAiCompatible('Mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1/chat/completions', 'MISTRAL_MODEL', 'mistral-small-latest', 'MISTRAL_REASONING_MODEL', 'mistral-large-latest');

async function callClaude(prompt, history, context, mode, skillPromptBlock, opts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const msgs = toChatMessages(prompt, history).filter((m) => m.role === 'user' || m.role === 'assistant');
  const media = ((opts && opts.media) || []).filter((m) => m.mimeType.startsWith('image/') || m.mimeType === 'application/pdf');
  if (media.length) {
    const last = msgs[msgs.length - 1];
    msgs[msgs.length - 1] = { role: last.role, content: media.map((m) => ({ type: m.mimeType === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: m.mimeType, data: m.data } })).concat([{ type: 'text', text: last.content }]) };
  }
  const system = buildSystemPrompt(context, mode, skillPromptBlock);
  const body = {
    // La clé Anthropic du compte n'appelle QUE Haiku 4.5, quel que soit le
    // niveau de tâche. Aucun modèle Sonnet/Opus n'est sélectionné ici.
    model: 'claude-haiku-4-5-20251001', max_tokens: (opts && opts.tier === 'reasoning') ? 4096 : 1024, system, messages: msgs,
  };
  // Cache Anthropic officiel (5 min) uniquement pour un historique texte
  // stable et suffisamment long pour Haiku 4.5 (seuil fournisseur: 4 096
  // tokens). Les appels courts, multimodaux ou à contexte variable gardent
  // exactement le comportement actuel. L'API renvoie les vrais cache hits.
  const estimatedPrefixBytes = Buffer.byteLength(JSON.stringify({ system, messages: msgs }), 'utf8');
  const cacheEligible = !context && !mode && !skillPromptBlock && !media.length
    && Array.isArray(history) && history.length >= 2 && estimatedPrefixBytes >= 16384;
  if (cacheEligible && opts && opts.cacheScope) {
    // Anthropic's cache matches exact prompt prefixes at workspace scope.
    // A server-derived opaque partition keeps each tenant/conversation on
    // its own prefix without placing the raw account/session ID in the prompt.
    const partition = crypto.createHash('sha256').update(String(opts.cacheScope)).digest('hex').slice(0, 24);
    body.system = `${system}\n\nPartition de cache interne (opaque, ne pas citer) : ${partition}`;
    body.cache_control = { type: 'ephemeral' };
  }
  const res = await axios.post('https://api.anthropic.com/v1/messages', body,
    { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, timeout: timeoutFor(opts) });
  const text = res.data && res.data.content && res.data.content[0] && res.data.content[0].text;
  if (!text) throw new Error('Réponse Claude vide ou de forme inattendue.');
  const rawUsage = res.data && res.data.usage;
  const usage = rawUsage && Number.isFinite(Number(rawUsage.input_tokens))
    ? {
      promptTokens: Number(rawUsage.input_tokens) + Number(rawUsage.cache_creation_input_tokens || 0) + Number(rawUsage.cache_read_input_tokens || 0),
      completionTokens: Number(rawUsage.output_tokens || 0),
      cacheReadTokens: Number(rawUsage.cache_read_input_tokens || 0),
      cacheWriteTokens: Number(rawUsage.cache_creation_input_tokens || 0),
      uncachedPromptTokens: Number(rawUsage.input_tokens || 0),
    }
    : null;
  return providerResult(text.trim(), usage, (res.data && res.data.model) || body.model);
}

// ---------------------------------------------------------------------------
// ROUTAGE PAR CAPACITÉS (AI Gateway). Le Chat intelligent ne dépend JAMAIS du nom d'un modèle ou d'un fournisseur : il
// demande une prestation (texte, image, audio, vidéo, document, outils, tâche complexe) et la sélection se fait ici.
// Chaque entrée déclare ce qu'elle sait réellement traiter ; un modèle incapable de traiter le type de contenu demandé
// n'est JAMAIS choisi (ni appelé « pour voir »). Capacités des modèles Gemini/Gemma vérifiées en direct (2026-09-21).
const CAPS = { TEXT: 'text', IMAGE: 'image', AUDIO: 'audio', VIDEO: 'video', DOCUMENT: 'document', TOOLS: 'tools', COMPLEX: 'complex' };
const PROVIDERS = [
  { name: 'claude', keyEnv: 'ANTHROPIC_API_KEY', caps: ['text', 'image', 'document', 'tools', 'complex'], call: callClaude },
  { name: 'gemini-primary', keyEnv: 'GEMINI_API_KEY', caps: ['text', 'image', 'tools', 'complex'], call: callGeminiPrimary },
  { name: 'gemini-secondary', keyEnv: 'GEMINI_API_KEY', caps: ['text', 'image', 'tools', 'complex'], call: callGeminiSecondary },
  { name: 'gemini-flash', keyEnv: 'GEMINI_API_KEY', caps: ['text', 'image', 'audio', 'video', 'document', 'tools', 'complex', 'search'], call: callGeminiFlash },
  { name: 'groq', keyEnv: 'GROQ_API_KEY', caps: ['text', 'tools', 'complex'], call: callGroq },
  { name: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', caps: ['text', 'image', 'tools'], call: callOpenRouter },
  { name: 'pollinations', keyEnv: null, caps: ['text'], call: callPollinations },
];

// Claude Haiku 4.5 est essayé en premier dans les deux niveaux et n'appelle
// aucun autre modèle Claude. Les replis commencent seulement après l'échec
// ou le timeout de Claude.
const byName = (n) => PROVIDERS.find((p) => p.name === n);
const STANDARD_ORDER = ['claude', 'gemini-primary', 'gemini-secondary', 'gemini-flash', 'groq', 'openrouter', 'pollinations'];
const REASONING_ORDER = ['claude', 'gemini-primary', 'gemini-secondary', 'gemini-flash', 'groq', 'openrouter', 'pollinations'];
function providersForTier(tier) {
  return (tier === 'reasoning' ? REASONING_ORDER : STANDARD_ORDER).map(byName).filter(Boolean);
}

// Capacités requises par une demande : le texte est toujours requis ; chaque média joint impose sa modalité ; l'appelant peut
// exiger explicitement d'autres capacités (meta.needs, ex. ['tools']).
function kindOfMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}
function normalizeMedia(list) {
  return (Array.isArray(list) ? list : []).filter((m) => m && m.data).map((m) => {
    const mimeType = String(m.mimeType || m.mimetype || 'application/octet-stream').toLowerCase().split(';')[0].trim();
    return { mimeType, kind: kindOfMime(mimeType), data: Buffer.isBuffer(m.data) ? m.data.toString('base64') : String(m.data) };
  });
}
const MAX_INLINE_MEDIA_BYTES = 18 * 1024 * 1024; // limite « données intégrées » des API multimodales
function requiredCapabilities(meta, media) {
  const need = new Set(['text']);
  (media || []).forEach((m) => need.add(m.kind));
  ((meta && meta.needs) || []).forEach((c) => need.add(c));
  if (meta && meta.grounding) need.add('search');
  return need;
}
function canHandle(provider, need) {
  return [...need].every((c) => provider.caps.includes(c));
}

// État des connexions IA (noms uniquement, jamais de clé) : qui est configuré, dans quel ordre pour chaque niveau.
const isConfigured = (p) => p.keyEnv === null || !!process.env[p.keyEnv];
function getProviderStatus() {
  const list = (tier) => providersForTier(tier).filter(isConfigured).map((p) => p.name);
  return {
    standard: list('standard'), reasoning: list('reasoning'),
    missingStrongModels: ['claude'].filter((n) => !isConfigured(byName(n))),
    capabilities: Object.fromEntries(PROVIDERS.filter(isConfigured).map((p) => [p.name, p.caps])),
  };
}

// Retry/backoff UNIQUEMENT pour les erreurs récupérables (surcharge, 5xx, limite de débit passagère, coupure réseau) :
// une seule nouvelle tentative brève. Erreur définitive (clé, quota, modèle absent, modalité refusée, requête invalide) ou
// timeout : aucune boucle, on passe tout de suite au suivant.
const MAX_RETRIES = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function backoffMs(attempt, classified) {
  const base = process.env.AI_RETRY_BASE_MS != null ? Number(process.env.AI_RETRY_BASE_MS) : 400;
  if (!(base > 0)) return 0;
  if (classified && classified.retryAfterMs) return Math.min(3000, classified.retryAfterMs);
  return Math.min(2000, base * (2 ** attempt)) + Math.floor(Math.random() * 150);
}
async function callWithRetry(provider, args) {
  const opts = Array.isArray(args) ? args[5] : null;
  const retryLimit = opts && opts.interactive === true ? 0 : MAX_RETRIES;
  for (let attempt = 0; ; attempt += 1) {
    try { return await provider.call(...args); }
    catch (err) {
      const c = aiErrors.classifyError(err);
      if (!c.retryable || attempt >= retryLimit) throw err;
      const wait = backoffMs(attempt, c);
      if (wait > 0) await sleep(wait);
    }
  }
}

// Disjoncteur par modèle : un modèle qui échoue coup sur coup (surcharge, timeouts) est mis de côté quelques instants pour ne
// pas faire attendre chaque message ; une erreur de configuration (clé, quota, modèle absent) le met de côté plus longtemps.
// Si TOUS les candidats sont écartés, on les essaie quand même (jamais un refus sans avoir essayé).
let searchBlockedUntil = 0;
const SEARCH_BLOCK_MS = 30 * 60 * 1000;
const health = new Map();
const COOLDOWN_SOFT_MS = 60 * 1000;
const COOLDOWN_HARD_MS = 5 * 60 * 1000;
const isCoolingDown = (name) => { const h = health.get(name); return !!h && h.until > Date.now(); };
function noteFailure(name, kind) {
  if (kind === 'unsupported_modality' || kind === 'bad_request' || kind === 'empty') return; // n'indique pas une panne du modèle
  const h = health.get(name) || { fails: 0, until: 0 };
  h.fails += 1;
  if (kind === 'auth' || kind === 'quota' || kind === 'not_found') h.until = Date.now() + COOLDOWN_HARD_MS;
  else if (h.fails >= 2) h.until = Date.now() + COOLDOWN_SOFT_MS;
  health.set(name, h);
}
const noteSuccess = (name) => health.delete(name);

// Journal INTERNE des derniers échecs (déjà redacté) : jamais renvoyé à un utilisateur.
const recentFailures = [];
function logInternalFailure(line) {
  recentFailures.push({ at: new Date().toISOString(), line });
  if (recentFailures.length > 50) recentFailures.shift();
  console.warn(`LLM Gateway — ${line}`);
}

// Parcourt la chaîne configurée ET capable, avec retry ciblé. Une clé absente saute silencieusement le niveau. Seul l'échec de
// TOUS les candidats lève une erreur — et cette erreur ne porte que le message générique pour l'utilisateur
// (AiUnavailableError) ; les détails, redactés, restent dans les logs internes.
// meta : { tier, maxTokens, taskId, purpose, tenant, media: [{mimeType, data}], needs: [...], jsonOutput, allowPro }
async function generateAIResponse(prompt, history, context, mode, explicitSkillKeys, meta) {
  const generationStartedAt = performance.now();
  const tier = (meta && meta.tier) || 'standard';
  const interactive = !!(meta && meta.interactive === true);
  const configuredInteractiveBudgetMs = interactive ? interactiveBudgetFor(meta) : null;
  const requestedInteractiveBudgetMs = Number(meta && meta.interactiveBudgetMs);
  const effectiveInteractiveBudgetMs = interactive
    ? (Number.isFinite(requestedInteractiveBudgetMs) && requestedInteractiveBudgetMs > 0
      ? Math.max(1, Math.min(configuredInteractiveBudgetMs, Math.floor(requestedInteractiveBudgetMs)))
      : configuredInteractiveBudgetMs)
    : null;
  const interactiveDeadline = interactive ? generationStartedAt + effectiveInteractiveBudgetMs : null;
  const interactiveProviderTimeoutMs = interactive ? Math.max(1, Math.min(interactiveProviderTimeoutFor(meta), Number(meta.interactiveProviderTimeoutMs) || interactiveProviderTimeoutFor(meta))) : null;
  const media = normalizeMedia(meta && meta.media);
  const providerOpts = { maxTokens: (meta && meta.maxTokens) || null, tier, media, interactive, timeoutMs: null, jsonOutput: !!(meta && meta.jsonOutput), allowPro: !!(meta && meta.allowPro === true), grounding: !!(meta && meta.grounding), tenant: meta && meta.tenant || null, cacheScope: meta && meta.cacheScope || null, sourcesOut: [] };
  let skillPromptBlock = '';
  if (explicitSkillKeys) {
    skillPromptBlock = skillsRegistry.buildSkillPromptBlock(explicitSkillKeys);
  } else {
    const skillKey = marketingSkills.detectSkill(prompt);
    skillPromptBlock = skillKey ? marketingSkills.buildSkillPromptBlock(skillKey) : '';
  }

  // Protection anti-boucle / anti-coût (§29) : si l'appel est rattaché à une tâche (meta.taskId), on refuse au-delà du
  // plafond d'appels IA par tâche. Déterministe, avant tout appel réseau. Lève AI_LOOP_LIMIT (l'appelant gère).
  if (meta && meta.taskId) {
    require('../../ai-engine/loopGuard').countAiCall(meta.taskId);
  }

  // Limite de consommation par CLIENT (10 échanges/heure) : appliquée ICI, au point de passage unique, pour tout appel rattaché à un
  // client (contexte posé par ai-engine/clientLimitGuard.js). Sans contexte (propriétaire, Chat intelligent, tâches internes) : illimité.
  await require('../../ai-engine/clientAiQuota').enforceForCurrent();

  if (media.reduce((n, m) => n + Math.ceil(m.data.length * 0.75), 0) > MAX_INLINE_MEDIA_BYTES) {
    throw new aiErrors.AiUnavailableError('média trop volumineux pour un envoi direct', 'MEDIA_TOO_LARGE');
  }

  const need = requiredCapabilities(meta, media);
  const candidates = providersForTier(tier).filter((p) => isConfigured(p) && canHandle(p, need));
  if (!candidates.length) {
    const e = new aiErrors.AiUnavailableError(`aucun modèle configuré ne sait traiter : ${[...need].join('+')}`, 'NO_CAPABLE_MODEL');
    logInternalFailure(e.internalDetail);
    throw e;
  }
  const healthy = candidates.filter((p) => !isCoolingDown(p.name));
  const chain = healthy.length ? healthy : candidates;

  const errors = [];
  const providerChainStartedAt = performance.now();
  // Un essai = un appel à UN fournisseur (avec son retry ciblé) ; rend { text, provider } ou null (clé absente), lève en cas d'échec.
  const attempt = async (provider) => {
    if (interactiveDeadline) {
      const remaining = Math.ceil(interactiveDeadline - performance.now());
      if (remaining <= 0) throw Object.assign(new Error('Interactive AI budget exhausted'), { code: 'AI_INTERACTIVE_BUDGET' });
      providerOpts.timeoutMs = Math.max(1, Math.min(interactiveProviderTimeoutMs, remaining));
    }
    const providerStartedAt = performance.now();
    try {
      const raw = await callWithRetry(provider, [prompt, history, context, mode, skillPromptBlock, providerOpts]);
      if (raw === null) return null; // clé API absente : niveau sauté intelligemment
      const result = raw && raw.__cyrusAiResult ? raw : { text: raw, usage: null, model: null };
      const text = result.text;
      if (looksLikeProviderError(text)) throw new Error('réponse assimilable à une erreur du fournisseur');
      return { text, provider, usage: result.usage, model: result.model, providerLatencyMs: Math.max(0, Math.round(performance.now() - providerStartedAt)) };
    } catch (err) {
      if (err && typeof err === 'object') err.providerLatencyMs = Math.max(0, Math.round(performance.now() - providerStartedAt));
      throw err;
    }
  };
  const onSuccess = ({ text, provider, usage, model, providerLatencyMs }) => {
    noteSuccess(provider.name);
    const gatewayLatencyMs = Math.max(0, Math.round(performance.now() - generationStartedAt));
    const providerChainLatencyMs = Math.max(0, Math.round(performance.now() - providerChainStartedAt));
    // AI Cost Guard (RÈGLE N°2) — point de passage UNIQUE de tous les appels IA : usage réel enregistré, 100 %
    // déterministe et NON bloquant.
    try {
      const m = meta || {};
      const historyChars = Array.isArray(history) ? JSON.stringify(history).length : 0;
      require('../../ai-engine/aiUsageLedger').record({
        provider: provider.name,
        model,
        promptChars: String(prompt || '').length + historyChars + (skillPromptBlock ? skillPromptBlock.length : 0),
        responseChars: String(text || '').length,
        usage,
        providerLatencyMs,
        gatewayLatencyMs,
        providerChainLatencyMs,
        purpose: (m.purpose || (mode ? String(mode) : 'conversation')) + (tier === 'reasoning' ? ':reasoning' : ''),
        tenant: m.tenant || null,
      });
    } catch (e) { /* jamais bloquant */ }
    return {
      text,
      provider: provider.name,
      sources: providerOpts.grounding ? providerOpts.sourcesOut.slice() : [],
      timings: { gatewayMs: gatewayLatencyMs, providerChainMs: providerChainLatencyMs, providerMs: providerLatencyMs },
    };
  };
  const onFailure = (provider, err) => {
    const c = aiErrors.classifyError(err);
    // Une recherche externe refusée (quota, facturation, outil non disponible) n'est PAS une panne du modèle : elle ne le met pas en cooldown pour
    // ses autres usages (audio, vidéo, documents…) ; la recherche seule est suspendue un moment (jamais relancée à chaque message).
    if (providerOpts.grounding && ['quota', 'auth', 'bad_request', 'not_found', 'unsupported_modality'].includes(c.kind)) { searchBlockedUntil = Date.now() + SEARCH_BLOCK_MS; noteFailure(provider.name, 'bad_request'); }
    else noteFailure(provider.name, c.kind);
    const line = aiErrors.describeForLog(provider.name, err);
    errors.push(line);
    logInternalFailure(`échec ${line} — passage au suivant`);
  };

  // RÉPONSE SPONTANÉE : pour un texte interactif (sans média ni recherche ; délai plus long au niveau « raisonnement »), si le fournisseur en cours n'a pas répondu au bout de HEDGE_MS,
  // le suivant de la chaîne est lancé EN PARALLÈLE (le premier qui répond gagne, l'ordre de priorité reste celui de la chaîne). Un modèle lent ou
  // surchargé ne retarde donc plus la réponse de plusieurs délais d'attente successifs. Désactivable : meta.hedge === false ou AI_HEDGE_MS=0.
  const envMs = (name, dflt) => (process.env[name] !== undefined && process.env[name] !== '' ? Math.max(0, Number(process.env[name]) || 0) : dflt);
  // Quand Haiku est disponible, il reste strictement seul jusqu'à son succès
  // ou son échec/timeout. Les replis ne démarrent qu'ensuite (pas de double
  // appel payant causé par le hedge générique).
  const hedgeMs = (meta && meta.hedge === false) || media.length || providerOpts.grounding || chain[0].name === 'claude'
    ? 0
    : (interactive ? envMs('AI_INTERACTIVE_HEDGE_MS', 1000) : (tier === 'standard' ? envMs('AI_HEDGE_MS', 3500) : envMs('AI_HEDGE_REASONING_MS', 7000)));
  if (!hedgeMs) {
    for (const provider of chain) {
      try { const r = await attempt(provider); if (r) return onSuccess(r); } catch (err) { onFailure(provider, err); }
    }
  } else {
    let next = 0; const inflight = new Map(); let winner = null;
    const launch = () => {
      const provider = chain[next++];
      const pr = attempt(provider).then((r) => ({ id: provider.name, r }), (err) => ({ id: provider.name, err, provider }));
      inflight.set(provider.name, pr);
    };
    launch();
    while (inflight.size && !winner) {
      let timer; const hedge = next < chain.length ? new Promise((res) => { timer = setTimeout(() => res({ hedge: true }), hedgeMs); }) : null;
      const settled = await Promise.race([...inflight.values(), ...(hedge ? [hedge] : [])]);
      if (timer) clearTimeout(timer);
      if (settled.hedge) { launch(); continue; }
      inflight.delete(settled.id);
      if (settled.err) { onFailure(settled.provider, settled.err); if (!inflight.size && next < chain.length) launch(); }
      else if (settled.r) winner = settled.r;
      else if (!inflight.size && next < chain.length) launch(); // clé absente : on passe au suivant
    }
    // Les appels encore en vol ne bloquent plus personne ; leurs erreurs éventuelles sont absorbées.
    for (const pr of inflight.values()) pr.catch(() => {});
    if (winner) return onSuccess(winner);
  }
  const final = new aiErrors.AiUnavailableError(errors.join(' | ') || 'aucune clé API configurée', errors.length ? 'ALL_FAILED' : 'NOT_CONFIGURED');
  console.error(`LLM Gateway — tous les modèles ont échoué : ${final.internalDetail}`);
  throw final;
}

module.exports = {
  looksLikeProviderError,
  generateAIResponse,
  getProviderStatus,
  providersForTier,
  CAPS,
  requiredCapabilities,
  // La recherche externe est-elle réellement utilisable maintenant ? (fournisseur configuré ET non suspendu après un refus de quota)
  isSearchAvailable: () => Date.now() > searchBlockedUntil && providersForTier('standard').some((p) => isConfigured(p) && p.caps.includes('search')),
  getRecentFailures: () => recentFailures.slice(),
  _resetHealth: () => { health.clear(); recentFailures.length = 0; searchBlockedUntil = 0; },
};
