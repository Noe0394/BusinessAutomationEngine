// AUTO-RESPONDER — ai-engine/autoResponder.js
// ---------------------------------------------------------------------------
// AUTONOMIE CONVERSATIONNELLE (priorité absolue du cahier des charges) : quand
// elle est activée pour un compte, CYRUS tient la conversation TOUT SEUL à
// chaque message entrant, sans que l'admin rouvre le Chat Intelligent.
//
// Chaîne réelle par message entrant :
//   idempotence (messageId) -> mémoire (historique du contact) -> IA (persona
//   + contexte métier RÉEL) -> envoi VÉRIFIÉ (runtime.sendMessageVerified,
//   identifiant réel) -> sauvegarde -> attente du prochain message.
//
// Sûreté : l'auto-réponse est CONVERSATIONNELLE/INFORMATIVE (répondre, informer,
// engager, citer les vrais prix). Elle ne DÉCLENCHE JAMAIS d'action à risque
// (paiement, déblocage d'accès) automatiquement — ces actions restent sous
// confirmation de l'admin. Désactivée par défaut (opt-in par compte + canal).

const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const personaManager = require('./personaManager');
const businessServices = require('./businessServices');
const messageHistory = require('./messageHistory');
const storageAdapter = require('./storageAdapter');
const modelRouter = require('./modelRouter');
const contactCrm = require('./contactCrm');
const conversationEngine = require('./jarvis/conversationEngine');
const { shared: conversationQueue } = require('./jarvis/conversationQueue');
const alwaysOn = require('./alwaysOn');

// Réponse SPONTANÉE : attente minimale pour regrouper deux messages quasi simultanés (0 = aucune attente). Auparavant 1,5 s fixes avant tout traitement.
const DEFAULT_DEBOUNCE_MS = process.env.AUTO_REPLY_DEBOUNCE_MS !== undefined && process.env.AUTO_REPLY_DEBOUNCE_MS !== '' ? Math.max(0, parseInt(process.env.AUTO_REPLY_DEBOUNCE_MS, 10) || 0) : 500;
// L'avis d'un spécialiste ne doit JAMAIS retarder la réponse : passé ce délai, Cyrus répond sans lui (les tâches longues restent sur les voies dédiées).
const SPECIALIST_BUDGET_MS = Math.max(0, parseInt(process.env.SPECIALIST_CUSTOMER_BUDGET_MS, 10) || 2500);
const withinBudget = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), SPECIALIST_BUDGET_MS))]);

const SETTINGS_NS = 'auto_settings';
const conversationPolicy = require('./conversationPolicy');
const conversationContext = require('./conversationContext');
const engagement = require('./engagement');

// Déduplication en mémoire par tenant (Baileys/Telegram peuvent redélivrer le
// même message ; on ne répond qu'UNE fois). Borné pour ne pas fuir en mémoire.
const processed = new Map(); // tenant -> Set(messageId)
function markProcessed(tenant, id) {
  if (!id) return false; // sans id, on ne peut pas dédupliquer — on laisse passer
  let set = processed.get(tenant);
  if (!set) { set = new Set(); processed.set(tenant, set); }
  if (set.has(id)) return true; // déjà traité
  set.add(id);
  if (set.size > 3000) { const first = set.values().next().value; set.delete(first); }
  return false;
}

