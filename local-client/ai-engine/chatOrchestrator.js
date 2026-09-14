const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const taskParser = require('../lib/intelligence/task-parser');
const goalChat = require('../lib/intelligence/goal-chat');
const offerClarifier = require('./offerClarifier');
const personaManager = require('./personaManager');
const platformOrchestrator = require('./platformOrchestrator');

// ADAPTATEUR local-client de ai-engine/chatOrchestrator.js (VPS) — même
// détection d'intention et mêmes handlers 'offer'/'report'/'payment'/'account'
// (réutilisent action-executor.js via deps.runtime.actionExecutor, EXACTEMENT
// comme côté VPS, aucune adaptation nécessaire pour ceux-là).
//
// 'goal' (campagnes) EST adapté : ce PC n'a pas d'automation-engine (moteur
// de tâches différées côté VPS, lib/intelligence/vps-bridge.js#engineFor) —
// seules les étapes IMMÉDIATES du plan (extraction + envoi) sont exécutées
// ici ; les étapes différées (relance à +4h, analyse à +6h, rapport à +22h)
// ne le sont PAS — même limitation de fond déjà présente côté VPS pour le
// ciblage de groupe (task-parser.js#detectGoals ne renseigne jamais
// goal.source, donc aucun groupId réel n'est connu automatiquement à partir
// d'un simple "je veux vendre X" — il faut avoir déjà extrait un groupe au
// préalable, via l'onglet Campagnes ou une commande dédiée).

