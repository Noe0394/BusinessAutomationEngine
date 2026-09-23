// Moteur de conversation Jarvis : le CODE garantit les contraintes (refus, pas de
// répétition, pas d'invention de montants, NO_ACTION), l'IA rédige et interprète.
const intentClassifier = require('./intentClassifier');
const conversationState = require('./conversationState');
const repetitionGuard = require('./repetitionGuard');

const POSITIVE_REENGAGE = new Set([
  'QUESTION', 'REQUEST_INFORMATION', 'REQUEST_MORE_INFORMATION', 'INTEREST', 'PURCHASE_INTENT',
  'PAYMENT_INTENT', 'PRICE_OBJECTION', 'OBJECTION', 'SUPPORT', 'COMPLAINT', 'HESITATION',
]);
const NO_SELL_KINDS = new Set(['CLOSE', 'WAIT', 'ACK', 'COURTESY']);
const GREET_VARIANTS = ['Bonjour ! 😊 Comment puis-je vous aider ?', 'Bonjour, ravi de vous lire ! Que puis-je faire pour vous ?', 'Bonjour ! Je vous écoute 🙂', 'Salut ! Comment puis-je vous être utile ?'];
const ACK_VARIANTS = ['Avec plaisir 😊', 'Je vous en prie 😊', 'Ravi d\'avoir pu vous aider 🙏', 'Pas de souci, à votre service 😊'];

const TEMPLATES = {
  REFUSAL: 'D\'accord, aucun souci 😊 Merci pour votre retour. Si vous changez d\'avis plus tard, n\'hésitez pas à m\'écrire.',
  REFUSAL_APOLOGY: 'Toutes mes excuses, j\'ai bien compris votre décision 🙏 Je ne vous relance plus. Belle journée !',
  STOP: 'C\'est noté, je ne vous contacterai plus. Merci et bonne continuation !',
  WAIT: 'Aucun souci, prenez votre temps 😊 Je reste disponible si vous avez la moindre question.',
  REPEAT_QUESTION: 'Je vous ai déjà donné cette information juste au-dessus 😊 Je peux la reformuler autrement si besoin.',
  AMOUNT_UNVERIFIED: 'Je préfère vérifier le montant exact avant de vous répondre pour ne pas me tromper — je reviens vers vous très vite.',
  COURTESY: 'Bonjour ! 😊 Comment puis-je vous aider ?',
  HOLD: 'Merci pour votre message 🙏 Je reviens vers vous très vite avec une réponse précise.',
  SMALLTALK: 'Ça va bien, merci ! 😊 Et vous ?',
  SENSITIVE: 'Toutes mes pensées vous accompagnent 🙏',
};

// Contenu commercial (montants, offres, inscription...) : interdit hors contexte commercial.
const PROMO_RE = /(\d[\d\s.,]*\s?(?:fcfa|f\s?cfa|cfa|xof|xaf|€|eur|usd|\$)|\bprix\b|\btarifs?\b|\bformations?\b|\boffres?\b|\bpromo\w*|\bremises?\b|\br[ée]ductions?\b|\binscri\w+|\bcatalogue\b|\bproduits?\b|\bcommander\b|\bacheter\b|\bpaiement\b)/i;
const STRONG_COMMERCIAL = new Set(['PURCHASE_INTENT', 'PAYMENT_INTENT', 'INTEREST', 'PRICE_OBJECTION', 'OBJECTION', 'REQUEST_INFORMATION', 'REQUEST_MORE_INFORMATION']);
const COMMERCIAL_WINDOW_MS = 30 * 60 * 1000;

// La promotion n'est légitime que si le client l'a lui-même ouverte (ou vient de le faire) — jamais dans
// un contexte sensible ni en simple conversation.
function commercialAllowed(cls, state, now) {
  const { intent, flags } = cls;
  if (flags.sensitive) return false;
  if (STRONG_COMMERCIAL.has(intent) || cls.intents.some((i) => ['PURCHASE_INTENT', 'PAYMENT_INTENT'].includes(i))) return true;
  if (intent === 'QUESTION' && (flags.topics || []).some((t) => t !== 'location')) return true;
  if (flags.smalltalk) return false;
  return !!(state.memory && state.memory.commercialUntil > now && !['GREETING', 'THANKS', 'UNKNOWN'].includes(intent));
}

