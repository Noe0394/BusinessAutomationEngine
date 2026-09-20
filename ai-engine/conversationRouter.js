// CONVERSATION ROUTER — ai-engine/conversationRouter.js
// ---------------------------------------------------------------------------
// Couche générale d'assistance du compte de l'utilisateur : chaque message entrant (WhatsApp/Telegram) est identifié,
// classé (métier / privé / urgent…), puis une DÉCISION est prise :
//   BUSINESS            -> conversation commerciale/client : le moteur existant (autoResponder / Jarvis) prend la suite.
//   AUTO_REPLY          -> réponse automatique sûre (salutation, remerciement, accusé de réception).
//   AUTO_REPLY_NOTIFY   -> réponse automatique + notification du propriétaire (politique configurable).
//   HUMAN_REQUIRED      -> le propriétaire doit intervenir : alerte immédiate + éventuelle réponse d'attente naturelle.
//   SILENT              -> rien à répondre (« ok », émoticône, groupe, propriétaire déjà en train de répondre…).
//
// PRINCIPES : jamais d'invention (position, horaires, décisions, famille, engagements) ; en cas de doute, on n'invente
// pas — on prévient le propriétaire. La classification combine plusieurs signaux (contenu, historique, contexte CRM,
// fil de conversation privé en cours) et, si la confiance est faible, une arbitrage IA optionnel qui ne peut que RENFORCER
// la prudence (il ne débloque jamais une réponse automatique sur un sujet sensible).

const { norm } = require('./jarvis/intentClassifier');
const intentClassifier = require('./jarvis/intentClassifier');
const conversationState = require('./jarvis/conversationState');
const alertCenter = require('./alertCenter');
const contactIdentity = require('./contactIdentity');

const CATEGORIES = [
  'PRIVATE_CASUAL', 'PRIVATE_PERSONAL', 'PRIVATE_SENSITIVE', 'GENERAL_INFORMATION', 'URGENT', 'CALLBACK_REQUEST',
  'BUSINESS_LEAD', 'CUSTOMER_SUPPORT', 'PAYMENT_PROOF', 'PAYMENT_VALIDATION', 'CAMPAIGN', 'SERVICE_REQUEST',
  'OWNER_COMMAND', 'HUMAN_INTERVENTION_REQUIRED', 'OTHER',
];
const HANDOFF = ['AI_ACTIVE', 'AI_WITH_OWNER_NOTIFICATION', 'HUMAN_REQUIRED', 'HUMAN_ACTIVE', 'AI_RESUMED'];

const THREAD_TTL_MS = 45 * 60 * 1000;          // un fil privé sensible reste « chaud » 45 min
const HUMAN_REQUIRED_TTL_MS = 24 * 3600 * 1000; // sans reprise du propriétaire, l'IA reprend après 24 h
const WAITING_REPLY_GAP_MS = 30 * 60 * 1000;    // au plus une réponse d'attente par 30 min et par conversation

