const aiGateway = require('../aiGateway');

// ADAPTATEUR local-client de lib/ai/llmFallbackEngine.js (VPS) — MÊME
// signature exportée (`generateAIResponse(prompt, history, context, mode,
// explicitSkillKeys)` -> `{text, provider}`) pour que les fichiers
// `ai-engine/*.js` copiés depuis le VPS fonctionnent ICI SANS AUCUNE
// MODIFICATION (seul ce fichier et ai-engine/storageAdapter.js/
// platformOrchestrator.js sont réellement adaptés par cible — voir
// docs/PARITE-LOCAL.md).
//
// Ne réimplémente AUCUNE cascade de fournisseurs ici : délègue entièrement
// à lib/aiGateway.js, déjà en place (Firebase en priorité, VPS en repli —
// voir son commentaire d'en-tête). `context` (source factuelle CYRUS) est
// ignoré ici — aiGateway.generateText() ne l'accepte pas, et local-client
// n'a pas d'équivalent du moteur local lib/ai/localCopywriterEngine.js du
// VPS dont ce paramètre provient normalement.
async function generateAIResponse(prompt, history, context, mode, explicitSkillKeys) {
  const skillKey = Array.isArray(explicitSkillKeys) ? explicitSkillKeys[0] : explicitSkillKeys;
  const data = await aiGateway.generateText(prompt, { history, mode, skillKey });
  return { text: data.text, provider: data.provider || 'aiGateway' };
}

module.exports = { generateAIResponse };