// Coordonnées absentes des données métier et du message du client = fuite potentielle d'informations privées.
function privateLeak(reply, knownText, clientText) {
  const found = (String(reply || '').match(/[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{7,}\d/g) || []).map((s) => s.replace(/\D/g, '') || s.toLowerCase());
  if (!found.length) return false;
  const hay = `${String(knownText || '')} ${String(clientText || '')}`;
  const digits = hay.replace(/\D/g, ' ').replace(/\s+/g, '');
  const low = hay.toLowerCase();
  return found.filter((f) => !/^\d+$/.test(f) || f.length >= 9).some((f) => (/^\d+$/.test(f) ? !digits.includes(f) : !low.includes(f)));
}

function pickVariant(list, recent) {
  const used = new Set((recent || []).map((r) => r.text));
  return list.find((v) => !used.has(v)) || list[(recent || []).length % list.length];
}

function amountsIn(text) {
  const re = /(\d[\d\s.,]*\d|\d)\s?(?:fcfa|f\s?cfa|xof|xaf|cfa|€|eur|usd|\$|francs?)/gi;
  const out = [];
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1].replace(/\D/g, ''));
  return out.filter(Boolean);
}
function digitsOnly(text) { return String(text || '').replace(/\D/g, ' ').replace(/\s+/g, ' '); }

// Un montant cité doit exister dans les données métier réellement configurées.
function unverifiedAmount(reply, knownText) {
  const amounts = amountsIn(reply);
  if (!amounts.length) return false;
  const known = String(knownText || '').replace(/[\s.,]/g, '');
  if (!known) return true;
  return amounts.some((a) => !known.includes(a));
}

function topicsOfReply(reply) {
  const cls = intentClassifier.classify(reply);
  const topics = new Set(cls.flags.topics);
  if (!amountsIn(reply).length) topics.delete('price');
  return Array.from(topics);
}

function memoryLines(state) {
  const m = state.memory || {};
  const lines = [];
  if (m.explained && m.explained.length) lines.push(`Sujets déjà expliqués au client (ne les répète pas sauf demande explicite): ${m.explained.join(', ')}.`);
  if (m.accepted && m.accepted.length) lines.push(`Le client a déjà accepté/exprimé: ${m.accepted.join(', ')}.`);
  if (m.refused && m.refused.length) lines.push(`Le client a déjà refusé: ${m.refused.join(', ')} — ne le repropose pas.`);
  if (m.interestService) lines.push(`Service qui a suscité l'intérêt du client : « ${m.interestService} » — c'est de lui qu'on parle par défaut (« l'attestation », « ça commence quand », « le prix » s'y rapportent).`);
  if (m.askedQuestions && m.askedQuestions.length) lines.push(`Questions déjà posées par le client : ${m.askedQuestions.join(' | ')} — ne les lui fais pas répéter.`);
  if (m.objections && m.objections.length) lines.push(`Objections déjà exprimées : ${m.objections.join(' | ')} — n'y reviens pas sans raison, traite-les avec les réponses préparées du service.`);
  if (m.otherInterest) lines.push(`Le client s'est aussi intéressé à : ${m.otherInterest}.`);
  if (m.waiting) lines.push(`Le client attend/reporte (${m.waiting.kind}${m.waiting.when ? ', ' + m.waiting.when : ''}) — ne redemande pas ce qu'il a déjà dit.`);
  lines.push(`État actuel de la conversation: ${state.state}.`);
  return lines;
}

