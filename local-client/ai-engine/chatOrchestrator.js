const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const taskParser = require('../lib/intelligence/task-parser');
const goalChat = require('../lib/intelligence/goal-chat');
const offerClarifier = require('./offerClarifier');
const personaManager = require('./personaManager');
const platformOrchestrator = require('./platformOrchestrator');
const connectorManager = require('./connectors/connectorManager');
const manualPaymentValidator = require('./manualPaymentValidator');
const contactCrm = require('./contactCrm');
const recurringTasks = require('../queues/recurringTasks');

// ADAPTATEUR local-client de ai-engine/chatOrchestrator.js (VPS) — MÊME modèle
// intelligent, mono-poste (tenant fixe 'local'). Le moteur d'objectif 'goal'
// reste adapté (pas d'automation-engine différé sur PC : seules extraction +
// envoi immédiats sont exécutés, voir runGoalPlanLocally). Toutes les autres
// intentions (inbox, groupes, publication, récurrence, CRM, connecteurs,
// paiement, compte) sont portées à l'identique du VPS, branchées sur
// lib/intelligence/runtimes/local-runtime.js via deps.runtime.

const TENANT = 'local';

function extractJsonBlock(rawText) {
  const match = String(rawText || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (err) { return null; }
}

const REPORT_RE = /(o[uù]\s+en\s+(?:est|sont)|bilan\s+du\s+jour|statut\s+de|rapport\s+de|comment\s+(?:vont|se\s+portent)|combien\s+de\s+ventes|r[ée]sultats?\s+du\s+jour)/i;
const PAYMENT_RE = /(lien\s+de\s+paiement|\bpayer\b|\bpaiement\b|encaiss|mobile\s?money|orange\s?money|mtn\s?money|moov\s?money|\bwave\b|\bremise\b|r[ée]duction|\brabais\b|n[ée]goci)/i;
const ACCOUNT_RE = /(compte\s+(?:[ée]l[eè]ve|[ée]tudiant|client)|cl[ée]\s+d.?acc[èe]s|acc[èe]s\s+(?:[ée]l[eè]ve|module|au\s+module)|g[ée]n[èe]re?\s+un\s+acc[èe]s|d[ée]bloque|inscri(?:s|re|t)|enr[ôo]le|suspend|d[ée]sactive)/i;
const CONNECTOR_RE = /(ajoute[rz]?\s+(?:ce\s+|le\s+|un\s+|mon\s+)?contact|\btague?r?\b|\btags?\b|system\.?io|systeme\.?io|\bcrm\b|factur|enregistre?\s+(?:la|une|cette)\s+vente|journal\s+des\s+ventes)/i;
const INBOX_RE = /(derniers?\s+messages?|messages?\s+re[çc]us?|qui\s+m.?a\s+(?:écrit|ecrit|envoy[ée]|contact[ée])|num[ée]ro\s+de\s+l.?exp[ée]diteur|\bexp[ée]diteur\b|bo[îi]te\s+de\s+r[ée]ception|\binbox\b|(?:es|est)-?\s*tu\s+(?:vraiment\s+)?connect[ée]|connect[ée]\s+[àa]\s+mon\s+(?:whatsapp|telegram)|montre(?:-|\s+)(?:moi\s+)?mes\s+messages)/i;
const GROUPS_RE = /(mes\s+groupes?|liste[rz]?\s+(?:mes\s+)?groupes?|quels?\s+(?:sont\s+)?(?:mes\s+)?groupes?|combien\s+de\s+groupes?|groupes?\s+(?:dont|o[ùu])\s+je\s+suis\s+admin|groupes?\s+que\s+j.?administre|mes\s+groupes?\s+admin)/i;
const RECURRING_RE = /(chaque\s+(?:matin|jour|soir|semaine|nuit|midi|\d{1,2}\s*h)|tous\s+les\s+(?:matins|jours|soirs)|chaque\s+jour|t[âa]ches?\s+r[ée]curren|r[ée]currente?s?\b|automatiser?\b|programme[rz]?\s+(?:un\s+)?(?:message|envoi)\s+quotidien)/i;
const GROUPPOST_RE = /(poste|publie|partage|diffuse|balance|envoi[e]?)\w*[^]{0,80}?(groupe|groupes|canal|canaux)/i;
const CRM_RE = /(mes\s+(?:prospects?|clients?|contacts?)|combien\s+de\s+(?:prospects?|clients?|contacts?)|contacts?\s+[ée]tiquet|contacts?\s+tagg?[ée]s?|liste[rz]?\s+(?:mes\s+)?(?:prospects?|clients?|contacts?)|qui\s+sont\s+mes\s+(?:prospects?|clients?)|mes\s+[ée]tiquettes)/i;
const GOAL_RE = /(\bvend|\bvente|prospect|groupes?|membres?|publier|poster|\bcontenu|relanc|follow\s?up|\bsuivi|rappel|analys|\brapport|\bbilan)/i;

function detectIntent(text, lastAssistantMessage) {
  const continuation = ['offer', 'payment', 'account', 'connector', 'goal', 'recurring', 'grouppost'];
  if (lastAssistantMessage && lastAssistantMessage.isPlanningQuestion && continuation.includes(lastAssistantMessage.intent)) {
    return lastAssistantMessage.intent;
  }
  if (offerClarifier.detectNewOfferIntent(text)) return 'offer';
  if (INBOX_RE.test(text)) return 'inbox';
  if (RECURRING_RE.test(text)) return 'recurring';
  if (GROUPPOST_RE.test(text) && !/membre/i.test(text)) return 'grouppost';
  if (GROUPS_RE.test(text)) return 'groups';
  if (CRM_RE.test(text)) return 'crm';
  if (REPORT_RE.test(text)) return 'report';
  if (PAYMENT_RE.test(text)) return 'payment';
  if (ACCOUNT_RE.test(text) || CONNECTOR_RE.test(text)) return 'connector';
  if (GOAL_RE.test(text)) return 'goal';
  return null;
}

async function buildPersonaFacts() {
  const profile = await offerClarifier.getBusinessProfile(TENANT);
  const domain = personaManager.inferDomain(profile);
  const recentOffers = (profile.offers || []).slice(-3).map((o) => `${o.name || o.category}${o.price ? ` (${o.price})` : ''}`);
  const paymentConfigured = ['MOBILE_MONEY_ORANGE', 'MOBILE_MONEY_MTN', 'MOBILE_MONEY_MOOV', 'MOBILE_MONEY_WAVE'].some((k) => !!process.env[k]);
  const parts = [];
  if (recentOffers.length) parts.push(`Offres déjà configurées : ${recentOffers.join(', ')}.`);
  parts.push(paymentConfigured ? 'Le lien/l\'instruction de paiement Mobile Money est configuré et actif.' : 'Aucun moyen de paiement Mobile Money n\'est configuré pour le moment.');
  return { domain, facts: parts.join(' ') };
}

// ---------------- 'offer' ----------------
async function handleOffer(text, history) {
  const { domain } = await buildPersonaFacts();
  const { raw, parsed } = await offerClarifier.planOffer(text, history, domain);
  if (parsed && parsed.ready && parsed.offer) {
    const entry = await offerClarifier.saveOffer(TENANT, parsed.offer, parsed.category);
    const name = entry.name || parsed.offer.name || 'votre offre';
    return {
      text: `${parsed.summary || ''}\n\n✅ C'est noté ! J'ai configuré l'offre "${name}". Je suis prêt à gérer les ventes et les questions des prospects.`.trim(),
      actionLog: [{ icon: '🗂️', label: `Offre "${name}" enregistrée`, status: 'done' }],
    };
  }
  return { text: raw, isPlanningQuestion: true, intent: 'offer' };
}

// ---------------- 'goal' (adapté PC : étapes immédiates seulement) ----------------
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
      await platformOrchestrator.notifyTenantChat(TENANT,
        '⚠️ Je n\'ai trouvé aucun contact à cibler automatiquement — pas de groupe déjà extrait. Utilisez l\'onglet Campagnes pour extraire un groupe puis relancer.',
        [{ icon: '⚠️', label: 'Aucun destinataire trouvé', status: 'error' }]);
      return;
    }
    const sendOut = await runtime.actionExecutor.execute('SEND_CAMPAIGN', {
      channel, recipients, text: (state.doc && state.doc.objective) || state.ctx.rawObjective || '',
    }, {});
    const ok = sendOut.ok;
    await platformOrchestrator.notifyTenantChat(TENANT,
      ok ? `✅ Campagne lancée sur ${recipients.length} contact(s).` : `⚠️ Échec du lancement (${sendOut.error}).`,
      [{ icon: ok ? '✅' : '⚠️', label: ok ? 'Campagne démarrée' : 'Échec campagne', status: ok ? 'done' : 'error' }]);
  } catch (err) {
    console.error('chatOrchestrator (local) — échec exécution du plan :', err.message);
    await platformOrchestrator.notifyTenantChat(TENANT, `⚠️ L'exécution a échoué (${err.message}).`, [{ icon: '⚠️', label: 'Échec', status: 'error' }]).catch(() => {});
  }
}

