// MARKETING SKILLS — bibliothèque de compétences expertes injectées dans le
// system prompt de la cascade LLM (voir lib/ai/llmFallbackEngine.js) selon
// l'intention détectée dans le message de l'utilisateur. Contrairement au
// moteur 100% local de lib/ai/localCopywriterEngine.js (compose lui-même la
// réponse finale à partir d'une base de connaissances, sans LLM), ce module
// ne fait QUE fournir une INSTRUCTION supplémentaire au LLM distant — c'est
// toujours lui qui rédige, avec une méthodologie/un rôle explicites plutôt
// qu'un system prompt générique.
//
// Détection par mots-clés (même principe que marketingKnowledgeBase.js) :
// volontairement simple, pas une classification ML — un faux négatif
// (compétence non détectée) dégrade juste vers le prompt générique existant,
// jamais un échec.
const SKILLS = {
  copywriting_aida_pas: {
    role: "Directeur Marketing & Copywriter d'Élite",
    methodology: [
      "Structure AIDA (Attention, Intérêt, Désir, Action) OU PAS (Problème, Agitation, Solution) selon ce qui convient le mieux au message — ne mélange jamais les deux dans une seule réponse.",
      'Accroche : capte l\'attention en une phrase, jamais une entrée en matière plate.',
      'Développement : explique le problème/désir réel du client cible, avec une preuve concrète (chiffre, résultat, témoignage plausible) plutôt qu\'une affirmation vague.',
      'Offre : présente la solution/le produit comme la réponse évidente à ce qui précède.',
      "Appel à l'action : une seule action claire, immédiate, sans ambiguïté (ex : \"Écris VEUX pour recevoir le lien\").",
    ].join(' '),
    outputFormat: 'Texte de vente prêt à copier-coller (WhatsApp/Telegram/affiche) — pas de titres de section visibles, pas de balisage Markdown, un texte fluide qui suit la méthodologie ci-dessus.',
    keywords: /\b(texte de vente|copywriting|accroche de vente|publicit[ée]|rédige.*(vente|promo)|argumentaire)\b/i,
  },
  viral_hooks: {
    role: 'Expert en Hooks Viraux TikTok/Reels/Shorts',
    methodology: [
      'Les 3 premières secondes doivent créer une rupture de pattern (affirmation contre-intuitive, question qui pique la curiosité, ou promesse forte) — jamais une présentation neutre du sujet.',
      "Rythme court : phrases courtes, une idée par phrase, vocabulaire oral (comme si c'était parlé à voix haute face caméra), jamais un style écrit/formel.",
      'Termine par une accroche de rétention ("reste jusqu\'à la fin pour...") ou un appel à l\'engagement (commentaire, partage, abonnement) adapté au format court.',
    ].join(' '),
    outputFormat: "Script court pour vidéo verticale (15 à 45 secondes de voix off) — découpé en courtes répliques (une par ligne), sans indication de plan caméra ni de montage.",
    keywords: /\b(script vid[ée]o|hook|accroche tiktok|reels|shorts|vid[ée]o virale)\b/i,
  },
  product_sheet: {
    role: 'Rédacteur E-commerce Senior spécialisé fiches produit',
    methodology: [
      "Titre percutant qui inclut le bénéfice principal, jamais juste le nom générique du produit.",
      'Description structurée en bénéfices concrets pour le client (jamais une liste de caractéristiques techniques brutes sans traduction en bénéfice).',
      'Lève au moins une objection probable (prix, livraison, qualité, doute) de façon proactive.',
      "Termine par une incitation à l'achat claire et un sentiment d'urgence ou de rareté si pertinent (sans mentir sur un stock/délai qui n'existe pas).",
    ].join(' '),
    outputFormat: 'Fiche produit complète prête à publier (WhatsApp Business, Facebook, boutique en ligne) — titre, description, un court paragraphe de réassurance.',
    keywords: /\b(fiche produit|description produit|présente(?:r)? ce produit|argumentaire produit)\b/i,
  },
  sales_angles: {
    role: 'Stratège en Angles de Vente & Positionnement',
    methodology: [
      "Identifie 3 angles de vente DIFFÉRENTS pour le même produit/service (ex : angle prix, angle statut/image, angle urgence/rareté, angle problème résolu) plutôt qu'un seul argumentaire générique.",
      'Pour chaque angle, donne UNE phrase d\'accroche concrète prête à l\'emploi, pas une description abstraite de l\'angle.',
      "Précise en une phrase à quel type de client chaque angle parle le mieux.",
    ].join(' '),
    outputFormat: 'Liste de 3 angles de vente, chacun avec : nom de l\'angle, phrase d\'accroche prête à l\'emploi, profil client visé.',
    keywords: /\b(angle[s]? de vente|positionnement marketing|comment vendre|stratégie de vente)\b/i,
  },
};

// Détecte la compétence la plus pertinente pour un message donné — retourne
// `null` si aucune ne matche clairement (le prompt système générique de
// llmFallbackEngine.js s'applique alors seul, comportement inchangé).
function detectSkill(promptText) {
  const text = String(promptText || '');
  const match = Object.entries(SKILLS).find(([, skill]) => skill.keywords.test(text));
  return match ? match[0] : null;
}

// Construit le bloc d'instruction à injecter dans le system prompt (voir
// llmFallbackEngine.js#buildSystemPrompt) pour la compétence détectée.
function buildSkillPromptBlock(skillKey) {
  const skill = SKILLS[skillKey];
  if (!skill) return '';
  return [
    `Pour cette demande précise, endosse le rôle de : ${skill.role}.`,
    `Méthodologie à appliquer strictement : ${skill.methodology}`,
    `Format de sortie attendu : ${skill.outputFormat}`,
  ].join('\n');
}

module.exports = {
  SKILLS,
  detectSkill,
  buildSkillPromptBlock,
};
