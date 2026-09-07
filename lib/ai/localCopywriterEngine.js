// Moteur de composition de réponses du Copywriter Studio IA — 100%
// autonome, embarqué, AUCUN appel à une API externe (pas d'IA générative
// distante) : une réponse est composée en piochant/assemblant du contenu
// dans lib/ai/marketingKnowledgeBase.js (savoir-faire marketing) et
// lib/ai/cyrusSupportGuide.js (support produit CYRUS) selon l'intention
// détectée dans le message (recherche de mots-clés, voir
// marketingKnowledgeBase#findTopics / cyrusSupportGuide#findGuide), jamais
// généré librement. C'est délibérément un système expert basé sur des
// règles, pas un modèle de langage : les réponses sont donc toujours
// exactes vis-à-vis de la base de connaissances, jamais "halluciné" — d'où
// l'absence d'un "system prompt" au sens LLM du terme : l'équivalent ici est
// ce pipeline de détection d'intention + composition ci-dessous.
const kb = require('./marketingKnowledgeBase');
const supportGuide = require('./cyrusSupportGuide');

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Tire N éléments distincts d'un pool, ordre aléatoire (voir le même motif
// côté dashboard, public/dashboard.html#smartTextGenerateVariant) — sert à
// ne pas toujours présenter les mêmes nuggets de connaissance dans le même
// ordre pour un même sujet.
function pickN(arr, n) {
  const pool = arr.slice();
  const picked = [];
  for (let i = 0; i < n && pool.length; i += 1) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

// ---------- Profil de l'interlocuteur (variateur de vocabulaire) ----------
// Détection légère et 100% locale du registre du message (aucune IA
// générative, simple analyse de marqueurs lexicaux/de ponctuation) pour
// adapter le VOCABULAIRE de la réponse — "Amical" (tutoiement, argot,
// émojis, ponctuation exclamative), "Pro" (vouvoiement, vocabulaire
// professionnel/administratif) ou "Direct" (message très court, sans
// marqueur de registre identifiable → on va droit au but). Volontairement
// simple : ce n'est PAS une analyse de sentiment, juste un choix de pool de
// formulations parmi celles déjà validées (voir OPENERS_BY_PROFILE ci-
// dessous), jamais une génération libre de texte.
const CASUAL_MARKERS_RE = /\b(tu|toi|ton|ta|tes|mdr|lol|ptdr|grave|trop|cool|frero|frère|pote|wesh|stp|dispo|carrément)\b|!{2,}|[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}]/iu;
const FORMAL_MARKERS_RE = /\b(vous|monsieur|madame|cordialement|société|entreprise|devis|facture|contrat|veuillez|pourriez[- ]vous)\b/i;

function detectToneProfile(text) {
  if (CASUAL_MARKERS_RE.test(text)) return 'amical';
  if (FORMAL_MARKERS_RE.test(text)) return 'pro';
  if (text.trim().length <= 25) return 'direct';
  return 'pro';
}

// ---------- Tons dynamiques (variateur de ton) ----------
// Chaque intention détectée (voir composeReply) sélectionne automatiquement
// le pool d'ouvertures/fermetures le plus adapté — "Amical" (salutations),
// "Business" (questions marketing), "Closing urgent" (intention d'achat) et
// "Support Technique" (guide pas-à-pas produit), plus un registre empathique
// dédié à la levée d'objections (règle 2 : traiter l'objection avec
// empathie). Auto-adaptatif par défaut ; rien n'empêche une sélection
// manuelle future en passant explicitement une catégorie à composeReply.
// Pour la catégorie [QUESTION] uniquement, le pool est en plus affiné par le
// profil détecté (detectToneProfile) — le ton de la catégorie prime toujours
// sur le profil pour les autres catégories (empathie/urgence/support restent
// non négociables), voir OPENERS_BY_PROFILE/CLOSERS_BY_PROFILE.
const OPENERS_BY_PROFILE = {
  amical: [
    'Carrément, voici ce que je te conseille :',
    'Ok top, on regarde ça ensemble :',
    'Bonne question ! Voici comment je ferais à ta place :',
  ],
  pro: [
    'Bonne question — voici ce que je recommande :',
    'Voici la stratégie la plus efficace pour votre cas :',
    "D'accord, on regarde ça ensemble. Voici les points clés :",
    'Voici mon conseil, basé sur les bonnes pratiques du secteur :',
  ],
  direct: [
    'Réponse concrète :',
    "Voici l'essentiel :",
    'Droit au but :',
  ],
};