// Décision pré-rédaction (100 % code) : garde-fous de contexte (humain, boucle, groupe, sensible) puis règles de fond.
function decide(state, cls, ctx) {
  const c = ctx || {};
  const now = c.now || Date.now();
  const { intent, flags } = cls;
  const commercial = commercialAllowed(cls, state, now);
  const base = ['Réponds à la DERNIÈRE intention exprimée par le client, pas à une intention précédente.'].concat(memoryLines(state));
  if (state.memory && state.memory.subject) base.push(`Sujet courant de la conversation : ${state.memory.subject}. Les mots courts (« ça », « cette formation », « combien ») s'y rapportent.`);
  const stop = (reason) => ({ action: 'NO_ACTION', kind: 'ACK', reason, directives: base.slice(), reopen: false, escalate: false });

  if (intent !== 'STOP') {
    if (c.humanActive) return stop('HUMAN_ACTIVE');
    if (c.loopSuspected) return stop('LOOP_PROTECTION');
    // Groupe de FORMATION lié à un cours (automatisation autorisée par le propriétaire) : une question d'apprentissage y est légitime.
    if (c.isGroup && !(c.learning && c.learning.active)) {
      // Groupes : la décision vient du moteur d'engagement (politique + mémoire 7 jours + à qui s'adresse le message) ; sans lui, ancien comportement prudent.
      if (c.engagement) { if (!c.engagement.respond) return stop(c.engagement.code); }
      else if (!c.groupReplies || !commercial || flags.sensitive) return stop('GROUP_NOT_ADDRESSED');
    }
    if (flags.sensitive && !state.refusal.active) {
      return {
        action: 'REPLY', kind: 'COURTESY', template: 'SENSITIVE', reason: `SENSITIVE_${flags.sensitive}`, reopen: false, escalate: flags.sensitive === 'URGENT', noPromo: true,
        directives: base.concat([`Contexte sensible (${flags.sensitive}) : réponse humaine, brève (1-2 phrases) et respectueuse. AUCUNE promotion, aucun prix, aucune offre, aucune allusion commerciale.`]),
      };
    }
  }
  // ACCOMPAGNEMENT D'APPRENANT : question d'apprentissage détectée (voir ai-engine/learnerSupport.js) -> réponse pédagogique ; ni refus, ni arrêt,
  // ni remerciement/salutation ne sont détournés (ils gardent leur traitement). Aucune consigne « pas de promotion » : parler de la formation est
  // précisément l'objet.
  if (c.learning && c.learning.active && !['STOP', 'REFUSAL', 'DISINTEREST', 'CANCELLATION', 'THANKS', 'CONFIRMATION', 'GREETING'].includes(intent) && !state.refusal.active) {
    return { action: 'REPLY', kind: 'ANSWER', reason: 'LEARNING', reopen: false, escalate: !!c.learning.escalate, noPromo: false, directives: base.concat(c.learning.directives || []) };
  }
  const d = decideCore(state, cls, c);
  if (d.action === 'REPLY' && intent === 'GREETING' && cls.intents.length === 1 && !flags.smalltalk && !d.template && !(c.engagement && c.engagement.register === 'NATURAL_CONTINUITY')) { d.variants = 'GREET'; d.kind = 'COURTESY'; }
  if (d.action === 'REPLY' && !commercial && !['CLOSE', 'SUPPORT'].includes(d.kind)) {
    d.noPromo = true;
    d.directives = d.directives.concat(['Conversation NON commerciale : réponds naturellement à ce que dit le client. AUCUNE promotion non sollicitée : ne cite ni prix, ni formation, ni offre, ni produit.']);
    if (flags.smalltalk && !d.template) d.template = 'SMALLTALK';
  }
  if (state.memory && state.memory.subject && d.action === 'REPLY') d.directives = d.directives.concat([`Sujet courant de la conversation : ${state.memory.subject}.`]);
  // Registre décidé par le moteur d'engagement (naturel / business / présentation / réponse de groupe) + contexte des 7 derniers jours.
  if (c.engagement && d.action === 'REPLY') {
    const e = c.engagement;
    d.directives = d.directives.concat(e.directives || []);
    if (['NATURAL', 'NATURAL_CONTINUITY'].includes(e.register) && !['CLOSE', 'SUPPORT'].includes(d.kind)) d.noPromo = true;
    d.engagement = { code: e.code, why: e.why, register: e.register };
  }
  return d;
}

