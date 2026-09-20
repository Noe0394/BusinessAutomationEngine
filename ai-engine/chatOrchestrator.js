const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const taskParser = require('../lib/intelligence/task-parser');
const goalChat = require('../lib/intelligence/goal-chat');
const offerClarifier = require('./offerClarifier');
const personaManager = require('./personaManager');
const platformOrchestrator = require('./platformOrchestrator');
const connectorManager = require('./connectors/connectorManager');
const businessServices = require('./businessServices');
const toolRegistry = require('./toolRegistry');
const toolAgent = require('./toolAgent');
const agentLoop = require('./jarvis/agentLoop');
const memoryQuery = require('./memoryQuery');
const manualPaymentValidator = require('./manualPaymentValidator');
const contactCrm = require('./contactCrm');
const recurringTasks = require('../queues/recurringTasks');
const messageHistory = require('./messageHistory');
const actionLedger = require('./actionLedger');

// CHAT-DRIVEN AGENT ORCHESTRATOR — ai-engine/chatOrchestrator.js
// ---------------------------------------------------------------------------
// Point d'entrée UNIQUE demandé par le cahier des charges : chaque message
// saisi dans la fenêtre de tchat principale (Copywriter Studio IA côté VPS,
// voir index.js#POST /api/ai-studio/sessions/:id/messages) est interprété
// comme une instruction de pilotage AVANT d'être traité comme un simple
// message de conversation.
//
// NE RÉINVENTE AUCUN MOTEUR — compose 3 systèmes déjà existants et éprouvés
// dans ce dépôt (voir docs/PARITE-LOCAL.md pour le détail de cette
// découverte) :
//   - ai-engine/offerClarifier.js : nouvelle offre -> questions structurées.
//   - lib/intelligence/{task-parser,goal-chat}.js : objectif business
//     (ventes/prospection/contenu/relance/rapport/comptes) -> plan de tâches
//     multi-canal, exécuté via le MÊME automation-engine que
//     /api/intelligence/goal-chat (voir `deps.engineFor`, injecté par
//     index.js depuis lib/intelligence/vps-bridge.js — jamais un second
//     moteur construit ici, ce qui fragmenterait l'idempotence par runId).
//   - lib/intelligence/action-executor.js (18 actions) : exécution directe
//     et immédiate des outils "un coup" (paiement, remise, compte élève,
//     accès module, rapport) via `deps.runtime.actionExecutor.execute(...)`
//     — jamais la file de tâches différées de l'automation-engine, inutile
//     pour une action synchrone à répondre dans le tour de tchat courant.
//
// Contrairement à l'UI Goal Chat existante (bouton "🚀 Oui, lancer
// maintenant"), ce module ne montre jamais de bouton — mais n'exécute plus
// non plus AUTOMATIQUEMENT une campagne dès que le plan est prêt (revu suite
// au cahier des charges "Human-like Dialogue", voir ai-engine/personaManager.js) :
// pour 'goal' (une campagne, potentiellement coûteuse/visible par de vrais
// clients), l'Agent reformule chaleureusement la mission et DEMANDE
// confirmation avant de lancer — l'exécution ne démarre qu'au message
// suivant si le vendeur confirme (voir personaManager.detectAffirmative),
// et tourne alors EN ARRIÈRE-PLAN (réponse immédiate + notification de fin
// via platformOrchestrator.notifyTenantChat, jamais de latence perçue —
// "Fluid Streaming", §2 du cahier des charges). Les actions "un coup" plus
// légères (paiement, remise, compte élève, accès module, rapport) restent
// exécutées dès que prêtes : leur coût/risque est sans commune mesure avec
// une campagne envoyée à de vrais contacts.