// ---------------- 'report' ----------------
async function handleReport(deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) return { text: 'Rapport indisponible pour le moment (moteur non injecté).' };
  const out = await deps.runtime.actionExecutor.execute('GENERATE_REPORT', { scope: 'day', tenantId: TENANT }, {});
  if (!out.ok) return { text: `Impossible de générer le rapport (${out.error}).` };
  const r = out.result;
  const text2 = [
    'Voici où on en est aujourd\'hui :',
    `📊 ${r.totalMessages} message(s) analysé(s), ${r.conversions} conversion(s) détectée(s), chaleur ${r.heat}.`,
    r.recommendations && r.recommendations.length ? `Recommandations : ${r.recommendations.join(' ')}` : null,
  ].filter(Boolean).join('\n');
  return { text: text2, actionLog: [{ icon: '📊', label: 'Rapport généré', status: 'done' }] };
}

// ---------------- 'inbox' ----------------
async function handleInbox(text, deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) return { text: 'Je ne peux pas lire les messages pour le moment (moteur non disponible).' };
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const out = await deps.runtime.actionExecutor.execute('READ_RECENT_MESSAGES', { channel, limit: 10, tenantId: TENANT }, { tenantId: TENANT });
  if (!out.ok) return { text: `Je n'ai pas pu lire ${label} (${out.error}).` };
  const r = out.result || {};
  const numLine = r.connectedNumber ? ` (numéro : ${r.connectedNumber})` : '';
  if (r.connected === false) {
    if (r.paired) return { text: `Ton compte ${label}${numLine} est bien appairé, mais la connexion se rétablit — réessaie dans un instant.`, actionLog: [{ icon: '🔄', label: `${label} appairé — reconnexion`, status: 'warning' }] };
    return { text: `⚠️ Je ne suis pas connecté à ${label} et aucun compte n'y est appairé — appaire d'abord le compte.`, actionLog: [{ icon: '🔌', label: `${label} non appairé`, status: 'warning' }] };
  }
  const messages = Array.isArray(r.messages) ? r.messages : [];
  if (!messages.length) {
    return { text: `Je suis bien connecté à ${label}${numLine}, mais aucun message en mémoire depuis mon dernier démarrage. Fais-toi écrire un message puis redemande-moi.`, actionLog: [{ icon: '🔌', label: `${label} connecté`, status: 'done' }] };
  }
  const fmtWho = (m) => (m.name ? `${m.name} (${m.number || m.username || m.from})` : (m.number || m.username || m.from));
  const fmtWhen = (m) => (m.ts ? new Date(m.ts * 1000).toLocaleString('fr-FR') : '');
  const fmtBody = (m) => (m.text ? `"${m.text}"` : (m.hasMedia ? '[média]' : '[message vide]'));
  const lines = messages.slice(0, 5).map((m, i) => `${i === 0 ? '➡️ ' : '• '}${fmtWho(m)}${m.isGroup ? ' [groupe]' : ''} — ${fmtBody(m)}${fmtWhen(m) ? ` · ${fmtWhen(m)}` : ''}`);
  return { text: [`Voici tes derniers messages ${label}${numLine} :`, ...lines].join('\n'), actionLog: [{ icon: '📥', label: `Dernier : ${fmtWho(messages[0])}`, status: 'done' }] };
}

