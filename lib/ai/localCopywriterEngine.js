// Moteur de composition de réponses du Copywriter Studio IA — 100%
// autonome, embarqué, AUCUN appel à une API externe (pas d'IA générative
// distante) : une réponse est composée en piochant/assemblant du contenu
// dans lib/ai/marketingKnowledgeBase.js selon l'intention détectée dans le
// message (recherche de mots-clés, voir marketingKnowledgeBase#findTopics),
// jamais généré librement. C'est délibérément un système expert basé sur
// des règles, pas un modèle de langage : les réponses sont donc toujours
// exactes vis-à-vis de la base de connaissances, jamais "halluciné".
const kb = require('./marketingKnowledgeBase');

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

const OPENERS = [
  'Bonne question — voici ce que je recommande :',
  'Voici la stratégie la plus efficace pour votre cas :',
  "D'accord, on regarde ça ensemble. Voici les points clés :",
  'Voici mon conseil, basé sur les bonnes pratiques du secteur :',
  'Voici comment je structurerais ça :',
];

const CLOSERS = [
  'Voulez-vous que je détaille un point en particulier ?',
  "Dites-moi si vous voulez un exemple concret prêt à l'emploi.",
  "Je peux aussi vous préparer un message prêt à envoyer si vous voulez — dites-le-moi.",
  'Une question précise sur un de ces points ?',
  "N'hésitez pas si vous voulez qu'on creuse un aspect précis.",
];

const GREETING_ONLY_RE = /^(salut|bonjour|hello|coucou|hey|bonsoir|yo)\s*[!.,]?\s*$/i;

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

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
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

function composeObjectionReply(objection) {
  return [
    pick(OPENERS),
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
    pick(CLOSERS),
  ].join('\n');
}

const CAPABILITIES_INTRO = [
  "Je suis votre assistant marketing, closing & rédaction — 100% local, aucune donnée envoyée à l'extérieur. Je peux vous aider sur :",
  '',
  '• 📣 Ads & trafic payant : Facebook, Google, TikTok (hooks, structure, règles anti-ban, landing page)',
  "• 🤝 Closing & psychologie de vente : frameworks AIDA / PAS / Hook-Story-Offer, matrice de levée d'objections",
  '• 💬 Approche 1-to-1 WhatsApp/Telegram : ouverture, rythme, ton',
  "• 🛡️ Anti-ban & délivrabilité : réchauffement de numéro, fréquence d'envoi",
  "• 🌍 Adaptation Afrique de l'Ouest / francophone : ton de proximité, Mobile Money",
  '',
  'Posez-moi une question précise (ex: "comment répondre à *c\'est trop cher*", "structure d\'une pub Facebook", "comment réchauffer un numéro WhatsApp") et je vous donne une stratégie concrète.',
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
// message libre. Retourne { text, matchedTopics } — matchedTopics sert aussi
// à générer un titre de discussion pertinent (voir generateSessionTitle).
function composeReply(userMessage) {
  const text = String(userMessage || '').trim();
  if (!text) {
    return { text: composeWelcomeReply(), matchedTopics: [] };
  }

  if (GREETING_ONLY_RE.test(text)) {
    return { text: composeWelcomeReply(), matchedTopics: [] };
  }

  const objection = kb.findObjection(text);
  const topicKeys = kb.findTopics(text);

  // Une objection est un signal fort et spécifique (voir
  // marketingKnowledgeBase#findObjection) : elle prime dès qu'elle matche,
  // que le message évoque aussi "objections" en tant que sujet général ou
  // pas d'autre sujet du tout.
  if (objection && (topicKeys.length === 0 || topicKeys.includes('objections'))) {
    return { text: composeObjectionReply(objection), matchedTopics: ['objections'] };
  }

  if (topicKeys.length === 0) {
    return { text: composeFallbackReply(), matchedTopics: [] };
  }

  const chosenTopics = topicKeys.slice(0, 2);
  const lines = [pick(OPENERS), ''];
  chosenTopics.forEach((key, idx) => {
    if (idx > 0) lines.push('');
    lines.push(sectionForTopic(key));
  });
  lines.push('');
  lines.push(pick(CLOSERS));

  return { text: lines.join('\n'), matchedTopics: chosenTopics };
}

// Titre dynamique d'une discussion (voir lib/aiStudioStore.js), dérivé du
// PREMIER message utilisateur uniquement — jamais recalculé ensuite, pour
// qu'une discussion garde un titre stable au fil de l'échange.
function generateSessionTitle(firstMessage) {
  const text = String(firstMessage || '').trim();
  if (!text) return 'Nouvelle discussion';

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