function sanitizeTenant(t) { return String(t || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'; }

// Politique de réglage : un compte « toujours actif » (alwaysOn) répond en permanence sur WhatsApp ET Telegram, sauf pause
// explicite (paused). AUTO_REPLY_DEFAULT_ON=true active aussi le répondeur par défaut des comptes sans réglage.
const defaultOn = () => process.env.AUTO_REPLY_DEFAULT_ON === 'true';
function applyPolicy(doc, tenant) {
  const d = Object.assign({}, doc);
  if (d.alwaysOn === true || alwaysOn.isAlwaysOn(tenant)) {
    d.alwaysOn = true;
    if (d.paused !== true) { d.whatsapp = true; d.telegram = true; }
  }
  return d;
}
async function getSettings(tenant) {
  const t = sanitizeTenant(tenant);
  const doc = await storageAdapter.get(SETTINGS_NS, t, { tenant: t, whatsapp: defaultOn(), telegram: defaultOn() });
  return applyPolicy(doc, t);
}
async function setSettings(tenant, patch) {
  const t = sanitizeTenant(tenant);
  const cur = await storageAdapter.get(SETTINGS_NS, t, { tenant: t, whatsapp: defaultOn(), telegram: defaultOn() });
  const next = Object.assign({}, cur, patch || {}, { tenant: t, updatedAt: new Date().toISOString() });
  if (typeof next.alwaysOn === 'boolean') alwaysOn.mark(t, next.alwaysOn);
  storageAdapter.set(SETTINGS_NS, t, next);
  return applyPolicy(next, t);
}
function isEnabled(settings, channel) {
  return String(channel).toUpperCase() === 'TELEGRAM' ? !!(settings && settings.telegram) : !!(settings && settings.whatsapp);
}

// Rédige la réponse au client, EN S'APPUYANT sur le contexte métier réel
// (produits/prix/règles des Services Métiers) et l'historique de la conversation.
async function composeReply({ tenant, channel, from, name, text, llm, directives, ctx, learning }) {
  // Model router (§6) : complexité du message -> taille de contexte + plafond
  // de tokens de sortie (économie réelle sur les messages simples).
  const route = modelRouter.classify(text);
  // Appel IA tagué (AI Cost Guard) : purpose 'client_conversation' + tenant +
  // maxTokens (routeur) + taskId (protection anti-boucle par conversation).
  // Toujours le niveau « standard » de la cascade pour un client qui attend : réponse spontanée (le doublon parallèle du fournisseur lent s'applique). Le niveau « raisonnement » (lent) reste réservé aux tâches longues.
  const meta = { purpose: 'client_conversation', tenant, maxTokens: route.maxTokens, taskId: `autoreply:${tenant}:${from}`, tier: 'standard' };
  const gen = typeof llm === 'function' ? llm : (p) => llmFallbackEngine.generateAIResponse(p, [], null, undefined, null, meta).then((r) => r.text);
  // Offres classées : SERVICE PRIORITAIRE (celui de la campagne / du sujet déjà évoqué, sinon le service actif le plus récent),
  // puis les autres offres en simples suggestions complémentaires. Source de vérité = Services métiers configurés.
  let convState = null; try { convState = await require('./jarvis/conversationState').get(tenant, channel, from); } catch (e) { convState = null; }
  let hint = (convState && ((convState.ad && convState.ad.productName) || (convState.memory && (convState.memory.interestService || convState.memory.subject)))) || '';
  // Un groupe lié (après vérification admin) à un Service métier répond d'abord sur CE service, quel que soit le métier.
  if (isGroupChat(channel, from)) { try { const linked = (await businessServices.list(tenant)).find((s) => (s.groups || []).some((g) => String(g.id) === String(from) && String(g.channel).toUpperCase() === String(channel).toUpperCase())); if (linked) hint = linked.name; } catch (e) { /* sans lien : comportement habituel */ } }
  const prio = await businessServices.getPrioritizedContext(tenant, { hint }).catch(() => ({ text: '' }));
  // Registre NATUREL (discussion courante, salutation, rappel du fil) : l'offre n'est PAS le sujet ; on la garde en tête sans la mettre en avant.
  const registerNow = ctx && ctx.decision && ctx.decision.engagement && ctx.decision.engagement.register;
  const bizCtx = ['NATURAL', 'NATURAL_CONTINUITY'].includes(registerNow)
    ? (prio.text ? "Tu connais l'activité du vendeur, mais elle n'est PAS le sujet de cette discussion : n'en parle pas, sauf si la personne t'interroge elle-même dessus." : '')
    : prio.text;
  let history = ''; let convArr = [];
  try {
    const conv = await messageHistory.getConversation(tenant, channel, from, route.maxContextMessages);
    if (conv && conv.length) { history = conv.map((m) => `${m.direction === 'in' ? 'Client' : 'Moi'}: ${m.text}`).join('\n'); convArr = conv.map((m) => ({ who: m.direction === 'in' ? 'Client' : 'Cyrus', text: m.text })); }
  } catch (e) { history = ''; }
  if (learning && learning.active) return composeLearning({ tenant, channel, from, name, text, llm, directives, learning, history, prio });
  // SPÉCIALISTE (Agency Agents) sous la tutelle de l'Orchestrateur : consulté EN COULISSES uniquement pour une étape commerciale/support qui le
  // justifie (intérêt, objection, closing, négociation, plainte) — jamais pour une salutation, un remerciement, un refus, un paiement ou un
  // contexte sensible. Il rend un AVIS ; c'est Cyrus qui écrit la réponse finale, validée par les mêmes garde-fous qu'avant.
  let advisory = '';
  try {
    const dec = ctx && ctx.decision;
    if (ctx && ctx.cls && dec && dec.action === 'REPLY' && !dec.noPromo && !dec.template && !['CLOSE', 'WAIT', 'ACK', 'COURTESY'].includes(dec.kind)) {
      const principal = require('./authz').issuePrincipal({ tenant, role: 'CUSTOMER', userId: String(from), channel, via: 'customer_message' });
      const adv = await withinBudget(require('./agents/orchestrationService').advise({
        principal, tenantId: tenant, audience: 'CUSTOMER', channel, conversationKey: `${channel}:${from}`, text: ctx.text, history: convArr, cls: ctx.cls, state: ctx.state && ctx.state.state,
        service: { name: prio.priority, text: prio.text, recommendedSpecialists: prio.recommendedSpecialists }, exchangeId: require('crypto').createHash('sha1').update(String(ctx.text)).digest('hex').slice(0, 12),
        llm: typeof llm === 'function' ? llm : undefined, synthLlm: typeof llm === 'function' ? llm : undefined,
      }).catch((e) => { if (e && e.code === 'CLIENT_AI_LIMIT') throw e; return null; }));
      if (adv && (adv.draftReply || adv.synthesis)) advisory = require('./untrusted').wrap('avis interne', [adv.synthesis, adv.draftReply ? `Brouillon possible : ${adv.draftReply}` : '', adv.cautions && adv.cautions.length ? `Vigilance : ${adv.cautions.join(' ; ')}` : ''].filter(Boolean).join('\n'), 2400);
    }
  } catch (e) { if (e && e.code === 'CLIENT_AI_LIMIT') throw e; advisory = ''; }
  // Contact issu d'une campagne Facebook Ads : le message d'accueil exact est déjà parti ; on continue à partir de là.
  let adCtx = '';
  try { adCtx = await require('./adCampaigns').continuationContext(tenant, channel, from); } catch (e) { adCtx = ''; }
  try { const gctx = await require('./groupCampaigns').continuationContext(tenant, channel, from); if (gctx) adCtx = [adCtx, gctx].filter(Boolean).join('\n'); } catch (e) { /* facultatif */ }
  const prompt = [
    personaManager.personaSystemPrompt('default'),
    adCtx,
    'Tu réponds DIRECTEMENT à un client/prospect qui vient d\'écrire au vendeur — tu réponds EN SON NOM, comme le vendeur lui-même. Sois chaleureux, humain et utile.',
    bizCtx
      ? `Informations RÉELLES de l'activité (produits, prix, règles — SEULE source autorisée, n'invente jamais au-delà de ceci) :\n${bizCtx}`
      : 'AUCUNE offre n\'est configurée pour ce vendeur. Tu ne connais donc PAS ses produits, services, prix ni domaine d\'activité.',
    history ? `Historique récent avec ce client :\n${history}` : '',
    advisory ? `AVIS INTERNE D'UN SPÉCIALISTE (consultatif — c'est TOI, Cyrus, qui écris la réponse finale avec tes mots ; ne mentionne jamais ce spécialiste ni cet avis ; il ne fait autorité sur AUCUN prix, date, promotion ou condition : seules les informations réelles ci-dessus comptent) :\n${advisory}` : '',
    directives && directives.length ? `CONSIGNES DE CONVERSATION (OBLIGATOIRES, prioritaires sur tout style commercial) :\n- ${directives.join('\n- ')}` : '',
    `Nouveau message du client ${name ? '(' + name + ')' : ''} : "${text}"`,
    // Garde-fou anti-invention RENFORCÉ (un vrai client est en face) :
    'RÈGLE ABSOLUE : n\'invente JAMAIS un produit, un service, une formation, un domaine d\'activité, un prix ou une promesse. Ne cite QUE ce qui figure explicitement dans les informations ci-dessus.',
    bizCtx
      ? 'Rédige la réponse en t\'appuyant uniquement sur ces informations réelles.'
      : 'Comme aucune offre n\'est renseignée, NE CITE AUCUN produit/service/domaine : réponds chaleureusement et demande simplement au client ce qu\'il recherche (ou dis que le vendeur va lui préciser) — sans jamais deviner ce qui est vendu.',
    // Conduite de la conversation commerciale (défauts constatés en test réel : moyens de paiement inventés, salutation répétée).
    'PAIEMENT : quand le client veut payer ou demande comment payer, donne EXACTEMENT les instructions de paiement configurées (numéro/moyen tels quels), puis demande la capture de la preuve de paiement avec son email. N\'invente JAMAIS un lien de paiement, un moyen (virement, carte…) ou un numéro absent des informations ci-dessus ; s\'ils ne sont pas configurés, dis que tu fais confirmer la procédure par le vendeur.',
    'CONSEILLER : parle comme un conseiller humain qui connaît son offre, jamais comme un questionnaire ; réponds d\'abord précisément à la question posée, puis propose la suite naturelle. Une question de suivi (« et l\'attestation ? », « ça commence quand ? », « et l\'autre formation ? ») se rapporte au service et à l\'historique ci-dessus : ne demande jamais au client de répéter le contexte. Prix, dates, caractéristiques, reconnaissance d\'une attestation, promotions et conditions : UNIQUEMENT s\'ils figurent dans les informations ci-dessus ; sinon dis que tu transmets la question au vendeur. Ne propose les autres offres que comme suggestion complémentaire pertinente, après avoir répondu.',
    'INTÉRÊT : si le client manifeste son intérêt, réponds concrètement avec ce que tu sais RÉELLEMENT de l\'offre (ce que c\'est, le prix), puis propose la suite (comment payer) — pas une simple question.',
    history ? 'Ne dis « Bonjour »/« Salut » que dans le TOUT PREMIER message d\'une conversation : ici l\'échange est déjà commencé, va droit au but.' : '',
    'INFORMATION ABSENTE : si la question porte sur un fait absent des informations (livraison, zone, délai…), ne promets pas de « vérifier et revenir » ; dis simplement que tu transmets la question au vendeur qui confirmera.',
    'Rédige UNIQUEMENT le message à lui envoyer (1 à 4 phrases naturelles, parlées), sans préambule ni guillemets. Ne présente JAMAIS une action (paiement reçu, accès débloqué) comme déjà faite — propose-la.',
  ].filter(Boolean).join('\n');
  const raw = await gen(prompt);
  return String(raw || '').trim().replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 1500);
}

// TOUR D'APPRENTISSAGE : prompt pédagogique (extraits ciblés du cours, provenance distinguée), recherche externe RÉELLE seulement si nécessaire et
// disponible (les sources consultées sont ajoutées par le code), enregistrement de la question comme CANDIDATE de FAQ (jamais le contenu officiel).
async function composeLearning({ tenant, channel, from, name, text, llm, directives, learning, history, prio }) {
  const learnerSupport = require('./learnerSupport');
  const svc = prio && prio.text ? String(prio.text).slice(0, 1500) : '';
  const prompt = learnerSupport.buildPrompt(learning, { persona: personaManager.personaSystemPrompt('default'), name, text, history, directives, businessCtx: svc });
  const meta = { purpose: 'learner_support', tenant, maxTokens: 700, taskId: `autoreply:${tenant}:${from}`, tier: 'standard' };
  let raw = null; let sources = [];
  if (typeof llm === 'function') raw = await llm(prompt);
  else {
    if (learning.needsWeb) {
      try {
        const r = await llmFallbackEngine.generateAIResponse(`${prompt}\n\nUne recherche web RÉELLE est activée : appuie-toi sur des sources fiables, présente ce qui en provient sous « Recherche externe : … », distinct du cours et de ta connaissance générale ; signale toute information incertaine ou contradictoire.`, [], null, undefined, null, Object.assign({}, meta, { grounding: true }));
        raw = r.text; sources = r.sources || [];
      } catch (e) { if (e && e.code === 'CLIENT_AI_LIMIT') throw e; raw = null; sources = []; } // recherche indisponible : jamais présentée comme effectuée
    }
    if (!raw) raw = (await llmFallbackEngine.generateAIResponse(prompt, [], null, undefined, null, meta)).text;
  }
  let reply = String(raw || '').trim().replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 1600);
  if (sources.length) reply = learnerSupport.withSources(reply, sources);
  try { await require('./courseKnowledge').recordQuestion(tenant, learning.course.id, text, learning.hasOfficial); } catch (e) { /* non bloquant */ }
  return reply;
}