function extractJsonBlock(rawText) {
  const match = String(rawText || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (err) { return null; }
}

const REPORT_RE = /(o[uù]\s+en\s+(?:est|sont)|bilan\s+du\s+jour|statut\s+de|rapport\s+de|comment\s+(?:vont|se\s+portent)|combien\s+de\s+ventes|r[ée]sultats?\s+du\s+jour)/i;
const PAYMENT_RE = /(lien\s+de\s+paiement|\bpayer\b|\bpaiement\b|encaiss|mobile\s?money|orange\s?money|mtn\s?money|moov\s?money|\bwave\b|\bremise\b|r[ée]duction|\brabais\b|n[ée]goci)/i;
const ACCOUNT_RE = /(compte\s+(?:[ée]l[eè]ve|[ée]tudiant|client)|cl[ée]\s+d.?acc[èe]s|acc[èe]s\s+(?:[ée]l[eè]ve|module|au\s+module)|g[ée]n[èe]re?\s+un\s+acc[èe]s|d[ée]bloque)/i;
const GOAL_RE = /(\bvend|\bvente|prospect|groupes?|membres?|publier|poster|\bcontenu|relanc|follow\s?up|\bsuivi|rappel|analys|\brapport|\bbilan)/i;

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

async function buildPersonaFacts() {
  const profile = await offerClarifier.getBusinessProfile('local');
  const domain = personaManager.inferDomain(profile);
  const recentOffers = (profile.offers || []).slice(-3).map((o) => `${o.name || o.category}${o.price ? ` (${o.price})` : ''}`);
  const paymentConfigured = ['MOBILE_MONEY_ORANGE', 'MOBILE_MONEY_MTN', 'MOBILE_MONEY_MOOV', 'MOBILE_MONEY_WAVE'].some((k) => !!process.env[k]);
  const parts = [];
  if (recentOffers.length) parts.push(`Offres déjà configurées : ${recentOffers.join(', ')}.`);
  parts.push(paymentConfigured ? 'Le lien/l\'instruction de paiement Mobile Money est configuré et actif.' : 'Aucun moyen de paiement Mobile Money n\'est configuré pour le moment.');
  return { domain, facts: parts.join(' ') };
}

async function handleOffer(text, history) {
  const { domain } = await buildPersonaFacts();
  const { raw, parsed } = await offerClarifier.planOffer(text, history, domain);
  if (parsed && parsed.ready && parsed.offer) {
    const entry = await offerClarifier.saveOffer('local', parsed.offer, parsed.category);
    const name = entry.name || parsed.offer.name || 'votre offre';
    return {
      text: `${parsed.summary || ''}\n\n✅ C'est noté ! J'ai configuré l'offre "${name}". Je suis prêt à gérer les ventes et les questions des prospects.`.trim(),
      actionLog: [{ icon: '🗂️', label: `Offre "${name}" enregistrée`, status: 'done' }],
    };
  }
  return { text: raw, isPlanningQuestion: true, intent: 'offer' };
}

const goalSessions = new Map();

async function handleGoal(text, sessionKey, deps) {
  const state = goalSessions.get(sessionKey);
  const awaitingConfirmation = !!(state && state.phase === 'ready');
  const { domain, facts } = await buildPersonaFacts();

  if (awaitingConfirmation) {
    if (personaManager.detectDecline(text)) {
      goalSessions.delete(sessionKey);
      return { text: await personaManager.rephrase({ kind: 'declined', rawText: 'La mission est annulée pour l\'instant.', facts, domain }) };
    }
    if (!personaManager.detectAffirmative(text)) {
      const warm = await personaManager.rephrase({
        kind: 'confirm_plan', rawText: (state.doc && state.doc.summary) || 'Le plan est prêt.',
        facts: `${facts} Précision du vendeur à prendre en compte : "${text}".`, domain,
      });
      return { text: warm, isPlanningQuestion: true, intent: 'goal' };
    }

    const ackText = await personaManager.rephrase({ kind: 'executing', rawText: 'La campagne est lancée maintenant.', facts, domain });
    goalSessions.delete(sessionKey);
    if (!deps.runtime || !deps.runtime.actionExecutor) {
      return { text: ackText, actionLog: [{ icon: '⚠️', label: 'Exécution indisponible (moteur non injecté)', status: 'error' }] };
    }
    runGoalPlanLocally(state, deps.runtime);
    return { text: ackText, actionLog: [{ icon: '🚀', label: 'Extraction + envoi démarrés en arrière-plan', status: 'pending' }] };
  }

  const freshState = state || goalChat.createSession({});
  goalSessions.set(sessionKey, freshState);
  const out = goalChat.step(freshState, { message: text, parser: taskParser, humanContext: deps.humanContext || null });

  if (out.kind !== 'plan') {
    const rawQuestion = (out.reply && out.reply.text) || 'Précisez votre objectif.';
    const warm = await personaManager.rephrase({ kind: 'question', rawText: rawQuestion, facts, domain });
    return { text: warm, isPlanningQuestion: true, intent: 'goal' };
  }

  const planText = out.reply.text.replace(/\n\nPrêt à exécuter \? Choisis une action ci-dessous\.$/, '');
  const warm = await personaManager.rephrase({
    kind: 'confirm_plan',
    rawText: `${planText}\n\n(Sur ce PC : seules l'extraction et l'envoi immédiats sont automatisés — relance/analyse/rapport différés restent à faire depuis les onglets Campagnes/Relance.)`,
    facts, domain,
  });
  return { text: warm, isPlanningQuestion: true, intent: 'goal' };
}

// Exécute uniquement EXTRACT_MEMBERS + SEND_CAMPAIGN (étapes immédiates
// réellement actionnables sans ordonnanceur de tâches différées, voir
// commentaire en tête de fichier) — fire-and-forget, notifie via
// platformOrchestrator une fois fait.
async function runGoalPlanLocally(state, runtime) {
  try {
    const channel = (state.ctx.channels && state.ctx.channels[0]) || 'WHATSAPP';
    const extractStep = state.doc && state.doc.plan.find((d) => d.action === 'EXTRACT_MEMBERS');
    let recipients = [];
    if (extractStep) {
      const out = await runtime.actionExecutor.execute('EXTRACT_MEMBERS', { channel, groupId: extractStep.payload.groupId || null }, {});
      recipients = (out.ok && out.result && out.result.members) || [];
    }
    if (!recipients.length) {
      await platformOrchestrator.notifyTenantChat('local',
        '⚠️ Je n\'ai trouvé aucun contact à cibler automatiquement — pas de groupe déjà extrait. Utilisez l\'onglet Campagnes pour extraire un groupe puis relancer.',
        [{ icon: '⚠️', label: 'Aucun destinataire trouvé', status: 'error' }]);
      return;
    }
    const sendOut = await runtime.actionExecutor.execute('SEND_CAMPAIGN', {
      channel, recipients, text: (state.doc && state.doc.objective) || state.ctx.rawObjective || '',
    }, {});
    const ok = sendOut.ok;
    await platformOrchestrator.notifyTenantChat('local',
      ok ? `✅ Campagne lancée sur ${recipients.length} contact(s).` : `⚠️ Échec du lancement (${sendOut.error}).`,
      [{ icon: ok ? '✅' : '⚠️', label: ok ? 'Campagne démarrée' : 'Échec campagne', status: ok ? 'done' : 'error' }]);
  } catch (err) {
    console.error('chatOrchestrator (local) — échec exécution du plan :', err.message);
    await platformOrchestrator.notifyTenantChat('local', `⚠️ L'exécution a échoué (${err.message}).`, [{ icon: '⚠️', label: 'Échec', status: 'error' }]).catch(() => {});
  }
}

async function handleReport(deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) return { text: 'Rapport indisponible pour le moment (moteur non injecté).' };
  const out = await deps.runtime.actionExecutor.execute('GENERATE_REPORT', { scope: 'day', tenantId: 'local' }, {});
  if (!out.ok) return { text: `Impossible de générer le rapport (${out.error}).` };
  const r = out.result;
  const text2 = [
    'Voici où on en est aujourd\'hui :',
    `📊 ${r.totalMessages} message(s) analysé(s), ${r.conversions} conversion(s) détectée(s), chaleur ${r.heat}.`,
    r.recommendations && r.recommendations.length ? `Recommandations : ${r.recommendations.join(' ')}` : null,
  ].filter(Boolean).join('\n');
  return { text: text2, actionLog: [{ icon: '📊', label: 'Rapport généré', status: 'done' }] };
}

