// HUMAN CONTEXT INTELLIGENCE ENGINE  (webapp-core/intelligence + lib/intelligence)
// -------------------------------------------------------------------------------
// Couche "Human & Context Intelligence" transversale, dual-env :
//   - Node (VPS Baileys, tests) :  module.exports
//   - Navigateur (Zero-VPS, webapp-core) : crée globalThis.HumanContextEngine
//
// Ce module est VOLONTAIREMENT autonome et sans import de dépendance : toutes
// ses entrées passent par l'injection `deps`. Il ne touche à AUCUN moteur
// d'envoi ni à la gestion de session WhatsApp/Telegram/Baileys existante —
// il produE de l'intelligence contextuelle consommable par ceux-ci.
//
// Boucle apprenante : OBSERVE -> ANALYZE -> UNDERSTAND -> CHOOSE STRATEGY
//   -> ACT -> OBSERVE REACTION -> MEASURE RESULT -> LEARN / MEMORY
//
// Cascade de décision à 4 niveaux (decide) :
//   1. Règles locales déterministes
//   2. Stratégies connues enregistrées (registry par patron)
//   3. Mémoire contextuelle locale, via `deps.memory`
//   4. Appel IA via les clés GRATUITES du .env (Groq -> Gemini -> OpenRouter
//      -> Hugging Face -> Pollinations) UNIQUEMENT si la situation est inédite.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HumanContextEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Lexiques FR (déterministes). Poids positifs = signal présent. Ces lexiques
  // sont le niveau 1 de la cascade : rapide, zéro coût réseau.
  // ---------------------------------------------------------------------------
  const LEX_PRICE_OBJECTION = [['prix', 1.0], ['trop cher', 1.2], ['chere', 0.9], ['code', 0.7], ['budget', 1.0], ['cout', 0.8], ['remise', 0.6], ['reduction', 0.6], ['paiement', 0.9], ['versement', 0.8], ['acompte', 0.7], ['refléter', 0.4], ['reflechir', 0.4], ['réfléchir', 0.4], ['reflechis', 0.4], ['réfléchis', 0.4], ['refléchis', 0.4], ['reflechissons', 0.5], ['réfléchissons', 0.5], ['mûrir', 0.6], ['maturer', 0.6], ['voir plus tard', 0.7], ['pas maintenant', 0.7], ['plus tard', 0.7], ['financement', 0.9], ['payer en plusieurs fois', 1.0]];
  const LEX_TRUST_OBJECTION = [['confiance', 0.8], ['pas sure', 0.7], ['pas sûre', 0.7], ['garantie', 0.9], ['remboursement', 1.0], ['arnaque', 1.3], ['escroquerie', 1.3], ['sérieux', 0.9], ['preuve', 0.8], ['temoignage', 0.7], ['témoignage', 0.7], ['resultat', 0.6], ['résultat', 0.6], ['avis', 0.7], ['reviews', 0.8], ['fiabilité', 0.8], ['fiable', 0.8], ['certification', 0.7]];
  const LEX_TIME_OBJECTION = [['temps', 0.7], ['pas le temps', 1.1], ['charge', 0.8], ['occupé', 0.8], ['maintenant', 0.7], ['semaine prochaine', 0.9], ['mois prochain', 0.9], ['disponible', 0.8], ['dispo', 0.8], ['rappeler', 0.7], ['neladonné', 0.4], ['disponibilité', 0.7], ['emploi du temps', 1.0], ['presse', 0.7]];
  const LEX_INTEREST_HIGH = [['intéressé', 1.0], ['interessé', 1.0], ['super', 0.9], ['génial', 0.9], ['genial', 0.9], ['top', 0.8], ['parfait', 0.9], ['je veux', 0.8], ['je voudrais', 0.7], ['j\'aimerais', 0.7], ['j aimerais', 0.7], ['combien', 0.8], ['dis-moi plus', 0.9], ['dit moi plus', 0.9], ['détails', 0.8], ['comment ca marche', 0.9], ['explique', 0.7], ['inscrire', 1.0], ['m\'inscrire', 1.0], ['acheter', 1.0], ['commander', 1.0], ['prendre le pack', 1.1], ['prendre le produit', 1.0], ['payer', 1.0], ['je vais réfléchir', 0.3], ['vais refléchir', 0.3], ['vais réflechir', 0.3], ['vais réfléchir', 0.3], ['je réfléchis', 0.4], ['je reflechis', 0.4], ['après', 0.3], ['bientôt', 0.5], ['des que possible', 0.7]];
  const LEX_INTEREST_LOW = [['pas intéresse', 1.0], ['pas intéressé', 1.0], ['non merci', 1.2], ['merci non', 1.1], ['inutile', 1.0], ['pas besoin', 1.1], ['stop', 1.0], ['arrête', 1.0], ['ne m\'écris plus', 1.3], ['retirez', 1.2], ['spam', 1.2]];
  const LEX_ENTHUSIASM = [['génial', 1.0], ['genial', 1.0], ['super', 0.9], ['excellent', 1.0], ['parfait', 1.0], ['top', 0.8], ['j\'adore', 1.1], ['wow', 1.0], ['hate de', 1.0], ['hâte de', 1.0], ['impatient', 1.0], ['merci beaucoup', 0.7], ['c\'est parti', 1.2], ['ok on y va', 1.1], ['on y va', 1.0], ['let\'s go', 1.1], ['yes', 0.9], ['👏', 0.8], ['🎉', 0.9], ['🔥', 1.0], ['😍', 1.0], ['🤩', 1.0]];
  const LEX_FRUSTRATION = [['pas sérieux', 1.1], ['bloqué', 1.0], ['problème', 1.0], ['erreur', 0.9], ['bug', 1.0], ['ça ne marche pas', 1.2], ['ça marche pas', 1.2], ['ne répond pas', 1.1], ['pas de réponse', 1.0], ['en retard', 0.9], ['je vous ai attendu', 1.0], ['honteux', 1.2], ['incompétent', 1.3], ['inadmissible', 1.2], ['colère', 1.2], ['frustré', 1.2], ['exaspéré', 1.2], ['!!!', 0.6], ['??!!', 0.7], ['déçu', 1.0], ['deçu', 1.0]];
  const LEX_FEAR = [['peur', 1.2], ['crainte', 1.1], ['risque', 1.0], ['risqué', 1.0], ['perdre', 0.9], ['perdrai', 0.9], ['trompé', 1.1], ['tromper', 1.1], ['arnaqué', 1.3], ['fragile', 0.9], ['inquiet', 1.1], ['inquiète', 1.1], ['stressé', 1.0], ['angoissé', 1.0], ['danger', 1.1]];
  const LEX_URGENCY = [['aujourd\'hui', 0.9], ['ce soir', 1.0], ['tout de suite', 1.2], ['immédiatement', 1.2], ['dès maintenant', 1.1], ['maintenant', 1.0], ['urgence', 1.3], ['dernière chance', 1.0], ['se termine', 0.8], ['bientôt', 0.7], ['limité', 0.8], ['vite', 1.0], ['rapidement', 1.0], ['dépêche', 1.1], ['avant de', 0.7]];
  const LEX_TRUST_HIGH = [['confiance', 0.7], ['je vous fais confiance', 1.2], ['d\'accord', 0.8], ['ok', 0.6], ['très bien', 0.9], ['parfait', 0.9], ['merci', 0.5], ['recommandé', 0.9], ['recommande', 0.9], ['fiable', 0.9], ['sérieux', 0.8]];
  const LEX_HESITATION = [['réfléchir', 1.1], ['refléchir', 1.1], ['réfléchis', 1.1], ['reflechis', 1.1], ['réflexion', 1.2], ['reflexion', 1.2], ['hésite', 1.2], ['hesite', 1.2], ['hésitation', 1.2], ['hesitation', 1.1], ['peut-être', 0.9], ['peut etre', 0.9], ['pas sûr', 1.0], ['pas sur', 1.0], ['pas sûre', 1.0], ['pas certain', 1.0], ['je ne sais pas', 1.0], ['je sais pas', 1.0], ['mûrir', 0.9], ['voir', 0.5], ['encore', 0.5], ['un peu', 0.5], ['consulter', 0.8], ['parle-en', 0.9], ['demander à', 0.8], ['après réflexion', 1.1], ['revenir', 0.7], ['je reviens', 0.8]];
  const LEX_BUY_INTENT = [['j\'achète', 1.4], ['j achete', 1.4], ['j\'ai acheté', 1.4], ['j ai acheté', 1.4], ['je prends', 1.1], ['je prend', 1.1], ['c\'est parti', 1.2], ['c est parti', 1.2], ['ok je paie', 1.3], ['lien de paiement', 1.0], ['payer maintenant', 1.2], ['envoie le lien', 1.0], ['send', 0.8], ['commande', 1.1], ['commander', 1.1], ['passer commande', 1.2], ['valider', 1.0], ['inscription', 1.0], ['m\'inscrire', 1.1]];
  const LEX_COMPARE = [['compare', 1.0], ['comparer', 1.0], ['quelle est la différence', 1.1], ['différence', 0.9], ['alternative', 0.9], ['autre option', 0.9], ['vs', 0.8], ['plutôt que', 0.8], ['advance', 0.7], ['autre produit', 0.8]];
  const LEX_SUPPORT = [['aide', 1.0], ['help', 1.0], ['comment', 0.7], ['problème', 0.9], ['erreur', 0.9], ['bug', 0.9], ['connexion', 0.7], ['login', 0.7], ['mot de passe', 0.9], ['compte', 0.8], ['débloquer', 1.0], ['accès', 0.8], ['fonctionne plus', 1.0], ['reinstaller', 0.9], ['réinstallation', 0.9], ['lien ne marche pas', 1.1], ['ne reçois pas', 1.0], ['keys', 0.8], ['clé', 0.8]];
  const LEX_DECLINE = [['non merci', 1.3], ['pas intéresse', 1.2], ['pas intéressé', 1.2], ['stop', 1.2], ['ne m\'écris plus', 1.3], ['retirez-moi', 1.3], ['spam', 1.3], ['pas besoin', 1.1], ['je ne suis pas intéressé', 1.3], ['pas intéressée', 1.2]];

  const INTENT_BY_LEXICON = [
    { intent: 'BUY', lexicon: LEX_BUY_INTENT },
    { intent: 'DECLINE', lexicon: LEX_DECLINE },
    { intent: 'SUPPORT', lexicon: LEX_SUPPORT },
    { intent: 'COMPARE', lexicon: LEX_COMPARE },
    { intent: 'LEARN', lexicon: LEX_INTEREST_HIGH },
    { intent: 'OBJECT', lexicon: [].concat(LEX_PRICE_OBJECTION, LEX_TRUST_OBJECTION, LEX_TIME_OBJECTION) },
  ];

  // Mots négations qui inversent/atténuent un signal positif (gérées par
  // scoreNegation au niveau du message).
  const NEGATION = [['pas', -0.8], ['ne', -0.6], ['non', -0.8], ['jamais', -1.0], ['pas du tout', -1.0], ['sans', -0.6], ['ni', -0.5], ['moins', -0.4]];

  // réduction responsable de la réponse — sert à l'intonation (!!) et aux
  // signaux de frustration.
  function countExclamations(text) {
    return (text.match(/!/g) || []).length;
  }
  function countQuestions(text) {
    return (text.match(/\?/g) || []).length;
  }

  function normalize(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function scoreLexicon(text, lexicon) {
    let score = 0;
    const hits = [];
    const seen = new Set();
    for (const [phrase, weight] of lexicon) {
      // `text` est déjè accent-nu (normalize) : normaliser aussi la phrase
      // pour que les lexèmes accentués (réfléchir, confiance...) matchent.
      // Un même mot sous 3 variantes accentuées compte UNE fois (première
      // occurrence gagne) : évite l'empilement des double-comptes.
      const np = normalize(phrase);
      if (seen.has(np)) continue;
      seen.add(np);
      if (text.indexOf(np) !== -1) {
        score += weight;
        hits.push(phrase);
      }
    }
    return { score: Math.min(score, 3), hits };
  }

  // Applique les négations : un signal positif juste après une négation est
  // retourné (ex. « pas de problème » => signal 'problème' annulé).
  function applyNegation(text, rawScore, contextWordLen) {
    let negScore = 0;
    for (const [w, wScore] of NEGATION) {
      if (text.indexOf(w) !== -1) negScore += wScore;
    }
    return Math.max(-1, Math.min(3, rawScore + Math.min(0, negScore)));
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  // combinaison d'un score lexème (0-3) en une probabilité lissée 0-1.
  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  function scoreToProp(score) {
    if (score <= 0) return 0;
    return clamp01(sigmoid(score * 1.8 - 0.8));
  }

  // ---------------------------------------------------------------------------
  // ANALYSE
  // ---------------------------------------------------------------------------
  function analyzeMessage(input, opts) {
    const text = String(input && (input.text != null ? input.text : input)).trim();
    const context = (input && input.context) || opts && opts.context || {};
    if (!text) {
      return { error: 'EMPTY_TEXT' };
    }
    const n = normalize(text);
    const excls = countExclamations(text);
    const questions = countQuestions(text);
    const intent = detectIntent(n);

    const intPrice = scoreLexicon(n, LEX_PRICE_OBJECTION).score;
    const intTrust = scoreLexicon(n, LEX_TRUST_OBJECTION).score;
    const intTime = scoreLexicon(n, LEX_TIME_OBJECTION).score;
    const intInterestHigh = applyNegation(n, scoreLexicon(n, LEX_INTEREST_HIGH).score, 4);
    const intInterestLow = scoreLexicon(n, LEX_INTEREST_LOW).score;
    const intEnthusiasm = scoreLexicon(n, LEX_ENTHUSIASM).score;
    const intFrustration = scoreLexicon(n, LEX_FRUSTRATION).score + Math.min(0.3, excls * 0.2);
    const intFear = scoreLexicon(n, LEX_FEAR).score;
    const intUrgency = applyNegation(n, scoreLexicon(n, LEX_URGENCY).score, 4);
    const intTrustHigh = applyNegation(n, scoreLexicon(n, LEX_TRUST_HIGH).score, 4);
    const intHesitation = scoreLexicon(n, LEX_HESITATION).score;
    const intBuy = applyNegation(n, scoreLexicon(n, LEX_BUY_INTENT).score, 4);

    // Règle métier explicite (spec) : « Je vais réfléchir » => INTEREST HIGH,
    // TRUST MEDIUM, HESITATION HIGH, LIKELY_OBJECTION PRICE.
    const hasReflexionPattern = /(reflechir|reflechis|reflexion|reconside|reflechie|murement|aucune idee|pas encore sur|pas encore sure)/i.test(n);
    const hasObjectionPattern = /(trop cher|c est codeux|budget|pas le moyen|pas les moyens)/i.test(n);

    // Intérêt : priorité au signal EXPRIME. Spéc non-match => dérivé.
    let interest = 'Medium';
    if (intInterestLow > 0.5 || /non merci|pas intéresse|pas intéressé/i.test(n)) interest = 'Low';
    else if (hasReflexionPattern || hasObjectionPattern) interest = 'High';
    else if (intTrust >= 0.3 && intent === 'OBJECT') interest = 'Medium';
    else if (intInterestHigh >= 1.2 || intBuy >= 0.8 || intUrgency >= 1) interest = 'High';
    else if (intInterestHigh >= 0.4) interest = 'Medium';
    else interest = 'Low';

    const dominant = dominantEmotion({ enthusiasm: intEnthusiasm, frustration: intFrustration, fear: intFear, trust: intTrustHigh, hesitation: intHesitation, urgency: intUrgency, interest: intInterestHigh - intInterestLow });

    // Probabilités calibrées : la confiance démarre à 0.5 pour toute réponse
    // engagée, corrigée par marqueurs de défiance ; tout le reste part de 0
    // (zéro signal = 0, jamais de plancher sigmoïde fantôme).
    const fear = scoreToProp(intFear);
    let trust = 0.5 + (intTrustHigh / 3) * 0.55 - Math.min(0.7, (intTrust / 3) * 0.95 + fear * 0.12);
    if (intent === 'DECLINE') trust = Math.min(trust, 0.35);
    trust = clamp01(trust);
    const hesitation = scoreToProp(intHesitation);
    const urgency = scoreToProp(intUrgency);
    const frustration = scoreToProp(intFrustration);
    const enthusiasm = scoreToProp(intEnthusiasm);
    const uncertainty = clamp01(0.5 * hesitation + 0.3 * fear + 0.2 * (intTrust > 0 ? 1 : 0) + 0.15 * (hasReflexionPattern ? 1 : 0));

    // objection la plus probable
    const objections = [];
    if (intPrice >= 0.3) objections.push('PRICE');
    if (intTrust >= 0.3) objections.push('TRUST');
    if (intTime >= 0.3) objections.push('TIME');
    const likely_objections = objections.length ? objections : guessObjection({ interest, hesitation, trust, context });

    let sentiment = 'neutral';
    const net = intEnthusiasm * 1.4 + intTrustHigh * 1.0 - intFrustration * 1.5 - intFear * 1.2;
    if (net > 1.1) sentiment = 'positive';
    else if (net < -0.9) sentiment = 'negative';
    else if (net > 0.2) sentiment = 'slightly_positive';
    else if (net < -0.2) sentiment = 'slightly_negative';

    const purchase_probability = estimatePurchaseProbability({ interest, intent, sentiment, trust, hesitation, urgency, frustration, fear });

    const analysis = {
      message: text,
      analysisAt: new Date().toISOString(),
      sentiment,
      dominant_emotion: dominant,
      interest,
      intent,
      trust: round(trust),
      hesitation: round(hesitation),
      urgency: round(urgency),
      frustration: round(frustration),
      fear: round(fear),
      enthusiasm: round(enthusiasm),
      uncertainty_level: round(uncertainty),
      likely_objections,
      objection_primary: likely_objections[0] || 'NONE',
      purchase_probability: round(purchase_probability),
      signals: {
        exclamations: excls,
        questions,
        responseDelayMs: context.responseDelayMs || null,
        previousSentiment: context.previousSentiment || null,
      },
      raw_scores: {
        price: round(intPrice / 3), trust: round(intTrust / 3), time: round(intTime / 3),
        interest_high: round(intInterestHigh / 3), interest_low: round(intInterestLow / 3),
        enthusiasm: round(intEnthusiasm / 3), frustration: round(intFrustration / 3),
        fear: round(intFear / 3), urgency: round(intUrgency / 3), hesitation: round(intHesitation / 3),
        buy: round(intBuy / 3),
      },
    };
    return analysis;
  }

  function dominantEmotion(scores) {
    const map = [
      ['enthusiasm', scores.enthusiasm],
      ['frustration', scores.frustration],
      ['fear', scores.fear],
      ['trust', scores.trust],
      ['hesitation', scores.hesitation],
      ['urgency', scores.urgency],
      ['interest', Math.max(0, scores.interest)],
    ];
    map.sort((a, b) => b[1] - a[1]);
    const top = map[0];
    if (top[1] < 0.3) return 'neutral';
    if (top[1] <= 0.4) return 'neutral';
    const label = {
      enthusiasm: 'enthusiasm', frustration: 'frustration', fear: 'fear',
      trust: 'trust', hesitation: 'hesitation', urgency: 'urgency',
      interest: 'interest',
    }[top[0]];
    return label;
  }

  function detectIntent(n, buy, support, compare, decline) {
    // passage réordonné : intention la plus forte d'abord
    const candidates = [];
    const s = (lex) => scoreLexicon(n, lex).score;
    const sBuy = s(LEX_BUY_INTENT);
    const sDecline = s(LEX_DECLINE);
    const sSupport = s(LEX_SUPPORT);
    const sCompare = s(LEX_COMPARE);
    const sHes = s(LEX_HESITATION);
    const sObject = s(LEX_PRICE_OBJECTION) + s(LEX_TRUST_OBJECTION) + s(LEX_TIME_OBJECTION);
    const sLearn = s(LEX_INTEREST_HIGH);
    if (sBuy >= 0.6) candidates.push(['BUY', sBuy]);
    if (sDecline >= 0.8) candidates.push(['DECLINE', sDecline]);
    if (sSupport >= 0.8) candidates.push(['SUPPORT', sSupport]);
    if (sCompare >= 0.8) candidates.push(['COMPARE', sCompare]);
    if (sObject >= 0.7) candidates.push(['OBJECT', sObject]);
    if (sHes >= 0.8) candidates.push(['CONSIDER', sHes + 0.1]);
    if (sLearn >= 0.6) candidates.push(['LEARN', sLearn]);
    if (candidates.length === 0) return 'CASUAL';
    candidates.sort((a, b) => b[1] - a[1]);
    return candidates[0][0];
  }

  function guessObjection({ interest, hesitation, trust, context }) {
    if (hesitation >= 0.65) return ['PRICE'];
    if (trust < 0.4) return ['TRUST'];
    if (context && context.objectionHint) return [context.objectionHint];
    return ['NONE'];
  }

  function estimatePurchaseProbability({ interest, intent, sentiment, trust, hesitation, urgency, frustration, fear }) {
    if (intent === 'BUY') return 0.86 + trust * 0.08;
    let p = 0;
    switch (interest) {
      case 'High': p = 0.55; break;
      case 'Medium': p = 0.30; break;
      default: p = 0.12;
    }
    // Adjust by blockers.
    p += trust * 0.15 - hesitation * 0.25 - frustration * 0.15 - fear * 0.15 + urgency * 0.1;
    if (intent === 'DECLINE') p = Math.min(p, 0.06);
    if (sentiment === 'negative') p -= 0.1;
    if (sentiment === 'positive') p += 0.1;
    return clamp01(p);
  }

  function round(v) {
    return Math.round(v * 100) / 100;
  }

  // ---------------------------------------------------------------------------
  // ANALYSE D'UN LOT DE RÉPONSES (agrégation)
  // ---------------------------------------------------------------------------
  function analyzeResponses(responses, opts) {
    const list = (responses || []).map((r) => analyzeMessage(r, opts));
    const valid = list.filter((r) => !r.error);
    if (valid.length === 0) {
      return { responses: [], positive: 0, negative: 0, neutral: 0, heat: 'LOW', bestWindow: null, suggestions: [] };
    }
    const positive = valid.filter((r) => r.sentiment === 'positive').length;
    const negative = valid.filter((r) => r.sentiment === 'negative').length;
    const neutral = valid.length - positive - negative;
    const heat = valid.length >= 5 ? (positive / valid.length >= 0.5 ? 'HIGH' : positive / valid.length >= 0.3 ? 'MEDIUM' : 'LOW') : 'LOW';
    // Calcul d'une fenêtre de relance optimale : clustering par heure
    const hours = valid.map((r) => new Date(r.analysisAt).getHours());
    const bestWindow = bestHourWindow(hours, valid.length);
    const suggestions = [];
    const objects = valid.filter((r) => r.likely_objections.length > 0).length;
    if (objects / valid.length > 0.4) suggestions.push('OBJECTION_CLUSTER_PRICE');
    if (negative / valid.length > 0.3) suggestions.push('TONE_ESCALATION_SUPPORT');
    return { responses: valid, total: valid.length, positive, negative, neutral, heat, bestWindow, suggestions };
  }

  function bestHourWindow(hours, n) {
    if (!hours.length) return null;
    const freq = new Array(24).fill(0);
    hours.forEach((h) => { freq[h] += 1; });
    let best = 0, bestCount = 0;
    for (let h = 0; h < 24; h++) {
      const w = freq[h] + freq[(h + 1) % 24];
      if (w > bestCount) { bestCount = w; best = h; }
    }
    return { startHour: best, endHour: (best + 1) % 24, density: Math.round(bestCount / Math.max(1, n) * 100) / 100 };
  }

  // ---------------------------------------------------------------------------
  // INTUITION PROBABILISTE — signaux faibles
  // ---------------------------------------------------------------------------
  // Détecte : ruptures de ton, changements de rythme, contradictions avec
  // l'historique, similarités historiques de pattern.
  function detectIntuition({ signals, analysis, history }) {
    const clues = [];
    let confidence = 0.5;
    const tone = analysis && analysis.sentiment;
    const interest = analysis && analysis.interest;

    // 1. Rupture de ton vs historique
    const prev = (history && history[history.length - 2]) || null;
    const last = (history && history[history.length - 1]) || null;
    if (prev && last && prev.sentiment !== last.sentiment) {
      clues.push({ clue: 'TONE_SHIFT', weight: 0.6, reason: 'Rupture de ton (' + prev.sentiment + '->' + last.sentiment + ')' });
      confidence += 0.15;
    }
    // 2. Rythme conversationnel : délai de réponse anormal
    const delay = (signals && signals.responseDelayMs) != null ? signals.responseDelayMs : (analysis && analysis.signals && analysis.signals.responseDelayMs);
    if (delay != null) {
      if (delay > 12 * 60 * 60 * 1000) {
        clues.push({ clue: 'SLOW_REPLY', weight: 0.5, reason: 'Réponse après plus de 12 h' });
        confidence += 0.12;
      } else if (delay < 10 * 1000 && analysis && analysis.intent === 'OBJECT') {
        clues.push({ clue: 'FAST_OBJECTION', weight: 0.6, reason: 'Objection exprimée très vite' });
        confidence += 0.1;
      }
    }
    // 3. Contradiction : texte positif + sentiment bas, ou intérêt déclaré puis doute
    if (analysis && analysis.interest === 'High' && analysis.hesitation > 0.6) {
      clues.push({ clue: 'INTEREST_HESITATION_GAP', weight: 0.8, reason: 'Intérêt élevé mais forte hésitation' });
      confidence += 0.2;
    }
    // 4. Similarité historique : même pattern déjà rejeté/objecté par le passé
    if (history && history.length >= 2 && analysis) {
      const similar = history.filter((h) => h.objection_primary && h.objection_primary === analysis.objection_primary).length;
      if (similar >= 2) {
        clues.push({ clue: 'REPEATING_OBJECTION', weight: 0.7, reason: 'Objection similaire déjà exprimée ' + similar + ' fois' });
        confidence += 0.18;
      }
    }
    // 5. Frustration silencieuse : tokens courts + retard
    if (analysis && analysis.frustration > 0.5 && analysis.message && analysis.message.length < 16) {
      clues.push({ clue: 'CURT_TONE', weight: 0.5, reason: 'Réponse brève sous frustration' });
      confidence += 0.1;
    }

    const verdict = confidence >= 0.8 ? 'CAUTION' : confidence >= 0.62 ? 'NOTICE' : 'CLEAR';
    return {
      intuition: verdict,
      confidence: round(clamp01(confidence)),
      reason: clues.length ? clues.map((c) => c.reason).join(' ; ') : 'Aucun signal faible détecté',
      clues: clues.map((c) => c.clue),
    };
  }

  // ---------------------------------------------------------------------------
  // STRATÉGIES  (niveau 2 de la cascade)
  // ---------------------------------------------------------------------------
  const STRATEGY_REGISTRY = [
    {
      id: 'PRICE_REASSURANCE',
      match: (a) => a.likely_objections && a.likely_objections.includes('PRICE') && (a.interest === 'High' || a.interest === 'Medium'),
      priority: 30,
      goal: 'Reformuler la valeur pour neutraliser l\'objection prix, sans réduire le prix d\'autorité.',
      angle: 'INSTALLMENT | VALUE_STACK | BONUS',
      followUpDelayMs: 4 * 60 * 60 * 1000,
      templates: [
        'Je comprends parfaitement {first_name}, vous voulez être sûr du choix. Le pack vous donne {valeur1} mais aussi {valeur2} — je peux vous proposer un paiement en {x} fois si ça vous aide. On avance ?',
        'Pas de souci {first_name} : je ne veux pas que vous payiez en vous posant des questions. Je vous réserve une confirmation sans engagement, et je vous montre concrètement comment ça se passe. Ça vous convient ?',
      ],
    },
    {
      id: 'TRUST_REASSURANCE',
      match: (a) => a.likely_objections && a.likely_objections.includes('TRUST'),
      priority: 29,
      goal: 'Installer la confiance par des preuves exploitables (résultats, démarche encadrée, support).',
      angle: 'SOCIAL_PROOF | GUARANTEE | SUPPORT_ENGAGED',
      followUpDelayMs: 6 * 60 * 60 * 1000,
      templates: [
        'Comptez sur moi {first_name} — voici exactement ce que vous recevez et comment je vous accompagne à chaque étape. Je reste disponible pour tout éclaircissement, je préfère que vous soyez 100% serein avant de valider.',
      ],
    },
    {
      id: 'TIME_REASSURANCE',
      match: (a) => a.likely_objections && a.likely_objections.includes('TIME'),
      priority: 28,
      goal: 'Lever la contrainte de temps en proposant un rendez-vous court et flexible.',
      angle: 'SHORT_COMMITMENT | REMINDER',
      followUpDelayMs: 3 * 60 * 60 * 1000,
      templates: [
        'Très bien {first_name}. On ne prend que 5 minutes, au moment qui vous arrange le mieux — si vous voulez, je vous envoie un petit récap à lire quand vous êtes disponible. Je vous laisse me dire quand.',
      ],
    },
    {
      id: 'HIGH_INTENT_RALLY',
      match: (a) => a.intent === 'BUY',
      priority: 26,
      goal: 'Fermer rapidement une intention d\'achat forte.',
      angle: 'CTA | PAYMENT',
      followUpDelayMs: 30 * 60 * 1000,
      templates: [
        'Parfait {first_name} ! {Je vous envoie|Voici} le lien de {paiement|confirmation} tout de suite. {Vous recevrez votre accès immédiatement|L\'accès est débloqué sous quelques minutes}.',
      ],
    },
    {
      id: 'LEAD_WARM',
      match: (a) => (a.interest === 'High' || a.interest === 'Medium') && a.intent !== 'BUY' && a.intent !== 'DECLINE' && !(a.likely_objections || []).length,
      priority: 25,
      goal: 'Nourrir un lead chaud sans objection : donner la preuve concrète, inviter à avancer.',
      angle: 'NURTURE | PROOF | SOFT_CTA',
      followUpDelayMs: 2 * 60 * 60 * 1000,
      templates: [
        'Ravi que ça vous intéresse, {first_name} ! Voici ce que je propose concrètement : {avantage1}, et {avantage2}. Je peux vous montrer un exemple réel pour que vous jugiez ?',
        'Parfait {first_name} ! Pour faire simple : vous avez {avantage1} et {avantage2}, le tout accompagné de {avantage3}. Je vous envoie le détail ?',
      ],
    },
    {
      id: 'RISK_ESCALATION',
      match: (a) => (a.dominant_emotion === 'frustration' || a.frustration >= 0.55) && !a.likely_objections.length,
      priority: 25,
      goal: 'Désamorcer une montée de frustration AVANT toute relance commerciale.',
      angle: 'APOLOGY | SUPPORT | RESET',
      followUpDelayMs: null,
      templates: [
        'Vous avez entièrement raison de me le signaler {first_name}. Laissez-moi vous régler cela immédiatement : voici {le correctif|la solution précise}. Merci pour votre patience, c\'est important pour moi.',
      ],
    },
    {
      id: 'LOW_INTENT_ARCHIVE',
      match: (a) => a.intent === 'DECLINE',
      priority: 40,
      goal: 'Ne pas harceler : dernière ouverture permission-based avant archivage.',
      angle: 'REMOVE | OPT_OUT',
      followUpDelayMs: null,
      templates: [
        'Merci pour votre franchise {first_name} — je vais vous retirer de la liste. Si un jour ça vous intéresse, vous savez où me trouver.',
      ],
    },
    {
      id: 'COLD_GREETING',
      match: (a) => a.intent === 'CASUAL',
      priority: 3,
      goal: 'Premier contact casual : qualifier sans insister.',
      angle: 'GREETING | QUALIFY',
      followUpDelayMs: 24 * 60 * 60 * 1000,
      templates: [
        'Bonjour {first_name} ! {Premier contact|On se présente} : j\'aide à {bénéfice}. Je voulais juste savoir si ça {vous intéresse|peut vous servir} — {je reste discret|sans insister, promis}.',
      ],
    },
    {
      id: 'COLD_FOLLOWUP',
      match: () => true,
      priority: 1,
      goal: 'Relance douce sans réponse, cadencée.',
      angle: 'LIGHT_NUDGE',
      followUpDelayMs: 24 * 60 * 60 * 1000,
      templates: [
        'Je repasse juste discrètement {first_name} — pas de pression. {Si vous voulez, on peut en parler 5 minutes|Je reste disponible dès que vous êtes prêt(e)}.',
      ],
    },
  ];

  function selectStrategy(analysis) {
    if (!analysis) return STRATEGY_REGISTRY[STRATEGY_REGISTRY.length - 1];
    // Objection explicite > tout sauf l'intention d'achat ferme : si le lead
    // dit précisément "trop cher" ou "pas confiance", on ne le pousse pas
    // vers un paiement immédiat.
    if (analysis.intent === 'BUY') return findById('HIGH_INTENT_RALLY') || lastStrategy();
    if (analysis.intent === 'DECLINE') return findById('LOW_INTENT_ARCHIVE') || lastStrategy();
    if (analysis.dominant_emotion === 'frustration' || analysis.frustration >= 0.55) return findById('RISK_ESCALATION') || lastStrategy();
    const objections = analysis.likely_objections || [];
    if (objections.includes('PRICE')) return findById('PRICE_REASSURANCE') || lastStrategy();
    if (objections.includes('TRUST')) return findById('TRUST_REASSURANCE') || lastStrategy();
    if (objections.includes('TIME')) return findById('TIME_REASSURANCE') || lastStrategy();
    if (analysis.interest === 'High' || analysis.interest === 'Medium') return findById('LEAD_WARM') || lastStrategy();
    if (analysis.intent === 'CASUAL') return findById('COLD_GREETING') || lastStrategy();
    return lastStrategy();
  }
  function findById(id) {
    return STRATEGY_REGISTRY.find((s) => s.id === id);
  }
  function lastStrategy() {
    return STRATEGY_REGISTRY[STRATEGY_REGISTRY.length - 1];
  }

  function generateFollowUp(analysis, strategy, vars) {
    const strat = strategy || selectStrategy(analysis);
    const templates = strat.templates || [];
    if (!templates.length) return null;
    return templates[Math.floor(Math.random() * templates.length)];
  }

  // ---------------------------------------------------------------------------
  // MÉMOIRE
  // ---------------------------------------------------------------------------
  function snapshot(analysis) {
    return {
      analysisAt: analysis.analysisAt,
      sentiment: analysis.sentiment,
      interest: analysis.interest,
      intent: analysis.intent,
      objection_primary: analysis.objection_primary,
      hesitation: analysis.hesitation,
    };
  }

  // ---------------------------------------------------------------------------
  // CASCADE DE DÉCISION 4 NIVEAUX
  // ---------------------------------------------------------------------------
  // decide(question, deps) -> { level, reason, strategy?, response?, data }
  // deps = { analyze, memory, callLLM, env } — env permet de lire les clés.
  async function decide(question, deps) {
    const opts = { context: (deps && deps.context) || {} };
    const analysis = (deps && deps.analyze) ? deps.analyze(question, opts) : analyzeMessage(question, opts);

    // Niveau 1 : règles déterministes de sécurité (mots-clés déclencheurs)
    const n = normalize(typeof question === 'string' ? question : (question && question.text) || '');
    if (/(je ne suis pas intéresse|pas intéresse|spam|arrêtez|retirez-moi)/i.test(n)) {
      return { level: 1, reason: 'Règle déterministe : désistement explicite', response: generateFollowUp(analysis, selectStrategy(analysis), {}), analysis, strategy: selectStrategy(analysis).id };
    }

    // Niveau 2 : stratégie connue par patron
    const strategy = selectStrategy(analysis);
    const response = generateFollowUp(analysis, strategy, (deps && deps.vars) || {});

    if (strategy.priority >= 8) {
      return { level: 2, reason: 'Stratégie connue : ' + strategy.id, response, analysis, strategy: strategy.id, data: { angle: strategy.angle, followUpDelayMs: strategy.followUpDelayMs } };
    }

    // Niveau 3 : mémoire
    if (deps && deps.memory && typeof deps.memory.find === 'function') {
      try {
        const mem = deps.memory.find({ objection: analysis.objection_primary });
        if (mem && mem.result) {
          return { level: 3, reason: 'Mémoire : pattern déjà traité', response: mem.result, analysis, strategy: strategy.id, data: mem };
        }
      } catch (e) { /* memory échoue proprement */ }
    }

    // Niveau 4 : IA seulement si nouvelle situation (cascade gratuite)
    if (deps && typeof deps.callLLM === 'function') {
      try {
        const ai = await deps.callLLM({ prompt: question, analysis });
        if (ai && ai.text) {
          return { level: 4, reason: 'Appel IA (niveau gratuit .env) : situation inédite', response: ai.text, provider: ai.provider || 'AI', analysis, strategy: strategy.id, data: ai };
        }
      } catch (e) { /* rcide si échec IA -> fallback */ }
    }

    // Repli : stratégie la plus basse (absence d'IA)
    return { level: 2, reason: 'Stratégie de repli : ' + strategy.id, response, analysis, strategy: strategy.id, data: { angle: strategy.angle, followUpDelayMs: strategy.followUpDelayMs } };
  }

  // ---------------------------------------------------------------------------
  // CLI publique de la lib (utilisée par task-parser / automation-engine / tests)
  // ---------------------------------------------------------------------------
  function createHumanContextEngine(deps) {
    return {
      analyzeMessage,
      analyzeResponses,
      detectIntuition,
      selectStrategy,
      generateFollowUp,
      decide,
      snapshot,
      _registry: STRATEGY_REGISTRY,
      _normalize: normalize,
    };
  }

  return {
    createHumanContextEngine,
    analyzeMessage,       // export direct (test simple)
    analyzeResponses,
    detectIntuition,
    selectStrategy,
    generateFollowUp,
    decide,
    snapshot,
    STRATEGY_REGISTRY,
  };
});