const R = (src) => new RegExp(`(?:^|\\s)(?:${src})(?=\\s|$|[?!])`);
const S = {
  greeting: R('bonjour|bonsoir|salut|slt|coucou|cc|hello|hey|hi|bjr|bsr|salam|yo'),
  howAreYou: R('ca va|comment (?:vas|allez) (?:tu|vous)|tu vas bien|vous allez bien|comment ca va|la forme|quoi de neuf|comment tu vas|how are you'),
  thanks: R('merci(?: beaucoup| bien)?|thanks|thank you|thx'),
  ack: R('bien recu|c est note|note|recu|ok merci|d accord merci|ok|okay|d accord|dac|entendu|parfait|top|super|compris|bonne (?:nuit|journee|soiree)|a plus|a demain|bisous'),
  sentDoc: R('je t ai envoye|je vous ai envoye|je viens de t envoyer|je te l ai envoye|voila le|voici le|regarde le (?:document|fichier|message)'),
  urgent: R('urgent\\w*|urgence|vite|au secours|accident|hopital|a l hopital|malade|tres malade|decede\\w*|deces|est mort\\w*|police|incendie|danger|tout de suite|immediatement|asap'),
  callback: R('rappelle(?: moi)?|rappel|appelle(?: moi)?|peux tu m appeler|tu peux m appeler|peux tu me rappeler|tu peux me rappeler|call me|rappelez moi|appelez moi|un appel'),
  whereabouts: R('tu es ou|t es ou|es tu ou|ou es tu|ou es tu|tu es la|t es la|tu es chez|t es chez|tu es a la maison|tu vas ou|tu fais quoi|que fais tu|tu es libre|tu es dispo|tu es disponible|t es dispo|t es libre|tu seras (?:dispo|disponible|libre)|quand (?:es tu|seras tu|tu seras|tu es) (?:dispo|disponible|libre|la)|quand est ce que tu (?:seras|es)|dis moi quand'),
  availability: R('dispo|disponible|libre|occupe\\w*'),
  family: R('ta maman|ton papa|ta mere|ton pere|ta famille|ton frere|ta soeur|ton mari|ta femme|ton epouse|ton epoux|tes parents|tes enfants|ta fille|ton fils|tes freres|tes soeurs|ta tante|ton oncle|ta grand mere|ton grand pere|ta belle famille|ta cherie|ton cheri|ta copine|ton copain|ta petite amie|ton petit ami|chez toi|a la maison|a la concession|au village'),
  secret: R('affaire personnelle|en prive|confidentiel\\w*|secret|important a te dire|quelque chose d important|un truc important|il faut qu on parle|faut qu on parle|faut qu on se parle|j ai (?:un|une) (?:probleme|souci|chose)|probleme avec|souci avec|je dois te parler|je dois te dire|on doit parler|c est grave|c est serieux|j ai besoin de te parler'),
  money: R('prete moi|pret|emprunt\\w*|dette|rembourse\\w*|te devoir|envoie moi (?:de l )?argent|besoin d argent|un petit geste|depanner|me depanner|cotisation'),
  commitment: R('tu m avais (?:dit|promis|demande)|tu avais dit|tu avais promis|tu peux me confirmer|tu te rappelles|tu te souviens|comme convenu|comme prevu|hier tu|ce que tu avais dit|ce que tu m as dit'),
  favor: R('rendre (?:un |ce |le |ton )?service|un service|ce service|coup de main|tu peux m aider|peux tu m aider|peux tu me|tu peux me (?:preter|donner|ramener|deposer|envoyer|passer)|j ai besoin de toi|j ai besoin que tu'),
  question: /\?/,
  businessWords: R('prix|tarifs?|combien|cout\\w*|formation\\w*|inscri\\w+|inscription|commande\\w*|acheter|achat|payer|paiement|paye|service\\w*|devis|catalogue|produits?|promo\\w*|offres?|livraison|cours|certificat\\w*|programme|session|abonnement|facture|recu de paiement|mobile money|orange money|wave|moov'),
};

const CASUAL_CATS = new Set(['PRIVATE_CASUAL']);
const HUMAN_CATS = new Set(['PRIVATE_PERSONAL', 'PRIVATE_SENSITIVE', 'URGENT', 'CALLBACK_REQUEST', 'HUMAN_INTERVENTION_REQUIRED']);

function has(re, n) { return re.test(n); }
function excerpt(t, n) { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function hash(str) { let h = 0; const s = String(str || ''); for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }
function isEnglish(n) { return /(?:^|\s)(?:hello|hi|hey|thanks|thank you|where are you|call me|are you|how are you|please|can you|available)(?=\s|$|[?!])/.test(n) && !/(?:^|\s)(?:bonjour|salut|merci|tu es|ca va|stp|s il te plait)(?=\s|$)/.test(n); }
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s!.]+$/u;