async function planPayment(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur : "${text}"`,
    'Le vendeur veut soit générer une instruction de paiement pour un client, soit négocier/accorder une remise. Détermine lequel.',
    'Informations nécessaires si paiement : le montant exact et la devise, le produit/offre concerné (facultatif, texte libre).',
    'Informations nécessaires si remise : le prix de départ et le pourcentage de remise demandé (si non précisé, mets requestedPercent à null).',
    'Base-toi sur l\'historique pour ne jamais reposer une question déjà répondue.',
    'Si des informations manquent, réponds UNIQUEMENT par 1 à 2 questions courtes (texte simple, jamais de JSON).',
    'Si tu as assez d\'informations, réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après) : {"ready":true,"kind":"payment"|"discount","amount":15000,"currency":"FCFA","product":"nom du produit ou chaîne vide","price":15000,"requestedPercent":10}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const trimmed = raw.trim();
  return { raw: trimmed, parsed: extractJsonBlock(trimmed) };
}

async function handlePayment(text, history, deps) {
  const { domain } = await buildPersonaFacts();
  const { raw, parsed } = await planPayment(text, history, domain);
  if (!parsed || !parsed.ready) return { text: raw, isPlanningQuestion: true, intent: 'payment' };
  if (!deps.runtime || !deps.runtime.actionExecutor) return { text: 'Impossible de traiter cette demande pour le moment (moteur non injecté).' };

  if (parsed.kind === 'discount') {
    const out = await deps.runtime.actionExecutor.execute('NEGOTIATE_DISCOUNT', { price: parsed.price, requestedPercent: parsed.requestedPercent }, {});
    if (!out.ok) return { text: `Impossible de calculer la remise (${out.error}).` };
    const r = out.result;
    const cappedNote = r.capped ? ` (plafonnée à ${r.appliedPercent}% — remise maximale autorisée)` : '';
    return {
      text: `🤝 Remise accordée : ${r.appliedPercent}%${cappedNote}. Prix final : ${r.finalPrice} ${r.currency} (au lieu de ${r.originalPrice} ${r.currency}).`,
      actionLog: [{ icon: '🤝', label: `Remise ${r.appliedPercent}% accordée`, status: 'done' }],
    };
  }

  const out = await deps.runtime.actionExecutor.execute('GENERATE_PAYMENT_LINK', { amount: parsed.amount, currency: parsed.currency, product: parsed.product }, {});
  if (!out.ok) {
    const hint = out.error === 'NO_MOBILE_MONEY_NUMBER_CONFIGURED' ? ' Configurez au moins un numéro Mobile Money (MOBILE_MONEY_ORANGE/MTN/MOOV/WAVE dans .env) pour activer cet outil.' : '';
    return { text: `Impossible de générer l'instruction de paiement (${out.error}).${hint}` };
  }
  return { text: out.result.message, actionLog: [{ icon: '💳', label: `Instruction de paiement générée (réf. ${out.result.reference})`, status: 'done' }] };
}

