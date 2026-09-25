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
const responseMetrics = require('./responseMetrics');

// Réponse SPONTANÉE : attente minimale pour regrouper deux messages quasi simultanés (0 = aucune attente). Auparavant 1,5 s fixes avant tout traitement.
const DEFAULT_DEBOUNCE_MS = process.env.AUTO_REPLY_DEBOUNCE_MS !== undefined && process.env.AUTO_REPLY_DEBOUNCE_MS !== '' ? Math.max(0, parseInt(process.env.AUTO_REPLY_DEBOUNCE_MS, 10) || 0) : 0;
// L'avis d'un spécialiste ne doit JAMAIS retarder la réponse : passé ce délai, Cyrus répond sans lui (les tâches longues restent sur les voies dédiées).
const SPECIALIST_BUDGET_MS = process.env.SPECIALIST_CUSTOMER_BUDGET_MS !== undefined && process.env.SPECIALIST_CUSTOMER_BUDGET_MS !== ''
  ? Math.max(0, parseInt(process.env.SPECIALIST_CUSTOMER_BUDGET_MS, 10) || 0) : 900;
const withinBudget = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), SPECIALIST_BUDGET_MS))]);

const SETTINGS_NS = 'auto_settings';
const conversationPolicy = require('./conversationPolicy');
const conversationContext = require('./conversationContext');
const engagement = require('./engagement');

// Déduplication en mémoire par tenant (Baileys/Telegram peuvent redélivrer le
// même message ; on ne répond qu'UNE fois). Borné pour ne pas fuir en mémoire.
const processed = new Map(); // tenant -> Set(messageId)
const inFlight = new Set(); // tenant:channel:messageId -> protection contre deux événements concurrents
function processedKey(channel, id) { return `${String(channel || '').toUpperCase()}:${String(id || '')}`; }
function wasProcessed(tenant, id) {
  const set = processed.get(tenant);
  return !!(id && set && set.has(id));
}
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
function dTrace(ctx) { return ctx && ctx.responseTrace || null; }