// ---------------- 'groups' ----------------
function targetLabel(t) {
  const k = (t && t.kind) || 'all';
  if (k === 'admin') return 'tous tes groupes où tu es admin';
  if ((k === 'named' || k === 'subject') && t.value) return `les groupes « ${t.value} »`;
  return 'tous tes groupes';
}

async function handleGroups(text, deps) {
  if (!deps.runtime || !deps.runtime.actionExecutor) return { text: 'Je ne peux pas lister les groupes (moteur non disponible).' };
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const out = await deps.runtime.actionExecutor.execute('LIST_GROUPS', { channel, tenantId: TENANT }, { tenantId: TENANT });
  if (!out.ok) return { text: `Je n'ai pas pu récupérer tes groupes ${label} (${out.error}).` };
  const r = out.result || {};
  if (r.connected === false) {
    return { text: r.paired ? `Ton compte ${label} est appairé mais la connexion se rétablit — réessaie dans un instant.` : `Je ne suis pas connecté à ${label} — appaire d'abord le compte.`, actionLog: [{ icon: '🔄', label: `${label} ${r.paired ? 'reconnexion' : 'non appairé'}`, status: 'warning' }] };
  }
  let groups = Array.isArray(r.groups) ? r.groups : [];
  const total = groups.length;
  const adminOnly = /(admin|administre|dont\s+je\s+suis|o[ùu]\s+je\s+suis)/i.test(text);
  if (adminOnly) groups = groups.filter((g) => g.isAdmin);
  const subj = text.match(/(?:sur|contenant|th[èe]me|[àa]\s+propos\s+de|parlant\s+de)\s+["']?([\p{L}\d][\p{L}\d \-]{1,40})/iu);
  if (subj) { const kw = subj[1].trim().toLowerCase(); groups = groups.filter((g) => (g.name || '').toLowerCase().includes(kw)); }
  if (!groups.length) return { text: adminOnly ? `Aucun groupe ${label} dont tu es admin (sur ${total}).` : `Aucun groupe ${label} trouvé${subj ? ' pour ce sujet' : ''} (${total}).` };
  const sorted = groups.slice().sort((a, b) => (b.size || 0) - (a.size || 0));
  const top = sorted.slice(0, 20);
  const lines = top.map((g) => `• ${g.name}${g.isAdmin ? ' 👑 (admin)' : ''} — ${g.size || 0} membre(s)`);
  const header = adminOnly ? `Tes groupes ${label} où tu es admin (${groups.length}) :` : `Tes groupes ${label} (${groups.length}${subj ? ' correspondant au sujet' : ''}) :`;
  const more = groups.length > top.length ? `\n… et ${groups.length - top.length} autre(s).` : '';
  return { text: [header, ...lines].join('\n') + more, actionLog: [{ icon: '👥', label: `${groups.length} groupe(s) ${label}`, status: 'done' }] };
}

// ---------------- 'grouppost' (publication ciblée, avec confirmation) ----------------
const groupPostSessions = new Map();

async function planGroupPost(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Message de l'administrateur : "${text}"`,
    'Il veut publier un message (et éventuellement un visuel/affiche généré) DANS un ou plusieurs de ses groupes.',
    "Cible : {kind:'named'|'subject'|'admin'|'all', value:'nom exact du groupe OU mot-clé de sujet, sinon chaîne vide'}.",
    'wantsVisual : true seulement s\'il demande de GÉNÉRER une affiche/image, sinon false. visualPrompt : courte description si wantsVisual.',
    "message : le texte à publier (rédige-le proprement si l'ordre est vague mais l'intention claire).",
    'Réponds UNIQUEMENT avec cet objet JSON : {"target":{"kind":"...","value":"..."},"message":"...","wantsVisual":false,"visualPrompt":""}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  return extractJsonBlock(String(raw || '').trim()) || { raw: String(raw || '').trim() };
}

async function handleGroupPost(text, history, sessionKey, deps) {
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  const { domain } = await buildPersonaFacts();
  const state = groupPostSessions.get(sessionKey);

  if (state && state.phase === 'ready') {
    if (personaManager.detectDecline(text)) { groupPostSessions.delete(sessionKey); return { text: 'Ok, j\'annule la publication.' }; }
    if (!personaManager.detectAffirmative(text)) {
      state.plan.message = text;
      return { text: `Compris. Je publie ceci dans ${targetLabel(state.plan.target)} (${state.groupsCount} groupe(s)) ? Réponds « oui » pour lancer.`, isPlanningQuestion: true, intent: 'grouppost' };
    }
    if (!deps.runtime || typeof deps.runtime.sendToGroups !== 'function') { groupPostSessions.delete(sessionKey); return { text: 'Publication indisponible (moteur non injecté).' }; }
    let media = null;
    if (state.plan.wantsVisual && typeof deps.generateImage === 'function') {
      try { const img = await deps.generateImage(state.plan.visualPrompt || state.plan.message); if (img && img.buffer) media = { buffer: img.buffer, mimetype: img.mimetype || 'image/jpeg', filename: 'affiche.jpg', caption: state.plan.message }; } catch (e) { /* repli texte */ }
    }
    const out = await deps.runtime.sendToGroups({ channel: state.plan.channel || channel, target: state.plan.target, text: state.plan.message, media, tenantId: TENANT });
    groupPostSessions.delete(sessionKey);
    if (!out.ok) {
      const hint = out.error === 'NO_MATCHING_GROUP' ? ' Aucun groupe ne correspond.' : (/RUNTIME_MISSING|getGroupsSummary/i.test(out.error || '') ? ' Vérifie que le compte est bien connecté.' : '');
      return { text: `Je n'ai pas pu publier (${out.error}).${hint}` };
    }
    return { text: `✅ Publié dans ${out.sent}/${out.total} groupe(s) ${label}${media ? ' (avec le visuel)' : ''}.`, actionLog: [{ icon: '📢', label: `Publié dans ${out.sent} groupe(s)`, status: 'done' }] };
  }

  const parsed = await planGroupPost(text, history, domain);
  if (!parsed || !parsed.message) return { text: (parsed && parsed.raw) || 'Que veux-tu publier, et dans quel(s) groupe(s) ?', isPlanningQuestion: true, intent: 'grouppost' };
  const target = parsed.target && parsed.target.kind ? parsed.target : { kind: 'all', value: '' };
  let groupsCount = null;
  let names = [];
  if (deps.runtime && typeof deps.runtime.resolveGroups === 'function') {
    const r = await deps.runtime.resolveGroups({ channel, target, tenantId: TENANT }).catch(() => null);
    if (r && r.ok) { groupsCount = r.groups.length; names = r.groups.slice(0, 5).map((g) => g.name); }
  }
  groupPostSessions.set(sessionKey, { phase: 'ready', plan: { channel, target, message: parsed.message, wantsVisual: !!parsed.wantsVisual, visualPrompt: parsed.visualPrompt || '' }, groupsCount: groupsCount || 0 });
  const where = groupsCount != null ? `${groupsCount} groupe(s)${names.length ? ` (${names.join(', ')}${groupsCount > names.length ? '…' : ''})` : ''}` : targetLabel(target);
  const visualNote = parsed.wantsVisual ? ' avec un visuel généré' : '';
  return { text: `Je vais publier${visualNote} dans ${where} sur ${label} :\n« ${parsed.message} »\n\nJe lance ? (réponds « oui », ou redicte un autre texte)`, isPlanningQuestion: true, intent: 'grouppost' };
}

// ---------------- 'recurring' ----------------
async function planRecurring(text, history) {
  const { domain } = await buildPersonaFacts();
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Ordre de l'administrateur : "${text}"`,
    'Il veut programmer un message QUOTIDIEN récurrent dans un ou des groupes.',
    "Extrais : channel ('WHATSAPP' ou 'TELEGRAM', défaut WHATSAPP), target {kind:'named'|'subject'|'admin'|'all', value}, message (rédige-le si l'intention est claire), hour (0-23) et minute (0-59).",
    "Si l'heure OU le message OU la cible manque vraiment, réponds UNIQUEMENT par une question courte (texte, jamais de JSON).",
    'Sinon réponds UNIQUEMENT : {"ready":true,"channel":"WHATSAPP","target":{"kind":"...","value":"..."},"message":"...","hour":7,"minute":0}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  return extractJsonBlock(String(raw || '').trim()) || { ready: false, raw: String(raw || '').trim() };
}

async function handleRecurring(text, history) {
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : 'WHATSAPP';
  if (/(liste|montre|voir|quelles?)\b/i.test(text) && /(t[âa]ches?|r[ée]curren|programm)/i.test(text)) {
    const active = (await recurringTasks.list(TENANT)).filter((t) => t.active);
    if (!active.length) return { text: 'Aucune tâche récurrente active pour le moment.' };
    const lines = active.map((t, i) => `${i + 1}. ${String(t.hour).padStart(2, '0')}h${String(t.minute).padStart(2, '0')} → ${targetLabel(t.target)} (${t.channel}) : « ${String(t.message).slice(0, 60)} »`);
    return { text: ['⏰ Tes tâches récurrentes :', ...lines].join('\n'), actionLog: [{ icon: '⏰', label: `${active.length} tâche(s)`, status: 'done' }] };
  }
  if (/(arr[êe]te|stop|supprime|annule|d[ée]sactive)/i.test(text)) {
    const n = await recurringTasks.stopAll(TENANT);
    return { text: n ? `🛑 ${n} tâche(s) récurrente(s) arrêtée(s).` : 'Aucune tâche récurrente à arrêter.', actionLog: n ? [{ icon: '🛑', label: 'Arrêtées', status: 'done' }] : null };
  }
  const parsed = await planRecurring(text, history);
  if (!parsed || parsed.ready === false || !parsed.message || parsed.hour == null) {
    return { text: (parsed && parsed.raw) || 'À quelle heure, dans quel groupe, et quel message veux-tu envoyer chaque jour ?', isPlanningQuestion: true, intent: 'recurring' };
  }
  const target = parsed.target && parsed.target.kind ? parsed.target : { kind: 'all', value: '' };
  const task = await recurringTasks.create(TENANT, { channel: parsed.channel || channel, target, message: parsed.message, hour: parsed.hour, minute: parsed.minute || 0 });
  const label = (parsed.channel || channel) === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
  return { text: `✅ Programmé : chaque jour à ${String(task.hour).padStart(2, '0')}h${String(task.minute).padStart(2, '0')}, j'enverrai dans ${targetLabel(target)} (${label}) :\n« ${task.message} »`, actionLog: [{ icon: '⏰', label: 'Tâche récurrente créée', status: 'done' }] };
}

// ---------------- 'crm' ----------------
async function handleCrm(text) {
  let tag = null;
  if (/\bclients?\b/i.test(text)) tag = 'client';
  else if (/\bprospects?\b/i.test(text)) tag = 'prospect';
  else if (/nouveau|nouvelle|nouveaux/i.test(text)) tag = 'nouveau_contact';
  const m = text.match(/(?:tagg?[ée]s?|[ée]tiquet[ée]s?)\s+["']?([\p{L}\d_-]{2,30})/iu);
  if (m) tag = m[1].trim().toLowerCase();
  const channel = /telegram/i.test(text) ? 'TELEGRAM' : (/whatsapp/i.test(text) ? 'WHATSAPP' : null);
  const c = await contactCrm.counts(TENANT);
  const items = await contactCrm.list(TENANT, { tag, channel });
  const recap = Object.entries(c.byTag || {}).map(([t, n]) => `${t}: ${n}`).join(', ');
  if (!items.length) {
    return { text: tag ? `Aucun contact avec l'étiquette « ${tag} »${channel ? ' sur ' + channel : ''}.${recap ? `\n(Récap : ${recap})` : ''}` : 'Aucun contact enregistré pour l\'instant.' };
  }
  const top = items.slice(0, 20);
  const lines = top.map((x) => `• ${x.name || x.from}${(x.tags || []).length ? ` — ${x.tags.join(', ')}` : ''}${(x.purchases || []).length ? ` · ${x.purchases.length} achat(s)` : ''}`);
  const header = tag ? `Contacts « ${tag} » (${items.length}) :` : `Tes contacts (${items.length}) :`;
  const more = items.length > top.length ? `\n… et ${items.length - top.length} autre(s).` : '';
  return { text: [header, ...lines].join('\n') + more, actionLog: [{ icon: '🏷️', label: `${items.length} contact(s)${tag ? ' « ' + tag + ' »' : ''}`, status: 'done' }] };
}

// ---------------- 'payment' ----------------
async function planPayment(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur : "${text}"`,
    'Le vendeur veut soit générer une instruction de paiement, soit négocier/accorder une remise. Détermine lequel.',
    'Paiement : montant exact + devise, produit (facultatif). Remise : prix de départ + pourcentage (null si non précisé).',
    'Si des informations manquent, réponds UNIQUEMENT par 1-2 questions courtes (texte, jamais de JSON).',
    'Sinon réponds UNIQUEMENT : {"ready":true,"kind":"payment"|"discount","amount":15000,"currency":"FCFA","product":"","price":15000,"requestedPercent":10}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const trimmed = raw.trim();
  return { raw: trimmed, parsed: extractJsonBlock(trimmed) };
}

async function handlePayment(text, history, deps) {
  const { domain } = await buildPersonaFacts();
  const { raw, parsed } = await planPayment(text, history, domain);
  if (!parsed || !parsed.ready) return { text: raw, isPlanningQuestion: true, intent: 'payment' };
  if (!deps.runtime || !deps.runtime.actionExecutor) return { text: 'Impossible de traiter cette demande (moteur non injecté).' };
  if (parsed.kind === 'discount') {
    const out = await deps.runtime.actionExecutor.execute('NEGOTIATE_DISCOUNT', { price: parsed.price, requestedPercent: parsed.requestedPercent }, {});
    if (!out.ok) return { text: `Impossible de calculer la remise (${out.error}).` };
    const r = out.result;
    const cappedNote = r.capped ? ` (plafonnée à ${r.appliedPercent}%)` : '';
    return { text: `🤝 Remise accordée : ${r.appliedPercent}%${cappedNote}. Prix final : ${r.finalPrice} ${r.currency} (au lieu de ${r.originalPrice} ${r.currency}).`, actionLog: [{ icon: '🤝', label: `Remise ${r.appliedPercent}%`, status: 'done' }] };
  }
  const out = await deps.runtime.actionExecutor.execute('GENERATE_PAYMENT_LINK', { amount: parsed.amount, currency: parsed.currency, product: parsed.product }, {});
  if (!out.ok) {
    const hint = out.error === 'NO_MOBILE_MONEY_NUMBER_CONFIGURED' ? ' Configurez au moins un numéro Mobile Money dans .env.' : '';
    return { text: `Impossible de générer l'instruction de paiement (${out.error}).${hint}` };
  }
  return { text: out.result.message, actionLog: [{ icon: '💳', label: `Instruction générée (réf. ${out.result.reference})`, status: 'done' }] };
}

// ---------------- 'connector' (plateformes externes) + repli compte interne ----------------
function describeToolsForPrompt(tools) {
  return tools.map((t) => {
    const params = Object.keys(t.parameters || {}).map((k) => `${k}${t.parameters[k] && t.parameters[k].required ? ' (requis)' : ''}: ${(t.parameters[k] && t.parameters[k].description) || ''}`).join(' ; ');
    return `- ${t.name} [${t.connectorLabel}] : ${t.description}\n  Paramètres : ${params || '(aucun)'}`;
  }).join('\n');
}
function formatConnectorResult(toolName, result) {
  const r = result || {};
  if (toolName === 'creer_compte_eleve') return { text: `🎓 Accès créé pour ${r.email} (formation « ${r.courseId} »).${r.passwordResetLink ? `\n🔗 ${r.passwordResetLink}` : ''}`, actionLog: [{ icon: '🎓', label: `Compte — ${r.email}`, status: 'done' }] };
  if (toolName === 'suspendre_compte_eleve') return { text: `⛔ Accès suspendu pour ${r.email} (réversible).`, actionLog: [{ icon: '⛔', label: `Suspendu — ${r.email}`, status: 'done' }] };
  if (toolName === 'ajouter_contact') return { text: `📇 Contact ${r.created ? 'créé' : 'retrouvé'} sur ${r.provider || 'la plateforme'} : ${r.email}.`, actionLog: [{ icon: '📇', label: `Contact — ${r.email}`, status: 'done' }] };
  if (toolName === 'attribuer_tag') return { text: `🏷️ Tag « ${r.tag} » attribué.`, actionLog: [{ icon: '🏷️', label: `Tag « ${r.tag} »`, status: 'done' }] };
  if (toolName === 'enregistrer_vente') { const e = r.entry || {}; return { text: `📒 Vente enregistrée : ${e.amount} ${e.currency}${e.product ? ` — ${e.product}` : ''}.`, actionLog: [{ icon: '📒', label: 'Vente enregistrée', status: 'done' }] }; }
  if (toolName === 'generer_facture') { const inv = r.invoice || {}; return { text: `🧾 Facture ${inv.number} : ${inv.amount} ${inv.currency}.`, actionLog: [{ icon: '🧾', label: `Facture ${inv.number}`, status: 'done' }] }; }
  return { text: '✅ Action effectuée sur la plateforme.', actionLog: [{ icon: '✅', label: `« ${toolName} »`, status: 'done' }] };
}

async function handleConnector(text, history, deps) {
  const tools = await connectorManager.getToolsForTenant(TENANT).catch(() => []);
  if (!tools.length) return handleAccount(text, history, deps);
  const { domain } = await buildPersonaFacts();
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    'Tu disposes des OUTILS d\'administration suivants (et AUCUN autre) :',
    describeToolsForPrompt(tools),
    `Message de l'administrateur : "${text}"`,
    'Choisis AU PLUS un outil pertinent et extrais ses arguments. Jamais de suppression.',
    'Si un argument requis manque, réponds UNIQUEMENT par 1-2 questions courtes (texte).',
    'Si aucun outil ne correspond, réponds UNIQUEMENT {"tool":null}.',
    'Sinon réponds UNIQUEMENT : {"tool":"nom_exact","args":{ ... }}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const trimmed = String(raw || '').trim();
  const parsed = extractJsonBlock(trimmed);
  if (!parsed || !('tool' in parsed)) return { text: trimmed, isPlanningQuestion: true, intent: 'connector' };
  if (!parsed.tool) return handleAccount(text, history, deps);
  if (!tools.some((t) => t.name === parsed.tool)) return handleAccount(text, history, deps);
  const out = await connectorManager.executeTool(TENANT, parsed.tool, parsed.args || {}, (deps && deps.executeOptions) || {});
  if (!out.ok) return { text: `Impossible d'exécuter « ${parsed.tool} » (${out.error}).${out.detail ? ' ' + out.detail : ''}` };
  return formatConnectorResult(parsed.tool, out.result);
}

async function planAccount(text, history, domain) {
  const prompt = [
    personaManager.personaSystemPrompt(domain || 'default'),
    `Nouveau message du vendeur : "${text}"`,
    'Le vendeur veut créer/débloquer l\'accès d\'un client à une formation déjà vendue.',
    'Infos : contact (téléphone ou email), et "action":"create_account" (nouveau) ou "grant_module" (module précis, nécessite moduleKey).',
    'Si des infos manquent, réponds UNIQUEMENT par 1-2 questions courtes (texte).',
    'Sinon réponds UNIQUEMENT : {"ready":true,"action":"create_account"|"grant_module","phone":"","email":"","studentName":"","sku":"","moduleKey":""}',
  ].join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history);
  const trimmed = raw.trim();
  return { raw: trimmed, parsed: extractJsonBlock(trimmed) };
}

async function handleAccount(text, history, deps) {
  const { domain } = await buildPersonaFacts();
  const { raw, parsed } = await planAccount(text, history, domain);
  if (!parsed || !parsed.ready) return { text: raw, isPlanningQuestion: true, intent: 'connector' };
  if (!deps.runtime || !deps.runtime.actionExecutor) return { text: 'Impossible de traiter cette demande (moteur non injecté).' };
  if (parsed.action === 'grant_module') {
    const out = await deps.runtime.actionExecutor.execute('GRANT_MODULE_ACCESS', { phone: parsed.phone, email: parsed.email, moduleKey: parsed.moduleKey }, {});
    if (!out.ok) return { text: `Impossible d'accorder l'accès (${out.error}).` };
    return { text: `🔓 Accès au module "${parsed.moduleKey}" accordé à ${parsed.phone || parsed.email}.`, actionLog: [{ icon: '🔓', label: `Module "${parsed.moduleKey}"`, status: 'done' }] };
  }
  const out = await deps.runtime.actionExecutor.execute('CREATE_USER_ACCOUNT', { phone: parsed.phone, email: parsed.email, studentName: parsed.studentName, sku: parsed.sku }, {});
  if (!out.ok) return { text: `Impossible de créer le compte (${out.error}).` };
  return { text: `🎓 Compte élève créé pour ${parsed.phone || parsed.email}.\n🔑 Clé d'accès : ${out.result.accessKey}`, actionLog: [{ icon: '🎓', label: `Compte créé — clé ${out.result.accessKey}`, status: 'done' }] };
}

// ---------------- Point d'entrée ----------------
async function handle({ text, history, sessionId, lastAssistantMessage }, deps) {
  const d = deps || {};
  const decision = await manualPaymentValidator.resolveAdminDecision(TENANT, text, {
    deliverToClient: d.deliverToClient || null,
    executeOptions: d.executeOptions || {},
  }).catch(() => null);
  if (decision) return { text: decision.text, actionLog: decision.actionLog || null };

  const intent = detectIntent(text, lastAssistantMessage);
  if (!intent) return null;

  const sessionKey = sessionId || 'default';
  switch (intent) {
    case 'offer': return handleOffer(text, history);
    case 'goal': return handleGoal(text, sessionKey, d);
    case 'report': return handleReport(d);
    case 'inbox': return handleInbox(text, d);
    case 'groups': return handleGroups(text, d);
    case 'grouppost': return handleGroupPost(text, history, sessionKey, d);
    case 'recurring': return handleRecurring(text, history);
    case 'crm': return handleCrm(text);
    case 'payment': return handlePayment(text, history, d);
    case 'connector': return handleConnector(text, history, d);
    default: return null;
  }
}

module.exports = { detectIntent, handle };