function decideCore(state, cls, ctx) {
  const c = ctx || {};
  const now = c.now || Date.now();
  const { intent, flags } = cls;
  const last = (state.recentReplies || [])[state.recentReplies.length - 1] || null;
  const lastKind = last ? last.kind : null;
  const sinceReply = state.lastReplyTs ? now - state.lastReplyTs : Infinity;
  const refusalActive = !!(state.refusal && state.refusal.active);
  const base = ['Réponds à la DERNIÈRE intention exprimée par le client, pas à une intention précédente.'].concat(memoryLines(state));
  const res = (o) => Object.assign({ directives: base.slice(), reopen: false, escalate: false }, o);

  if (intent === 'STOP') {
    return state.optOut && lastKind === 'CLOSE' ? res({ action: 'NO_ACTION', kind: 'CLOSE', reason: 'STOP_ALREADY_ACK' }) : res({ action: 'REPLY', kind: 'CLOSE', template: 'STOP', reason: 'STOP' });
  }
  if (intent === 'REFUSAL' || intent === 'DISINTEREST') {
    if (lastKind === 'CLOSE' && refusalActive) return res({ action: 'NO_ACTION', kind: 'CLOSE', reason: 'REFUSAL_ALREADY_ACK' });
    const apology = refusalActive || flags.repeatComplaint;
    return res({
      action: 'REPLY', kind: 'CLOSE', template: apology ? 'REFUSAL_APOLOGY' : 'REFUSAL', reason: 'REFUSAL',
      directives: base.concat(['Le client REFUSE. Prends acte simplement et chaleureusement (1-2 phrases), remercie, laisse la porte ouverte.',
        'INTERDIT: reposer une question de vente, redonner le prix, proposer une offre, insister ou demander pourquoi.']),
    });
  }
  if (refusalActive) {
    if (['THANKS', 'CONFIRMATION', 'UNKNOWN'].includes(intent)) return res({ action: 'NO_ACTION', kind: 'ACK', reason: 'AFTER_REFUSAL_NO_ACTION' });
    if (intent === 'GREETING') return res({ action: 'REPLY', kind: 'COURTESY', template: 'COURTESY', reason: 'GREETING_AFTER_REFUSAL' });
    if (POSITIVE_REENGAGE.has(intent)) {
      return res({ reopen: true, action: 'REPLY', kind: 'ANSWER', reason: 'REOPENED_BY_CLIENT', directives: base.concat(['Le client avait décliné puis revient de lui-même: réponds à sa demande actuelle sans insister ni rappeler son refus.']) });
    }
  }
  if (intent === 'THANKS' || intent === 'CONFIRMATION') {
    if (conversationState.TERMINAL.has(state.state) || ((lastKind === 'ACK' || lastKind === 'CLOSE') && sinceReply < 10 * 60 * 1000)) {
      return res({ action: 'NO_ACTION', kind: 'ACK', reason: 'ACK_NOT_NEEDED' });
    }
    return res({
      action: 'REPLY', kind: 'ACK', variants: 'ACK', reason: 'ACK',
      directives: base.concat(['Le client remercie/confirme. Réponse TRÈS courte (une phrase), sans nouvelle question ni relance' + (flags.understood ? ', et sans recommencer la présentation.' : '.')]),
    });
  }
  if (intent === 'CANCELLATION') {
    return res({ action: 'REPLY', kind: 'SUPPORT', escalate: true, reason: 'CANCELLATION', directives: base.concat(['Le client parle d\'annulation/remboursement: reste factuel et calme, dis-lui simplement que tu reviens vers lui très vite avec la marche à suivre; ne promets aucun remboursement.']) });
  }
  if (intent === 'COMPLAINT' || intent === 'SUPPORT') {
    return res({ action: 'REPLY', kind: 'SUPPORT', escalate: intent === 'COMPLAINT', reason: intent, directives: base.concat(['Montre de l\'empathie en une phrase, traite le problème avec les seules informations réelles; sinon dis simplement que tu reviens vers lui très vite avec une réponse. Aucune relance commerciale.']) });
  }
  if (['HESITATION', 'LATER', 'REQUEST_TIME'].includes(intent) || ((intent === 'PURCHASE_INTENT' || intent === 'PAYMENT_INTENT') && flags.deferral)) {
    const purchase = intent === 'PURCHASE_INTENT' || intent === 'PAYMENT_INTENT';
    return res({
      action: 'REPLY', kind: 'WAIT', template: purchase ? null : 'WAIT', reason: purchase ? 'PURCHASE_DEFERRED' : intent,
      directives: base.concat([purchase ? `Le client veut acheter mais ${flags.deferral || 'plus tard'}: confirme chaleureusement que tu l'attends, sans redemander s'il veut s'inscrire ni redonner le prix.` : 'Le client réfléchit/reporte: réponds avec compréhension en 1-2 phrases, SANS relancer, SANS redemander de payer ni de s\'inscrire, SANS redonner le prix.']),
    });
  }
  if (intent === 'PRICE_OBJECTION' || intent === 'OBJECTION') {
    return res({ action: 'REPLY', kind: 'OBJECTION', reason: intent, directives: base.concat(['Le client émet une objection: reconnais-la sincèrement, réponds à SON argument précis, sans répéter mécaniquement le prix ni le pitch; n\'invente aucune remise ni facilité qui ne figure pas dans les informations réelles.']) });
  }
  if (['QUESTION', 'REQUEST_INFORMATION', 'REQUEST_MORE_INFORMATION'].includes(intent)) {
    const topics = flags.topics || [];
    const asked = (state.memory.questions || {});
    const already = topics.filter((t) => (state.memory.explained || []).includes(t));
    const repeatedTopic = topics.find((t) => (asked[t] || 0) >= 2);
    const dirs = base.concat(['Réponds précisément à la question posée avec les seules informations réelles, sur un ton naturel et chaleureux. Si l\'information n\'existe pas dans les données configurées, dis-le honnêtement (avec la même chaleur), propose de vérifier — n\'invente rien (prix, date, lien, horaire, disponibilité).']);
    if (flags.repeatComplaint) dirs.push('Le client signale qu\'il a déjà posé cette question: reconnais-le brièvement et donne DIRECTEMENT la réponse, sans reformuler tout le pitch.');
    else if (already.length) dirs.push(`Le sujet (${already.join(', ')}) a déjà été traité: réponds uniquement à ce qui est demandé, en une phrase, sans tout répéter.`);
    if (flags.topicChange) dirs.push('Le client change de sujet: abandonne le fil précédent et traite ce nouveau sujet.');
    // Question à caractère commercial/activité alors qu'AUCUN Service Métier n'est configuré (voir
    // ai-engine/businessServices.js#getPrioritizedContext, priorityService vaut `null` seulement quand ce module
    // l'a explicitement vérifié et qu'aucun service n'existe) : le propriétaire est notifié (self-chat WhatsApp /
    // Chat Intelligent — voir handleBatch ci-dessous) pour qu'il configure une fiche ou réponde lui-même, plutôt
    // que de laisser la question sans suite. Comparaison stricte à `null` (pas juste falsy) : un appelant qui ne
    // fournit pas ce champ (ex. ai-engine/emotionalCloser.js, autre source de faits métier) laisse `undefined` et
    // n'est jamais concerné par cette escalade.
    const noServiceForBusinessQuestion = c.priorityService === null && commercialAllowed(cls, state, now);
    return res({ action: 'REPLY', kind: 'ANSWER', escalate: !!repeatedTopic || noServiceForBusinessQuestion, businessRequestNoService: noServiceForBusinessQuestion, reason: 'QUESTION', directives: dirs });
  }
  if (intent === 'PURCHASE_INTENT' || intent === 'PAYMENT_INTENT') {
    return res({ action: 'REPLY', kind: 'ANSWER', reason: intent, directives: base.concat(['Le client veut acheter/payer: indique la prochaine étape en t\'appuyant UNIQUEMENT sur les modalités réellement configurées. Sans elles, dis simplement que tu reviens vers lui très vite avec les modalités exactes. Ne déclare JAMAIS un paiement reçu ni un accès accordé.']) });
  }
  if (intent === 'INTEREST') {
    return res({ action: 'REPLY', kind: 'ANSWER', reason: 'INTEREST', directives: base.concat(['Le client est intéressé: réponds naturellement, propose les informations utiles, sans pression.']) });
  }
  if (intent === 'GREETING') return res({ action: 'REPLY', kind: 'ANSWER', reason: 'GREETING', directives: base.concat(['Salue naturellement et demande comment aider, sans présenter toute l\'offre.']) });
  return res({ action: 'REPLY', kind: 'ANSWER', reason: 'UNKNOWN', directives: base.concat(['Message peu clair: demande une précision courte plutôt que de deviner.']) });
}