// Politique de réglage : un compte « toujours actif » (alwaysOn) répond en permanence sur WhatsApp ET Telegram, sauf pause
// explicite (paused). AUTO_REPLY_DEFAULT_ON=true active aussi le répondeur par défaut des comptes sans réglage.
const defaultOn = () => process.env.AUTO_REPLY_DEFAULT_ON === 'true';
function applyPolicy(doc, tenant) {
  const d = Object.assign({}, doc);
  if (d.alwaysOn === true || alwaysOn.isAlwaysOn(tenant)) {
    d.alwaysOn = true;
    if (d.paused !== true) {
      d.whatsapp = true;
      d.telegram = true;
      // Le mode permanent inclut les groupes. Le moteur d'engagement garde
      // son filtrage par sujet, mentions, contexte métier et limite de débit.
      d.groupReplies = true;
      const currentPolicy = conversationPolicy.fromSettings(d);
      d.conversationPolicy = conversationPolicy.normalize(Object.assign({}, currentPolicy, { group: 'topic' }));
    }
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
  await storageAdapter.setDurable(SETTINGS_NS, t, next);
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
  let convState = ctx && ctx.conversationStateSnapshot || null;
  if (!convState) { try { convState = await require('./jarvis/conversationState').get(tenant, channel, from); } catch (e) { convState = null; } }
  let hint = (convState && ((convState.ad && convState.ad.productName) || (convState.memory && (convState.memory.interestService || convState.memory.subject)))) || '';
  // Un groupe lié (après vérification admin) à un Service métier répond d'abord sur CE service, quel que soit le métier.
  const snapshotServices = ctx && ctx.businessContextSnapshot && ctx.businessContextSnapshot.services;
  if (isGroupChat(channel, from)) {
    try {
      const source = Array.isArray(snapshotServices) ? snapshotServices : await businessServices.list(tenant);
      const linked = source.find((s) => (s.groups || []).some((g) => String(g.id) === String(from) && String(g.channel).toUpperCase() === String(channel).toUpperCase()));
      if (linked) hint = linked.name;
    } catch (e) { /* sans lien : comportement habituel */ }
  }
  let prio; let businessContextUnavailable = false;
  try {
    const priorityOpts = { hint, currentHint: isGroupChat(channel, from) ? '' : text };
    prio = Array.isArray(snapshotServices)
      ? businessServices.getPrioritizedContextFromServices(snapshotServices, priorityOpts)
      : await businessServices.getPrioritizedContext(tenant, priorityOpts);
  }
  catch (err) {
    businessContextUnavailable = true;
    prio = { text: '' };
    console.error(`autoResponder : lecture des Services métier impossible (tenant "${tenant}") :`, err && err.message ? err.message : err);
  }
  // Le registre naturel ne doit jamais effacer les faits configurés. Il interdit
  // seulement la promotion spontanée ; une question explicite garde le contexte
  // complet afin que le modèle puisse répondre avec les prix et détails exacts.
  const registerNow = ctx && ctx.decision && ctx.decision.engagement && ctx.decision.engagement.register;
  const naturalRegister = ['NATURAL', 'NATURAL_CONTINUITY'].includes(registerNow);
  const explicitBusinessRequest = !!(
    businessServices.matchService(prio.services || [], text)
    || /\b(?:prix|tarifs?|combien|co[uû]t|coute|montant|frais|offres?|services?|formations?|cours|produits?|inscriptions?|inscrire|vendre|vendez|vente)\b/i.test(String(text || ''))
    || ['BUSINESS_ANSWER', 'PRESENT_SERVICE'].includes(registerNow)
  );
  const bizCtx = prio.text && (!naturalRegister || explicitBusinessRequest) ? prio.text : '';
  const deterministicPrice = businessServices.answerExplicitPriceQuestion(prio.services || [], text, hint);
  if (deterministicPrice) {
    if (dTrace(ctx)) dTrace(ctx).mark('generated', { method: 'business_fact' });
    return deterministicPrice;
  }
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
    const needsSpecialist = ctx && ctx.cls && ['PRICE_OBJECTION', 'OBJECTION', 'COMPLAINT', 'SUPPORT'].includes(ctx.cls.intent);
    if (SPECIALIST_BUDGET_MS > 0 && needsSpecialist && dec && dec.action === 'REPLY' && !dec.noPromo && !dec.template && !['CLOSE', 'WAIT', 'ACK', 'COURTESY'].includes(dec.kind)) {
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
    personaManager.personaSystemPrompt('default', { audience: 'customer' }),
    adCtx,
    'Tu réponds DIRECTEMENT à un client/prospect qui vient d\'écrire au vendeur — tu réponds EN SON NOM, comme le vendeur lui-même. Sois chaleureux, humain et utile.',
    bizCtx
      ? `Informations RÉELLES de l'activité (produits, prix, règles — SEULE source autorisée, n'invente jamais au-delà de ceci) :\n${bizCtx}`
      : (businessContextUnavailable
        ? 'La lecture du Service métier a échoué temporairement. Ne prétends pas qu’aucune offre n’est configurée et n’invente aucun fait ; indique simplement que tu vérifies l’information.'
        : (naturalRegister && prio.text
          ? 'Des offres sont configurées, mais ce message ne les concerne pas. Ne les mentionne pas spontanément ; si le client pose une question métier, réponds uniquement avec les faits configurés.'
          : 'AUCUNE offre n\'est configurée pour ce vendeur. Tu ne connais donc PAS ses produits, services, prix ni domaine d\'activité.')),
    ctx && ctx.decision && ctx.decision.engagement && ctx.decision.engagement.register === 'NATURAL_CONTINUITY'
      ? 'MEMOIRE DE CONVERSATION : tu peux rappeler en une courte phrase le sujet recemment aborde, sans reprendre un prix ni relancer la vente.' : '',
    naturalRegister && !explicitBusinessRequest
      ? "REGISTRE NATUREL : l'activité n'est PAS le sujet de cette discussion. Ne cite aucune offre sauf si le client l'aborde lui-même."
      : (naturalRegister ? 'REGISTRE NATUREL : aucune promotion spontanée. Pour une question explicite, réponds seulement avec les faits réels configurés.' : ''),
    history ? `Historique récent avec ce client :\n${history}` : '',
    advisory ? `AVIS INTERNE D'UN SPÉCIALISTE (consultatif — c'est TOI, Cyrus, qui écris la réponse finale avec tes mots ; ne mentionne jamais ce spécialiste ni cet avis ; il ne fait autorité sur AUCUN prix, date, promotion ou condition : seules les informations réelles ci-dessus comptent) :\n${advisory}` : '',
    directives && directives.length ? `CONSIGNES DE CONVERSATION (OBLIGATOIRES, prioritaires sur tout style commercial) :\n- ${directives.join('\n- ')}` : '',
    `Nouveau message du client ${name ? '(' + name + ')' : ''} : "${text}"`,
    // Garde-fou anti-invention RENFORCÉ (un vrai client est en face) :
    'RÈGLE ABSOLUE : n\'invente JAMAIS un produit, un service, une formation, un domaine d\'activité, un prix ou une promesse. Ne cite QUE ce qui figure explicitement dans les informations ci-dessus.',
    bizCtx
      ? 'Rédige la réponse en t\'appuyant uniquement sur ces informations réelles.'
      : (businessContextUnavailable
        ? 'Comme le Service métier est momentanément illisible, ne dis pas qu’il est vide et ne devine rien ; réponds brièvement que tu vérifies le détail exact.'
        : 'Comme aucune offre n\'est renseignée, NE CITE AUCUN produit/service/domaine : réponds chaleureusement et demande simplement au client ce qu\'il recherche — sans jamais deviner ce qui est vendu.'),
    // Conduite de la conversation commerciale (défauts constatés en test réel : moyens de paiement inventés, salutation répétée).
    'PAIEMENT : quand le client veut payer ou demande comment payer, donne EXACTEMENT les instructions de paiement configurées (numéro/moyen tels quels), puis demande la capture de la preuve de paiement avec son email. N\'invente JAMAIS un lien de paiement, un moyen (virement, carte…) ou un numéro absent des informations ci-dessus ; s\'ils ne sont pas configurés, dis simplement que tu reviens vers lui très vite avec la procédure exacte.',
    'CONSEILLER : parle comme un conseiller humain qui connaît son offre, jamais comme un questionnaire ; réponds d\'abord précisément à la question posée, puis propose la suite naturelle. Une question de suivi (« et l\'attestation ? », « ça commence quand ? », « et l\'autre formation ? ») se rapporte au service et à l\'historique ci-dessus : ne demande jamais au client de répéter le contexte. Prix, dates, caractéristiques, reconnaissance d\'une attestation, promotions et conditions : UNIQUEMENT s\'ils figurent dans les informations ci-dessus ; sinon dis simplement que tu reviens vers lui très vite avec la réponse exacte. Ne propose les autres offres que comme suggestion complémentaire pertinente, après avoir répondu.',
    'INTÉRÊT : si le client manifeste son intérêt, réponds concrètement avec ce que tu sais RÉELLEMENT de l\'offre (ce que c\'est, le prix), puis propose la suite (comment payer) — pas une simple question.',
    history ? 'Ne dis « Bonjour »/« Salut » que dans le TOUT PREMIER message d\'une conversation : ici l\'échange est déjà commencé, va droit au but.' : '',
    'INFORMATION ABSENTE : si la question porte sur un fait absent des informations (livraison, zone, délai…), dis-le simplement à la première personne et annonce que tu reviens très vite avec la confirmation exacte — jamais que tu « transmets »/« fais remonter » à quelqu\'un d\'autre, ne mentionne aucun tiers.',
    'Rédige UNIQUEMENT le message à lui envoyer (1 à 4 phrases naturelles, parlées), sans préambule ni guillemets. Ne présente JAMAIS une action (paiement reçu, accès débloqué) comme déjà faite — propose-la.',
  ].filter(Boolean).join('\n');
  if (dTrace(ctx)) dTrace(ctx).mark('ai_started', { provider: 'cascade' });
  const raw = await gen(prompt);
  if (dTrace(ctx)) dTrace(ctx).mark('generated', { method: 'ai' });
  return scrubPaymentUrls(String(raw || '').trim().replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 1500), text);
}