const CLOSERS_BY_PROFILE = {
  amical: [
    'Tu veux que je détaille un point en particulier ?',
    "Dis-moi si tu veux un exemple concret prêt à l'emploi.",
    'Je peux aussi te préparer un message tout prêt si tu veux.',
  ],
  pro: [
    'Voulez-vous que je détaille un point en particulier ?',
    "Dites-moi si vous voulez un exemple concret prêt à l'emploi.",
    "Je peux aussi vous préparer un message prêt à envoyer si vous voulez — dites-le-moi.",
  ],
  direct: [
    'Un point précis à creuser ?',
    'Autre chose ?',
  ],
};

const EMPATHETIC_OPENERS = [
  'Je comprends totalement votre point, et c\'est une remarque légitime.',
  'Merci de le partager avec moi — voyons ça ensemble :',
  'C\'est une hésitation que je comprends parfaitement, regardons-la calmement :',
];

const REASSURING_CLOSERS = [
  'Ça répond à votre inquiétude ? Dites-moi si un doute subsiste.',
  'Voulez-vous qu\'on avance ensemble sur ce point maintenant ?',
  'Je reste juste là si vous voulez qu\'on creuse davantage.',
];

const CLOSING_OPENERS = [
  "Parfait, on passe à l'action tout de suite 🚀",
  'Excellente nouvelle — finalisons ça maintenant :',
  "On y est ! Voici comment conclure en moins de 2 minutes :",
];

const SUPPORT_CLOSERS = [
  'Dites-moi si un point précis coince encore, je peux détailler davantage.',
  'Ça débloque votre situation ? Sinon je creuse plus précisément avec vous.',
  "N'hésitez pas si une étape n'est pas claire, on la reprend ensemble.",
];

// Salutation en DÉBUT de message uniquement (règle 1 : toujours répondre à
// la salutation D'ABORD) — volontairement un préfixe, pas une correspondance
// stricte du message entier, pour capter aussi "salut, ça coûte combien ?"
// et pas seulement "salut" tout seul.
const GREETING_PREFIX_RE = /^\s*(salut|bonjour|coucou|hello|hey+|bonsoir|yo|slt|cc|bjr|bsr)\b[\s,!.:;-]*/i;