async function draft(decision, ctx) {
  const d = ctx.deps;
  const recent = ctx.state.recentReplies;
  if (decision.variants === 'ACK') return pickVariant(ACK_VARIANTS, recent);
  if (decision.variants === 'GREET') return pickVariant(GREET_VARIANTS, recent);
  if (decision.template && (decision.template === 'STOP' || decision.template === 'COURTESY')) return TEMPLATES[decision.template];
  const fallback = decision.template ? TEMPLATES[decision.template] : (decision.kind === 'ANSWER' ? TEMPLATES.HOLD : null);
  if (!d.compose) return fallback;
  try { return String((await d.compose(decision.directives, ctx)) || '').trim(); }
  catch (err) { return fallback; }
}

// Vérifie/corrige la rédaction avec au plus UNE régénération.
async function guard(text, decision, ctx) {
  const d = ctx.deps;
  const noSell = NO_SELL_KINDS.has(decision.kind) || ctx.state.refusal.active;
  const problems = (t) => {
    if (!t) return 'EMPTY';
    if (d.learning && d.learning.forcedReply) return null; // refus/urgence déterministes : jamais réécrits ni jugés « répétitifs »
    if (noSell && repetitionGuard.SALES_PUSH_RE.test(t)) return 'SALES_PUSH';
    if (decision.noPromo && PROMO_RE.test(t)) return 'UNSOLICITED_PROMO';
    if (privateLeak(t, d.knownText, ctx.text)) return 'PRIVATE_DATA';
    const rep = repetitionGuard.check(t, ctx.state.recentReplies);
    if (rep.repeated) return `REPEAT_${rep.kind}`;
    if (unverifiedAmount(t, d.knownText)) return 'AMOUNT_UNVERIFIED';
    if (!(d.learning && d.learning.forcedReply) && require('../claimGuard').hasCustomerClaim(t)) return 'ACTION_CLAIM_UNVERIFIED'; // jamais « c'est fait / j'ai enregistré… » sans action réelle
    if (d.learning && d.learning.verify) { const lp = d.learning.verify(t); if (lp) return lp; }
    return null;
  };
  let issue = problems(text);
  if (!issue) return { text, issue: null };
  if (d.compose && issue !== 'EMPTY') {
    const fix = {
      SALES_PUSH: 'Ta réponse précédente contenait une relance commerciale interdite: reformule sans aucune invitation à acheter/s\'inscrire/payer.',
      REPEAT_REPLY: 'Ta réponse précédente répétait ce qui a déjà été dit: change d\'angle, apporte quelque chose de nouveau ou clôture simplement.',
      REPEAT_QUESTION: 'Ne repose PAS une question déjà posée au client.',
      UNSOLICITED_PROMO: 'Ta réponse précédente contenait une promotion/un prix/une offre NON sollicités : reformule en répondant uniquement à ce que dit le client, sans aucun contenu commercial.',
      PRIVATE_DATA: 'Ta réponse précédente contenait des coordonnées (numéro/e-mail) absentes des données réelles : retire-les.',
      ACTION_CLAIM_UNVERIFIED: "Ta réponse affirmait qu'une action était faite (enregistré, validé, envoyé, réservé…) alors que RIEN n'a été exécuté : reformule sans rien affirmer d'accompli ; dis ce que le client peut faire, ou simplement que tu reviens vers lui très vite avec la confirmation.",
      AMOUNT_UNVERIFIED: 'Ta réponse citait un montant absent des données réelles: retire tout montant non présent dans les informations configurées.',
      COURSE_CLAIM_UNSUPPORTED: 'Ta réponse prétendait venir du cours alors qu\'aucun extrait n\'a été retrouvé : reformule en disant clairement que cette précision n\'est pas dans le contenu de la formation, puis, si pertinent, donne un complément clairement marqué « connaissance générale ».',
    }[issue];
    try {
      const retry = String((await d.compose(decision.directives.concat([fix]), ctx)) || '').trim();
      const again = problems(retry);
      if (!again) return { text: retry, issue: null, regenerated: true };
      issue = again;
    } catch (e) { /* on retombe sur le filet déterministe */ }
  }
  if (issue === 'UNSOLICITED_PROMO' || issue === 'PRIVATE_DATA') {
    const safe = decision.template && TEMPLATES[decision.template] && !PROMO_RE.test(TEMPLATES[decision.template]) ? TEMPLATES[decision.template] : null;
    return { text: safe || (ctx.cls.flags.greeting ? TEMPLATES.COURTESY : (decision.kind === 'ANSWER' ? TEMPLATES.HOLD : null)), issue };
  }
  if (issue === 'ACTION_CLAIM_UNVERIFIED') return { text: TEMPLATES.HOLD, issue, escalate: true }; // le vendeur est prévenu : rien n'est promis
  if (issue === 'AMOUNT_UNVERIFIED') return { text: TEMPLATES.AMOUNT_UNVERIFIED, issue };
  if (issue === 'COURSE_CLAIM_UNSUPPORTED') return { text: require('../learnerSupport').UNKNOWN_IN_COURSE, issue, escalate: true };
  if (issue === 'SALES_PUSH') return { text: decision.template ? TEMPLATES[decision.template] : TEMPLATES.WAIT, issue };
  if (issue === 'REPEAT_REPLY' || issue === 'REPEAT_QUESTION') {
    if (decision.kind === 'ANSWER') return { text: TEMPLATES.REPEAT_QUESTION, issue };
    return { text: null, issue };
  }
  return { text: null, issue };
}