// Point d'entrée : traite un message entrant de bout en bout. Retourne un objet
// d'état honnête (jamais un faux succès) : { sent, status, confirmationId } ou
// { skipped: 'DISABLED' | 'DUPLICATE' | 'NO_RUNTIME' | 'EMPTY_REPLY' }.
async function handleIncoming({ tenantId, channel, from, name, text, messageId, senderId, addressing }, deps) {
  const d = deps || {};
  const settings = d.settings || await getSettings(tenantId);
  if (!isEnabled(settings, channel)) return { skipped: 'DISABLED' };
  if (!from || !text) return { skipped: 'EMPTY_REPLY' };
  if (markProcessed(tenantId, messageId)) return { skipped: 'DUPLICATE' };
  if (!d.runtime || typeof d.runtime.sendMessageVerified !== 'function') return { skipped: 'NO_RUNTIME' };
  // Anti-boucle entre assistants : jamais de réponse automatique à un message signé par un assistant, ni à répétition avec un autre compte Cyrus.
  const peer = require('./botSignature').detectPeer({ tenantId, channel, from, text });
  if (peer) {
    try { require('./activityStore').record({ type: 'peer_bot_ignored', action: 'Message venant d’un autre assistant : aucune réponse automatique', status: 'warning', channel, tenant: tenantId, target: from, detail: peer.reason }); } catch (e) { /* non bloquant */ }
    return { skipped: 'PEER_BOT', reason: peer.reason };
  }

  try { require('./activityStore').record({ type: 'message_in', action: 'Message client reçu', status: 'ok', channel, tenant: tenantId, target: from, detail: `${text.length} caractères` }); } catch (e) { /* non bloquant */ }

  // Ancien mode : même limite par client (10 échanges IA/heure) que le moteur Jarvis.
  if (settings.jarvis === false) {
    return require('./clientLimitGuard').guardExchange(
      { tenantId, channel, from, senderId, identity: d.identity, name, exchangeId: messageId, isGroup: isGroupChat(channel, from) },
      () => legacyReply({ tenantId, channel, from, name, text }, d),
    );
  }

  const debounceMs = d.debounceMs != null ? d.debounceMs : (settings.debounceMs != null ? settings.debounceMs : DEFAULT_DEBOUNCE_MS);
  return conversationQueue.submit(
    `${sanitizeTenant(tenantId)}:${channel}:${from}`,
    { text, messageId, senderId, addressing },
    (items) => processBatch({ tenantId, channel, from, name, items, settings }, d),
    { debounceMs },
  );
}