// ---------------------------------------------------------------------------
// Classification déterministe multi-signaux. Retourne { category, confidence, reason, signals, sensitivity }.
// `ctx` : { crmContact, state, history, isGroup, hasAttachment }
// ---------------------------------------------------------------------------
function classify(text, ctx) {
  const c = ctx || {};
  const raw = String(text || '').trim();
  const n = norm(raw);
  const signals = [];
  const out = (category, confidence, reason, sensitivity) => ({ category, confidence, reason, sensitivity: sensitivity || 'none', signals });

  if (!n) {
    if (raw && EMOJI_ONLY.test(raw)) return out('PRIVATE_CASUAL', 0.9, 'emoji seul', 'none');
    return c.hasAttachment ? out('OTHER', 0.4, 'pièce jointe sans texte', 'low') : out('OTHER', 0.3, 'message vide', 'none');
  }

  const tags = (c.crmContact && c.crmContact.tags) || [];
  const businessContext = tags.includes('client') || tags.includes('prospect') || (c.crmContact && c.crmContact.stage && !['new', undefined].includes(c.crmContact.stage))
    || (c.state && c.state.state && !['NEW', 'DISCOVERY'].includes(c.state.state) && c.state.turns > 0);
  if (businessContext) signals.push('contexte_commercial_connu');

  // Signaux forts, par ordre de gravité.
  const urgent = has(S.urgent, n);
  const secret = has(S.secret, n);
  const money = has(S.money, n);
  const family = has(S.family, n);
  const callback = has(S.callback, n);
  const where = has(S.whereabouts, n) || (has(S.availability, n) && S.question.test(raw));
  const commit = has(S.commitment, n);
  const favor = has(S.favor, n);
  // « rendre (ce/un) service », « un coup de main » sont des services PERSONNELS, pas du vocabulaire métier.
  const nBiz = n.replace(/(?:rendre|me rendre|nous rendre)\s+(?:ce|un|le|ton)\s+service|un service|ce service/g, ' ');
  const biz = has(S.businessWords, nBiz);
  [['urgent', urgent], ['secret', secret], ['argent', money], ['famille', family], ['rappel', callback], ['disponibilite', where], ['engagement', commit], ['service', favor], ['metier', biz]]
    .forEach(([k, v]) => { if (v) signals.push(k); });

  // Fil privé sensible en cours : une réponse brève (« oui », « stp », « dis-moi ») hérite de la sensibilité.
  const thread = c.state && c.state.private;
  const threadHot = thread && HUMAN_CATS.has(thread.category) && Date.now() - (thread.at || 0) < THREAD_TTL_MS;

  if (urgent) return out('URGENT', 0.9, 'signal d\'urgence', 'high');
  if (secret || (family && S.question.test(raw)) || money) return out('PRIVATE_SENSITIVE', 0.85, secret ? 'sujet personnel/confidentiel' : (money ? 'demande d\'argent/dette' : 'question sur la famille'), 'high');
  if (callback && !biz) return out('CALLBACK_REQUEST', 0.85, 'demande de rappel', 'medium');
  if (family) return out('PRIVATE_PERSONAL', 0.8, 'mention de la famille', 'medium');
  if ((where || commit || favor) && !biz) return out('PRIVATE_PERSONAL', 0.8, where ? 'question sur la position/disponibilité du propriétaire' : (commit ? 'référence à un engagement passé' : 'demande de service personnel'), 'medium');
  if (threadHot && raw.length < 60) return out('HUMAN_INTERVENTION_REQUIRED', 0.7, 'suite d\'un fil privé nécessitant le propriétaire', 'medium');

  // Contexte métier : mots-clés OU relation commerciale connue avec une vraie demande.
  const cls = intentClassifier.classify(raw, { state: c.state });
  const commercialIntents = new Set(['INTEREST', 'REQUEST_INFORMATION', 'REQUEST_MORE_INFORMATION', 'PURCHASE_INTENT', 'PAYMENT_INTENT', 'PRICE_OBJECTION', 'OBJECTION', 'HESITATION', 'REFUSAL', 'DISINTEREST', 'STOP', 'CANCELLATION', 'SUPPORT', 'COMPLAINT', 'REQUEST_TIME', 'LATER']);
  if (businessContext && commercialIntents.has(cls.intent)) return out(cls.intent === 'SUPPORT' || cls.intent === 'COMPLAINT' ? 'CUSTOMER_SUPPORT' : 'BUSINESS_LEAD', 0.8, 'contexte commercial + intention métier', 'none');
  if (biz && (commercialIntents.has(cls.intent) || S.question.test(raw))) {
    return out(cls.intent === 'PAYMENT_INTENT' ? 'PAYMENT_PROOF' : (cls.intent === 'SUPPORT' ? 'CUSTOMER_SUPPORT' : 'BUSINESS_LEAD'), 0.75, 'vocabulaire métier + demande', 'none');
  }
  if (businessContext && !S.question.test(raw) && raw.length > 25) return out('BUSINESS_LEAD', 0.55, 'contexte commercial, message libre', 'none');

  // Conversation quotidienne banale.
  const short = n.split(' ').length <= 8;
  if (short && !S.question.test(raw.replace(/ca va \?|tu vas bien \?|comment vas tu \?/gi, ''))
    && (has(S.greeting, n) || has(S.howAreYou, n) || has(S.thanks, n) || has(S.ack, n) || has(S.sentDoc, n))) {
    return out('PRIVATE_CASUAL', 0.85, 'salutation/remerciement/accusé', 'none');
  }
  if (short && (has(S.greeting, n) || has(S.howAreYou, n))) return out('PRIVATE_CASUAL', 0.8, 'salutation avec question de politesse', 'none');
  if (has(S.thanks, n) || has(S.sentDoc, n)) return out('PRIVATE_CASUAL', 0.7, 'remerciement/envoi', 'none');

  // Question ou demande sans signal reconnu : on ne sait pas y répondre -> le propriétaire.
  if (S.question.test(raw)) return out('HUMAN_INTERVENTION_REQUIRED', 0.6, 'question que Cyrus ne peut pas traiter sans inventer', 'medium');
  if (raw.length >= 40) return out('HUMAN_INTERVENTION_REQUIRED', 0.5, 'message libre trop ouvert pour une réponse sûre', 'medium');
  return out('OTHER', 0.4, 'message ambigu', 'low');
}