function applyState(state, cls, decision, sent, replyText, items, now, deps) {
  const { intent, flags } = cls;
  const prev = state.state;
  state.state = conversationState.nextState(prev, intent, flags);
  if (decision.reopen) state.refusal.active = false;
  if (intent === 'REFUSAL' || intent === 'DISINTEREST' || intent === 'STOP') {
    state.refusal = { active: true, kind: intent, count: (state.refusal.count || 0) + 1, at: now };
    state.user_refused_action = true; // drapeau explicite : le contact a refusé -> on n'insiste plus
    if (intent === 'STOP') state.optOut = true;
    const t = (flags.topics || [])[0] || 'offre';
    if (!state.memory.refused.includes(t)) state.memory.refused.push(t);
  }
  if (intent === 'PURCHASE_INTENT' || intent === 'PAYMENT_INTENT') {
    if (!state.memory.accepted.includes('achat')) state.memory.accepted.push('achat');
  }
  if (STRONG_COMMERCIAL.has(intent) || (intent === 'QUESTION' && (flags.topics || []).some((t) => t !== 'location'))) state.memory.commercialUntil = now + COMMERCIAL_WINDOW_MS;
  if (['REFUSAL', 'DISINTEREST', 'STOP'].includes(intent)) state.memory.commercialUntil = 0;
  if (decision.kind === 'WAIT') state.memory.waiting = { kind: intent, when: flags.deferral || null, since: now };
  else if (['PURCHASE_INTENT', 'PAYMENT_INTENT', 'QUESTION', 'INTEREST'].includes(intent) && !flags.deferral) state.memory.waiting = null;
  for (const t of (flags.topics || [])) state.memory.questions[t] = (state.memory.questions[t] || 0) + 1;
  // Contexte pédagogique (formation, leçon, sujet, difficulté) : permet de comprendre « Et pour le sel ? » au message suivant.
  if (deps && deps.learning && deps.learning.memory && !deps.learning.forcedReply) state.memory.learning = deps.learning.memory;
  // Mémoire commerciale : questions posées, objections, service d'intérêt (le code décide ; l'IA n'écrit jamais dans l'état).
  const said = String(items.map((i) => i.text).join(' ')).replace(/\s+/g, ' ').trim().slice(0, 100);
  if ((intent === 'QUESTION' || intent === 'REQUEST_INFORMATION' || intent === 'REQUEST_MORE_INFORMATION') && said) { state.memory.askedQuestions = (state.memory.askedQuestions || []).concat([said]).slice(-8); }
  if ((intent === 'OBJECTION' || intent === 'PRICE_OBJECTION') && said) { state.memory.objections = (state.memory.objections || []).concat([said]).slice(-5); }
  if (deps && deps.priorityService && !state.memory.interestService && (STRONG_COMMERCIAL.has(intent) || intent === 'QUESTION')) { state.memory.interestService = deps.priorityService; if (!state.memory.subject) state.memory.subject = deps.priorityService; }
  if (sent && replyText) {
    for (const t of topicsOfReply(replyText)) if (!state.memory.explained.includes(t)) state.memory.explained.push(t);
    state.recentReplies.push({ text: replyText.slice(0, 600), ts: now, kind: decision.kind });
    state.lastReplyTs = now;
  }
  state.lastMessage = String(items.map((i) => i.text).join(' ')).slice(0, 120);
  state.lastMessageTs = now;
  for (const it of items) if (it.messageId) state.processedIds.push(String(it.messageId));
  state.turns += 1;
}

