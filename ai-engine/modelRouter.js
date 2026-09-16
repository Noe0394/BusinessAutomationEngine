// MODEL ROUTER — ai-engine/modelRouter.js
// ---------------------------------------------------------------------------
// Routage IA par complexité (§6) : choisit, de façon 100 % DÉTERMINISTE (aucun
// appel IA), le "gabarit" d'appel adapté au message — pour dépenser le minimum
// de tokens sur les messages simples sans robotiser la conversation.
//
// Ne CHANGE pas le fournisseur (la cascade llmFallbackEngine reste « le moins
// cher d'abord » : groq → … → pollinations gratuit). Le routeur agit sur les
// deux vrais leviers de coût que l'on contrôle : la TAILLE DU CONTEXTE envoyé
// (nombre de messages d'historique) et le PLAFOND DE TOKENS DE SORTIE.
//
// Renvoie : { tier, maxContextMessages, maxTokens }.

const GREETING_RE = /^\s*(bonjour|bonsoir|salut|coucou|hello|hi|hey|cc|slt|yo|wesh|merci|thanks|ok|d'accord|dac|👍|🙏|bonne\s+journ[ée]e|bonne\s+soir[ée]e|[àa]\s+bient[ôo]t|au revoir)\b[\s!.…]*$/i;
// Signaux de complexité : plusieurs questions, comparaison, raisonnement,
// négociation, explication détaillée, énumération.
const COMPLEX_RE = /(pourquoi|comment\s+(?:ça|ca)\s+marche|expliqu|d[ée]taill|compar|diff[ée]rence|strat[ée]gie|n[ée]goci|plusieurs|list[ée]?|étape|analyse|budget|devis|combien.*(?:et|puis|ensuite)|\?.*\?)/i;

function classify(text, history) {
  const t = String(text || '').trim();
  const len = t.length;
  const questions = (t.match(/\?/g) || []).length;
  const histLen = Array.isArray(history) ? history.length : 0;

  // SIMPLE : salutation/remerciement seul, ou message très court sans question.
  if (GREETING_RE.test(t) || (len <= 40 && questions === 0)) {
    return { tier: 'simple', maxContextMessages: Math.min(6, histLen || 6), maxTokens: 220 };
  }
  // COMPLEXE : long, plusieurs questions, ou signaux de raisonnement.
  if (len > 220 || questions >= 2 || COMPLEX_RE.test(t)) {
    return { tier: 'complex', maxContextMessages: 16, maxTokens: 1024 };
  }
  // NORMAL : le cas courant.
  return { tier: 'normal', maxContextMessages: 10, maxTokens: 512 };
}

module.exports = { classify, GREETING_RE, COMPLEX_RE };