function extractJsonBlock(rawText) {
  const match = String(rawText || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (err) { return null; }
}

// Pas de `\b` final volontairement (voir lib/intelligence/task-parser.js#detectGoals,
// même convention) : les racines ci-dessous (vend, prospect, relanc, analys,
// encaiss, negoci, debloque...) sont volontairement TRONQUÉES pour capter
// toutes leurs formes conjuguées/dérivées (vendre/vends/vendu, prospecter/
// prospection, relance/relancer, analyser/analyse, encaisser/encaisse,
// négocie/négocier, débloque/débloquer...) — un `\b` final les aurait
// bloquées à tort (ex: /\bvend\b/ ne matche jamais "vendre").
const REPORT_RE = /(o[uù]\s+en\s+(?:est|sont)|bilan\s+du\s+jour|statut\s+de|rapport\s+de|comment\s+(?:vont|se\s+portent)|combien\s+de\s+ventes|r[ée]sultats?\s+du\s+jour)/i;
const PAYMENT_RE = /(lien\s+de\s+paiement|\bpayer\b|\bpaiement\b|encaiss|mobile\s?money|orange\s?money|mtn\s?money|moov\s?money|\bwave\b|\bremise\b|r[ée]duction|\brabais\b|n[ée]goci)/i;
const ACCOUNT_RE = /(compte\s+(?:[ée]l[eè]ve|[ée]tudiant|client)|cl[ée]\s+d.?acc[èe]s|acc[èe]s\s+(?:[ée]l[eè]ve|module|au\s+module)|g[ée]n[èe]re?\s+un\s+acc[èe]s|d[ée]bloque|inscri(?:s|re|t)|enr[ôo]le|suspend|d[ée]sactive)/i;
// Actions "plateforme externe" (connecteurs pilotés par les permissions du
// vendeur, voir ai-engine/connectors/) : ajout de contact/tag CRM, inscription
// sur une plateforme tierce, comptabilité... CYRUS n'est PAS limité à une
// plateforme précise — les mots-clés ci-dessous sont volontairement TRONQUÉS
// (contact/tag/inscri/factur/vente) pour capter leurs formes dérivées, comme
// task-parser.js. Le handler ne propose au LLM que les outils réellement
// autorisés pour ce tenant (getToolsForTenant) — s'il n'y en a aucun, il
// retombe sur le flux compte interne classique.
// NB : "contact" seul est volontairement EXCLU (trop générique — "prospecter
// 100 contacts" est un objectif, pas une action connecteur) ; on exige un
// verbe/contexte explicite (ajoute … contact / system.io / crm / tag / facture).
const CONNECTOR_RE = /(ajoute[rz]?\s+(?:ce\s+|le\s+|un\s+|mon\s+)?contact|\btague?r?\b|\btags?\b|system\.?io|systeme\.?io|\bcrm\b|factur|enregistre?\s+(?:la|une|cette)\s+vente|journal\s+des\s+ventes)/i;
// Lecture de la boîte de réception (prouver la connexion réelle + citer un
// vrai message/expéditeur). Volontairement placé AVANT 'goal' dans
// detectIntent : "dernier message reçu" ne doit pas être happé par le moteur
// d'objectifs.
const INBOX_RE = /(derniers?\s+messages?|messages?\s+re[çc]us?|qui\s+m.?a\s+(?:écrit|ecrit|envoy[ée]|contact[ée])|num[ée]ro\s+de\s+l.?exp[ée]diteur|\bexp[ée]diteur\b|bo[îi]te\s+de\s+r[ée]ception|\binbox\b|(?:es|est)-?\s*tu\s+(?:vraiment\s+)?connect[ée]|connect[ée]\s+[àa]\s+mon\s+(?:whatsapp|telegram)|montre(?:-|\s+)(?:moi\s+)?mes\s+messages)/i;
// Consultation des groupes (liste, "où je suis admin", filtre par sujet).
// Placé AVANT 'goal' (GOAL_RE capte "groupes"/"membres") : une QUESTION sur les
// groupes ne doit pas lancer le moteur d'objectifs. La véritable exécution
// ("écris aux membres du groupe X …") reste gérée par 'goal' (à enrichir).
const GROUPS_RE = /(mes\s+groupes?|liste[rz]?\s+(?:mes\s+)?groupes?|quels?\s+(?:sont\s+)?(?:mes\s+)?groupes?|combien\s+de\s+groupes?|groupes?\s+(?:dont|o[ùu])\s+je\s+suis\s+admin|groupes?\s+que\s+j.?administre|mes\s+groupes?\s+admin)/i;
// Consultation du CRM (contacts étiquetés prospect/client, comptages).
// AVANT 'goal' (GOAL_RE capte "prospect") : une question sur les contacts
// étiquetés ne doit pas lancer le moteur d'objectifs.
const CRM_RE = /(mes\s+(?:prospects?|clients?|contacts?)|combien\s+de\s+(?:prospects?|clients?|contacts?)|contacts?\s+[ée]tiquet|contacts?\s+tagg?[ée]s?|liste[rz]?\s+(?:mes\s+)?(?:prospects?|clients?|contacts?)|qui\s+sont\s+mes\s+(?:prospects?|clients?)|mes\s+[ée]tiquettes)/i;
// Tâches récurrentes ("chaque matin envoie X au groupe Y") + gestion (liste,
// arrêt). Placé AVANT 'grouppost' : un envoi récurrent est d'abord une
// programmation, pas un envoi immédiat.
const RECURRING_RE = /(chaque\s+(?:matin|jour|soir|semaine|nuit|midi|\d{1,2}\s*h)|tous\s+les\s+(?:matins|jours|soirs)|chaque\s+jour|t[âa]ches?\s+r[ée]curren|r[ée]currente?s?\b|automatiser?\b|programme[rz]?\s+(?:un\s+)?(?:message|envoi)\s+quotidien)/i;
// Publication/partage DANS un ou des groupes (poste ça dans le groupe X, envoie
// à tous mes groupes admin). Exclut "membre" (là c'est un envoi aux MEMBRES en
// DM = 'goal'/campagne, pas une publication dans le groupe).
const GROUPPOST_RE = /(poste|publie|partage|diffuse|balance|envoi[e]?)\w*[^]{0,80}?(groupe|groupes|canal|canaux)/i;
// Réponse RÉELLE au dernier message (ou à un contact nommé), avec vérification.
const REPLY_RE = /(r[ée]ponds?(?:\s|-)?(?:lui|leur|[àa]\b)|r[ée]pondre\s+[àa]\b|dis(?:\s|-)?lui|renvoie(?:\s|-)?lui|r[ée]pond(?:s|re)\s+(?:au|à|a)\b)/i;
// Supervision : "qu'as-tu fait / statut de tes actions / rapport de tes envois".
const ACTIONS_RE = /(qu.?as-?tu\s+fait|tes\s+actions|actions\s+r[ée]centes|statut\s+de[s]?\s+actions|rapport\s+de[s]?\s+(?:tes\s+)?(?:actions|envois)|historique\s+de[s]?\s+actions)/i;
const GOAL_RE = /(\bvend|\bvente|prospect|groupes?|membres?|publier|poster|\bcontenu|relanc|follow\s?up|\bsuivi|rappel|analys|\brapport|\bbilan)/i;
// Question FACTUELLE sur l'activité configurée dans l'onglet Services Métiers
// (prix, tarif, produit, formation, offre, catalogue, règle, objectif). Le
// chat doit y répondre depuis les VRAIES données (businessServices), jamais en
// inventant — c'est le maillon "DONNÉES → INTELLIGENCE" qui manquait. Exige un
// cue de CONSULTATION (quel/combien/liste/montre/rappelle… OU « prix de … »)
// pour ne PAS happer un ordre d'action ("présente ma formation à ce client" =
// action, pas une question). Placé APRÈS toutes les intentions d'action et
// juste AVANT 'goal' : une vraie commande garde la priorité.
const BUSINESSINFO_RE = /((?:\bquel(?:le|s|les)?\b|\bcombien\b|c(?:'|’)?est\s+(?:quoi|combien)|\bliste[rz]?\b|\bmontre|\baffiche|\brappelle|\bdonne(?:-|\s)moi|\bc'est\s+quoi)[^]{0,40}(?:prix|tarif|co[ûu]te?|produits?|formations?|offres?|services?|catalogue|r[èe]gles?|objectifs?))|((?:prix|tarif)\s+(?:de|d'|du|de\s+la|de\s+ma|de\s+mon)\b)|(mes\s+(?:produits?|offres?|formations?|r[èe]gles?|objectifs?|tarifs?)\b)|(mon\s+catalogue\b)/i;
// Configuration d'un Service Métier PAR LE CHAT (création / connexion API /
// permissions). Placé AVANT payment/account/businessinfo/goal.
const CONFIGSVC_RE = /((cr[ée]e?r?|configur|param[èe]tr|enregistre?|ajoute?r?|mets?\s+en\s+place)\w*[^]{0,40}(service\s+m[ée]tier|nouveau\s+service|mon\s+service|activit[ée]|business))|((connect|branch|relie?|lie?)\w*[^]{0,30}(api|plateforme|passerelle|system\.?io))|(configure?r?\s+mon\s+api)/i;
// Import de contacts en masse depuis un fichier joint dans le chat.
const IMPORTCONTACTS_RE = /((importe?r?|charge?r?|ajoute?r?|int[èe]gre?r?)\s+(ces?|les?|mes?|ce|le|un|des)?\s*(contacts?|fichier|liste|excel|csv))|(importe?r?\s+(ce|le)\s+fichier)/i;
// Génération d'un média (affiche/image/visuel) — hors publication de groupe.
const GENMEDIA_RE = /(g[ée]n[èe]re?r?|cr[ée]e?r?|fabrique?r?|dessine?r?|fais(?:-|\s)moi|con[çc]ois)\w*[^]{0,25}(affiche|image|visuel|flyer|banni[èe]re|logo|illustration|poster|carte|design)/i;

// Détection d'intention (Command Parsing, §1.1 du cahier des charges) —
// zéro appel réseau, comme index.js#detectStudioIntent dont ce module étend
// le principe. `lastAssistantMessage` (voir même mécanisme de "reprise du
// fil" que index.js#POST .../messages) fait gagner la continuation d'une
// intention en cours sur toute reclassification par mots-clés du nouveau
// message, exactement comme pour image/vidéo/livre.
function detectIntent(text, lastAssistantMessage) {
  const continuation = ['offer', 'payment', 'account', 'connector', 'goal', 'recurring', 'grouppost', 'reply'];
  if (lastAssistantMessage && lastAssistantMessage.isPlanningQuestion && continuation.includes(lastAssistantMessage.intent)) {
    return lastAssistantMessage.intent;
  }
  if (offerClarifier.detectNewOfferIntent(text)) return 'offer';
  // 'reply' (répondre réellement au dernier message) AVANT 'inbox' : "réponds-lui"
  // est une action d'envoi, pas une lecture. AVANT 'report' aussi (répond ≠ rapport).
  if (REPLY_RE.test(text)) return 'reply';
  if (ACTIONS_RE.test(text)) return 'actionsreport';
  // Questions sur la mémoire 7×24 h (retrouver une discussion, ce qu'un client a dit, qui a parlé de...) : réponse factuelle.
  if (memoryQuery.isMemoryQuestion(text) && !(INBOX_RE.test(text) && !memoryQuery.hasSpecifics(text))) return 'memory';
  if (INBOX_RE.test(text)) return 'inbox';
  // Actions "centre des intentions" pilotées par le chat, prioritaires sur les
  // intentions génériques (payment/account/businessinfo/goal) qui les
  // happaient. genmedia laisse la main à grouppost si un groupe est mentionné.
  if (CONFIGSVC_RE.test(text)) return 'configsvc';
  if (IMPORTCONTACTS_RE.test(text)) return 'importcontacts';
  if (GENMEDIA_RE.test(text) && !/groupe/i.test(text)) return 'genmedia';
  // Ordre important : une programmation récurrente ("chaque matin envoie au
  // groupe…") l'emporte sur une publication ponctuelle ; une publication (verbe
  // poste/partage/…) l'emporte sur la simple LISTE des groupes — sinon
  // "partage à tous mes groupes admin" serait pris pour une question de liste.
  if (RECURRING_RE.test(text)) return 'recurring';
  if (GROUPPOST_RE.test(text) && !/membre/i.test(text)) return 'grouppost';
  if (GROUPS_RE.test(text)) return 'groups';
  if (CRM_RE.test(text)) return 'crm';
  if (REPORT_RE.test(text)) return 'report';
  if (PAYMENT_RE.test(text)) return 'payment';
  // 'account' et 'connector' partagent le même handler (handleConnector) :
  // action d'administration sur une plateforme (interne cyrus_students en
  // repli, ou plateforme externe du vendeur via connecteur autorisé).
  if (ACCOUNT_RE.test(text) || CONNECTOR_RE.test(text)) return 'connector';
  // Question factuelle sur l'activité (prix/produits/règles/objectifs) —
  // APRÈS les actions, AVANT 'goal' : "analyse mes ventes" reste un objectif,
  // "quel est le prix de ma formation ?" devient une consultation de données.
  if (BUSINESSINFO_RE.test(text)) return 'businessinfo';
  if (GOAL_RE.test(text)) return 'goal';
  return null;
}

// ---------------------------------------------------------------------------
// 'offer' — délègue entièrement à offerClarifier (Phases 1/2/3 du module de
// clarification d'offre).
// ---------------------------------------------------------------------------
async function handleOffer(text, history, tenantId) {
  const { domain } = await buildPersonaFacts(tenantId);
  const { raw, parsed } = await offerClarifier.planOffer(text, history, domain);
  if (parsed && parsed.ready && parsed.offer) {
    const entry = await offerClarifier.saveOffer(tenantId, parsed.offer, parsed.category);
    const name = entry.name || parsed.offer.name || 'votre offre';
    return {
      text: `${parsed.summary || ''}\n\n✅ C'est noté ! J'ai configuré l'offre "${name}". Je suis prêt à gérer les ventes et les questions des prospects.`.trim(),
      actionLog: [{ icon: '🗂️', label: `Offre "${name}" enregistrée`, status: 'done' }],
    };
  }
  return { text: raw, isPlanningQuestion: true, intent: 'offer' };
}

// ---------------------------------------------------------------------------
// 'goal' — délègue à goal-chat (multi-tour tant qu'il manque une info REQUISE
// — cible, canaux). Une fois le plan prêt, DEMANDE confirmation (reformulée
// chaleureusement par personaManager) au lieu d'exécuter — l'exécution ne
// démarre qu'au tour SUIVANT si le vendeur confirme, et tourne alors en
// arrière-plan (voir runGoalPlanInBackground) pendant qu'une réponse
// immédiate est déjà renvoyée (Fluid Streaming, §2 du cahier des charges).
// ---------------------------------------------------------------------------
const goalSessions = new Map();

// Faits réels à injecter dans la reformulation (JAMAIS inventés par le LLM,
// voir personaManager.js) : offres déjà clarifiées (offerClarifier.js) +
// statut du moyen de paiement configuré — permet une reformulation du style
// "la formation est prête, le lien de paiement est actif" QUAND c'est
// factuellement vrai, sans jamais l'affirmer par défaut.
async function buildPersonaFacts(tenantId) {
  const profile = await offerClarifier.getBusinessProfile(tenantId);
  const domain = personaManager.inferDomain(profile);
  const recentOffers = (profile.offers || []).slice(-3)
    .map((o) => `${o.name || o.category}${o.price ? ` (${o.price})` : ''}`);
  const paymentConfigured = ['MOBILE_MONEY_ORANGE', 'MOBILE_MONEY_MTN', 'MOBILE_MONEY_MOOV', 'MOBILE_MONEY_WAVE']
    .some((k) => !!process.env[k]);
  const parts = [];
  if (recentOffers.length) parts.push(`Offres déjà configurées : ${recentOffers.join(', ')}.`);
  parts.push(paymentConfigured
    ? 'Le lien/l\'instruction de paiement Mobile Money est configuré et actif.'
    : 'Aucun moyen de paiement Mobile Money n\'est configuré pour le moment.');
  return { domain, facts: parts.join(' ') };
}

async function handleGoal(text, sessionKey, tenantId, deps) {
  const state = goalSessions.get(sessionKey);
  const awaitingConfirmation = !!(state && state.phase === 'ready');
  const { domain, facts } = await buildPersonaFacts(tenantId);

  if (awaitingConfirmation) {
    if (personaManager.detectDecline(text)) {
      goalSessions.delete(sessionKey);
      const warm = await personaManager.rephrase({
        kind: 'declined', rawText: 'La mission est annulée pour l\'instant.', facts, domain,
      });
      return { text: warm };
    }

    if (!personaManager.detectAffirmative(text)) {
      // Ni "oui" net ni refus net : traité comme une PRÉCISION business
      // (ex: "avec 10% de remise pour les 3 premiers") — reconnue et
      // reportée dans la reformulation, mais NON encodée dans le plan de
      // tâches lui-même (task-parser/goal-chat n'ont pas de notion de
      // remise) : limitation assumée, la nuance reste conversationnelle
      // tant qu'un vrai champ dédié n'existe pas dans le plan de tâches.
      const warm = await personaManager.rephrase({
        kind: 'confirm_plan',
        rawText: (state.doc && state.doc.summary) || 'Le plan est prêt.',
        facts: `${facts} Précision du vendeur à prendre en compte : "${text}".`,
        domain,
      });
      return { text: warm, isPlanningQuestion: true, intent: 'goal' };
    }

    // Confirmé : réponse IMMÉDIATE, exécution réelle lancée EN ARRIÈRE-PLAN.
    const ackText = await personaManager.rephrase({
      kind: 'executing', rawText: 'La campagne est lancée maintenant.', facts, domain,
    });
    const eng = deps.engineFor ? deps.engineFor(tenantId) : null;
    goalSessions.delete(sessionKey);

    if (!eng) {
      return { text: ackText, actionLog: [{ icon: '⚠️', label: 'Exécution indisponible (moteur non injecté)', status: 'error' }] };
    }

    runGoalPlanInBackground(state, eng, tenantId); // fire-and-forget, voir plus bas
    return { text: ackText, actionLog: [{ icon: '🚀', label: 'Exécution démarrée en arrière-plan', status: 'pending' }] };
  }

  const freshState = state || goalChat.createSession({});
  goalSessions.set(sessionKey, freshState);
  const out = goalChat.step(freshState, { message: text, parser: taskParser, humanContext: deps.humanContext || null });

  if (out.kind !== 'plan') {
    const rawQuestion = (out.reply && out.reply.text) || 'Précisez votre objectif.';
    const warm = await personaManager.rephrase({ kind: 'question', rawText: rawQuestion, facts, domain });
    return { text: warm, isPlanningQuestion: true, intent: 'goal' };
  }

  // Ordre compris : exécution DIRECTE (aucune validation imposée). Ancien comportement (plan puis « oui ») :
  // CHAT_CONFIRM_PLANS=true.
  if (process.env.CHAT_CONFIRM_PLANS !== 'true') {
    const eng = deps.engineFor ? deps.engineFor(tenantId) : null;
    const planLine = out.reply.text.replace(/\n\nPrêt à exécuter \? Choisis une action ci-dessous\.$/, '');
    const ack = await personaManager.rephrase({ kind: 'executing', rawText: `Je m'en occupe : ${planLine}`, facts, domain });
    goalSessions.delete(sessionKey);
    if (!eng) return { text: ack, actionLog: [{ icon: '⚠️', label: 'Exécution indisponible (moteur non injecté)', status: 'error' }] };
    runGoalPlanInBackground(freshState, eng, tenantId);
    return { text: ack, actionLog: [{ icon: '🚀', label: 'Exécution démarrée en arrière-plan', status: 'pending' }] };
  }

  // Prêt : reformulation + demande de confirmation — freshState.phase est
  // déjà passé à 'ready' par goalChat.step() ci-dessus (persiste dans
  // goalSessions), aucune exécution ici.
  const planText = out.reply.text.replace(/\n\nPrêt à exécuter \? Choisis une action ci-dessous\.$/, '');
  const warm = await personaManager.rephrase({ kind: 'confirm_plan', rawText: planText, facts, domain });
  return { text: warm, isPlanningQuestion: true, intent: 'goal' };
}

// Exécution réelle du plan, hors du cycle requête/réponse HTTP courant
// (voir handleGoal ci-dessus) — pousse le résultat final dans le tchat via
// platformOrchestrator.notifyTenantChat une fois terminé, exactement comme
// les notifications anti-spam déjà en place pour les campagnes.
async function runGoalPlanInBackground(state, eng, tenantId) {
  try {
    const runResult = await goalChat.runPlan(state, {
      execute: async (tasks) => {
        await eng.createTasks(tasks);
        const runOut = await eng.runDue({ tenantId });
        return {
          runId: (tasks[0] && tasks[0].runId) || null,
          executed: runOut.executed,
          results: runOut.results,
          error: runOut.failed > 0 ? `${runOut.failed} tâche(s) en échec` : null,
        };
      },
    });

    const results = (runResult.execution && runResult.execution.results) || [];
    const actionLog = results.map((r) => ({
      icon: r.ok ? '✅' : '⚠️',
      label: `${r.type || r.action || 'Action'} — ${r.ok ? 'terminé' : (r.error || 'échec')}`,
      status: r.ok ? 'done' : 'error',
    }));
    const summaryText = runResult.ok
      ? '✅ C\'est fait, la campagne tourne — je vous tiens au courant des résultats au fil de l\'eau.'
      : `⚠️ Petit souci pendant l'exécution (${(runResult.execution && runResult.execution.error) || 'erreur inconnue'}) — j'y jette un œil.`;
    await platformOrchestrator.notifyTenantChat(tenantId, summaryText, actionLog);
  } catch (err) {
    console.error(`chatOrchestrator — échec de l'exécution en arrière-plan (tenant "${tenantId}") :`, err.message);
    await platformOrchestrator.notifyTenantChat(
      tenantId,
      `⚠️ L'exécution de la campagne a échoué (${err.message}).`,
      [{ icon: '⚠️', label: 'Échec de la campagne', status: 'error' }],
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 'report' — lecture seule, exécution directe via action-executor
// (GENERATE_REPORT), aucun appel LLM nécessaire pour la détection.
// ---------------------------------------------------------------------------
async function handleReport(text, tenantId, deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Rapport indisponible pour le moment (moteur non injecté).' };
  }
  const out = await deps.runtime.actionExecutor.execute('GENERATE_REPORT', { scope: 'day', tenantId }, { tenantId });
  if (!out.ok) return { text: `Impossible de générer le rapport (${out.error}).` };
  const r = out.result;
  const text2 = [
    'Voici où on en est aujourd\'hui :',
    `📊 ${r.totalMessages} message(s) analysé(s), ${r.conversions} conversion(s) détectée(s), chaleur ${r.heat}.`,
    r.recommendations && r.recommendations.length ? `Recommandations : ${r.recommendations.join(' ')}` : null,
  ].filter(Boolean).join('\n');
  return { text: text2, actionLog: [{ icon: '📊', label: 'Rapport généré', status: 'done' }] };
}

// ---------------------------------------------------------------------------
// 'inbox' — lecture réelle des derniers messages reçus (READ_RECENT_MESSAGES).
// Répond à "quel est le dernier message reçu / qui m'a écrit / es-tu connecté à
// mon WhatsApp ?" avec des DONNÉES RÉELLES (expéditeur + contenu + numéro
// connecté), plutôt qu'une réponse vide du chat générique. Distingue les 3 cas
// honnêtement : non connecté / connecté mais tampon vide (après redémarrage) /
// messages disponibles.
// ---------------------------------------------------------------------------
async function handleMemory(text, tenantId, deps) {
  const llm = deps.llm || ((prompt) => llmFallbackEngine.generateAIResponse(prompt, [], null, undefined, null, { purpose: 'memory_summary', tenant: tenantId }).then((r) => r.text));
  try {
    const out = await memoryQuery.answer(tenantId, text, { llm });
    return { text: out.text, actionLog: out.actionLog };
  } catch (err) {
    return { text: `Je n'ai pas pu interroger la mémoire (${err.message}).`, actionLog: [{ icon: '⚠️', label: 'Mémoire indisponible', status: 'error' }] };
  }
}

async function handleInbox(text, tenantId, deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Je ne peux pas lire les messages pour le moment (moteur non disponible).' };
  }
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const out = await deps.runtime.actionExecutor.execute('READ_RECENT_MESSAGES', { channel, limit: 10, tenantId }, { tenantId });
  if (!out.ok) {
    return { text: `Je n'ai pas pu lire ${label} (${out.error}).` };
  }
  const r = out.result || {};
  const numLine = r.connectedNumber ? ` (numéro : ${r.connectedNumber})` : '';
  // Trois états distincts, honnêtes (voir la distinction connecté/appairé
  // ajoutée dans les adaptateurs) : appairé mais reconnexion en cours (coupures
  // 428 fréquentes sur IP cloud) ≠ jamais appairé. On ne dit "pas connecté" à
  // sec que si le compte n'est PAS appairé du tout.
  if (r.connected === false) {
    if (r.paired) {
      return {
        text: `Ton compte ${label}${numLine} est bien appairé, mais la connexion est momentanément coupée (WhatsApp ferme parfois la session sur les serveurs cloud) et se rétablit automatiquement. Réessaie dans quelques instants — dès que c'est reconnecté je pourrai lire tes messages.`,
        actionLog: [{ icon: '🔄', label: `${label} appairé — reconnexion en cours`, status: 'warning' }],
      };
    }
    return {
      text: `⚠️ Je ne suis pas connecté à ${label} pour l'instant, et aucun compte n'y est appairé — il faut d'abord scanner le QR / saisir le code dans l'onglet ${label} du tableau de bord.`,
      actionLog: [{ icon: '🔌', label: `${label} non appairé`, status: 'warning' }],
    };
  }
  const messages = Array.isArray(r.messages) ? r.messages : [];
  if (!messages.length) {
    return {
      text: `Je suis bien connecté à ${label}${numLine}, mais je n'ai encore aucun message en mémoire depuis mon dernier redémarrage. Demande à un contact de t'écrire (ou envoie-toi un message depuis un autre numéro), puis redemande-moi : je te donnerai l'expéditeur et le contenu exact.`,
      actionLog: [{ icon: '🔌', label: `${label} connecté${r.connectedNumber ? ' — ' + r.connectedNumber : ''}`, status: 'done' }],
    };
  }
  const fmtWho = (m) => (m.name ? `${m.name} (${m.number || m.username || m.from})` : (m.number || m.username || m.from));
  const fmtWhen = (m) => (m.ts ? new Date(m.ts * 1000).toLocaleString('fr-FR') : '');
  const fmtBody = (m) => (m.text ? `"${m.text}"` : (m.hasMedia ? '[média]' : '[message vide]'));
  const lines = messages.slice(0, 5).map((m, i) => {
    const when = fmtWhen(m);
    return `${i === 0 ? '➡️ ' : '• '}${fmtWho(m)}${m.isGroup ? ' [groupe]' : ''} — ${fmtBody(m)}${when ? ` · ${when}` : ''}`;
  });
  const last = messages[0];
  return {
    text: [`Voici tes derniers messages ${label}${numLine} :`, ...lines].join('\n'),
    actionLog: [{ icon: '📥', label: `Dernier message : ${fmtWho(last)}`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'reply' — répond RÉELLEMENT au dernier message reçu (ou à un contact nommé)
// et VÉRIFIE l'envoi. Chaîne complète : identifie l'expéditeur/canal réels
// (historique persistant) -> rédige la réponse (style du vendeur) -> envoi
// vérifié (runtime.sendMessageVerified, registre d'actions) -> rapport de
// VÉRITÉ (SUCCESS confirmé / FAILED / PENDING, jamais un faux positif).
// ---------------------------------------------------------------------------
// Compte rendu d'envoi rédigé de façon HUMAINE (pas de bloc « Canal:/Action:/
// Statut: » robotique) tout en restant strictement VRAI : on ne dit « envoyé »
// que si l'envoi est confirmé, et on cite la référence réelle comme preuve.
function sendReport({ status, label, who, replyText, confirmationId, error }) {
  if (status === 'SUCCESS') {
    return { text: `C'est parti, j'ai écrit à ${who} sur ${label} : « ${replyText} ». Message bien remis ✅ (réf. ${confirmationId}).`, actionLog: [{ icon: '✅', label: `Envoyé à ${who}`, status: 'done' }] };
  }
  if (status === 'PENDING') {
    return { text: `J'ai lancé le message pour ${who} sur ${label}, mais je n'ai pas encore la confirmation de remise — je garde un œil dessus et je te dis dès que c'est bon.`, actionLog: [{ icon: '⏳', label: `En attente — ${who}`, status: 'warning' }] };
  }
  return { text: `Aïe, je n'ai pas réussi à joindre ${who} sur ${label} (${error || 'envoi non confirmé'}). Le message n'est PAS parti — on peut réessayer dès que le canal est reconnecté.`, actionLog: [{ icon: '❌', label: `Échec — ${who}`, status: 'error' }] };
}

async function composeReplyText(instruction, last, tenantId, domain) {
  let context = '';
  try {
    const conv = await messageHistory.getConversation(tenantId, last.channel, last.number, 12);
    if (conv && conv.length) context = conv.map((m) => `${m.direction === 'in' ? 'Client' : 'Moi'}: ${m.text}`).join('\n');
  } catch (e) { context = ''; }
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Dernier message reçu de ${last.name || last.number} : "${last.text}"`,
    context ? `Contexte récent de la conversation :\n${context}` : '',
    `Le vendeur te demande : "${instruction}"`,
    'Rédige UNIQUEMENT le message EXACT à envoyer au client, dans le style habituel du vendeur, sans guillemets ni préambule ni explication. Si le vendeur dicte le contenu (ex : "réponds-lui que je vais bien"), reformule fidèlement (ex : "Je vais bien.").',
  ].filter(Boolean).join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, []);
  return String(raw || '').trim().replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 1500);
}

async function handleReply(text, tenantId, deps) {
  if (!deps.runtime || typeof deps.runtime.sendMessageVerified !== 'function') {
    return { text: 'Envoi indisponible pour le moment (moteur non injecté).' };
  }
  let channel = /telegram/i.test(text) ? 'TELEGRAM' : (/whatsapp/i.test(text) ? 'WHATSAPP' : null);
  const lastWA = await messageHistory.getLastIncoming(tenantId, 'WHATSAPP').catch(() => null);
  const lastTG = await messageHistory.getLastIncoming(tenantId, 'TELEGRAM').catch(() => null);
  let last;
  if (channel === 'TELEGRAM') last = lastTG;
  else if (channel === 'WHATSAPP') last = lastWA;
  else {
    if (lastWA && lastTG) last = (lastWA.ts >= lastTG.ts) ? lastWA : lastTG;
    else last = lastWA || lastTG;
    channel = last ? last.channel : 'WHATSAPP';
  }
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  if (!last) {
    return { text: `Je n'ai aucun message reçu récemment sur ${label} auquel répondre. Demande-moi d'abord « quel est le dernier message reçu ? ».` };
  }
  const who = last.name ? `${last.name} (${last.number})` : last.number;
  const { domain } = await buildPersonaFacts(tenantId);
  const replyText = await composeReplyText(text, last, tenantId, domain);
  if (!replyText) return { text: 'Je n\'ai pas compris quel message envoyer — dicte-moi la réponse exacte.', isPlanningQuestion: true, intent: 'reply' };
  const to = last.chatId || last.party;
  const out = await deps.runtime.sendMessageVerified({ channel, to, text: replyText, tenantId });
  return sendReport({ status: out.status, label, who, replyText, confirmationId: out.confirmationId, error: out.error });
}

// ---------------------------------------------------------------------------
// 'actionsreport' — supervision : ce que l'agent a RÉELLEMENT fait (registre
// d'actions), avec le statut réel de chacune. Empêche le "c'est fait" abstrait.
// ---------------------------------------------------------------------------
async function handleActionsReport(tenantId) {
  const actions = await actionLedger.listRecent(tenantId, 10).catch(() => []);
  if (!actions.length) return { text: 'Je n\'ai encore exécuté aucune action traçable.' };
  const icon = (s) => (s === 'SUCCESS' ? '✅' : s === 'FAILED' ? '❌' : s === 'PENDING' ? '⏳' : '•');
  const lines = actions.map((a) => {
    const when = a.finishedAt || a.startedAt || a.requestedAt;
    const target = a.target || '';
    const ref = a.confirmation && a.confirmation.confirmationId ? ` (réf. ${a.confirmation.confirmationId})` : (a.error ? ` (${a.error})` : '');
    return `${icon(a.status)} ${a.type} ${a.channel || ''} → ${target} : ${a.status}${ref} · ${new Date(when).toLocaleString('fr-FR')}`;
  });
  return { text: ['📊 Mes dernières actions (statut réel) :', ...lines].join('\n'), actionLog: [{ icon: '📊', label: `${actions.length} action(s)`, status: 'done' }] };
}

// ---------------------------------------------------------------------------
// 'groups' — liste réelle des groupes du compte (LIST_GROUPS), avec le rôle
// (admin) et la taille. Sait filtrer "où je suis admin" et par sujet (mot-clé).
// Base concrète pour cibler ensuite une campagne (extraction + envoi), qui
// passe par le moteur de campagne existant sur confirmation.
// ---------------------------------------------------------------------------
async function handleGroups(text, tenantId, deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Je ne peux pas lister les groupes pour le moment (moteur non disponible).' };
  }
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const out = await deps.runtime.actionExecutor.execute('LIST_GROUPS', { channel, tenantId }, { tenantId });
  if (!out.ok) return { text: `Je n'ai pas pu récupérer tes groupes ${label} (${out.error}).` };
  const r = out.result || {};
  if (r.connected === false) {
    return {
      text: r.paired
        ? `Ton compte ${label} est appairé mais la connexion se rétablit — réessaie dans un instant pour que je liste tes groupes.`
        : `Je ne suis pas connecté à ${label} — appaire d'abord le compte dans l'onglet ${label}.`,
      actionLog: [{ icon: '🔄', label: `${label} ${r.paired ? 'reconnexion' : 'non appairé'}`, status: 'warning' }],
    };
  }
  let groups = Array.isArray(r.groups) ? r.groups : [];
  const total = groups.length;
  const adminOnly = /(admin|administre|dont\s+je\s+suis|o[ùu]\s+je\s+suis)/i.test(text);
  if (adminOnly) groups = groups.filter((g) => g.isAdmin);
  const subj = text.match(/(?:sur|contenant|th[èe]me|[àa]\s+propos\s+de|parlant\s+de)\s+["']?([\p{L}\d][\p{L}\d \-]{1,40})/iu);
  if (subj) {
    const kw = subj[1].trim().toLowerCase();
    groups = groups.filter((g) => (g.name || '').toLowerCase().includes(kw));
  }
  if (!groups.length) {
    return {
      text: adminOnly
        ? `Je ne trouve aucun groupe ${label} dont tu es admin (sur ${total} groupe(s) au total).`
        : `Aucun groupe ${label} trouvé${subj ? ' pour ce sujet' : ''} (${total} au total).`,
      actionLog: [{ icon: '👥', label: `0 groupe ${label}`, status: 'done' }],
    };
  }
  const sorted = groups.slice().sort((a, b) => (b.size || 0) - (a.size || 0));
  const top = sorted.slice(0, 20);
  const lines = top.map((g) => `• ${g.name}${g.isAdmin ? ' 👑 (admin)' : ''} — ${g.size || 0} membre(s)`);
  const header = adminOnly
    ? `Tes groupes ${label} où tu es admin (${groups.length}) :`
    : `Tes groupes ${label} (${groups.length}${subj ? ' correspondant au sujet' : ''}) :`;
  const more = groups.length > top.length ? `\n… et ${groups.length - top.length} autre(s).` : '';
  return {
    text: [header, ...lines].join('\n') + more,
    actionLog: [{ icon: '👥', label: `${groups.length} groupe(s) ${label}`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'grouppost' — publie (partage) un message + éventuel visuel généré DANS les
// groupes ciblés (par nom, sujet, "admin", ou tous). Confirmation OBLIGATOIRE
// avant tout envoi de masse (même prudence que 'goal'). Exécute via
// deps.runtime.sendToGroups (appel direct, média en mémoire) — jamais un envoi
// sans le "oui" du vendeur.
// ---------------------------------------------------------------------------
function targetLabel(t) {
  const k = (t && t.kind) || 'all';
  if (k === 'admin') return 'tous tes groupes où tu es admin';
  if ((k === 'named' || k === 'subject') && t.value) return `les groupes « ${t.value} »`;
  return 'tous tes groupes';
}

const groupPostSessions = new Map();

async function planGroupPost(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Message de l'administrateur : "${text}"`,
    'Il veut publier un message (et éventuellement un visuel/affiche généré) DANS un ou plusieurs de ses groupes WhatsApp/Telegram.',
    "Cible : {kind:'named'|'subject'|'admin'|'all', value:'nom exact du groupe OU mot-clé de sujet, sinon chaîne vide'}.",
    'wantsVisual : true seulement s\'il demande de GÉNÉRER une affiche/image à joindre, sinon false. visualPrompt : courte description du visuel si wantsVisual.',
    "message : le texte à publier (rédige-le proprement si l'ordre est vague mais l'intention claire).",
    'Réponds UNIQUEMENT avec cet objet JSON (aucun texte autour) : {"target":{"kind":"...","value":"..."},"message":"...","wantsVisual":false,"visualPrompt":""}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const parsed = extractJsonBlock(String(raw || '').trim());
  return parsed || { raw: String(raw || '').trim() };
}

async function handleGroupPost(text, history, sessionKey, tenantId, deps) {
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const { domain } = await buildPersonaFacts(tenantId);
  const state = groupPostSessions.get(sessionKey);

  if (state && state.phase === 'ready') {
    if (personaManager.detectDecline(text)) {
      groupPostSessions.delete(sessionKey);
      return { text: 'Ok, j\'annule la publication.' };
    }
    if (!personaManager.detectAffirmative(text)) {
      state.plan.message = text; // le vendeur redicte le texte
      return { text: `Compris. Je publie ceci dans ${targetLabel(state.plan.target)} (${state.groupsCount} groupe(s)) ? Réponds « oui » pour lancer.`, isPlanningQuestion: true, intent: 'grouppost' };
    }
    if (!deps.runtime || typeof deps.runtime.sendToGroups !== 'function') {
      groupPostSessions.delete(sessionKey);
      return { text: 'Publication indisponible pour le moment (moteur non injecté).' };
    }
    let media = null;
    if (state.plan.wantsVisual && typeof deps.generateImage === 'function') {
      try {
        const img = await deps.generateImage(state.plan.visualPrompt || state.plan.message);
        if (img && img.buffer) media = { buffer: img.buffer, mimetype: img.mimetype || 'image/jpeg', filename: 'affiche.jpg', caption: state.plan.message };
      } catch (err) { /* repli texte seul */ }
    }
    const out = await deps.runtime.sendToGroups({ channel: state.plan.channel || channel, target: state.plan.target, text: state.plan.message, media, tenantId });
    groupPostSessions.delete(sessionKey);
    if (!out.ok) {
      const hint = out.error === 'NO_MATCHING_GROUP'
        ? ' Aucun groupe ne correspond à la cible.'
        : (/RUNTIME_MISSING|whatsapp|telegram|getGroupsSummary/i.test(out.error || '') ? ' Vérifie que le compte est bien connecté.' : '');
      return { text: `Je n'ai pas pu publier (${out.error}).${hint}` };
    }
    return {
      text: `✅ Publié dans ${out.sent}/${out.total} groupe(s) ${label}${media ? ' (avec le visuel)' : ''}.`,
      actionLog: [{ icon: '📢', label: `Publié dans ${out.sent} groupe(s)`, status: 'done' }],
    };
  }

  const parsed = await planGroupPost(text, history, domain);
  if (!parsed || !parsed.message) {
    return { text: (parsed && parsed.raw) || 'Que veux-tu publier, et dans quel(s) groupe(s) — un nom précis, un sujet, ou « tous mes groupes admin » ?', isPlanningQuestion: true, intent: 'grouppost' };
  }
  const target = parsed.target && parsed.target.kind ? parsed.target : { kind: 'all', value: '' };
  let groupsCount = null;
  let names = [];
  if (deps.runtime && typeof deps.runtime.resolveGroups === 'function') {
    const r = await deps.runtime.resolveGroups({ channel, target, tenantId }).catch(() => null);
    if (r && r.ok) { groupsCount = r.groups.length; names = r.groups.slice(0, 5).map((g) => g.name); }
  }
  groupPostSessions.set(sessionKey, {
    phase: 'ready',
    plan: { channel, target, message: parsed.message, wantsVisual: !!parsed.wantsVisual, visualPrompt: parsed.visualPrompt || '' },
    groupsCount: groupsCount || 0,
  });
  const where = groupsCount != null
    ? `${groupsCount} groupe(s)${names.length ? ` (${names.join(', ')}${groupsCount > names.length ? '…' : ''})` : ''}`
    : targetLabel(target);
  const visualNote = parsed.wantsVisual ? ' avec un visuel généré' : '';
  return {
    text: `Je vais publier${visualNote} dans ${where} sur ${label} :\n« ${parsed.message} »\n\nJe lance ? (réponds « oui », ou redicte un autre texte)`,
    isPlanningQuestion: true,
    intent: 'grouppost',
  };
}

// ---------------------------------------------------------------------------
// 'recurring' — tâches quotidiennes récurrentes ("chaque matin envoie X au
// groupe Y") + gestion (liste, arrêt). Persisté (queues/recurringTasks.js),
// exécuté par le tick d'index.js. La création ne fait aucun envoi immédiat.
// ---------------------------------------------------------------------------
async function planRecurring(text, history, tenantId) {
  const { domain } = await buildPersonaFacts(tenantId);
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Ordre de l'administrateur : "${text}"`,
    'Il veut programmer un message QUOTIDIEN récurrent dans un ou des groupes.',
    "Extrais : channel ('WHATSAPP' ou 'TELEGRAM', défaut WHATSAPP), target {kind:'named'|'subject'|'admin'|'all', value}, message (le texte à envoyer — rédige-le si l'intention est claire, ex. message de motivation/prière), hour (0-23) et minute (0-59).",
    "Si l'heure OU le message OU la cible manque vraiment, réponds UNIQUEMENT par une question courte (texte, jamais de JSON).",
    'Sinon réponds UNIQUEMENT avec cet objet JSON : {"ready":true,"channel":"WHATSAPP","target":{"kind":"...","value":"..."},"message":"...","hour":7,"minute":0}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const parsed = extractJsonBlock(String(raw || '').trim());
  return parsed || { ready: false, raw: String(raw || '').trim() };
}

async function handleRecurring(text, history, tenantId, deps) {
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  // Liste
  if (/(liste|montre|voir|quelles?)\b/i.test(text) && /(t[âa]ches?|r[ée]curren|programm)/i.test(text)) {
    const tasks = await recurringTasks.list(tenantId);
    const active = tasks.filter((t) => t.active);
    if (!active.length) return { text: 'Aucune tâche récurrente active pour le moment.' };
    const lines = active.map((t, i) => `${i + 1}. ${String(t.hour).padStart(2, '0')}h${String(t.minute).padStart(2, '0')} → ${targetLabel(t.target)} (${t.channel}) : « ${String(t.message).slice(0, 60)} »`);
    return { text: ['⏰ Tes tâches récurrentes :', ...lines].join('\n'), actionLog: [{ icon: '⏰', label: `${active.length} tâche(s) récurrente(s)`, status: 'done' }] };
  }
  // Arrêt
  if (/(arr[êe]te|stop|supprime|annule|d[ée]sactive)/i.test(text)) {
    const n = await recurringTasks.stopAll(tenantId);
    return { text: n ? `🛑 ${n} tâche(s) récurrente(s) arrêtée(s).` : 'Aucune tâche récurrente à arrêter.', actionLog: n ? [{ icon: '🛑', label: 'Tâches récurrentes arrêtées', status: 'done' }] : null };
  }
  // Création
  const parsed = await planRecurring(text, history, tenantId);
  if (!parsed || parsed.ready === false || !parsed.message || parsed.hour == null) {
    return { text: (parsed && parsed.raw) || 'À quelle heure, dans quel groupe, et quel message veux-tu envoyer chaque jour ?', isPlanningQuestion: true, intent: 'recurring' };
  }
  const target = parsed.target && parsed.target.kind ? parsed.target : { kind: 'all', value: '' };
  const task = await recurringTasks.create(tenantId, { channel: parsed.channel || channel, target, message: parsed.message, hour: parsed.hour, minute: parsed.minute || 0 });
  const label = (parsed.channel || channel) === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  return {
    text: `✅ C'est programmé : chaque jour à ${String(task.hour).padStart(2, '0')}h${String(task.minute).padStart(2, '0')}, j'enverrai dans ${targetLabel(target)} (${label}) :\n« ${task.message} »\n\nDis « liste mes tâches récurrentes » ou « arrête mes tâches récurrentes » quand tu veux.`,
    actionLog: [{ icon: '⏰', label: 'Tâche récurrente créée', status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'crm' — consultation du CRM de contacts (ai-engine/contactCrm.js) : liste par
// étiquette (prospect/client/personnalisée) + comptages. Lecture pure
// (stockage), fonctionne même WhatsApp/Telegram déconnecté.
// ---------------------------------------------------------------------------
async function handleCrm(text, tenantId) {
  let tag = null;
  if (/\bclients?\b/i.test(text)) tag = 'client';
  else if (/\bprospects?\b/i.test(text)) tag = 'prospect';
  else if (/nouveau|nouvelle|nouveaux/i.test(text)) tag = 'nouveau_contact';
  const m = text.match(/(?:tagg?[ée]s?|[ée]tiquet[ée]s?)\s+["']?([\p{L}\d_-]{2,30})/iu);
  if (m) tag = m[1].trim().toLowerCase();
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : (/whatsapp/i.test(text) ? 'WHATSAPP' : null);

  const c = await contactCrm.counts(tenantId);
  const items = await contactCrm.list(tenantId, { tag, channel });
  const recap = Object.entries(c.byTag || {}).map(([t, n]) => `${t}: ${n}`).join(', ');

  if (!items.length) {
    return {
      text: tag
        ? `Aucun contact avec l'étiquette « ${tag} »${channel ? ' sur ' + channel : ''}.${recap ? `\n(Récap : ${recap})` : ''}`
        : `Aucun contact enregistré pour l'instant. Dès qu'une personne t'écrit, je l'ajoute et l'étiquette automatiquement.`,
    };
  }
  const top = items.slice(0, 20);
  const lines = top.map((x) => {
    const who = x.name || x.from;
    const tags = (x.tags || []).length ? ` — ${x.tags.join(', ')}` : '';
    const buys = (x.purchases || []).length ? ` · ${x.purchases.length} achat(s)` : '';
    return `• ${who}${tags}${buys}`;
  });
  const header = tag ? `Contacts « ${tag} » (${items.length}) :` : `Tes contacts (${items.length}) :`;
  const more = items.length > top.length ? `\n… et ${items.length - top.length} autre(s).` : '';
  return {
    text: [header, ...lines].join('\n') + more,
    actionLog: [{ icon: '🏷️', label: `${items.length} contact(s)${tag ? ' « ' + tag + ' »' : ''}`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'payment' — extraction LLM ciblée (montant, destinataire, produit, remise
// demandée) puis exécution directe GENERATE_PAYMENT_LINK / NEGOTIATE_DISCOUNT.
// Même patron qu'index.js#planOrAsk (planImage/planVideo/planBook) : un seul
// appel LLM par tour, JSON "ready" ou question courte.
// ---------------------------------------------------------------------------
async function planPayment(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur : "${text}"`,
    'Le vendeur veut soit générer une instruction de paiement pour un client, soit négocier/accorder une remise. Détermine lequel.',
    'Informations nécessaires si paiement : le montant exact et la devise, le produit/offre concerné (facultatif, texte libre).',
    'Informations nécessaires si remise : le prix de départ et le pourcentage de remise demandé (si le client n\'a pas précisé de pourcentage, mets requestedPercent à null — le système appliquera le plafond autorisé).',
    'Base-toi sur l\'historique de la discussion pour ne jamais reposer une question déjà répondue.',
    'Si des informations manquent, réponds UNIQUEMENT par 1 à 2 questions courtes (texte simple, jamais de JSON).',
    'Si tu as assez d\'informations, réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après) : {"ready":true,"kind":"payment"|"discount","amount":15000,"currency":"FCFA","product":"nom du produit ou chaîne vide","price":15000,"requestedPercent":10}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const trimmed = raw.trim();
  return { raw: trimmed, parsed: extractJsonBlock(trimmed) };
}

async function handlePayment(text, history, tenantId, deps) {
  const { domain } = await buildPersonaFacts(tenantId);
  const { raw, parsed } = await planPayment(text, history, domain);
  if (!parsed || !parsed.ready) {
    return { text: raw, isPlanningQuestion: true, intent: 'payment' };
  }
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Impossible de traiter cette demande de paiement pour le moment (moteur non injecté).' };
  }

  if (parsed.kind === 'discount') {
    const out = await deps.runtime.actionExecutor.execute('NEGOTIATE_DISCOUNT', {
      price: parsed.price, requestedPercent: parsed.requestedPercent, tenantId,
    }, { tenantId });
    if (!out.ok) return { text: `Impossible de calculer la remise (${out.error}).` };
    const r = out.result;
    const cappedNote = r.capped ? ` (plafonnée à ${r.appliedPercent}% — remise maximale autorisée)` : '';
    return {
      text: `🤝 Remise accordée : ${r.appliedPercent}%${cappedNote}. Prix final : ${r.finalPrice} ${r.currency} (au lieu de ${r.originalPrice} ${r.currency}).`,
      actionLog: [{ icon: '🤝', label: `Remise ${r.appliedPercent}% accordée`, status: 'done' }],
    };
  }

  const out = await deps.runtime.actionExecutor.execute('GENERATE_PAYMENT_LINK', {
    amount: parsed.amount, currency: parsed.currency, product: parsed.product, tenantId,
  }, { tenantId });
  if (!out.ok) {
    const hint = out.error === 'NO_MOBILE_MONEY_NUMBER_CONFIGURED'
      ? ' Configurez au moins un numéro Mobile Money (MOBILE_MONEY_ORANGE/MTN/MOOV/WAVE dans .env) pour activer cet outil.'
      : '';
    return { text: `Impossible de générer l'instruction de paiement (${out.error}).${hint}` };
  }
  return { text: out.result.message, actionLog: [{ icon: '💳', label: `Instruction de paiement générée (réf. ${out.result.reference})`, status: 'done' }] };
}

// ---------------------------------------------------------------------------
// 'account' — extraction LLM ciblée (contact, produit/formation, type d'accès)
// puis CREATE_USER_ACCOUNT / GENERATE_ACCESS_KEY / GRANT_MODULE_ACCESS.
// ---------------------------------------------------------------------------
async function planAccount(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur : "${text}"`,
    'Le vendeur veut créer/débloquer l\'accès d\'un client à une formation déjà vendue.',
    'Informations nécessaires : le contact du client (téléphone ou email), et soit "action":"create_account" (nouveau client, génère aussi une clé d\'accès), soit "action":"grant_module" (client déjà créé, ajoute juste un module précis — nécessite moduleKey).',
    'Base-toi sur l\'historique de la discussion pour ne jamais reposer une question déjà répondue.',
    'Si des informations manquent, réponds UNIQUEMENT par 1 à 2 questions courtes (texte simple, jamais de JSON).',
    'Si tu as assez d\'informations, réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après) : {"ready":true,"action":"create_account"|"grant_module","phone":"+225...","email":"","studentName":"","sku":"nom de la formation ou chaîne vide","moduleKey":"identifiant du module ou chaîne vide (grant_module uniquement)"}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const trimmed = raw.trim();
  return { raw: trimmed, parsed: extractJsonBlock(trimmed) };
}

async function handleAccount(text, history, tenantId, deps) {
  const { domain } = await buildPersonaFacts(tenantId);
  const { raw, parsed } = await planAccount(text, history, domain);
  if (!parsed || !parsed.ready) {
    return { text: raw, isPlanningQuestion: true, intent: 'account' };
  }
  if (!deps.runtime || !deps.runtime.actionExecutor) {
    return { text: 'Impossible de traiter cette demande pour le moment (moteur non injecté).' };
  }

  if (parsed.action === 'grant_module') {
    const out = await deps.runtime.actionExecutor.execute('GRANT_MODULE_ACCESS', {
      phone: parsed.phone, email: parsed.email, moduleKey: parsed.moduleKey, tenantId,
    }, { tenantId });
    if (!out.ok) return { text: `Impossible d'accorder l'accès (${out.error}).` };
    return {
      text: `🔓 Accès au module "${parsed.moduleKey}" accordé à ${parsed.phone || parsed.email}.`,
      actionLog: [{ icon: '🔓', label: `Module "${parsed.moduleKey}" débloqué pour ${parsed.phone || parsed.email}`, status: 'done' }],
    };
  }

  const out = await deps.runtime.actionExecutor.execute('CREATE_USER_ACCOUNT', {
    phone: parsed.phone, email: parsed.email, studentName: parsed.studentName, sku: parsed.sku, tenantId,
  }, { tenantId });
  if (!out.ok) return { text: `Impossible de créer le compte (${out.error}).` };
  const r = out.result;
  return {
    text: `🎓 Compte élève créé pour ${parsed.phone || parsed.email}.\n🔑 Clé d'accès : ${r.accessKey}`,
    actionLog: [{ icon: '🎓', label: `Compte élève créé — clé ${r.accessKey}`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'connector' — action d'administration sur une plateforme. CYRUS n'est PAS
// limité à une plateforme : `connectorManager.getToolsForTenant` ne renvoie
// que les outils des connecteurs ACTIVÉS par CE vendeur et dont la PERMISSION
// est accordée (voir ai-engine/connectors/). Le LLM choisit l'outil pertinent
// et extrait ses arguments parmi CETTE liste seulement ; s'il n'y a aucun
// connecteur externe (ou aucun outil applicable), on retombe sur le flux de
// compte interne classique (handleAccount, Cloud Function cyrus_students).
// ---------------------------------------------------------------------------
function describeToolsForPrompt(tools) {
  return tools.map((t) => {
    const params = Object.keys(t.parameters || {}).map((k) => {
      const p = t.parameters[k];
      return `${k}${p && p.required ? ' (requis)' : ''}: ${(p && p.description) || ''}`;
    }).join(' ; ');
    return `- ${t.name} [${t.connectorLabel}] : ${t.description}\n  Paramètres : ${params || '(aucun)'}`;
  }).join('\n');
}

function formatConnectorResult(toolName, result) {
  const r = result || {};
  if (toolName === 'creer_compte_eleve') {
    const link = r.passwordResetLink ? `\n🔗 Lien de définition du mot de passe : ${r.passwordResetLink}` : '';
    return {
      text: `🎓 Accès créé sur la plateforme pour ${r.email} (formation « ${r.courseId} »).${link}`,
      actionLog: [{ icon: '🎓', label: `Compte plateforme — ${r.email}`, status: 'done' }],
    };
  }
  if (toolName === 'suspendre_compte_eleve') {
    return { text: `⛔ Accès suspendu pour ${r.email} (réversible).`, actionLog: [{ icon: '⛔', label: `Accès suspendu — ${r.email}`, status: 'done' }] };
  }
  if (toolName === 'ajouter_contact') {
    return { text: `📇 Contact ${r.created ? 'créé' : 'retrouvé'} sur ${r.provider || 'la plateforme'} : ${r.email}.`, actionLog: [{ icon: '📇', label: `Contact — ${r.email}`, status: 'done' }] };
  }
  if (toolName === 'attribuer_tag') {
    return { text: `🏷️ Tag « ${r.tag} » attribué au contact.`, actionLog: [{ icon: '🏷️', label: `Tag « ${r.tag} » attribué`, status: 'done' }] };
  }
  if (toolName === 'enregistrer_vente') {
    const e = r.entry || {};
    return { text: `📒 Vente enregistrée : ${e.amount} ${e.currency}${e.product ? ` — ${e.product}` : ''}.`, actionLog: [{ icon: '📒', label: 'Vente enregistrée', status: 'done' }] };
  }
  if (toolName === 'generer_facture') {
    const inv = r.invoice || {};
    return { text: `🧾 Facture ${inv.number} générée : ${inv.amount} ${inv.currency}${inv.customer ? ` — ${inv.customer}` : ''}.`, actionLog: [{ icon: '🧾', label: `Facture ${inv.number}`, status: 'done' }] };
  }
  return { text: '✅ Action effectuée sur la plateforme.', actionLog: [{ icon: '✅', label: `Action « ${toolName} » effectuée`, status: 'done' }] };
}

async function handleConnector(text, history, tenantId, deps) {
  const tools = await connectorManager.getToolsForTenant(tenantId).catch(() => []);
  // Aucun connecteur externe autorisé -> flux compte interne classique.
  if (!tools.length) return handleAccount(text, history, tenantId, deps);

  const { domain } = await buildPersonaFacts(tenantId);
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    'Tu disposes des OUTILS d\'administration suivants (et AUCUN autre — n\'invente jamais un outil ni un accès) :',
    describeToolsForPrompt(tools),
    `Message de l'administrateur : "${text}"`,
    'Choisis AU PLUS un outil réellement pertinent et extrais ses arguments depuis le message et l\'historique. N\'exécute jamais d\'action de suppression.',
    'Si un argument requis manque, réponds UNIQUEMENT par 1 à 2 questions courtes (texte simple, jamais de JSON).',
    'Si aucun outil ne correspond, réponds UNIQUEMENT {"tool":null}.',
    'Sinon réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après) : {"tool":"nom_exact_de_l_outil","args":{ ... }}',
  ].join('\n');

  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const trimmed = String(raw || '').trim();
  const parsed = extractJsonBlock(trimmed);

  // Pas de JSON exploitable : le LLM a (probablement) posé une question de
  // clarification — on la renvoie telle quelle en gardant l'intention active.
  if (!parsed || !('tool' in parsed)) {
    return { text: trimmed, isPlanningQuestion: true, intent: 'connector' };
  }
  // Aucun outil applicable -> repli sur le flux compte interne classique.
  if (!parsed.tool) return handleAccount(text, history, tenantId, deps);

  const available = tools.some((t) => t.name === parsed.tool);
  if (!available) return handleAccount(text, history, tenantId, deps);

  const out = await connectorManager.executeTool(tenantId, parsed.tool, parsed.args || {}, deps.executeOptions || {});
  if (!out.ok) {
    return { text: `Impossible d'exécuter « ${parsed.tool} » (${out.error}).${out.detail ? ' ' + out.detail : ''}` };
  }
  return formatConnectorResult(parsed.tool, out.result);
}

// ---------------------------------------------------------------------------
// 'businessinfo' — répond à une question FACTUELLE du vendeur sur son activité
// (prix, produits, formations, règles, objectifs, capacités) en s'appuyant
// EXCLUSIVEMENT sur ce qu'il a réellement configuré dans l'onglet Services
// Métiers (businessServices.getEngineContextText). C'est le maillon
// "DONNÉES → INTELLIGENCE" : le chat lit la vraie donnée au lieu de l'inventer.
// Si rien n'est configuré, il le dit franchement (jamais un prix fictif).
// ---------------------------------------------------------------------------
async function handleBusinessInfo(text, history, tenantId) {
  const ctxText = await businessServices.getEngineContextText(tenantId).catch(() => '');
  if (!ctxText) {
    return {
      text: "Je n'ai encore aucune information sur tes produits ou services. Ajoute-les dans l'onglet « Services Métiers » (activité, produits, prix, règles, objectifs) et je pourrai répondre précisément à ce genre de question.",
      actionLog: [{ icon: '📋', label: 'Aucun Service Métier configuré', status: 'warning' }],
    };
  }
  const { domain } = await buildPersonaFacts(tenantId);
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    "Voici les informations RÉELLES et à jour de l'activité du vendeur, telles qu'il les a configurées (source de vérité) :",
    ctxText,
    `Question du vendeur : "${text}"`,
    "Réponds à sa question en t'appuyant UNIQUEMENT sur ces données. Cite le chiffre / le fait EXACT (ex. le prix précis). N'invente JAMAIS un prix, un produit, une règle ou un objectif absent de ces données — si l'information demandée n'y figure pas, dis-le franchement et invite-le à la renseigner dans l'onglet Services Métiers.",
  ].join('\n');
  try {
    const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history || []);
    const answer = String(raw || '').trim();
    return {
      text: answer || "Je n'ai pas trouvé cette information dans ta configuration actuelle.",
      actionLog: [{ icon: '📋', label: 'Réponse basée sur tes Services Métiers', status: 'done' }],
    };
  } catch (err) {
    // Repli honnête si toute la cascade LLM est indisponible : on renvoie le
    // contexte brut plutôt que rien (jamais une valeur inventée).
    return { text: `Voici ce que j'ai sur ton activité :\n${ctxText}` };
  }
}

// ---------------------------------------------------------------------------
// 'configsvc' — configure un Service Métier depuis une instruction en langage
// naturel (extraction LLM des champs) puis exécute l'outil réel
// configureBusinessService (création + connexion API + test réel si fournis).
// ---------------------------------------------------------------------------
async function handleConfigSvc(text, history, tenantId) {
  const prompt = [
    personaManager.personaSystemPrompt('default'),
    'Le vendeur veut créer/configurer un Service Métier. Extrais ses informations.',
    `Instruction : "${text}"`,
    'Réponds UNIQUEMENT avec cet objet JSON (aucun texte autour), en ne remplissant que ce qui est fourni : {"ready":true,"name":"...","type":"formation|ecommerce|service|autre","price":8000,"currency":"FCFA","description":"","products":"Nom|Prix; Nom|Prix","rules":"regle1; regle2","objectives":"obj1; obj2","baseUrl":"","apiKey":"","authHeader":"X-API-Key","connectorType":"platform_gateway|systemio|generic","scopes":"students:create,students:suspend"}. Si le NOM du service manque vraiment, réponds plutôt {"ready":false,"ask":"question courte pour obtenir le nom"}.',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history || []);
  const parsed = extractJsonBlock(String(raw || '').trim());
  if (!parsed || parsed.ready === false || !parsed.name) {
    return { text: (parsed && parsed.ask) || 'Quel nom veux-tu donner à ce service métier, et quel type d\'activité (formation, e-commerce, service…) ?', isPlanningQuestion: true, intent: 'configsvc' };
  }
  const call = await toolRegistry.execute(tenantId, 'configureBusinessService', parsed, {});
  if (call.state !== 'SUCCESS') {
    return { text: `Je n'ai pas pu configurer le service (${(call.error && call.error.code) || call.state}).`, actionLog: [{ icon: '⚠️', label: 'Échec configuration service', status: 'error' }] };
  }
  const r = call.result;
  let msg = `✅ C'est configuré : le service « ${r.name} » est créé.`;
  if (r.test) {
    msg += r.connected
      ? ` J'ai connecté ton API et le test est bon (${r.test.detail || 'authentifié et joignable'}).`
      : ` Par contre le test de l'API n'est pas passé (${(r.test && r.test.detail) || 'non connecté'}) — vérifie l'URL et la clé.`;
  }
  return { text: msg, toolCall: { name: 'configureBusinessService', state: call.state, result: r }, actionLog: [{ icon: '🏢', label: `Service « ${r.name} » configuré`, status: r.connected || !r.test ? 'done' : 'warning' }] };
}

// ---------------------------------------------------------------------------
// 'importcontacts' — importe en masse les contacts d'un fichier JOINT (le
// fileId est présent dans le contexte des pièces jointes injecté par la route).
// ---------------------------------------------------------------------------
async function handleImportContacts(text, tenantId) {
  const m = String(text || '').match(/\[id:\s*(f_[A-Za-z0-9]+)\]/);
  if (!m) {
    return { text: 'Joins-moi le fichier de contacts (CSV ou Excel) via le trombone 📎, puis redis « importe ces contacts » — je m\'occupe du reste.', isPlanningQuestion: true, intent: 'importcontacts' };
  }
  const call = await toolRegistry.execute(tenantId, 'importContactsFromFile', { fileId: m[1] }, {});
  if (call.state !== 'SUCCESS') {
    return { text: `Je n'ai pas pu importer le fichier (${(call.error && call.error.code) || call.state}). Vérifie qu'il contient une colonne « telephone ».`, actionLog: [{ icon: '⚠️', label: 'Import échoué', status: 'error' }] };
  }
  const r = call.result;
  return {
    text: `📇 Import terminé : ${r.imported} contact(s) ajouté(s), ${r.updated} mis à jour, ${r.duplicates} doublon(s), ${r.invalid} rejeté(s). Tu peux maintenant me demander de les filtrer, les analyser ou lancer une campagne.`,
    toolCall: { name: 'importContactsFromFile', state: call.state, result: r },
    actionLog: [{ icon: '📇', label: `${r.imported} contact(s) importé(s)`, status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// 'genmedia' — génère un visuel (affiche/image) et le renvoie téléchargeable.
// ---------------------------------------------------------------------------
async function handleGenMedia(text, tenantId, deps) {
  const call = await toolRegistry.execute(tenantId, 'generateImage', { prompt: text }, { generateImage: deps.generateImage || null });
  if (call.state !== 'SUCCESS') {
    const why = (call.error && call.error.code) === 'IMAGE_ENGINE_UNAVAILABLE'
      ? 'le générateur d\'image n\'est pas disponible ici'
      : ((call.error && call.error.code) || call.state);
    return { text: `Je n'ai pas pu générer le visuel (${why}).`, actionLog: [{ icon: '⚠️', label: 'Génération échouée', status: 'error' }] };
  }
  return {
    text: 'Voilà ton visuel ! Tu peux le télécharger juste en dessous. 👇',
    toolCall: { name: 'generateImage', state: call.state, result: call.result },
    actionLog: [{ icon: '🎨', label: 'Visuel généré', status: 'done' }],
  };
}

// ---------------------------------------------------------------------------
// Point d'entrée unique — appelé par index.js AVANT le pipeline chat/média
// existant (image/vidéo/livre, réponse générique). `deps` = { runtime,
// engineFor, humanContext } injectés depuis la même instance que
// lib/intelligence/vps-bridge.js (voir index.js, zéro moteur dupliqué).
// ---------------------------------------------------------------------------
async function handle({ text, history, tenantId, sessionId, lastAssistantMessage }, deps) {
  const d = deps || {};

  // Décision de validation de paiement manuel (Human-in-the-Loop) — un
  // "VALIDER"/"REFUSER" tapé par l'admin dans SON tchat ne correspond à aucune
  // intention ci-dessous ; il est traité en priorité. resolveAdminDecision
  // renvoie null (2 tests regex) si ce n'est pas une décision, sans jamais lire
  // le disque — aucun surcoût sur un message normal.
  const decision = await manualPaymentValidator.resolveAdminDecision(tenantId, text, {
    deliverToClient: d.deliverToClient || null,
    executeOptions: d.executeOptions || {},
  }).catch((err) => {
    console.warn('chatOrchestrator — échec resolveAdminDecision, repli :', err.message);
    return null;
  });
  if (decision) return { text: decision.text, actionLog: decision.actionLog || null };

  // Confirmation d'une action sensible préparée (PREPARE -> oui -> EXECUTE -> VERIFY).
  const confirmed = await agentLoop.resolvePending({ tenantId, sessionId, text }, { ctx: { runtime: d.runtime || null } }).catch(() => null);
  if (confirmed) return confirmed;

  const intent = detectIntent(text, lastAssistantMessage);
  if (!intent) {
    // Aucune intention à motif connu : l'AGENT À OUTILS prend le relais — le LLM
    // choisit dynamiquement un outil RÉEL du registre (toolRegistry), l'exécute
    // de façon vérifiée et répond en s'appuyant sur le résultat réel. C'est la
    // boucle « Chat → sélection d'outil → tool call → vérification → réponse ».
    // S'il n'y a aucun outil pertinent, il renvoie null et le chat générique
    // (image/vidéo/livre/conversation) reprend la main.
    const agent = await agentLoop.runAgentLoop(
      { text, history, tenantId, sessionId },
      { runtime: d.runtime || null, permissions: d.toolPermissions || undefined, generateImage: d.generateImage || null, llm: d.llm || undefined },
    ).catch((err) => {
      console.warn('chatOrchestrator — toolAgent indisponible, repli :', err.message);
      return null;
    });
    if (agent) return agent;
    return null;
  }

  const sessionKey = `${tenantId || 'default'}:${sessionId || 'default'}`;
  switch (intent) {
    case 'offer': return handleOffer(text, history, tenantId);
    case 'goal': return handleGoal(text, sessionKey, tenantId, d);
    case 'report': return handleReport(text, tenantId, d);
    case 'inbox': return handleInbox(text, tenantId, d);
    case 'memory': return handleMemory(text, tenantId, d);
    case 'reply': return handleReply(text, tenantId, d);
    case 'actionsreport': return handleActionsReport(tenantId);
    case 'groups': return handleGroups(text, tenantId, d);
    case 'grouppost': return handleGroupPost(text, history, sessionKey, tenantId, d);
    case 'recurring': return handleRecurring(text, history, tenantId, d);
    case 'crm': return handleCrm(text, tenantId);
    case 'payment': return handlePayment(text, history, tenantId, d);
    case 'connector': return handleConnector(text, history, tenantId, d);
    case 'businessinfo': return handleBusinessInfo(text, history, tenantId);
    case 'configsvc': return handleConfigSvc(text, history, tenantId);
    case 'importcontacts': return handleImportContacts(text, tenantId);
    case 'genmedia': return handleGenMedia(text, tenantId, d);
    default: return null;
  }
}

module.exports = { detectIntent, handle };