// TOUR D'APPRENTISSAGE : prompt pédagogique (extraits ciblés du cours, provenance distinguée), recherche externe RÉELLE seulement si nécessaire et
// disponible (les sources consultées sont ajoutées par le code), enregistrement de la question comme CANDIDATE de FAQ (jamais le contenu officiel).
async function composeLearning({ tenant, channel, from, name, text, llm, directives, learning, history, prio }) {
  const learnerSupport = require('./learnerSupport');
  const svc = prio && prio.text ? String(prio.text).slice(0, 1500) : '';
  const prompt = learnerSupport.buildPrompt(learning, { persona: personaManager.personaSystemPrompt('default', { audience: 'customer' }), name, text, history, directives, businessCtx: svc });
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
async function handleIncomingCore({ tenantId, channel, from, name, text, messageId, senderId, addressing }, deps) {
  const d = deps || {};
  const settings = d.settings || await getSettings(tenantId);
  if (!isEnabled(settings, channel)) return { skipped: 'DISABLED' };
  if (!from || !text) return { skipped: 'EMPTY_REPLY' };
  if (!d.runtime || typeof d.runtime.sendMessageVerified !== 'function') return { skipped: 'NO_RUNTIME' };
  // L'identifiant n'est consommé qu'après un résultat terminal. Une panne IA
  // ou un échec certain d'envoi peut donc être retenté avec le même message ;
  // deux livraisons simultanées restent bloquées par inFlight.
  const dedupeId = messageId ? processedKey(channel, messageId) : null;
  const flightId = dedupeId ? `${sanitizeTenant(tenantId)}:${dedupeId}` : null;
  if (dedupeId && wasProcessed(tenantId, dedupeId)) return { skipped: 'DUPLICATE' };
  if (flightId && inFlight.has(flightId)) return { skipped: 'DUPLICATE_IN_FLIGHT' };
  if (flightId) inFlight.add(flightId);
  try {
  // Anti-boucle entre assistants : jamais de réponse automatique à un message signé par un assistant, ni à répétition avec un autre compte Cyrus.
  const peer = require('./botSignature').detectPeer({ tenantId, channel, from, text });
  if (peer) {
    try { require('./activityStore').record({ type: 'peer_bot_ignored', action: 'Message venant d’un autre assistant : aucune réponse automatique', status: 'warning', channel, tenant: tenantId, target: from, detail: peer.reason }); } catch (e) { /* non bloquant */ }
    if (dedupeId) markProcessed(tenantId, dedupeId);
    return { skipped: 'PEER_BOT', reason: peer.reason };
  }

  try { require('./activityStore').record({ type: 'message_in', action: 'Message client reçu', status: 'ok', channel, tenant: tenantId, target: from, detail: `${text.length} caractères` }); } catch (e) { /* non bloquant */ }

  // Ancien mode : même limite par client (10 échanges IA/heure) que le moteur Jarvis.
  if (settings.jarvis === false) {
    const out = await require('./clientLimitGuard').guardExchange(
      { tenantId, channel, from, senderId, identity: d.identity, name, exchangeId: messageId, isGroup: isGroupChat(channel, from) },
      () => legacyReply({ tenantId, channel, from, name, text }, d),
    );
    if (dedupeId && terminalOutcome(out)) markProcessed(tenantId, dedupeId);
    return out;
  }

  const debounceMs = d.debounceMs != null ? d.debounceMs : DEFAULT_DEBOUNCE_MS;
  const out = await conversationQueue.submit(
    `${sanitizeTenant(tenantId)}:${channel}:${from}`,
    { text, messageId, senderId, addressing },
    (items) => processBatch({ tenantId, channel, from, name, items, settings }, d),
    { debounceMs },
  );
  if (dedupeId && terminalOutcome(out)) markProcessed(tenantId, dedupeId);
  return out;
  } finally {
    if (flightId) inFlight.delete(flightId);
  }
}

// Trace toutes les sorties du répondeur (y compris les refus, dédoublons et
// pannes) sans enregistrer le texte du message. Un appelant plus haut dans le
// webhook peut fournir son propre trace pour couvrir aussi détection et routage.
async function handleIncoming(input, deps) {
  const event = input || {};
  const upstreamTrace = deps && deps.responseTrace;
  const trace = upstreamTrace || responseMetrics.start({
    tenant: event.tenantId, channel: event.channel, target: event.from, source: 'auto_responder',
  });
  trace.mark('routed', { method: 'auto_responder' });
  let outcome = null;
  let failed = false;
  try {
    outcome = await handleIncomingCore(event, Object.assign({}, deps || {}, { responseTrace: trace }));
    return outcome;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!upstreamTrace) await trace.finish({ status: failed ? 'ERROR' : (outcome && outcome.sent ? 'SENT' : (outcome && outcome.skipped) || 'DONE') });
  }
}