async function planAccount(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur : "${text}"`,
    'Le vendeur veut créer/débloquer l\'accès d\'un client à une formation déjà vendue.',
    'Informations nécessaires : le contact du client (téléphone ou email), et soit "action":"create_account" (nouveau client), soit "action":"grant_module" (client déjà créé, ajoute un module — nécessite moduleKey).',
    'Base-toi sur l\'historique pour ne jamais reposer une question déjà répondue.',
    'Si des informations manquent, réponds UNIQUEMENT par 1 à 2 questions courtes (texte simple, jamais de JSON).',
    'Si tu as assez d\'informations, réponds UNIQUEMENT avec cet objet JSON (aucun texte avant/après) : {"ready":true,"action":"create_account"|"grant_module","phone":"+225...","email":"","studentName":"","sku":"nom de la formation ou chaîne vide","moduleKey":"identifiant du module ou chaîne vide (grant_module uniquement)"}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const trimmed = raw.trim();
  return { raw: trimmed, parsed: extractJsonBlock(trimmed) };
}

async function handleAccount(text, history, deps) {
  const { domain } = await buildPersonaFacts();
  const { raw, parsed } = await planAccount(text, history, domain);
  if (!parsed || !parsed.ready) return { text: raw, isPlanningQuestion: true, intent: 'account' };
  if (!deps.runtime || !deps.runtime.actionExecutor) return { text: 'Impossible de traiter cette demande pour le moment (moteur non injecté).' };

  if (parsed.action === 'grant_module') {
    const out = await deps.runtime.actionExecutor.execute('GRANT_MODULE_ACCESS', { phone: parsed.phone, email: parsed.email, moduleKey: parsed.moduleKey }, {});
    if (!out.ok) return { text: `Impossible d'accorder l'accès (${out.error}).` };
    return {
      text: `🔓 Accès au module "${parsed.moduleKey}" accordé à ${parsed.phone || parsed.email}.`,
      actionLog: [{ icon: '🔓', label: `Module "${parsed.moduleKey}" débloqué`, status: 'done' }],
    };
  }

  const out = await deps.runtime.actionExecutor.execute('CREATE_USER_ACCOUNT', { phone: parsed.phone, email: parsed.email, studentName: parsed.studentName, sku: parsed.sku }, {});
  if (!out.ok) return { text: `Impossible de créer le compte (${out.error}).` };
  const r = out.result;
  return {
    text: `🎓 Compte élève créé pour ${parsed.phone || parsed.email}.\n🔑 Clé d'accès : ${r.accessKey}`,
    actionLog: [{ icon: '🎓', label: `Compte élève créé — clé ${r.accessKey}`, status: 'done' }],
  };
}

// Point d'entrée unique — `deps` = { runtime, humanContext } (voir
// lib/intelligence/runtimes/local-runtime.js, injecté depuis index.js).
async function handle({ text, history, sessionId, lastAssistantMessage }, deps) {
  const intent = detectIntent(text, lastAssistantMessage);
  if (!intent) return null;

  const sessionKey = sessionId || 'default';
  switch (intent) {
    case 'offer': return handleOffer(text, history);
    case 'goal': return handleGoal(text, sessionKey, deps || {});
    case 'report': return handleReport(deps || {});
    case 'payment': return handlePayment(text, history, deps || {});
    case 'account': return handleAccount(text, history, deps || {});
    default: return null;
  }
}

module.exports = { detectIntent, handle };
