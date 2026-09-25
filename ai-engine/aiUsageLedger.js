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
  claude: 3.0, // estimation blend only; exact Haiku 4.5 cost uses provider usage below
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
  claude: 'claude-haiku-4-5-20251001',
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

const CLAUDE_HAIKU_45_RATES = { input: 1.0, output: 5.0, cacheWrite5m: 1.25, cacheRead: 0.10 };

function emptyStats() {
  return {
    calls: 0, tokens: 0, cost: 0, estimatedTokens: 0, measuredTokens: 0,
    estimatedCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, cacheHits: 0,
  };
}

function normalizeStats(stats) {
  if (!stats || typeof stats !== 'object') return emptyStats();
  const legacyTokens = Number(stats.tokens) || 0;
  const legacyCalls = Number(stats.calls) || 0;
  if (stats.estimatedTokens == null && stats.measuredTokens == null) {
    stats.estimatedTokens = legacyTokens;
    stats.measuredTokens = 0;
  }
  if (stats.estimatedTokens == null) stats.estimatedTokens = 0;
  if (stats.measuredTokens == null) stats.measuredTokens = 0;
  if (stats.measuredCalls == null) stats.measuredCalls = 0;
  if (stats.estimatedCalls == null) stats.estimatedCalls = Math.max(0, legacyCalls - stats.measuredCalls);
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheHits']) {
    if (stats[key] == null) stats[key] = 0;
  }
  return stats;
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
  current.totals = normalizeStats(current.totals);
  for (const section of ['byPurpose', 'byProvider', 'byTenant']) {
    for (const key of Object.keys(current[section] || {})) current[section][key] = normalizeStats(current[section][key]);
  }
  return current;
}

function bump(map, key, delta) {
  const k = key || 'unknown';
  map[k] = normalizeStats(map[k] || emptyStats());
  for (const field of Object.keys(delta)) map[k][field] = (Number(map[k][field]) || 0) + delta[field];
}

// Enregistre un appel IA réellement effectué. Non bloquant : à envelopper par
// l'appelant dans un contexte où une exception est ignorée (déjà le cas ici).
async function record({ provider, model, promptChars, responseChars, purpose, tenant, usage }) {
  try {
    const agg = await ensureLoaded();
    const prov = provider || 'unknown';
    const measured = usage && Number.isFinite(Number(usage.promptTokens)) && Number.isFinite(Number(usage.completionTokens));
    const promptTokens = measured ? Math.max(0, Number(usage.promptTokens)) : estimateTokens(promptChars);
    const outputTokens = measured ? Math.max(0, Number(usage.completionTokens)) : estimateTokens(responseChars);
    const tokens = promptTokens + outputTokens;
    const cacheReadTokens = measured ? Math.max(0, Number(usage.cacheReadTokens) || 0) : 0;
    const cacheWriteTokens = measured ? Math.max(0, Number(usage.cacheWriteTokens) || 0) : 0;
    const uncachedPromptTokens = measured && Number.isFinite(Number(usage.uncachedPromptTokens))
      ? Math.max(0, Number(usage.uncachedPromptTokens)) : Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
    const cost = measured && prov === 'claude'
      ? (uncachedPromptTokens * CLAUDE_HAIKU_45_RATES.input
        + cacheWriteTokens * CLAUDE_HAIKU_45_RATES.cacheWrite5m
        + cacheReadTokens * CLAUDE_HAIKU_45_RATES.cacheRead
        + outputTokens * CLAUDE_HAIKU_45_RATES.output) / 1e6
      : estimateCost(prov, tokens);
    const delta = {
      calls: 1, tokens, cost,
      estimatedTokens: measured ? 0 : tokens,
      measuredTokens: measured ? tokens : 0,
      estimatedCalls: measured ? 0 : 1,
      measuredCalls: measured ? 1 : 0,
      inputTokens: measured ? promptTokens : 0,
      outputTokens: measured ? outputTokens : 0,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHits: cacheReadTokens > 0 ? 1 : 0,
    };
    for (const field of Object.keys(delta)) agg.totals[field] = (Number(agg.totals[field]) || 0) + delta[field];
    bump(agg.byPurpose, purpose || 'unknown', delta);
    bump(agg.byProvider, prov, delta);
    bump(agg.byTenant, tenant || 'unknown', delta);
    agg.recent.unshift({
      ts: new Date().toISOString(), provider: prov,
      model: model || MODEL_BY_PROVIDER[prov] || prov,
      tokens, cost: Number(cost.toFixed(6)), purpose: purpose || 'unknown', tenant: tenant || null,
      tokenSource: measured ? 'provider' : 'estimated',
      inputTokens: measured ? promptTokens : null, outputTokens: measured ? outputTokens : null,
      estimatedTokens: measured ? 0 : tokens,
      cacheReadTokens, cacheWriteTokens,
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