// Arbitrage IA optionnel pour les cas peu fiables : il ne peut que renforcer la prudence.
async function arbitrate(base, text, llm) {
  if (!llm || base.confidence >= 0.65 || String(text || '').length < 12) return base;
  const prompt = [
    'Tu aides le propriétaire d\'un compte WhatsApp. Classe le message reçu. Réponds UNIQUEMENT en JSON :',
    '{"category":"PRIVATE_CASUAL|PRIVATE_PERSONAL|PRIVATE_SENSITIVE|BUSINESS_LEAD|URGENT|CALLBACK_REQUEST|OTHER","needsOwner":true|false}',
    'needsOwner = true si répondre exige une information que seul le propriétaire connaît (position, agenda, famille, décision, engagement) ou si le sujet est personnel/sensible/ambigu.',
    `Message : "${String(text).slice(0, 400)}"`,
  ].join('\n');
  try {
    const raw = await llm(prompt);
    const s = String(raw || ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    const j = a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null;
    if (!j || !CATEGORIES.includes(j.category)) return base;
    if (j.needsOwner || HUMAN_CATS.has(j.category)) {
      const cat = HUMAN_CATS.has(j.category) ? j.category : 'HUMAN_INTERVENTION_REQUIRED';
      return Object.assign({}, base, { category: cat, confidence: 0.7, reason: 'arbitrage IA : intervention du propriétaire', sensitivity: base.sensitivity === 'none' ? 'medium' : base.sensitivity, arbitrated: true });
    }
    if (j.category === 'BUSINESS_LEAD' && base.category !== 'BUSINESS_LEAD') return Object.assign({}, base, { category: 'BUSINESS_LEAD', confidence: 0.65, reason: 'arbitrage IA : demande métier', arbitrated: true });
    return base; // jamais de déblocage automatique d'une réponse sur avis IA seul
  } catch (e) { return base; }
}

// ---------------------------------------------------------------------------
// Décision (pure) à partir de la classification, de l'état et de la politique.
// ---------------------------------------------------------------------------
function decide(cls, ctx) {
  const c = ctx || {};
  const st = c.state || {};
  const handoff = st.handoff || {};
  const now = c.now || Date.now();
  const policy = c.policy || {};
  const base = {
    category: cls.category, confidence: cls.confidence, reason: cls.reason, sensitivityLevel: cls.sensitivity,
    automaticReplyAllowed: false, ownerNotificationRequired: false, humanInterventionRequired: false,
  };

  if (c.isGroup) return Object.assign(base, { mode: 'SILENT', reason: 'groupe : aucune réponse ni alerte automatique' , ownerNotificationRequired: policy.groupAlerts === true });
  if (cls.category === 'OWNER_COMMAND') return Object.assign(base, { mode: 'SILENT', reason: 'commande propriétaire non acceptée depuis une conversation externe' });

  // Métier : le moteur existant prend le relais (aucune logique privée appliquée).
  if (['BUSINESS_LEAD', 'CUSTOMER_SUPPORT', 'PAYMENT_PROOF', 'PAYMENT_VALIDATION', 'CAMPAIGN', 'SERVICE_REQUEST', 'GENERAL_INFORMATION'].includes(cls.category)) {
    return Object.assign(base, { mode: 'BUSINESS', automaticReplyAllowed: true });
  }

  // Le propriétaire a repris la conversation : l'automatisation se tait.
  const humanActive = (st.humanUntil && st.humanUntil > now) || (handoff.state === 'HUMAN_ACTIVE' && (!handoff.until || handoff.until > now));
  if (humanActive) return Object.assign(base, { mode: 'SILENT', reason: 'le propriétaire est actif dans cette conversation (HUMAN_ACTIVE)' });

  // Conversation déjà escaladée : on ne répète pas la réponse d'attente, on agrège l'alerte.
  const humanRequired = handoff.state === 'HUMAN_REQUIRED' && (now - (handoff.at || 0) < HUMAN_REQUIRED_TTL_MS);

  if (HUMAN_CATS.has(cls.category) || (humanRequired && cls.category !== 'PRIVATE_CASUAL')) {
    const waitingOk = policy.waitingReply !== false && !(humanRequired && now - (handoff.lastWaitingReplyAt || 0) < WAITING_REPLY_GAP_MS);
    return Object.assign(base, {
      mode: 'HUMAN_REQUIRED', humanInterventionRequired: true, ownerNotificationRequired: true,
      sendWaitingReply: waitingOk,
    });
  }

  if (CASUAL_CATS.has(cls.category)) {
    // Pendant une escalade, un simple « ok/merci » ne relance pas d'échange automatique.
    if (humanRequired) return Object.assign(base, { mode: 'SILENT', reason: 'escalade en cours : pas de réponse automatique' });
    const notify = policy.notifyCasual === true;
    return Object.assign(base, { mode: notify ? 'AUTO_REPLY_NOTIFY' : 'AUTO_REPLY', automaticReplyAllowed: true, ownerNotificationRequired: notify });
  }

  // OTHER / ambigu : on ne devine pas.
  return Object.assign(base, { mode: 'HUMAN_REQUIRED', humanInterventionRequired: true, ownerNotificationRequired: true, sendWaitingReply: policy.waitingReply !== false && !humanRequired });
}

// ---------------------------------------------------------------------------
// Réponses : sûres, naturelles, non répétitives, sans aucune invention.
// ---------------------------------------------------------------------------
const CASUAL_FR = {
  greetingHow: ['Salut ! Ça va bien, merci 😊 Et toi ?', 'Coucou ! Oui ça va, merci 🙂 Et de ton côté ?', 'Salut 😊 Ça va bien, merci ! Et toi, comment vas-tu ?'],
  greeting: ['Salut ! 😊', 'Bonjour ! 🙂', 'Coucou ! Comment vas-tu ?'],
  thanks: ['Avec plaisir 😊', 'Je t\'en prie 🙂', 'De rien !'],
  ack: ['Bien reçu, merci ! 👍', 'C\'est bien noté, merci 🙂', 'Message bien reçu, merci !'],
  sentDoc: ['Bien reçu, merci ! 👍', 'Merci, c\'est bien reçu 🙂', 'Message bien reçu, merci !'],
  bye: ['À bientôt ! 🙂', 'Bonne journée à toi aussi 😊', 'À plus tard !'],
};
const CASUAL_EN = {
  greetingHow: ['Hi! I\'m doing well, thanks 😊 And you?', 'Hey! All good, thank you 🙂 How about you?'],
  greeting: ['Hi! 😊', 'Hello! 🙂'], thanks: ['You\'re welcome 😊', 'No problem!'],
  ack: ['Got it, thanks! 👍', 'Message received, thank you 🙂'], sentDoc: ['Received, thank you! 👍'], bye: ['See you soon! 🙂'],
};
const WAIT_FR = {
  generic: ['Je vais lui transmettre ton message.', 'Je lui fais parvenir ton message, il te répondra dès qu\'il sera disponible.', 'Je note ton message et je le lui transmets.'],
  personal: ['Je lui transmets ton message, il te répondra directement.', 'Je préfère demander à mon utilisateur de te répondre directement. Je lui transmets ton message.', 'Je vais lui signaler que tu souhaites lui parler directement.'],
  callback: ['Je lui signale que tu souhaites qu\'il te rappelle.', 'Je lui transmets ta demande de rappel, il reviendra vers toi dès qu\'il le peut.'],
  urgent: ['Je le préviens tout de suite.', 'J\'alerte immédiatement mon utilisateur, il te répondra dès que possible.'],
};
const WAIT_EN = {
  generic: ['I\'ll pass your message on to him.', 'I\'ll let him know, he\'ll get back to you as soon as he can.'],
  personal: ['I\'ll pass this on, he\'ll reply to you directly.'], callback: ['I\'ll let him know you\'d like a call back.'], urgent: ['I\'m alerting him right now.'],
};

function pick(pool, seed, recent) {
  const used = new Set((recent || []).map((r) => String(r).trim()));
  const fresh = pool.filter((p) => !used.has(p));
  const list = fresh.length ? fresh : null;
  return list ? list[hash(seed) % list.length] : null; // tout est déjà récent : on ne répète pas
}

function casualReply(text, { seed, recentReplies }) {
  const n = norm(text);
  const en = isEnglish(n);
  const pools = en ? CASUAL_EN : CASUAL_FR;
  let key = 'ack';
  if (has(S.thanks, n) && !has(S.greeting, n)) key = 'thanks';
  else if (has(S.greeting, n) && has(S.howAreYou, n)) key = 'greetingHow';
  else if (has(S.howAreYou, n)) key = 'greetingHow';
  else if (has(S.greeting, n)) key = 'greeting';
  else if (has(S.sentDoc, n)) key = 'sentDoc';
  else if (/(?:^|\s)(?:bonne (?:nuit|journee|soiree)|a plus|a demain|bisous)(?=\s|$)/.test(n)) key = 'bye';
  // « ok » / « d'accord » seuls : rien à répondre (évite les échanges sans fin).
  if (/^(?:ok|okay|d accord|dac|entendu|parfait|top|super|compris|recu|note)(?: merci)?$/.test(n) && !/merci/.test(n)) return null;
  return pick(pools[key], seed, recentReplies);
}

function waitingReply(category, text, { seed, recentReplies }) {
  const n = norm(text);
  const pools = isEnglish(n) ? WAIT_EN : WAIT_FR;
  const key = category === 'URGENT' ? 'urgent' : (category === 'CALLBACK_REQUEST' ? 'callback' : (category === 'PRIVATE_SENSITIVE' || category === 'PRIVATE_PERSONAL' ? 'personal' : 'generic'));
  return pick(pools[key], seed, recentReplies) || pools[key][hash(seed) % pools[key].length];
}

// ---------------------------------------------------------------------------
// Handoff (AI_ACTIVE | AI_WITH_OWNER_NOTIFICATION | HUMAN_REQUIRED | HUMAN_ACTIVE | AI_RESUMED)
// ---------------------------------------------------------------------------
async function setHandoff(tenantId, channel, from, state, extra) {
  const st = await conversationState.get(tenantId, channel, from);
  st.handoff = Object.assign({}, st.handoff || {}, { state, at: Date.now() }, extra || {});
  await conversationState.save(st);
  return st.handoff;
}
async function getHandoff(tenantId, channel, from) {
  const st = await conversationState.get(tenantId, channel, from);
  return st.handoff || { state: 'AI_ACTIVE' };
}
// Le propriétaire reprend la main (ou rend la main à l'IA).
async function noteOwnerTookOver(tenantId, channel, from, minutes) {
  const until = Date.now() + (Number(minutes) > 0 ? Number(minutes) : 60) * 60 * 1000;
  const st = await conversationState.get(tenantId, channel, from);
  st.humanUntil = until;
  st.private = null; // le fil privé est désormais géré par le propriétaire
  st.handoff = Object.assign({}, st.handoff || {}, { state: 'HUMAN_ACTIVE', at: Date.now(), until });
  await conversationState.save(st);
  return until;
}
async function resumeAutomation(tenantId, channel, from) {
  const st = await conversationState.get(tenantId, channel, from);
  st.humanUntil = 0;
  st.private = null;
  st.handoff = { state: 'AI_RESUMED', at: Date.now() };
  await conversationState.save(st);
  return st.handoff;
}

// Conversations qui attendent le propriétaire (états réels, non expirés).
async function listAwaitingOwner(tenantId, states) {
  const wanted = new Set(states || ['HUMAN_REQUIRED']);
  const storageAdapter = require('./storageAdapter');
  const prefix = `${String(tenantId).replace(/[^A-Za-z0-9_.-]/g, '_')}__`;
  const out = [];
  const now = Date.now();
  for (const id of storageAdapter.listIds(conversationState.NAMESPACE)) {
    if (!id.startsWith(prefix)) continue;
    const doc = await storageAdapter.get(conversationState.NAMESPACE, id, null);
    if (!doc || conversationState.isExpired(doc)) continue;
    const h = doc.handoff;
    if (h && wanted.has(h.state) && now - (h.at || 0) < HUMAN_REQUIRED_TTL_MS) {
      out.push({ state: h.state, conversationId: doc.conversationId, channel: doc.platform, chatId: doc.chatId, since: h.at, reason: h.reason || null, category: h.category || null, contactLabel: h.contactLabel || null, lastMessage: doc.lastMessage || null, lastMessageTs: doc.lastMessageTs || null });
    }
  }
  return out.sort((a, b) => b.since - a.since);
}

// ---------------------------------------------------------------------------
// Point d'entrée : traite un LOT de messages d'une même conversation privée.
//   input : { tenantId, channel, from, identity, items:[{text, messageId}], hasAttachment, isGroup }
//   deps  : { send(text) -> {status,error}, llm?, crm?, settings? (policy) , raise? }
// Retourne { mode, decision, replied, alerted, ... }.
// ---------------------------------------------------------------------------
async function processBatch(input, deps) {
  const d = deps || {};
  const { tenantId, channel, from, identity } = input;
  const items = input.items || [];
  const fresh = [];
  const state = await conversationState.get(tenantId, channel, from);
  for (const it of items) { if (!it.messageId || !state.processedIds.includes(String(it.messageId))) fresh.push(it); }
  if (!fresh.length) return { mode: 'SILENT', reason: 'DUPLICATE' };
  const text = fresh.map((i) => i.text).filter(Boolean).join('\n');
  const lastText = fresh[fresh.length - 1].text || '';

  let crmContact = null;
  try { crmContact = await (d.crm || require('./contactCrm')).getContact(tenantId, channel, require('./contactCrm').identityOf(from)); } catch (e) { crmContact = null; }
  const policy = Object.assign({}, await alertCenter.getPolicy(tenantId), (d.settings && d.settings.alertPolicy) || {}, { waitingReply: d.settings && d.settings.waitingReply, groupAlerts: d.settings && d.settings.groupAlerts });
  if (policy.waitingReply === undefined) delete policy.waitingReply;

  let cls = classify(text, { crmContact, state, isGroup: input.isGroup, hasAttachment: input.hasAttachment });
  // Une pièce jointe (image/document) sans texte exploitable n'est pas classable : on ne devine pas.
  cls = await arbitrate(cls, text, d.llm);
  const decision = decide(cls, { state, policy, isGroup: input.isGroup });

  const label = identity ? identity.label : contactIdentity.resolveIdentity({ channel, jid: from }).label;
  const result = { mode: decision.mode, decision, category: cls.category, replied: false, alerted: false, label };
  const recent = (state.recentReplies || []).map((r) => (r && r.text) || r);
  const seed = `${fresh[fresh.length - 1].messageId || ''}${from}${text}`;

  // Marque les messages traités (idempotence) dès maintenant.
  for (const it of fresh) if (it.messageId) state.processedIds.push(String(it.messageId));
  state.lastMessage = excerpt(lastText, 200); state.lastMessageTs = Date.now();

  const rememberReply = (reply) => { state.recentReplies = (state.recentReplies || []).concat([{ text: reply, ts: Date.now() }]).slice(-6); state.lastReplyTs = Date.now(); };

  if (decision.mode === 'BUSINESS' || decision.mode === 'SILENT') {
    if (HUMAN_CATS.has(cls.category) === false && state.private && cls.category !== 'PRIVATE_CASUAL') { /* le fil privé n'est pas modifié par un message métier */ }
    await conversationState.save(state);
    return result;
  }

  if (decision.mode === 'AUTO_REPLY' || decision.mode === 'AUTO_REPLY_NOTIFY') {
    const reply = casualReply(lastText, { seed, recentReplies: recent });
    if (reply && d.send) {
      const out = await d.send(reply);
      result.replied = !!(out && out.status === 'SUCCESS'); result.replyStatus = out && out.status; result.reply = reply;
      if (result.replied) rememberReply(reply);
    }
    if (decision.mode === 'AUTO_REPLY_NOTIFY') {
      const r = await alertCenter.raise(tenantId, {
        type: 'PRIVATE_CASUAL', notify: true, title: `${label} vient de t'écrire`,
        body: `Message : “${excerpt(lastText, 160)}”${result.reply ? `\nRéponse automatique envoyée : “${result.reply}”` : ''}`,
        contact: identity, groupKey: `msg:${(identity && identity.contactId) || from}`, lastBody: excerpt(lastText, 160),
        aggregateTitle: (c) => `${label} vient d'envoyer ${c + 1} messages`, idempotencyKey: `casual:${tenantId}:${fresh[fresh.length - 1].messageId || seed}`,
      });
      result.alerted = !!(r && (r.delivered || r.aggregated));
    }
    await conversationState.save(state);
    return result;
  }

  // HUMAN_REQUIRED : alerte + réponse d'attente éventuelle + fil privé + handoff.
  state.private = { category: HUMAN_CATS.has(cls.category) ? cls.category : 'HUMAN_INTERVENTION_REQUIRED', at: Date.now() };
  const wasRequired = state.handoff && state.handoff.state === 'HUMAN_REQUIRED';
  state.handoff = Object.assign({}, state.handoff || {}, {
    state: 'HUMAN_REQUIRED', at: wasRequired ? state.handoff.at : Date.now(), reason: cls.reason, category: cls.category, contactLabel: label,
  });
  if (decision.sendWaitingReply && d.send) {
    const reply = waitingReply(cls.category, lastText, { seed, recentReplies: recent });
    const out = await d.send(reply);
    result.replied = !!(out && out.status === 'SUCCESS'); result.replyStatus = out && out.status; result.reply = reply;
    if (result.replied) { rememberReply(reply); state.handoff.lastWaitingReplyAt = Date.now(); }
  }
  await conversationState.save(state);

  const typeByCat = { URGENT: 'URGENT_MESSAGE', CALLBACK_REQUEST: 'CALLBACK_REQUEST', PRIVATE_SENSITIVE: 'PRIVATE_SENSITIVE', PRIVATE_PERSONAL: 'PRIVATE_PERSONAL' };
  const why = {
    URGENT: 'ce message semble urgent',
    CALLBACK_REQUEST: 'cette personne demande à être rappelée',
    PRIVATE_SENSITIVE: 'cette demande semble personnelle ou sensible',
    PRIVATE_PERSONAL: 'cette demande semble personnelle et exige ta réponse (je ne peux pas inventer)',
  }[cls.category] || 'je ne peux pas répondre sans inventer une information';
  const r = await alertCenter.raise(tenantId, {
    type: typeByCat[cls.category] || 'HUMAN_INTERVENTION_REQUIRED',
    title: `${label} vient de t'écrire`,
    body: `Message : “${excerpt(lastText, 200)}”\nLe Chat intelligent n'a pas répondu automatiquement : ${why}.${result.reply ? `\nJe lui ai répondu : “${result.reply}”` : ''}`,
    hint: 'Intervention recommandée : réponds directement dans la conversation.',
    contact: identity, conversationId: identity && identity.conversationId,
    groupKey: `msg:${(identity && identity.contactId) || from}`, lastBody: excerpt(lastText, 200),
    aggregateTitle: (c) => `${label} vient d'envoyer ${c + 1} messages`,
    idempotencyKey: `human:${tenantId}:${fresh[fresh.length - 1].messageId || seed}`,
  });
  result.alerted = !!(r && (r.delivered || r.aggregated));
  result.alert = r;
  return result;
}

module.exports = {
  CATEGORIES, HANDOFF, classify, arbitrate, decide, casualReply, waitingReply, processBatch,
  setHandoff, getHandoff, noteOwnerTookOver, resumeAutomation, listAwaitingOwner,
  THREAD_TTL_MS, HUMAN_REQUIRED_TTL_MS,
};