function terminalOutcome(out) {
  if (!out) return false;
  if (out.sent === true || out.status === 'PENDING') return true;
  return ['NO_ACTION', 'PEER_BOT', 'DISABLED', 'EMPTY_REPLY'].includes(out.skipped);
}

async function sendAndLog({ tenantId, channel, from, reply }, d) {
  if (d && d.responseTrace) d.responseTrace.mark('send_started');
  const out = await d.runtime.sendMessageVerified({ channel, to: from, text: require('./botSignature').sign(reply), tenantId });
  const sent = out.status === 'SUCCESS';
  if (d && d.responseTrace) d.responseTrace.mark(sent ? 'send_confirmed' : 'send_failed', { status: out.status || 'UNKNOWN' });
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

// Le client est informé qu'une réponse va suivre / qu'on vérifie : dans ce cas le propriétaire DOIT être prévenu (promesse tenue).
// Depuis le 2026-09-23, le client ne doit plus jamais lire « je transmets au vendeur » (voir directives ci-dessus, réécrites en
// « je reviens vers vous très vite ») : le premier motif ci-dessous couvre cette nouvelle formulation ; les motifs suivants
// restent en repli pour toute variante que l'IA rédigerait malgré tout dans l'ancien style.
const PROMISE_TO_OWNER_RE = /(?:revi(?:ens|endrai|endra)\s+vers\s+(?:toi|vous|lui|elle)|je\s+(?:vais\s+)?(?:v[ée]rifie\w*|me\s+renseigne\w*|regarde\w*)[^.!?]{0,80}(?:reviens|reviendrai|revenir|reviendra|reponds|répondrai)|je\s+(?:te|vous)\s+(?:reviens|recontacte\w*|tiens\s+au\s+courant)|transmet\w*\s+(?:ta|votre|la|cette|tes|vos)\s+(?:question|demande|message)s?|(?:fais|faire|fera)\s+confirmer|(?:le\s+)?vendeur\s+(?:te|vous)?\s*(?:qui\s+)?(?:te\s+|vous\s+)?(?:confirmera|reviendra|revient|répondra|contactera)|(?:il|elle)\s+(?:te|vous)\s+(?:revient|répondra|confirmera|recontactera))/i;

// Consignes de personnalisation de l'accueil : contact enregistré -> on l'appelle par son nom ; inconnu -> on demande poliment
// son nom/l'objet de sa demande (sans insister s'il ne répond pas).
function scrubPaymentUrls(reply, context) {
  const text = String(reply || '');
  return /paiement|payer|payez|mobile\s*money|wave|orange\s*money|mtn\s*money|moov/i.test(`${context || ''} ${text}`)
    ? text.replace(/https?:\/\/\S+|www\.\S+/gi, '').replace(/\s{2,}/g, ' ').trim()
    : text;
}

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
  const trace = d && d.responseTrace;
  const batchText = items.map((i) => i.text).join('\n');
  if (trace) trace.mark('context_started');
  const [serviceData, history, st] = await Promise.all([
    businessServices.getEngineContext(tenantId).catch((e) => { console.error(`autoResponder : contexte métier indisponible (${tenantId}) :`, e && e.message); return []; }),
    messageHistory.getConversation(tenantId, channel, from, 8).catch(() => []),
    require('./jarvis/conversationState').get(tenantId, channel, from).catch(() => null),
  ]);
  const knownText = businessServices.getEngineContextTextFromServices(serviceData);
  const productNames = [];
  for (const svc of serviceData) {
    if (svc.name) productNames.push(svc.name);
    for (const p of (svc.products || [])) if (p && (p.name || typeof p === 'string')) productNames.push(p.name || String(p));
  }
  let serviceHint = (st && st.memory && (st.memory.interestService || st.memory.subject)) || '';
  if (isGroupChat(channel, from)) {
    const linked = serviceData.find((svc) => (svc.groups || []).some((g) => String(g.id) === String(from) && String(g.channel).toUpperCase() === String(channel).toUpperCase()));
    if (linked) serviceHint = linked.name;
  }
  const businessContextSnapshot = businessServices.getPrioritizedContextFromServices(serviceData, {
    hint: serviceHint,
    currentHint: isGroupChat(channel, from) ? '' : batchText,
  });
  if (trace) {
    trace.mark('business_service_resolved', { status: businessContextSnapshot.priority ? 'matched' : 'none' });
    trace.mark('context_ready');
  }
  let lastOut = null;
  // Arbitrage des intentions AMBIGUËES (refus vs intérêt, hésitation vs paiement…) : décision critique -> niveau raisonnement.
  const arbitrationLlm = d.llm || ((p) => llmFallbackEngine.generateAIResponse(p, [], null, undefined, null, { purpose: 'intent_arbitration', tenant: tenantId, tier: 'reasoning', maxTokens: 300 }).then((r) => r.text));
  // Juge des cas ambigus d'engagement : la cascade d'IA en production (niveau « standard », court, avec doublon parallèle) ; un modèle injecté (tests) n'est utilisé que s'il est
  // fourni explicitement (engagementLlm) — jamais le modèle de rédaction simulé.
  const judgeLlm = d.engagementLlm || (d.llm ? null : ((p) => llmFallbackEngine.generateAIResponse(p, [], null, undefined, null, { purpose: 'engagement_judgment', tenant: tenantId, tier: 'standard', maxTokens: 120 }).then((r) => r.text)));
  // ACCOMPAGNEMENT D'APPRENANT (privé ou groupe de formation lié) : recherche ciblée dans la base de connaissances de CE compte.
  let learn = null;
  try {
    learn = await require('./learnerSupport').prepare({ tenant: tenantId, channel, from, senderId: (items[items.length - 1] || {}).senderId, text: items.map((i) => i.text).join('\n'), isGroup: isGroupChat(channel, from), state: st, settings });
    if (learn) learn.verify = require('./learnerSupport').verify(learn);
  } catch (e) { learn = null; }
  const result = await conversationEngine.handleBatch({ tenantId, channel, from, name, items }, {
    isGroup: isGroupChat(channel, from),
    learning: learn || undefined,
    groupReplies: settings.groupReplies === true,
    productNames,
    // Sélection du service pertinent guidée par le CONTEXTE déjà engagé (service qui a suscité l'intérêt du
    // client, sinon sujet courant de la conversation — voir jarvis/conversationEngine.js#applyState) plutôt que
    // toujours le service le plus récent : un `hint` vide ici faisait retomber getPrioritizedContext sur son seul
    // repli "le plus récent" à CHAQUE message, y compris en pleine conversation sur un autre service.
    priorityService: businessContextSnapshot.priority || null,
    // Politique du propriétaire + mémoire 7 jours de CETTE discussion → décision d'engagement (répondre ? registre ? présenter un service ?). Sans réseau ni IA.
    engagementFn: typeof d.engagementFn === 'function' ? d.engagementFn : async ({ cls, state, text: batchText, items: batchItems }) => {
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
      const replyCtx = Object.assign({}, ctx, { businessContextSnapshot, conversationStateSnapshot: st, responseTrace: trace });
      const reply = await composeReply({ learning: learn || undefined, tenant: tenantId, channel, from, name, text: ctx.text, llm: d.llm, directives: (directives || []).concat(identityDirectives(d.identity, name)), ctx: replyCtx });
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
  if (trace) trace.mark('intent_detected', { intent: result.intent || result.reason || 'unknown', method: result.action || 'conversation_engine' });
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

module.exports = { handleHumanActivity, isGroupChat, handleIncoming, composeReply, scrubPaymentUrls, getSettings, setSettings, isEnabled, markProcessed, SETTINGS_NS };