async function sendAndLog({ tenantId, channel, from, reply }, d) {
  const out = await d.runtime.sendMessageVerified({ channel, to: from, text: require('./botSignature').sign(reply), tenantId });
  const sent = out.status === 'SUCCESS';
  try {
    require('./activityStore').record({
      type: 'auto_reply', action: 'Réponse automatique', channel, tenant: tenantId, target: from,
      status: sent ? 'ok' : (out.status === 'PENDING' ? 'pending' : 'error'),
      detail: sent ? `envoyée (réf. ${out.confirmationId || '?'})` : (out.error || out.status),
    });
  } catch (e) { /* non bloquant */ }
  return out;
}

function isGroupChat(channel, from) {
  const id = String(from || '');
  return String(channel).toUpperCase() === 'TELEGRAM' ? /^-\d+$/.test(id) : /@(?:g\.us|broadcast)$/i.test(id);
}

// L'utilisateur écrit lui-même depuis son téléphone : Cyrus se tait sur cette conversation (settings.humanPauseMinutes, 0 = désactivé).
async function handleHumanActivity({ tenantId, channel, from }) {
  const settings = await getSettings(tenantId);
  if (!isEnabled(settings, channel) || settings.humanPauseMinutes === 0 || !from) return null;
  return conversationEngine.noteHumanActivity(tenantId, channel, from, settings.humanPauseMinutes);
}

