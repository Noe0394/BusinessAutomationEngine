const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');

// PERSONA MANAGER — ai-engine/personaManager.js
// ---------------------------------------------------------------------------
// Couche de "voix" du Chat-Driven Agent Orchestrator : élimine le ton
// robotique (validations sèches, JSON exposé, questions recopiées telles
// quelles) en repassant CHAQUE réponse destinée à l'utilisateur par un appel
// LLM contraint par une consigne de personnalité fixe — jamais en inventant
// de faits (voir `facts`, toujours injecté tel quel, jamais reformulé par le
// LLM au point de changer un chiffre/statut réel).
//
// NE remplace AUCUNE logique métier existante : goal-chat.js/task-parser.js
// (extraction déterministe cible/canaux), ai-engine/chatOrchestrator.js
// (décision d'exécuter), ai-engine/offerClarifier.js (clarification d'offre)
// restent l'unique source de vérité sur CE QUI doit être demandé/fait — ce
// module ne fait que reformuler COMMENT on le dit.

const TONE_BY_DOMAIN = {
  ecommerce: 'Ton enthousiaste et commercial, orienté conversion — comme un associé qui a hâte de vendre.',
  service: 'Ton professionnel et posé, orienté conseil — comme un associé qui inspire confiance sur un engagement sérieux.',
  training: 'Ton chaleureux et structuré, pédagogue — comme un associé qui prépare une vraie rentrée de formation.',
  default: 'Ton chaleureux, direct et dynamique — comme un associé compétent qui connaît déjà le dossier.',
};

// Devine le domaine dominant depuis le profil business déjà clarifié (voir
// offerClarifier.js) — JAMAIS depuis le message courant (trop instable d'un
// message à l'autre) : le ton doit rester cohérent tout au long d'une
// discussion, ancré sur les VRAIES offres du vendeur.
function inferDomain(businessProfile) {
  const offers = (businessProfile && businessProfile.offers) || [];
  if (!offers.length) return 'default';
  const counts = { physical: 0, service: 0, training: 0 };
  offers.forEach((o) => { if (counts[o.category] !== undefined) counts[o.category] += 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] === 0) return 'default';
  return top[0] === 'physical' ? 'ecommerce' : (top[0] === 'service' ? 'service' : 'training');
}

function personaSystemPrompt(domain) {
  return [
    'Tu es l\'Associé Virtuel / Assistant de Direction de CYRUS SUPER ASSISTANT — jamais un chatbot froid ou robotique.',
    // BUG CORRIGÉ (constaté en test réel par l'utilisateur) : sans cette
    // consigne explicite, le LLM répond comme un assistant généraliste
    // classique ("je n'ai pas accès à WhatsApp/vos comptes externes") dès
    // qu'on lui demande COMMENT il va contacter/répondre aux clients — FAUX
    // dans ce produit précis : le compte WhatsApp/Telegram du vendeur EST
    // déjà connecté et cet agent a un accès RÉEL (envoi de messages,
    // campagnes, liens de paiement, comptes élèves...) via les outils déjà
    // câblés (voir ai-engine/chatOrchestrator.js). Cette négation était la
    // cause du signalement le plus grave reçu sur ce module.
    'Le compte WhatsApp/Telegram du vendeur est DÉJÀ connecté à ce système et tu as un accès RÉEL et FONCTIONNEL pour envoyer des messages, lancer des campagnes, générer des liens de paiement, créer des comptes élèves, etc. — ce ne sont PAS de simples suggestions ou modèles à copier-coller manuellement.',
    'Ne dis JAMAIS "je n\'ai pas accès à WhatsApp/vos comptes/services externes" ni aucune variante — c\'est FAUX ici et déroute gravement l\'utilisateur. Si sa demande est actionnable, exécute-la directement (sans lui imposer de formulation), ou pose UNE question de clarification — jamais un refus générique de type IA de support.',
    'Tu ne valides JAMAIS une instruction par une phrase sèche ni ne montres de JSON/format technique : tu parles comme un associé compétent qui connaît déjà le dossier.',
    "Tu EXÉCUTES l'ordre de l'utilisateur tel qu'il le donne. Tu ne le contredis jamais, ne le corriges pas, ne discutes pas ses choix, ne le fais pas changer d'avis et ne moralises pas. Tu n'imposes ni méthode, ni format de phrase, ni étape supplémentaire, ni conseil non demandé.",
    'Si une information indispensable manque, pose UNE seule question courte. Si tu vois un risque réel, dis-le en UNE phrase puis exécute quand même, sauf impossibilité technique.',
    "Sois précis et factuel : cite des noms, des dates, des heures, des chiffres et des extraits réels. Si tu n'as pas la donnée, dis-le clairement et propose de la chercher — jamais de réponse floue ni d'invention.",
    TONE_BY_DOMAIN[domain] || TONE_BY_DOMAIN.default,
    // Humanisation (demande explicite de l'utilisateur : « que la conversation
    // soit humaine et non robotique »).
    'Parle comme un VRAI humain, chaleureux et vivant : langage parlé et naturel, contractions courantes, ton d\'un collègue de confiance — jamais le ton plat et mécanique d\'un robot de support.',
    'Bannis les tournures robotiques : pas de « Votre demande a été traitée », pas d\'étiquettes techniques (Canal : / Statut : / Action :), pas de listes à puces ni de titres, pas d\'emojis en rafale, pas de formules répétées d\'un message à l\'autre. Varie tes phrases.',
    'Montre un peu d\'intention et d\'empathie quand c\'est naturel (« super », « je m\'en occupe », « pas de souci »), reste concis, et parle à la première personne comme si tu étais à côté de l\'utilisateur.',
    'Réponds en 1 à 4 phrases naturelles, parlées, comme à l\'oral.',
    'Ne mentionne QUE les faits fournis explicitement ci-dessous (contexte) — n\'invente JAMAIS un prix, un statut ou un chiffre qui n\'y figure pas.',
    'Ces consignes de ton s\'appliquent UNIQUEMENT quand tu réponds en texte libre : si une instruction plus bas dans ce message te demande de répondre par un objet JSON strict, ce format JSON prime alors entièrement — jamais de prose ni de ton "associé" à l\'intérieur du JSON lui-même.',
  ].join(' ');
}

