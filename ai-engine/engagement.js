// DÉCISION D'ENGAGEMENT — ai-engine/engagement.js
// ---------------------------------------------------------------------------
// « Dois-je répondre ? Sur quel registre ? Dois-je présenter mes services ? » — UNE fonction pure, sans effet de bord ni appel réseau, donc instantanée
// et testable. Elle combine trois choses et rien d'autre :
//   1. la POLITIQUE du propriétaire (conversationPolicy.js) ;
//   2. le CONTEXTE de la discussion issu de la mémoire 7 jours (conversationContext.js) ;
//   3. le MESSAGE courant (intention déjà classée + qui s'adresse à moi).
//
// Résultat : { respond, register, present, code, why, directives[] }
//   register : NATURAL (discuter, aucune promo) | NATURAL_CONTINUITY (discuter + reprendre le fil business d'avant) | BUSINESS_ANSWER (répondre à une
//              question sur l'activité) | PRESENT_SERVICE (présenter le service concerné) | GROUP_ANSWER (réponse brève à une question du groupe)
//   code     : identifiant stable de la RAISON (utilisé par les logs et l'explication « pourquoi ? »)
//   why      : la raison en français simple
// Toujours business : la personne parle d'acheter, de payer, de son intérêt, d'un problème avec l'activité.
const BUSINESS_INTENTS = new Set(['PURCHASE_INTENT', 'PAYMENT_INTENT', 'PRICE_OBJECTION', 'INTEREST', 'CANCELLATION', 'COMPLAINT', 'SUPPORT']);
// Business SEULEMENT si le sujet touche l'activité (mot de vente, produit/service du compte, thème connu) : « tu as vu le match ? » est une question, pas du business.
const BUSINESS_IF_ON_TOPIC = new Set(['QUESTION', 'REQUEST_INFORMATION', 'REQUEST_MORE_INFORMATION', 'OBJECTION', 'HESITATION', 'LATER', 'REQUEST_TIME']);
const ASK_OFFER_RE = /(qu['’]?est[- ]ce que (?:vous|tu) (?:vendez|proposez|faites|offrez)|(?:vous|tu) (?:vendez|proposez|faites) quoi|quels? (?:sont )?(?:vos|tes|les) (?:services?|produits?|offres?|formations?|prestations?)|que proposez[- ]vous|votre catalogue|vos tarifs|c['’]est quoi (?:votre|ton) (?:activit|service|offre))/i;

const R = (o) => Object.assign({ respond: true, present: false, register: 'NATURAL', directives: [] }, o);
const NATURAL_RULE = 'Discussion NATURELLE : réponds comme une personne, avec chaleur et simplicité. Pas de promotion spontanée ; si la personne demande explicitement un prix, un service ou une offre, réponds avec les faits configurés.';