const MUTED = new Set(['HUMAN_ACTIVE', 'GROUP_NOT_ADDRESSED', 'LOOP_PROTECTION']);

// Sujet courant : nom de produit/offre configuré cité par le client (les mots courts s'y rapportent ensuite).
function detectSubject(text, productNames) {
  const n = intentClassifier.norm(text);
  for (const name of productNames || []) {
    const nn = intentClassifier.norm(name);
    if (nn.length >= 3 && n.includes(nn)) return String(name);
  }
  return null;
}

// L'utilisateur écrit lui-même dans la conversation : Cyrus se tait pendant `minutes` (défaut 30).
async function noteHumanActivity(tenantId, channel, from, minutes) {
  const state = await conversationState.get(tenantId, channel, from);
  state.humanUntil = Date.now() + (Number(minutes) > 0 ? Number(minutes) : 30) * 60 * 1000;
  // Handoff : le propriétaire écrit lui-même -> HUMAN_ACTIVE (l'automatisation se tait, le contexte est conservé).
  state.private = null;
  state.handoff = Object.assign({}, state.handoff || {}, { state: 'HUMAN_ACTIVE', at: Date.now(), until: state.humanUntil });
  await conversationState.save(state);
  return state.humanUntil;
}

// Point d'entrée : traite un LOT de messages d'une même conversation.
async function handleBatch({ tenantId, channel, from, name, items }, deps) {
  const d = deps || {};
  const now = Date.now();
  const state = await conversationState.get(tenantId, channel, from);
  const fresh = items.filter((i) => !i.messageId || !state.processedIds.includes(String(i.messageId)));
  if (!fresh.length) return { action: 'NO_ACTION', reason: 'DUPLICATE', intent: null, state: state.state };
  const text = fresh.map((i) => i.text).join('\n');

  let cls = intentClassifier.classify(text, { state });
  if (cls.needsArbitration && d.llm && !(d.learning && d.learning.forcedReply)) cls = await intentClassifier.arbitrate({ text, history: d.history, llm: d.llm, base: cls });

  // Engagement (politique + contexte 7 jours) : calculé UNE fois, sans réseau ni IA, avant toute décision.
  let engagement = null;
  if (typeof d.engagementFn === 'function') { try { engagement = await d.engagementFn({ cls, state, text, items: fresh }); } catch (e) { engagement = null; } }
  const recentTs = (state.recentTs || []).filter((t) => now - t < 120000);
  const subject = detectSubject(text, d.productNames);
  if (subject) state.memory.subject = subject;
  const decision = decide(state, cls, {
    now, humanActive: state.humanUntil > now, loopSuspected: recentTs.length >= 8,
    isGroup: !!d.isGroup, groupReplies: !!d.groupReplies, learning: d.learning, engagement,
    priorityService: d.priorityService,
  });
  const ctx = { tenantId, channel, from, name, text, cls, state, deps: d, decision };
  let replyText = null; let guardInfo = null; let out = null; let sent = false;

  if (decision.action === 'REPLY') {
    const drafted = await draft(decision, ctx);
    guardInfo = await guard(drafted, decision, ctx);
    replyText = guardInfo.text;
    if (guardInfo.escalate) decision.escalate = true; // réponse impossible à fonder sur le cours : le formateur est prévenu
  }
  const action = decision.action === 'REPLY' && !replyText ? 'NO_ACTION' : decision.action;
  const reason = decision.action === 'REPLY' && !replyText ? `SUPPRESSED_${guardInfo && guardInfo.issue}` : decision.reason;

  if (action === 'REPLY') {
    out = await d.send(replyText);
    sent = !!out && out.status !== 'FAILED';
  }
  if (MUTED.has(decision.reason)) {
    // Silence de contexte (humain actif, groupe, boucle) : on ne fait pas évoluer l'état commercial.
    for (const it of fresh) if (it.messageId) state.processedIds.push(String(it.messageId));
    state.recentTs = recentTs.concat(now);
    state.lastMessageTs = now;
  } else {
    applyState(state, cls, decision, sent, replyText, fresh, now, d);
    state.recentTs = recentTs.concat(now).slice(-30);
  }
  await conversationState.save(state);

  const crm = d.crm;
  if (crm) {
    try {
      if (cls.intent === 'STOP') await crm.markOptOut(tenantId, channel, from, 'STOP');
      else if (cls.intent === 'REFUSAL' || cls.intent === 'DISINTEREST') await crm.markOptOut(tenantId, channel, from, cls.intent);
      else if (decision.reopen && state.optOut !== true) await crm.clearOptOut(tenantId, channel, from);
    } catch (e) { /* le CRM ne bloque jamais la conversation */ }
  }
  // SAV générique : une réclamation / un problème d'un client (privé) ouvre un dossier suivi (dédoublonné : un problème = un dossier) — quel que soit le métier.
  if (!d.isGroup && decision.kind === 'SUPPORT' && ['COMPLAINT', 'SUPPORT', 'CANCELLATION'].includes(decision.reason)) {
    try {
      const t = String(text).toLowerCase();
      const category = /livr|colis|re[cç]u|retard/.test(t) ? 'livraison' : (/pay|rembours|factur|d[ée]bit/.test(t) ? 'paiement' : (/acc[eè]s|connexion|mot de passe|lien/.test(t) ? 'acces' : (/prestation|rendez|service|intervention/.test(t) ? 'prestation' : (/produit|d[ée]fect|cass|qualit/.test(t) ? 'produit' : 'autre'))));
      await require('../customerLifecycle').openCase(tenantId, { contact: { channel, id: String(from).split('@')[0], name }, category, summary: String(text).slice(0, 280), source: 'conversation' });
    } catch (e) { /* le SAV ne bloque jamais la conversation */ }
  }
  if (decision.escalate && d.notify) {
    try {
      // Jamais l'identifiant technique (JID/LID) : nom, sinon vrai numéro, sinon « non identifié » (contactIdentity).
      const who = await require('../contactIdentity').labelFor(tenantId, channel, from, name ? { pushName: name } : null);
      // Cas spécifique : question commerciale/sur l'activité alors qu'aucun Service Métier n'est configuré (voir
      // decideCore#businessRequestNoService) — message distinct pour que le propriétaire comprenne l'action
      // attendue (configurer une fiche), plutôt que le message générique d'escalade.
      const msg = decision.businessRequestNoService
        ? `💼 ${who} vous a posé une question sur votre activité/vos services (${cls.intent}), mais aucun Service Métier n'est encore configuré pour y répondre avec de vraies informations. J'ai répondu honnêtement sans rien inventer — configurez une fiche dans l'onglet Services Métiers pour que je puisse répondre correctement la prochaine fois.`
        : `Conversation ${channel} avec ${who} (${cls.intent}) : intervention du vendeur recommandée.`;
      await d.notify(msg);
    } catch (e) { /* non bloquant */ }
  }

  return { action, reason, intent: cls.intent, intents: cls.intents, state: state.state, kind: decision.kind, text: replyText, out, sent, guard: guardInfo && guardInfo.issue, engagement: decision.engagement || (engagement ? { code: engagement.code, why: engagement.why, register: engagement.register } : null) };
}

module.exports = { handleBatch, decide, noteHumanActivity, commercialAllowed, privateLeak, unverifiedAmount, amountsIn, TEMPLATES };
