// MESSAGE TRIAGE — isolation automatique privé/pro (dual-env : Node + navigateur)
// -------------------------------------------------------------------------------
// §3 du cahier des charges "Chat-Driven Agent Orchestrator" : filtre en
// arrière-plan les discussions WhatsApp/Telegram ENTRANTES (pas le tchat
// admin — voir ai-engine/chatOrchestrator.js pour ça) pour séparer la vie
// privée (ignorée, jamais de réponse automatique) des opportunités
// commerciales. Heuristique lexicale FR, même style que
// lib/intelligence/human-context-engine.js (LEX_BUY_INTENT etc.) — zéro
// appel réseau, volontairement PRUDENT : en cas de doute, classe en
// 'personal' plutôt que de risquer une réponse automatique à un message
// privé (une opportunité business ambiguë ratée est un moindre mal qu'un
// message privé traité comme un client).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MessageTriage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BUSINESS_RE = /(prix|tarif|combien\s+(?:ça|ca)?\s*co[uû]te|co[uû]te|achat|acheter|command|paiement|payer|formation|cours|module|acc[èe]s|dispo\b|disponible|livraison|int[ée]ress[ée]|inscription|\bpack\b|\boffre\b|catalogue|comment\s+(?:je\s+)?fais\s+pour|je\s+veux\s+(?:acheter|commander|m.inscrire)|c.est\s+combien)/i;
  const PERSONAL_GREETING_RE = /^(salut|coucou|bonjour|bonsoir|hello|hey)\b[\s!.,]*$/i;
  const PERSONAL_CHAT_RE = /(comment\s+(?:tu\s+vas|vas.tu)|[çc]a\s+va\??$|bisous|bonne\s+(?:nuit|journ[ée]e|soir[ée]e)|joyeux\s+anniversaire|tu\s+me\s+manques|famille|comment\s+va\s+la)/i;

  // classify(text, opts) — opts.threadHasBusinessContext (bool, facultatif) :
  // le fil de discussion a déjà été classé 'business' récemment (le vendeur y
  // a répondu à une question produit) — fait pencher un message court/ambigu
  // ultérieur ('ok', 'merci', 'et la livraison ?') vers 'business' plutôt que
  // de re-basculer à tort en 'personal' à chaque message court.
  function classify(text, opts) {
    const o = opts || {};
    const t = String(text || '').trim();
    if (!t) return { category: 'personal', confidence: 0.5, reason: 'EMPTY' };

    if (BUSINESS_RE.test(t)) return { category: 'business', confidence: 0.85, reason: 'KEYWORD_MATCH' };

    if (PERSONAL_GREETING_RE.test(t) || (PERSONAL_CHAT_RE.test(t) && t.length < 120)) {
      return { category: 'personal', confidence: 0.75, reason: 'PERSONAL_SIGNAL' };
    }

    if (o.threadHasBusinessContext && t.length < 40) {
      return { category: 'business', confidence: 0.55, reason: 'THREAD_CONTEXT' };
    }

    // Par défaut : privé (voir justification en tête de fichier).
    return { category: 'personal', confidence: 0.5, reason: 'DEFAULT_PRIVATE' };
  }

  // ---------------------------------------------------------------------------
  // Onboarding passif (§3, fiche business) — scope volontairement ÉTROIT :
  // capture les QUESTIONS clients récurrentes observées (pour une FAQ légère),
  // jamais l'invention de produits/prix — ceux-ci restent la seule autorité de
  // ai-engine/offerClarifier.js (clarification ACTIVE, jamais devinée). Une
  // question déjà vue (normalisée, comparaison approximative par préfixe) voit
  // simplement son compteur incrémenté plutôt que d'être dupliquée.
  function recordFaqSignal(profile, question) {
    const p = profile && typeof profile === 'object' ? profile : {};
    p.faq = Array.isArray(p.faq) ? p.faq : [];
    const normalized = String(question || '').trim().toLowerCase().slice(0, 200);
    if (!normalized) return p;
    const existing = p.faq.find((f) => f.question.toLowerCase().slice(0, 60) === normalized.slice(0, 60));
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastSeenAt = new Date().toISOString();
    } else {
      p.faq.push({ question: String(question).trim().slice(0, 300), count: 1, lastSeenAt: new Date().toISOString() });
    }
    p.faq = p.faq.sort((a, b) => b.count - a.count).slice(0, 50); // garde-fou anti-croissance illimitée
    return p;
  }

  return { classify, recordFaqSignal };
});