// input : { policy (résolue pour cette discussion), ctx (analyze), cls (intentClassifier), isGroup, addressing:{mentioned,quotedFromBot,named}, text, state, learning }
function decide(input) {
  const { policy, ctx, cls, isGroup, text } = input; const a = input.addressing || {}; const state = input.state || {};
  const flags = (cls && cls.flags) || {}; const intent = cls && cls.intent;
  const addressed = !!(a.mentioned || a.quotedFromBot || a.named);
  const asksOffer = ASK_OFFER_RE.test(String(text || ''));
  const svc = ctx && (ctx.service || ctx.fallbackService);
  const cur = (ctx && ctx.current) || {};
  const onTopic = !!(cur.businessWords || cur.serviceHit || cur.onTheme || (flags.topics || []).filter((t) => !['schedule', 'location'].includes(t)).length); // « quand ? » / « où ? » seuls ne font pas un sujet d'activité
  // Message qui « ressemble à une question » : intention de type question, ou intention inconnue terminée par « ? ».
  const questionLike = BUSINESS_IF_ON_TOPIC.has(intent) || (intent === 'UNKNOWN' && /\?\s*$/.test(String(text || '')));
  // Suite d'une discussion business EN COURS (moins de 30 min : mémoire de conversation ou historique) : « et la durée ? », « et l'attestation ? » prolongent le fil, même sans mot de vente.
  const st = state.memory || {};
  const businessOngoing = !!((st.commercialUntil && st.commercialUntil > Date.now()) || (ctx && ctx.business && ctx.business.lastTs && Date.now() - ctx.business.lastTs < 30 * 60 * 1000));
  const businessAsk = (businessOngoing && questionLike && !isGroup) || BUSINESS_INTENTS.has(intent) || asksOffer || (BUSINESS_IF_ON_TOPIC.has(intent) && onTopic && !(flags.smalltalk && !cur.serviceHit));
  const brief = ctx && ctx.messages ? [`CONTEXTE DE LA DISCUSSION (mémoire ${ctx.windowDays} jours) : ${require('./conversationContext').summarize(ctx)}`] : ['CONTEXTE : première prise de contact (aucun historique).'];
  const canPresent = policy.presentServices !== 'never' && !!svc;
  const presentedRecently = !!(ctx && ctx.business && ctx.business.presentedRecently);

  // ------------------------------------------------------------------ GROUPES
  if (isGroup) {
    if (policy.mode === 'off') return R({ respond: false, code: 'GROUP_POLICY_OFF', why: 'Les réponses en groupe sont désactivées pour cette conversation.' });
    if (flags.sensitive && !addressed) return R({ respond: false, code: 'GROUP_SENSITIVE_NOT_ADDRESSED', why: 'Sujet sensible dans un groupe et personne ne s\'adresse à moi : je me tais.' });
    if (addressed) {
      const asked = businessAsk && !flags.smalltalk;
      return R({
        code: 'GROUP_ADDRESSED', why: `On s'adresse à moi (${a.mentioned ? 'mention' : a.quotedFromBot ? 'réponse à mon message' : 'mon nom'}).`,
        register: asked ? 'GROUP_ANSWER' : 'NATURAL', present: asked && asksOffer && canPresent,
        directives: brief.concat(asked ? ['Réponse BRÈVE (1 à 3 phrases) adressée à la personne qui vient de parler ; réponds seulement à ce qui est demandé.'] : [NATURAL_RULE, 'Réponse brève et sociable, adaptée au ton du groupe.']),
      });
    }
    if (policy.mode === 'addressed') return R({ respond: false, code: 'GROUP_NOT_ADDRESSED', why: 'Politique « seulement si on s\'adresse à moi » et personne ne s\'est adressé à moi.' });
    // mode « topic » : uniquement un groupe lié à l'activité, une vraie question sur son thème, sans couper un échange entre membres, avec plafond.
    const businessGroup = !!(policy.openGroups || (ctx && (ctx.groupLinked || (svc && svc.affinity >= 0.5))));
    if (!businessGroup) return R({ respond: false, code: 'GROUP_CASUAL', why: 'Ce groupe ne parle pas de votre activité (aucun lien avec vos services) : je n\'interviens pas dans les conversations entre membres.' });
    if (ctx && ctx.group && ctx.group.duo) return R({ respond: false, code: 'GROUP_DUO', why: 'Deux membres échangent entre eux : je ne les interromps pas.' });
    if (!businessAsk || flags.smalltalk) return R({ respond: false, code: 'GROUP_OFF_TOPIC', uncertain: !flags.smalltalk && questionLike, why: 'Le message n\'est pas une question sur le thème du groupe.' });
    if (ctx && ctx.group && ctx.group.botRepliesLast10Min >= policy.groupMaxRepliesPer10Min) return R({ respond: false, code: 'GROUP_RATE_LIMIT', why: `J'ai déjà répondu ${ctx.group.botRepliesLast10Min} fois ces 10 dernières minutes dans ce groupe : je laisse la place aux membres.` });
    return R({
      code: 'GROUP_TOPIC_QUESTION', why: `Question sur le thème du groupe (« ${svc ? svc.name : 'activité'} ») : je réponds brièvement.`, register: 'GROUP_ANSWER',
      directives: brief.concat(['Réponse BRÈVE (1 à 3 phrases), utile pour tout le groupe, à la personne qui a posé la question. Aucune promotion non demandée : réponds seulement à la question.']),
    });
  }

  // ------------------------------------------------------------------ DISCUSSIONS PRIVÉES
  const refused = !!(state.refusal && state.refusal.active) || state.optOut === true;
  if (refused) return R({ code: 'PRIVATE_AFTER_REFUSAL', why: 'La personne a décliné : je reste naturel, sans rien proposer.', directives: brief.concat([NATURAL_RULE]) });

  // « Naturel » interdit la vente non sollicitée ; il ne doit jamais empêcher
  // de répondre à une question explicite sur l'offre, le service ou son prix.
  // L'ancienne sortie anticipée renvoyait NATURAL même pour « combien coûte la
  // formation ? », ce qui masquait ensuite les faits au rédacteur.
  if (policy.mode === 'natural') {
    if (businessAsk && !flags.smalltalk) {
      const askedForCatalog = asksOffer && !!svc;
      const instructions = askedForCatalog && ctx.serviceNames && ctx.serviceNames.length > 1
        ? `La personne demande explicitement vos offres : présente brièvement les services configurés (${ctx.serviceNames.join(', ')}) avec les seuls faits disponibles, puis demande ce qui l'intéresse. Pas de pression.`
        : `La personne pose une question explicite sur votre activité : réponds directement avec les faits configurés et uniquement ceux-ci. N'ajoute aucune promotion ni relance non demandée.`;
      return R({
        code: askedForCatalog ? 'PRIVATE_ASKED_OFFER' : 'PRIVATE_NATURAL_BUSINESS_QUESTION',
        why: 'La personne demande une information métier : je réponds précisément sans promotion spontanée.',
        register: askedForCatalog ? 'PRESENT_SERVICE' : 'BUSINESS_ANSWER',
        present: askedForCatalog,
        directives: brief.concat([instructions]),
      });
    }
    return R({ code: 'PRIVATE_NATURAL_POLICY', why: 'Politique « toujours naturel » : aucune promotion spontanée.', directives: brief.concat([NATURAL_RULE]) });
  }

  if (businessAsk || policy.mode === 'business') {
    const wantsPresentation = canPresent && policy.presentServices !== 'on-request' ? (!presentedRecently || asksOffer || intent === 'INTEREST') : (canPresent && asksOffer);
    if (wantsPresentation) {
      return R({
        code: asksOffer ? 'PRIVATE_ASKED_OFFER' : 'PRIVATE_BUSINESS_PRESENT', register: 'PRESENT_SERVICE', present: true,
        why: asksOffer ? 'On me demande ce que je propose : je présente le service concerné.' : `Question sur l'activité et « ${svc.name} » n'a pas été présenté récemment : je le présente (sans forcer).`,
        directives: brief.concat([asksOffer && ctx.serviceNames && ctx.serviceNames.length > 1
          ? `On te demande ce que tu proposes : présente BRIÈVEMENT chacun de ces services (${ctx.serviceNames.join(', ')}) en une phrase chacun, à partir de leurs informations RÉELLES uniquement, puis demande ce qui l'intéresse. Aucune pression.`
          : `Présente le service « ${svc.name} » en 2 ou 3 phrases (à partir de ses informations RÉELLES uniquement), puis pose UNE question simple pour connaître le besoin. Aucune pression.`]),
      });
    }
    return R({
      code: 'PRIVATE_BUSINESS_ANSWER', register: 'BUSINESS_ANSWER',
      why: presentedRecently ? 'Question sur l\'activité : je réponds précisément sans re-présenter (déjà fait récemment).' : 'Question sur l\'activité : je réponds précisément.',
      directives: brief.concat(['Réponds précisément à la question posée, avec les seules informations réelles ; ne répète pas une présentation déjà faite.']),
    });
  }

  // Ni question business ni demande d'offre : discussion naturelle. Si le business a été évoqué récemment (mémoire 7 jours) et que la personne salue / relance,
  // on garde la continuité du fil, sans pousser.
  const resumes = ctx && ctx.business && ctx.business.temperature !== 'cold' && (flags.greeting || intent === 'GREETING') && svc && policy.presentServices !== 'never';
  if (resumes) {
    return R({
      code: 'PRIVATE_NATURAL_CONTINUITY', register: 'NATURAL_CONTINUITY', why: 'La personne salue et nous avions parlé de votre activité récemment : je salue et je rappelle simplement où nous en étions.',
      directives: brief.concat([NATURAL_RULE.replace('Ne cite aucun prix, aucune offre, aucun service : ils ne sont pas le sujet.', 'Tu peux seulement rappeler en une courte phrase le sujet dont vous parliez (sans prix, sans relance) et demander si elle veut continuer.')]),
    });
  }
  return R({ code: 'PRIVATE_NATURAL', uncertain: !!(ctx && ctx.business && ctx.business.temperature !== 'cold' && questionLike), why: 'Discussion courante, rien à voir avec l\'activité : je réponds naturellement, sans rien vendre.', directives: brief.concat([NATURAL_RULE]) });
}