// Le client est informé qu'une réponse viendra du vendeur / qu'on vérifie : dans ce cas le propriétaire DOIT être prévenu (promesse tenue).
const PROMISE_TO_OWNER_RE = /(?:je\s+(?:vais\s+)?(?:v[ée]rifie\w*|me\s+renseigne\w*|regarde\w*)[^.!?]{0,80}(?:reviens|reviendrai|revenir|reviendra|reponds|répondrai)|je\s+(?:te|vous)\s+(?:reviens|recontacte\w*|tiens\s+au\s+courant)|transmet\w*\s+(?:ta|votre|la|cette|tes|vos)\s+(?:question|demande|message)s?|(?:fais|faire|fera)\s+confirmer|(?:le\s+)?vendeur\s+(?:te|vous)?\s*(?:qui\s+)?(?:te\s+|vous\s+)?(?:confirmera|reviendra|revient|répondra|contactera)|(?:il|elle)\s+(?:te|vous)\s+(?:revient|répondra|confirmera|recontactera))/i;

// Consignes de personnalisation de l'accueil : contact enregistré -> on l'appelle par son nom ; inconnu -> on demande poliment
// son nom/l'objet de sa demande (sans insister s'il ne répond pas).
function identityDirectives(identity, name) {
  if (identity && identity.isSavedContact && identity.contactName) return [`Ce contact est enregistré dans le répertoire du propriétaire sous le nom « ${identity.contactName} » : appelle-le par ce nom, sans le lui redemander.`];
  if (name) return [`Le contact se fait appeler « ${name} » (nom public, non vérifié) : tu peux l'utiliser naturellement.`];
  return ["Tu ne connais ni le nom ni l'objet de la demande de ce contact : demande-lui poliment, une seule fois, son nom et ce qu'il souhaite ; n'insiste pas s'il ne répond pas."];
}