// Intention [CLOSING] (règle 2) : le prospect signale une intention d'achat
// ou de passage à l'action — volontairement large pour capter les
// formulations courantes en français.
const CLOSING_RE = /\b(je veux (l')?achet\w*|je suis (très |vraiment )?int[ée]ress[ée]|comment (je )?(fais |dois )?(pour )?payer|comment (on|je) (paie|r[ée]gl\w*)|comment (je )?commence|comment (on )?d[ée]marre|comment souscrire|comment m'inscrire|je prends|je valide|je fonce|c'est bon,? je|je suis pr[êe]t|on signe|prendre (un )?rendez[- ]vous|r[ée]server un appel|\brdv\b|je veux commencer|donnez[- ]moi le lien|envoyez[- ]moi le lien)\b/i;

// Extraction du prénom éventuellement communiqué par le prospect au fil de
// la discussion (historique + message courant) — filtre de contexte simple
// et 100% local, aucune inférence hasardeuse : ne se déclenche que sur des
// tournures explicites ("je m'appelle X", "moi c'est X"...).
const NAME_HINT_RE = /\b(?:je\s*m['’]?\s*appelle|moi\s*,?\s*c['’]?\s*est|mon\s+nom\s+est|ici)\s+([A-ZÀ-Ý][a-zà-ÿ'-]{1,20})\b/i;

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function extractFirstName(history, currentText) {
  const candidates = [];
  (Array.isArray(history) ? history : []).forEach((entry) => {
    if (entry && entry.role === 'user' && typeof entry.text === 'string') {
      candidates.push(entry.text);
    }
  });
  candidates.push(currentText);

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const match = NAME_HINT_RE.exec(candidates[i]);
    if (match) return capitalize(match[1]);
  }
  return null;
}

// Vocabulaire de salutation adapté au profil détecté (voir
// detectToneProfile) — tutoiement/argot pour "amical", vouvoiement complet
// pour "pro", formule courte pour "direct".
function greetingReplies(firstName, profile) {
  const suffix = firstName ? ` ${firstName}` : '';
  if (profile === 'amical') {
    return [
      `Salut${suffix} ! 😊 Content de te lire.`,
      `Yo${suffix} ! Qu'est-ce qui t'amène ?`,
      `Coucou${suffix} ! Dis-moi tout.`,
    ];
  }
  if (profile === 'direct') {
    return [
      `Bonjour${suffix}, je vous écoute.`,
      `Salut${suffix}. Dites-moi ce qu'il vous faut.`,
    ];
  }
  return [
    `Salut${suffix} ! 😊 Ravi de vous lire.`,
    `Coucou${suffix} ! Comment puis-je vous aider aujourd'hui ?`,
    `Hello${suffix} ! J'espère que vous allez bien.`,
    `Bonjour${suffix} ! Content d'échanger avec vous.`,
  ];
}

const FIELD_LABELS = {
  antiban: '🛡️ Anti-ban',
  hooks: '🎣 Hooks / accroches',
  structure: '🧱 Structure',
  landingPage: '📄 Landing page',
  whatsapp: '💬 WhatsApp',
  telegram: '✈️ Telegram',
  warmup: '🔥 Réchauffement',
  frequency: '⏱️ Fréquence',
  deliverability: '📶 Délivrabilité',
  tone: '🗣️ Ton',
  mobileMoney: '📱 Mobile Money',
  proximity: '🤝 Proximité',
  method: '📋 Méthode',
};

function formatList(items) {
  return items.map((item) => `• ${item}`).join('\n');
}

function formatSteps(items) {
  return items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
}

// Compose la section d'un topic "à plat" (tableaux directs : antiban/hooks/
// structure/... — voir facebook_ads/google_ads/tiktok_ads/one_to_one/
// anti_ban_channels/regional_west_africa) OU d'un topic à sous-frameworks
// (closing_frameworks : aida/pas/hso, chacun {name, steps}) — jamais les
// deux en même temps dans la base de connaissances actuelle, ce garde-fou
// couvre donc toute évolution future du KB sans changer ce moteur.
function sectionForTopic(topicKey) {
  const topic = kb.topics[topicKey];
  const lines = [`📚 ${topic.label}`];

  const arrayFields = Object.entries(topic).filter(([key, val]) => key !== 'label' && key !== 'keywords' && Array.isArray(val));
  const frameworkFields = Object.entries(topic).filter(([key, val]) => key !== 'label' && key !== 'keywords' && val && typeof val === 'object' && Array.isArray(val.steps));

  if (arrayFields.length) {
    pickN(arrayFields, Math.min(2, arrayFields.length)).forEach(([fieldName, items]) => {
      lines.push('');
      lines.push(FIELD_LABELS[fieldName] || fieldName);
      lines.push(formatList(pickN(items, Math.min(3, items.length))));
    });
  } else if (frameworkFields.length) {
    pickN(frameworkFields, Math.min(2, frameworkFields.length)).forEach(([, framework]) => {
      lines.push('');
      lines.push(`🔹 ${framework.name}`);
      lines.push(formatList(framework.steps));
    });
  }

  return lines.join('\n');
}

// [OBJECTION] (règle 2) : traitée avec empathie (ouverture/fermeture
// dédiées, voir EMPATHETIC_OPENERS/REASSURING_CLOSERS) et jamais en
// argumentant frontalement contre le prospect.
function composeObjectionReply(objection) {
  return [
    pick(EMPATHETIC_OPENERS),
    '',
    `🎯 Objection détectée : "${objection.phrase}"`,
    '',
    `🧠 Pourquoi elle apparaît : ${objection.reframe}`,
    '',
    `✅ Comment y répondre : ${objection.response}`,
    '',
    "💬 Exemple prêt à l'emploi :",
    objection.example,
    '',
    `📋 Méthode générale à garder en tête : ${pick(kb.topics.objections.method)}`,
    '',
    pick(REASSURING_CLOSERS),
  ].join('\n');
}

// [CLOSING] (règle 2) : le prospect est prêt à passer à l'action — on guide
// vers le paiement ou la prise de rendez-vous, sans détour ni pavé
// marketing générique.
function composeClosingReply() {
  return [
    pick(CLOSING_OPENERS),
    '',
    '🎯 Étapes pour finaliser dès maintenant :',
    formatSteps([
      "Confirmez l'offre/le forfait qui vous intéresse (je peux vous rappeler les options si besoin).",
      'Choisissez votre moyen de paiement (Mobile Money — Orange Money / Wave / MTN MoMo — ou carte bancaire selon disponibilité).',
      "Dès le paiement confirmé, l'accès est activé immédiatement — ou nous calons un rendez-vous si vous préférez en discuter d'abord.",
    ]),
    '',
    'Dites-moi simplement "je paie maintenant" ou "je préfère un appel" et on avance tout de suite.',
  ].join('\n');
}

// Support produit CYRUS (guide pas-à-pas, voir lib/ai/cyrusSupportGuide.js)
// — étapes exactes et actionnables, jamais une réponse vague, conformément
// au rôle de support client 24/7 attendu de l'assistant.
function composeSupportReply(guide) {
  return [
    guide.title,
    '',
    formatSteps(guide.steps),
    '',
    pick(SUPPORT_CLOSERS),
  ].join('\n');
}

const CAPABILITIES_INTRO = [
  "Je suis votre assistant marketing, closing, support technique & rédaction — 100% local, aucune donnée envoyée à l'extérieur. Je peux vous aider sur :",
  '',
  '• 📣 Ads & trafic payant : Facebook, Google, TikTok (hooks, structure, règles anti-ban, landing page)',
  "• 🤝 Closing & psychologie de vente : frameworks AIDA / PAS / Hook-Story-Offer, matrice de levée d'objections",
  '• 💬 Approche 1-to-1 WhatsApp/Telegram : ouverture, rythme, ton',
  "• 🛡️ Anti-ban & délivrabilité : réchauffement de numéro, fréquence d'envoi",
  "• 🌍 Adaptation Afrique de l'Ouest / francophone : ton de proximité, Mobile Money",
  '• 🛠️ Support CYRUS : connexion WhatsApp (QR/code d\'association), Spintax, Studio IA, générateur de livres PDF, Relance Express, installation PWA',
  '',
  'Posez-moi une question précise (ex: "comment répondre à *c\'est trop cher*", "structure d\'une pub Facebook", "mon QR code WhatsApp est rejeté") et je vous donne une réponse concrète.',
].join('\n');

function composeWelcomeReply() {
  return CAPABILITIES_INTRO;
}

function composeFallbackReply() {
  return [
    "Je n'ai pas identifié de sujet précis dans votre message — voici ce sur quoi je peux vous aider concrètement :",
    '',
    CAPABILITIES_INTRO,
  ].join('\n');
}

// Point d'entrée principal : compose une réponse d'assistant à partir d'un
// message libre, en 2 temps conformes à la feuille de route CYRUS :
//   1. Analyse d'intention en 4 catégories — [GREETING] / [QUESTION] /
//      [OBJECTION] / [CLOSING] (+ le sous-cas [SUPPORT], une question
//      spécifique au fonctionnement de CYRUS lui-même, traitée en priorité
//      dès qu'elle est identifiée car plus actionnable qu'une réponse
//      marketing générique).
//   2. Composition de la réponse avec le ton adapté à l'intention détectée.
// `history` (optionnel) : messages précédents de la session ({role, text}),
// utilisé uniquement pour retrouver un prénom explicitement communiqué par
// le prospect (filtre de contexte, voir extractFirstName) — jamais pour
// deviner ou halluciner une information non dite.
// Retourne { text, matchedTopics, category }.
function composeReply(userMessage, history) {
  const text = String(userMessage || '').trim();
  if (!text) {
    return { text: composeWelcomeReply(), matchedTopics: [], category: 'GREETING' };
  }

  const firstName = extractFirstName(history, text);
  const profile = detectToneProfile(text);

  // Règle 1 : une salutation en tête de message DOIT toujours être reconnue
  // et saluée en premier, avant tout traitement du reste de la demande.
  const greetingMatch = GREETING_PREFIX_RE.exec(text);
  const remainder = greetingMatch ? text.slice(greetingMatch[0].length).trim() : text;

  if (greetingMatch && !remainder) {
    return { text: `${pick(greetingReplies(firstName, profile))}\n\n${CAPABILITIES_INTRO}`, matchedTopics: [], category: 'GREETING' };
  }

  const analysisText = remainder || text;
  const greetingPrefix = greetingMatch ? pick(greetingReplies(firstName, profile)) : null;

  const guide = supportGuide.findGuide(analysisText);
  const objection = kb.findObjection(analysisText);
  const topicKeys = kb.findTopics(analysisText);
  const isClosing = CLOSING_RE.test(analysisText);

  let body;
  let matchedTopics = [];
  let category;

  if (guide) {
    // [QUESTION] spécifique au produit CYRUS lui-même — priorité sur le
    // reste : une question technique bloquante est toujours plus urgente
    // qu'une réponse marketing générique (rôle de support client 24/7).
    body = composeSupportReply(guide);
    category = 'SUPPORT';
  } else if (isClosing) {
    body = composeClosingReply();
    category = 'CLOSING';
  } else if (objection && (topicKeys.length === 0 || topicKeys.includes('objections'))) {
    // Une objection est un signal fort et spécifique (voir
    // marketingKnowledgeBase#findObjection) : elle prime dès qu'elle
    // matche, que le message évoque aussi "objections" en tant que sujet
    // général ou pas d'autre sujet du tout.
    body = composeObjectionReply(objection);
    matchedTopics = ['objections'];
    category = 'OBJECTION';
  } else if (topicKeys.length > 0) {
    const chosenTopics = topicKeys.slice(0, 2);
    const lines = [pick(OPENERS_BY_PROFILE[profile]), ''];
    chosenTopics.forEach((key, idx) => {
      if (idx > 0) lines.push('');
      lines.push(sectionForTopic(key));
    });
    lines.push('');
    lines.push(pick(CLOSERS_BY_PROFILE[profile]));
    body = lines.join('\n');
    matchedTopics = chosenTopics;
    category = 'QUESTION';
  } else {
    body = composeFallbackReply();
    category = 'UNKNOWN';
  }

  const finalText = greetingPrefix ? `${greetingPrefix}\n\n${body}` : body;
  return { text: finalText, matchedTopics, category };
}

// Titre dynamique d'une discussion (voir lib/aiStudioStore.js), dérivé du
// PREMIER message utilisateur uniquement — jamais recalculé ensuite, pour
// qu'une discussion garde un titre stable au fil de l'échange.
function generateSessionTitle(firstMessage) {
  const text = String(firstMessage || '').trim();
  if (!text) return 'Nouvelle discussion';

  const guide = supportGuide.findGuide(text);
  if (guide) return guide.title.replace(/^\S+\s+/, '');

  const objection = kb.findObjection(text);
  if (objection) return `Objection : ${capitalize(objection.phrase)}`;

  const topicKeys = kb.findTopics(text);
  if (topicKeys.length) return kb.topics[topicKeys[0]].label;

  const words = text.split(/\s+/).slice(0, 6).join(' ');
  return words.length < text.length ? `${words}…` : words;
}

module.exports = {
  composeReply,
  generateSessionTitle,
};