// ARBITRAGE PAR L'IA (cascade de modèles) — uniquement pour les cas AMBIGUS marqués `uncertain` : « et pour la cuisson du poulet ? » dans un groupe de grillade, « et ça dure combien de temps ? »
// après une discussion business. L'IA voit le contexte des 7 jours et tranche ; les règles DURES ne sont jamais contournées (politique, plafond, échange entre membres, sujet sensible,
// refus). Budget de temps strict : sans réponse à temps, la décision par règles s'applique. `llm(prompt)` = la cascade (llmFallbackEngine).
async function arbitrate(input, base, llm, budgetMs) {
  if (!base || !base.uncertain || typeof llm !== 'function' || !input.policy || input.policy.aiJudgment === false) return base;
  const { ctx, isGroup } = input;
  const prompt = [
    'Tu aides un assistant de messagerie à décider s\'il doit répondre et sur quel registre. Réponds UNIQUEMENT par un objet JSON : {"respond":true|false,"register":"NATURAL|BUSINESS_ANSWER|GROUP_ANSWER","why":"raison en français, une phrase"}.',
    isGroup ? 'Contexte : GROUPE. Réponds (respond:true, register:GROUP_ANSWER) seulement si le message est une vraie question sur le thème du groupe ci-dessous ; sinon respond:false.' : 'Contexte : DISCUSSION PRIVÉE. register:BUSINESS_ANSWER si le message prolonge la discussion sur l\'activité (suite d\'une question sur un produit, prix, délai, inscription…) ; register:NATURAL si c\'est une discussion courante.',
    `Activité du vendeur : ${(ctx && ctx.serviceNames && ctx.serviceNames.join(', ')) || 'non précisée'}.`,
    `Ce que l'on sait de la discussion (7 derniers jours) : ${require('./conversationContext').summarize(ctx)}`,
    (ctx && ctx.recent && ctx.recent.length) ? `Derniers messages :\n${ctx.recent.slice(-6).join('\n')}` : '',
    `Nouveau message : "${String(input.text || '').slice(0, 400)}"`,
  ].filter(Boolean).join('\n');
  let raw = null;
  try { raw = await Promise.race([Promise.resolve(llm(prompt)), new Promise((res) => setTimeout(() => res(null), budgetMs || 1800))]); } catch (e) { raw = null; }
  const m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return base;
  let j; try { j = JSON.parse(m[0]); } catch (e) { return base; }
  const why = String(j.why || '').slice(0, 200) || 'décision de l\'IA';
  if (isGroup) {
    if (j.respond === true && j.register === 'GROUP_ANSWER') return R({ code: 'GROUP_AI_ON_TOPIC', why: `L'IA juge que c'est une vraie question sur le thème du groupe : ${why}`, register: 'GROUP_ANSWER', ai: true, directives: (base.directives || []).concat(['Réponse BRÈVE (1 à 3 phrases), utile pour tout le groupe, à la personne qui a posé la question. Aucune promotion non demandée.']) });
    return Object.assign({}, base, { uncertain: false, ai: true, why: `L'IA confirme le silence : ${why}` });
  }
  if (j.register === 'BUSINESS_ANSWER') return R({ code: 'PRIVATE_AI_BUSINESS_FOLLOWUP', why: `L'IA juge que le message prolonge la discussion sur votre activité : ${why}`, register: 'BUSINESS_ANSWER', ai: true, directives: (input.briefDirectives || []).concat(['Réponds précisément à la question, avec les seules informations réelles ; ne répète pas une présentation déjà faite.']) });
  return Object.assign({}, base, { uncertain: false, ai: true, why: `L'IA confirme une discussion naturelle : ${why}` });
}

module.exports = { decide, arbitrate, BUSINESS_INTENTS, BUSINESS_IF_ON_TOPIC, ASK_OFFER_RE };