// Chaque lot est un ÉCHANGE IA client : limite de 10/heure par client (voir clientAiQuota) ; au-delà, aucun appel IA, passage au propriétaire.
async function processBatch(args, d) {
  const last = args.items[args.items.length - 1] || {};
  return require('./clientLimitGuard').guardExchange(
    { tenantId: args.tenantId, channel: args.channel, from: args.from, senderId: last.senderId, identity: d.identity, name: args.name, exchangeId: last.messageId, isGroup: isGroupChat(args.channel, args.from) },
    () => processBatchInner(args, d),
  );
}

async function processBatchInner({ tenantId, channel, from, name, items, settings }, d) {
  const knownText = await businessServices.getEngineContextText(tenantId).catch(() => '');
  let history = [];
  try { history = await messageHistory.getConversation(tenantId, channel, from, 8); } catch (e) { history = []; }
  let lastOut = null;
  let productNames = [];
  try {
    const ctxData = await businessServices.getEngineContext(tenantId);
    for (const svc of ctxData || []) {
      if (svc.name) productNames.push(svc.name);
      for (const p of (svc.products || [])) if (p && (p.name || typeof p === 'string')) productNames.push(p.name || String(p));
    }
  } catch (e) { productNames = []; }
  // Arbitrage des intentions AMBIGUËES (refus vs intérêt, hésitation vs paiement…) : décision critique -> niveau raisonnement.
  const arbitrationLlm = d.llm || ((p) => llmFallbackEngine.generateAIResponse(p, [], null, undefined, null, { purpose: 'intent_arbitration', tenant: tenantId, tier: 'reasoning', maxTokens: 300 }).then((r) => r.text));
  // Juge des cas ambigus d'engagement : la cascade d'IA en production (niveau « standard », court, avec doublon parallèle) ; un modèle injecté (tests) n'est utilisé que s'il est
  // fourni explicitement (engagementLlm) — jamais le modèle de rédaction simulé.
  const judgeLlm = d.engagementLlm || (d.llm ? null : ((p) => llmFallbackEngine.generateAIResponse(p, [], null, undefined, null, { purpose: 'engagement_judgment', tenant: tenantId, tier: 'standard', maxTokens: 120 }).then((r) => r.text)));
  // ACCOMPAGNEMENT D'APPRENANT (privé ou groupe de formation lié) : recherche ciblée dans la base de connaissances de CE compte.
  let learn = null;
  try {
    const st = await require('./jarvis/conversationState').get(tenantId, channel, from);
    learn = await require('./learnerSupport').prepare({ tenant: tenantId, channel, from, senderId: (items[items.length - 1] || {}).senderId, text: items.map((i) => i.text).join('\n'), isGroup: isGroupChat(channel, from), state: st, settings });
    if (learn) learn.verify = require('./learnerSupport').verify(learn);
  } catch (e) { learn = null; }
  const result = await conversationEngine.handleBatch({ tenantId, channel, from, name, items }, {
    isGroup: isGroupChat(channel, from),
    learning: learn || undefined,
    groupReplies: settings.groupReplies === true,
    productNames,
    priorityService: (await businessServices.getPrioritizedContext(tenantId, { hint: '' }).catch(() => ({}))).priority || null,
    // Politique du propriétaire + mémoire 7 jours de CETTE discussion → décision d'engagement (répondre ? registre ? présenter un service ?). Sans réseau ni IA.
    engagementFn: async ({ cls, state, text: batchText, items: batchItems }) => {
      const group = isGroupChat(channel, from);
      const pol = conversationPolicy.resolveFor(conversationPolicy.fromSettings(settings), channel, from, group);
      const ctx = await conversationContext.analyze({ tenant: tenantId, channel, from, isGroup: group, text: batchText, windowDays: pol.windowDays });
      const lastItem = (batchItems || [])[(batchItems || []).length - 1] || {};
      const addressing = Object.assign({ named: /\bcyrus\b/i.test(batchText) }, lastItem.addressing || {});
      const base = engagement.decide({ policy: pol, ctx, cls, isGroup: group, addressing, text: batchText, state, learning: learn });
      // Cas ambigus : la cascade d'IA tranche (budget 1,8 s) ; sinon la décision par règles s'applique. Les règles dures ne sont jamais contournées.
      return engagement.arbitrate({ policy: pol, ctx, cls, isGroup: group, text: batchText, briefDirectives: base.directives }, base, judgeLlm, parseInt(process.env.ENGAGEMENT_AI_BUDGET_MS, 10) || 1800);
    },
    llm: arbitrationLlm,
    crm: d.crm || contactCrm,
    knownText: learn ? `${knownText}\n${learn.knownText}` : knownText,
    history,
    settings,
    compose: async (directives, ctx) => {
      if (learn && learn.forcedReply) return learn.forcedReply; // refus/urgence : réponse DÉTERMINISTE, aucun appel IA
      const reply = await composeReply({ learning: learn || undefined, tenant: tenantId, channel, from, name, text: ctx.text, llm: d.llm, directives: (directives || []).concat(identityDirectives(d.identity, name)), ctx });
      // Le client attend une confirmation du vendeur (fait absent du Service métier) : la promesse est TENUE — le propriétaire est prévenu.
      if (PROMISE_TO_OWNER_RE.test(reply)) {
        require('./alertCenter').triggerAdminNotification(tenantId, {
          reason: `Question sans réponse dans le Service métier : le client attend une confirmation.`, contact: d.identity || null, text: ctx.text,
          key: `esc:${tenantId}:${channel}:${from}:${Math.floor(Date.now() / 600000)}`, // même clé que l'escalade du moteur : une seule alerte par événement
        }).catch(() => {});
      }
      return reply;
    },
    send: async (reply) => { lastOut = await sendAndLog({ tenantId, channel, from, reply }, d); return lastOut; },
    // Demande hors périmètre / escalade : triggerAdminNotification (alerte persistante, WhatsApp du propriétaire + tableau de bord).
    notify: d.notify || ((msg) => require('./alertCenter').triggerAdminNotification(tenantId, { reason: msg, contact: d.identity || null, key: `esc:${tenantId}:${channel}:${from}:${Math.floor(Date.now() / 600000)}` })),
  });
  // Journal des décisions d'engagement (répond / se tait, et POURQUOI) : alimente l'outil « explainReply ».
  if (result.engagement) { try { require('./activityStore').record({ type: 'engagement', action: result.action === 'NO_ACTION' ? 'Pas de réponse' : `Réponse (${result.engagement.register})`, status: 'ok', channel, tenant: tenantId, target: from, detail: `${result.engagement.code} | ${result.engagement.why}` }); } catch (e) { /* non bloquant */ } }
  if (result.action === 'NO_ACTION') {
    try { require('./activityStore').record({ type: 'no_action', action: 'Aucune réponse nécessaire', channel, tenant: tenantId, target: from, status: 'ok', detail: `${result.intent || '-'} / ${result.reason}${result.engagement ? ' / ' + result.engagement.why : ''}` }); } catch (e) { /* non bloquant */ }
    return { skipped: 'NO_ACTION', reason: result.reason, intent: result.intent, engagement: result.engagement || null };
  }
  const out = lastOut || {};
  const sent = out.status === 'SUCCESS';
  return { sent, status: out.status, confirmationId: out.confirmationId || null, error: out.error || null, reply: result.text, intent: result.intent, state: result.state, kind: result.kind, engagement: result.engagement || null };
}

// Ancien comportement (settings.jarvis === false) : une réponse par message.
async function legacyReply({ tenantId, channel, from, name, text }, d) {
  const reply = await composeReply({ tenant: tenantId, channel, from, name, text, llm: d.llm });
  if (!reply) return { skipped: 'EMPTY_REPLY' };
  const out = await sendAndLog({ tenantId, channel, from, reply }, d);
  const sent = out.status === 'SUCCESS';
  return { sent, status: out.status, confirmationId: out.confirmationId || null, error: out.error || null, reply };
}

module.exports = { handleHumanActivity, isGroupChat, handleIncoming, composeReply, getSettings, setSettings, isEnabled, markProcessed, SETTINGS_NS };