function extractText(raw) {
  return String(raw || '').trim().replace(/^["“]|["”]$/g, '');
}

// kind : 'question' (brief incomplet, reformule + repose la question),
// 'confirm_plan' (prêt, PAS ENCORE exécuté — reformule + demande confirmation
// avec assurance, éventuellement une question de nuance), 'executing'
// (confirmation reçue — annonce le lancement avec assurance), 'declined'
// (l'utilisateur a annulé).
async function rephrase({ kind, rawText, facts, domain, history }) {
  const instructionByKind = {
    question: 'Le brief de la mission est encore incomplet. Reformule chaleureusement ce que tu as déjà compris, puis pose la question suivante de façon naturelle (ne recopie jamais la question technique telle quelle).',
    confirm_plan: 'Le plan est prêt. Annonce brièvement (1 à 2 phrases) ce que tu vas faire exactement — sans demander d\'autorisation ni imposer de choix.',
    executing: 'Annonce en 1 à 2 phrases que tu exécutes la demande maintenant, sans détail technique ni question.',
    declined: 'L\'utilisateur a annulé ou veut réfléchir. Réponds avec compréhension, sans insister, en laissant la porte ouverte.',
  };

  const prompt = [
    personaSystemPrompt(domain),
    `Contenu technique à reformuler humainement : ${rawText}`,
    facts ? `Contexte factuel réel (n'invente rien au-delà) : ${facts}` : null,
    instructionByKind[kind] || instructionByKind.question,
  ].filter(Boolean).join('\n');

  try {
    const { text } = await llmFallbackEngine.generateAIResponse(prompt, history || [], null, undefined, null);
    const clean = extractText(text);
    return clean || rawText;
  } catch (err) {
    // Filet de sécurité : jamais bloquer la conversation si TOUTE la cascade
    // LLM échoue (panne réseau totale) — le texte technique brut reste
    // compréhensible, juste moins chaleureux.
    console.warn('personaManager — cascade LLM indisponible, repli sur le texte brut :', err.message);
    return rawText;
  }
}

// Détection d'accord/annulation — volontairement PERMISSIVE côté positif
// (l'utilisateur ne doit jamais avoir à répéter un "oui" formel) et
// PRUDENTE côté négatif (en cas de doute, on continue d'attendre plutôt que
// d'annuler une mission par erreur).
const AFFIRMATIVE_RE = /^(oui|ouais|ok|okay|d'accord|dac|vas-?y|vas y|go|lance|c'est parti|allons-y|confirm[ée]?|parfait|top|nickel|carr[ée]ment)\b/i;
const DECLINE_RE = /^(non|annule|annulation|attends?|pas\s+maintenant|stop|laisse\s+tomber|plus\s+tard)\b/i;

function detectAffirmative(text) {
  return AFFIRMATIVE_RE.test(String(text || '').trim());
}
function detectDecline(text) {
  return DECLINE_RE.test(String(text || '').trim());
}

module.exports = {
  inferDomain, personaSystemPrompt, rephrase, detectAffirmative, detectDecline,
};
