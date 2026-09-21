// AI USAGE LEDGER — ai-engine/aiUsageLedger.js
// ---------------------------------------------------------------------------
// Mesure RÉELLE de la consommation IA (RÈGLE N°2 : optimisation des coûts —
// « on ne peut optimiser que ce qu'on mesure »). Enregistre CHAQUE appel IA qui
// passe par le point de passage unique lib/ai/llmFallbackEngine.js :
// fournisseur, modèle, tokens (estimés), coût (estimé), but (purpose), tenant.
//
// 100 % DÉTERMINISTE : ce module ne fait AUCUN appel IA (c'est du comptage,
// interdit d'utiliser l'IA pour du monitoring — §0.1 catégorie A). Non bloquant :
// une erreur d'enregistrement ne casse jamais la réponse IA de l'appelant.
//
// Agrégat en mémoire (source de vérité pendant la vie du process) + persistance
// par jour (storageAdapter, namespace 'ai_usage', docId = 'YYYY-MM-DD') pour
// survivre à un redémarrage. Pas un document par appel (éviterait de scaler) :
// on incrémente des compteurs par purpose / provider / tenant.

const storageAdapter = require('./storageAdapter');

const NAMESPACE = 'ai_usage';

// Coûts ESTIMÉS (USD) par million de tokens, mélange entrée/sortie — valeurs
// approximatives de tarif public, pour visualiser « où part le budget », PAS une
// facturation exacte. Les fournisseurs gratuits sont à 0.
const COST_PER_MTOK = {
  groq: 0.30,
  gemini: 0.20,
  'gemini-primary': 0.20,
  'gemini-secondary': 0.10,
  'gemini-flash': 0.20,
  deepseek: 0.28,
  openrouter: 0.0, // modèles :free utilisés
  huggingface: 0.0,
  pollinations: 0.0,
  unknown: 0.0,
};
const MODEL_BY_PROVIDER = {
  groq: 'openai/gpt-oss-120b',
  gemini: process.env.GEMINI_MODEL || 'gemini-flash',
  'gemini-primary': process.env.GEMINI_PRIMARY_MODEL || 'gemma-4-31b-it',
  'gemini-secondary': process.env.GEMINI_SECONDARY_MODEL || 'gemma-4-26b-a4b-it',
  'gemini-flash': process.env.GEMINI_FLASH_MODEL || 'gemini-flash-latest',
  deepseek: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  openrouter: 'google/gemma:free',
  huggingface: 'Qwen2.5-72B-Instruct',
  pollinations: 'pollinations',
};

function today() { return new Date().toISOString().slice(0, 10); }
function estimateTokens(chars) { return Math.max(1, Math.ceil((Number(chars) || 0) / 4)); }
function estimateCost(provider, tokens) {
  const rate = COST_PER_MTOK[provider] != null ? COST_PER_MTOK[provider] : 0;
  return (tokens / 1e6) * rate;
}

// Agrégat courant (mémoire). Rechargé depuis le disque au premier accès du jour.
let current = null; // { date, totals:{calls,tokens,cost}, byPurpose, byProvider, byTenant, recent[] }

async function ensureLoaded() {
  const d = today();
  if (current && current.date === d) return current;
  const fresh = { date: d, totals: { calls: 0, tokens: 0, cost: 0 }, byPurpose: {}, byProvider: {}, byTenant: {}, recent: [] };
  try {
    const doc = await storageAdapter.get(NAMESPACE, d, null);
    current = (doc && doc.date === d) ? Object.assign(fresh, doc) : fresh;
  } catch (e) { current = fresh; }
  return current;
}

function bump(map, key, tokens, cost) {
  const k = key || 'unknown';
  if (!map[k]) map[k] = { calls: 0, tokens: 0, cost: 0 };
  map[k].calls += 1; map[k].tokens += tokens; map[k].cost += cost;
}

// Enregistre un appel IA réellement effectué. Non bloquant : à envelopper par
// l'appelant dans un contexte où une exception est ignorée (déjà le cas ici).
async function record({ provider, model, promptChars, responseChars, purpose, tenant }) {
  try {
    const agg = await ensureLoaded();
    const prov = provider || 'unknown';
    const tokens = estimateTokens(promptChars) + estimateTokens(responseChars);
    const cost = estimateCost(prov, tokens);
    agg.totals.calls += 1; agg.totals.tokens += tokens; agg.totals.cost += cost;
    bump(agg.byPurpose, purpose || 'unknown', tokens, cost);
    bump(agg.byProvider, prov, tokens, cost);
    bump(agg.byTenant, tenant || 'unknown', tokens, cost);
    agg.recent.unshift({
      ts: new Date().toISOString(), provider: prov,
      model: model || MODEL_BY_PROVIDER[prov] || prov,
      tokens, cost: Number(cost.toFixed(6)), purpose: purpose || 'unknown', tenant: tenant || null,
    });
    if (agg.recent.length > 100) agg.recent.length = 100;
    storageAdapter.set(NAMESPACE, agg.date, agg); // persistance (miroir GitHub fire-and-forget)
    return { tokens, cost };
  } catch (e) {
    return null; // jamais bloquant
  }
}

async function summary(dateStr) {
  const d = dateStr || today();
  if (current && current.date === d) return current;
  try { return await storageAdapter.get(NAMESPACE, d, { date: d, totals: { calls: 0, tokens: 0, cost: 0 }, byPurpose: {}, byProvider: {}, byTenant: {}, recent: [] }); }
  catch (e) { return { date: d, totals: { calls: 0, tokens: 0, cost: 0 }, byPurpose: {}, byProvider: {}, byTenant: {}, recent: [] }; }
}

module.exports = { record, summary, MODEL_BY_PROVIDER, COST_PER_MTOK, NAMESPACE };
