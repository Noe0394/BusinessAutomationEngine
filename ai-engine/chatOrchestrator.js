const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const taskParser = require('../lib/intelligence/task-parser');
const goalChat = require('../lib/intelligence/goal-chat');
const offerClarifier = require('./offerClarifier');
const personaManager = require('./personaManager');
const platformOrchestrator = require('./platformOrchestrator');

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
const ACCOUNT_RE = /(compte\s+(?:[ée]l[eè]ve|[ée]tudiant|client)|cl[ée]\s+d.?acc[èe]s|acc[èe]s\s+(?:[ée]l[eè]ve|module|au\s+module)|g[ée]n[èe]re?\s+un\s+acc[èe]s|d[ée]bloque)/i;
const GOAL_RE = /(\bvend|\bvente|prospect|groupes?|membres?|publier|poster|\bcontenu|relanc|follow\s?up|\bsuivi|rappel|analys|\brapport|\bbilan)/i;

// Détection d'intention (Command Parsing, §1.1 du cahier des charges) —
// zéro appel réseau, comme index.js#detectStudioIntent dont ce module étend
// le principe. `lastAssistantMessage` (voir même mécanisme de "reprise du
// fil" que index.js#POST .../messages) fait gagner la continuation d'une
// intention en cours sur toute reclassification par mots-clés du nouveau
// message, exactement comme pour image/vidéo/livre.
function detectIntent(text, lastAssistantMessage) {
  const continuation = ['offer', 'payment', 'account', 'goal'];
  if (lastAssistantMessage && lastAssistantMessage.isPlanningQuestion && continuation.includes(lastAssistantMessage.intent)) {
    return lastAssistantMessage.intent;
  }
  if (offerClarifier.detectNewOfferIntent(text)) return 'offer';
  if (REPORT_RE.test(text)) return 'report';
  if (PAYMENT_RE.test(text)) return 'payment';
  if (ACCOUNT_RE.test(text)) return 'account';
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
// Point d'entrée unique — appelé par index.js AVANT le pipeline chat/média
// existant (image/vidéo/livre, réponse générique). `deps` = { runtime,
// engineFor, humanContext } injectés depuis la même instance que
// lib/intelligence/vps-bridge.js (voir index.js, zéro moteur dupliqué).
// ---------------------------------------------------------------------------
async function handle({ text, history, tenantId, sessionId, lastAssistantMessage }, deps) {
  const intent = detectIntent(text, lastAssistantMessage);
  if (!intent) return null; // laisse l'appelant retomber sur image/vidéo/livre/chat générique.

  const sessionKey = `${tenantId || 'default'}:${sessionId || 'default'}`;
  switch (intent) {
    case 'offer': return handleOffer(text, history, tenantId);
    case 'goal': return handleGoal(text, sessionKey, tenantId, deps || {});
    case 'report': return handleReport(text, tenantId, deps || {});
    case 'payment': return handlePayment(text, history, tenantId, deps || {});
    case 'account': return handleAccount(text, history, tenantId, deps || {});
    default: return null;
  }
}

module.exports = { detectIntent, handle };
