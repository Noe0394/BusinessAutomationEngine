// Outils du ToolRegistry pour le CYCLE DE VIE CLIENT générique (commandes, SAV, relances, suivi), le GUIDAGE pas à pas et la LIAISON de groupes à un
// Service métier. Chacun s'appuie sur un module réel (customerLifecycle, guidedSetup, businessServices, sessions WhatsApp/Telegram) — sans
// module ou sans connexion, l'outil échoue honnêtement, jamais de faux succès. Fusionné dans TOOLS par toolsExtra.js.
const lifecycle = require('./customerLifecycle');

const fail = (code, message, retryable) => ({ ok: false, error: { code, message: message || code, retryable: !!retryable } });
const chan = (c) => String(c || 'WHATSAPP').toUpperCase();
const wrap = async (fn) => { try { return await fn(); } catch (e) { return fail(e.code || 'FAILED', e.message); } };

const REASONS = {
  AUTHORIZATION_REQUIRED: "les relances automatiques ne sont pas activées (elles attendent votre validation)",
  OPEN_SAV_CASE: 'une réclamation SAV est ouverte pour ce contact',
  ORDER_CANCELLED: 'la commande a été annulée', ORDER_NOT_DELIVERED_YET: "la commande n'est pas encore livrée",
  PAYMENT_ALREADY_DONE: 'le paiement est déjà confirmé', ALREADY_CONVERTED: 'le prospect a déjà acheté',
  RECENT_CLIENT_ACTIVITY: 'le client vient de vous écrire (je ne le dérange pas)', CONTACTED_RECENTLY: 'il a été contacté il y a moins de 12 h',
  CLIENT_ALREADY_REPLIED_AFTER_DELIVERY: 'le client a déjà répondu après la livraison', OPTED_OUT: 'le client a demandé à ne plus être contacté',
  SERVICE_INACTIVE: "le Service métier n'est pas actif", CAMPAIGN_INACTIVE: 'la campagne source est arrêtée', MAX_ATTEMPTS: "trois tentatives ont déjà échoué",
  NO_RUNTIME: "le canal d'envoi n'était pas disponible", ALL_CHECKS_PASSED: 'toutes les vérifications étaient passées',
};
const explainReason = (r) => REASONS[r] || r;

// ADAPTATEUR local-client : pas de gestionnaire multi-tenant (un seul compte local par canal) — le module de
// session existe toujours (importé), `isConnected()` reflète l'état réel au lieu d'un peek() null/existant.
function sessionOf(channel, tenant) {
  return channel === 'TELEGRAM' ? require('../lib/telegram') : require('../lib/whatsapp');
}

const TOOLS = {
  recordOrder: {
    description: 'Enregistre un dossier client (commande, réservation, inscription, prestation, devis) rattaché à un contact et éventuellement à un Service métier. Le suivi (livraison, paiement, SAV, relance) part de ce dossier.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { contactId: { type: 'string', required: true, description: 'Numéro, JID ou @username du client.' }, contactName: { type: 'string' }, channel: { type: 'string' }, serviceId: { type: 'string' }, serviceName: { type: 'string' }, items: { type: 'array', description: 'Liste {name, qty, price}.' }, total: { type: 'number' }, currency: { type: 'string' }, kind: { type: 'string', description: 'ORDER | BOOKING | ENROLLMENT | QUOTE | SERVICE' }, note: { type: 'string' } },
    async execute(a, ctx) { return wrap(async () => ({ ok: true, result: { order: await lifecycle.recordOrder(ctx.tenant, { serviceId: a.serviceId, serviceName: a.serviceName, contact: { channel: a.channel, id: a.contactId, name: a.contactName }, items: a.items, total: a.total, currency: a.currency, kind: a.kind, note: a.note, by: 'owner' }) } })); },
    async verify(r) { return { verified: !!(r && r.order && r.order.id) }; },
  },
  updateOrderStatus: {
    description: 'Change le statut d\'un dossier : PAYMENT_PENDING, PAID, IN_PROGRESS, DELIVERED (livré / prestation réalisée / accès activé), CANCELLED. DELIVERED planifie automatiquement le suivi après livraison ; PAYMENT_PENDING planifie une relance de paiement.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { orderId: { type: 'string', required: true }, status: { type: 'string', required: true }, note: { type: 'string' } },
    async execute(a, ctx) { return wrap(async () => { const r = await lifecycle.setOrderStatus(ctx.tenant, a.orderId, String(a.status).toUpperCase(), { by: 'owner', note: a.note }); return { ok: true, result: { orderId: a.orderId, status: r.order.status, changed: r.changed, followUpPlanned: !!(r.followUp && r.followUp.followUp) } }; }); },
    async verify(r, a, ctx) { const o = (await lifecycle.listOrders(ctx.tenant)).find((x) => x.id === r.orderId); return { verified: !!o && o.status === r.status }; },
  },
  listOrders: {
    description: 'Liste les dossiers clients (filtre : status, serviceId, contactId). Ex. « commandes livrées sans suivi » → status DELIVERED puis followUpCandidates.',
    permission: null, risk: 'READ', inputSchema: { status: { type: 'string' }, serviceId: { type: 'string' }, contactId: { type: 'string' } },
    async execute(a, ctx) { const l = await lifecycle.listOrders(ctx.tenant, { status: a.status && String(a.status).toUpperCase(), serviceId: a.serviceId, contactId: a.contactId }); return { ok: true, result: { count: l.length, orders: l.slice(0, 40).map((o) => ({ id: o.id, kind: o.kind, status: o.status, contact: o.contact, service: o.serviceName || o.serviceId, total: o.total, currency: o.currency, createdAt: o.createdAt, deliveredAt: o.deliveredAt || null })) } }; },
  },
  openSavCase: {
    description: 'Ouvre un dossier SAV (réclamation, problème de livraison/paiement/accès/prestation) pour un contact ; dédoublonné (une réclamation = un dossier).',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { contactId: { type: 'string', required: true }, contactName: { type: 'string' }, channel: { type: 'string' }, category: { type: 'string', description: 'produit | livraison | paiement | acces | prestation | autre' }, summary: { type: 'string', required: true }, orderId: { type: 'string' }, serviceId: { type: 'string' } },
    async execute(a, ctx) { return wrap(async () => { const r = await lifecycle.openCase(ctx.tenant, { contact: { channel: a.channel, id: a.contactId, name: a.contactName }, category: a.category, summary: a.summary, orderId: a.orderId, serviceId: a.serviceId, source: 'owner' }); return { ok: true, result: { caseId: r.case.id, created: r.created, status: r.case.status } }; }); },
  },
  resolveSavCase: {
    description: 'Clôture un dossier SAV avec la résolution apportée.', permission: null, risk: 'LOW_WRITE',
    inputSchema: { caseId: { type: 'string', required: true }, resolution: { type: 'string', required: true } },
    async execute(a, ctx) { return wrap(async () => { const c = await lifecycle.resolveCase(ctx.tenant, a.caseId, a.resolution); return { ok: true, result: { caseId: c.id, status: c.status } }; }); },
  },
  listSavCases: {
    description: 'Liste les dossiers SAV (OPEN ou RESOLVED).', permission: null, risk: 'READ', inputSchema: { status: { type: 'string' }, serviceId: { type: 'string' } },
    async execute(a, ctx) { const l = await lifecycle.listCases(ctx.tenant, { status: a.status && String(a.status).toUpperCase(), serviceId: a.serviceId }); return { ok: true, result: { count: l.length, cases: l.slice(0, 40).map((c) => ({ id: c.id, category: c.category, status: c.status, contact: c.contact, summary: c.summary, mentions: c.mentions, openedAt: c.openedAt })) } }; },
  },
  planFollowUp: {
    description: 'Planifie une relance ou un suivi (POST_DELIVERY, PAYMENT_REMINDER, PROSPECT_NUDGE, SATISFACTION, LOYALTY, SAV_CHECK). Avant CHAQUE envoi, je revérifie 10 points (statut, dernier échange, action déjà faite, conversion, activité récente, opt-out, service actif, campagne, permission) : l\'envoi peut être reporté, annulé ou transmis au propriétaire.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { kind: { type: 'string', required: true }, contactId: { type: 'string', required: true }, contactName: { type: 'string' }, channel: { type: 'string' }, orderId: { type: 'string' }, serviceId: { type: 'string' }, delayHours: { type: 'number' }, note: { type: 'string' } },
    async execute(a, ctx) { return wrap(async () => { const r = await lifecycle.planFollowUp(ctx.tenant, { kind: String(a.kind).toUpperCase(), contact: { channel: a.channel, id: a.contactId, name: a.contactName }, orderId: a.orderId, serviceId: a.serviceId, dueAt: a.delayHours != null ? Date.now() + Number(a.delayHours) * 3600000 : undefined, note: a.note, source: 'owner' }); return { ok: true, result: { followUpId: r.followUp.id, created: r.created, dueAt: r.followUp.dueAt, status: r.followUp.status } }; }); },
  },
  listFollowUps: {
    description: 'Liste les relances/suivis (PLANNED, WAITING, SENT, CANCELLED, NEEDS_OWNER) avec le motif de la dernière décision.', permission: null, risk: 'READ', inputSchema: { status: { type: 'string' }, kind: { type: 'string' } },
    async execute(a, ctx) { const l = await lifecycle.listFollowUps(ctx.tenant, { status: a.status && String(a.status).toUpperCase(), kind: a.kind && String(a.kind).toUpperCase() }); return { ok: true, result: { count: l.length, followUps: l.slice(0, 40).map((f) => ({ id: f.id, kind: f.kind, status: f.status, contact: f.contact, dueAt: f.dueAt, lastDecision: f.decisions.length ? explainReason(f.decisions[f.decisions.length - 1].reasons.slice(-1)[0]) : null })) } }; },
  },
  followUpCandidates: {
    description: 'Qui doit être relancé ou suivi MAINTENANT ? Prospects restés sans suite, relances dues, paiements en attente, commandes livrées sans suivi, relances en attente de votre décision. Uniquement des données réelles.',
    permission: null, risk: 'READ', inputSchema: {},
    async execute(a, ctx) { const c = await lifecycle.candidates(ctx.tenant); return { ok: true, result: Object.assign({ summary: { idleProspects: c.idleProspects.length, dueFollowUps: c.due.length, pendingPayments: c.pendingPayments.length, deliveredWithoutFollowUp: c.deliveredWithoutFollowUp.length, needsOwner: c.needsOwner.length } }, c) }; },
  },
  whyFollowUpNotSent: {
    description: 'Explique POURQUOI une relance n\'a pas été envoyée à un contact (nom ou identifiant) : statut, décisions successives et motifs réels.', permission: null, risk: 'READ',
    inputSchema: { contact: { type: 'string', required: true, description: 'Nom ou identifiant du contact.' } },
    async execute(a, ctx) {
      const q = String(a.contact || '').toLowerCase().trim(); if (!q) return fail('CONTACT_REQUIRED');
      const l = (await lifecycle.listFollowUps(ctx.tenant)).filter((f) => String(f.contact.name || '').toLowerCase().includes(q) || String(f.contact.id).includes(q.replace(/\D/g, '') || '§'));
      if (!l.length) return { ok: true, result: { found: 0, explanation: "Je n'ai aucune relance planifiée pour ce contact : elle n'a donc jamais été prévue (aucun dossier livré, paiement en attente ni relance créée)." } };
      return { ok: true, result: { found: l.length, followUps: l.slice(0, 5).map((f) => ({ id: f.id, kind: f.kind, status: f.status, dueAt: f.dueAt, reasons: f.decisions.map((d) => ({ action: d.action, reason: explainReason(d.reasons.slice(-1)[0]) })), cancelReason: f.cancelReason ? explainReason(f.cancelReason) : null, ownerReason: f.ownerReason ? explainReason(f.ownerReason) : null })) } };
    },
  },

  // ---------- guidage pas à pas ----------
  guideSetup: {
    description: 'GUIDAGE pas à pas d\'une mise en place (create-service, catalogue, import-contacts, create-campaign, schedule-campaign, connect-whatsapp, connect-telegram, configure-sav, configure-followups, manage-groups). action : start | status | explain | list. Chaque étape est VÉRIFIÉE dans le compte réel avant de passer à la suivante.',
    permission: null, risk: 'READ',
    inputSchema: { action: { type: 'string' }, plan: { type: 'string' }, request: { type: 'string', description: 'Texte libre pour retrouver le plan.' } },
    async execute(a, ctx) {
      const g = require('./guidedSetup'); const act = String(a.action || 'status').toLowerCase();
      if (act === 'list') return { ok: true, result: { plans: g.listPlans() } };
      const planId = a.plan || g.planForText(a.request);
      if (act === 'explain') { const e = g.explain(planId); return e ? { ok: true, result: e } : fail('UNKNOWN_PLAN', 'Dites-moi ce que vous voulez mettre en place.'); }
      if (act === 'start') { if (!planId) return fail('UNKNOWN_PLAN', 'Dites-moi ce que vous voulez mettre en place.'); const ev = await g.start(ctx.tenant, planId); return { ok: true, result: { evaluation: ev, message: g.render(ev) } }; }
      const ev = await g.status(ctx.tenant); return { ok: true, result: { evaluation: ev, message: g.render(ev) } };
    },
  },

  // ---------- auto-connaissance, rapport & amélioration ----------
  describeCapabilities: {
    description: 'Ce que Cyrus peut réellement faire pour ce compte (outils autorisés, spécialistes, Services métiers, canaux connectés, réglages, limites). Répond à « que peux-tu faire ? », « quels agents ? », « peux-tu … ? », « que ne peux-tu pas faire ? ».',
    permission: null, risk: 'READ', inputSchema: { question: { type: 'string' } },
    async execute(a, ctx) { const s = require('./cyrusSelf'); if (a.question) { const r = await s.answer(ctx.tenant, a.question); return { ok: true, result: r }; } const cap = await s.capabilities(ctx.tenant); return { ok: true, result: { domains: cap.domains.filter((d) => d.available).map((d) => d.label), agents: cap.agents, services: cap.services.map((x) => ({ name: x.name, lifecycle: x.lifecycle })), channels: cap.channels, limits: await s.limits(ctx.tenant) } }; },
  },
  activityReport: {
    description: 'RAPPORT & ACTIVITÉ : ce qui a été fait, pas fait, bloqué, à améliorer, amélioré (avec résultat), sur les données réelles. Filtres : serviceId, product, campaign, channel, group, period (ex. 7d, 24h), client, status (DONE|NOT_DONE|BLOCKED|TO_IMPROVE|IMPROVED), actionType.',
    permission: null, risk: 'READ',
    inputSchema: { serviceId: { type: 'string' }, product: { type: 'string' }, campaign: { type: 'string' }, channel: { type: 'string' }, group: { type: 'string' }, period: { type: 'string' }, client: { type: 'string' }, status: { type: 'string' }, actionType: { type: 'string' } },
    async execute(a, ctx) { const r = await require('./activityIntelligence').buildReport(ctx.tenant, a); const cut = (l) => l.slice(0, 15).map((i) => ({ title: i.title, status: i.status, reason: i.reason, how: i.how, result: i.result || null, ts: i.ts })); return { ok: true, result: { total: r.total, totals: r.totals, toDoNow: r.toDoNow, note: r.note, done: cut(r.sections.done), notDone: cut(r.sections.notDone), blocked: cut(r.sections.blocked), toImprove: cut(r.sections.toImprove), improved: cut(r.sections.improved) } }; },
  },
  improvementCycle: {
    description: "Boucle d'amélioration : observe les données réelles, diagnostique et enregistre des recommandations (action sûre automatique si autorisée / validation propriétaire / changement technique jamais automatique). action : scan (défaut) | list | apply (id) | measure (id).",
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { action: { type: 'string' }, id: { type: 'string' }, approve: { type: 'boolean', description: "true = le propriétaire valide l'application." } },
    async execute(a, ctx) {
      const ai = require('./activityIntelligence'); const act = String(a.action || 'scan').toLowerCase();
      if (act === 'list') { const d = await ai.loadImprovements(ctx.tenant); return { ok: true, result: { count: d.items.length, items: d.items.slice(0, 20).map((i) => ({ id: i.id, status: i.status, kind: i.kind, observation: i.observation, recommendation: i.recommendation, result: i.result || null })) } }; }
      if (act === 'apply') { const r = await ai.apply(ctx.tenant, a.id, { approvedByOwner: a.approve === true || a.approve === 'true' }); return r.ok ? { ok: true, result: { id: a.id, changed: r.changed, status: r.item.status } } : fail(r.error, r.message); }
      if (act === 'measure') { const r = await ai.measure(ctx.tenant, a.id); return r.ok ? { ok: true, result: r.item.result } : fail(r.error); }
      const r = await ai.refresh(ctx.tenant); return { ok: true, result: { newRecommendations: r.created.length, open: r.open.map((i) => ({ id: i.id, kind: i.kind, observation: i.observation, diagnostic: i.diagnostic, recommendation: i.recommendation })) } };
    },
  },
  analyzeActivity: {
    description: "Fait analyser l'activité réelle par les spécialistes (analyse de conversations, commercial, SAV, stratégie, marketing) via l'Orchestrateur : uniquement des données réelles ; si l'analyse est indisponible, le dit.",
    permission: null, risk: 'READ', inputSchema: { serviceId: { type: 'string' }, period: { type: 'string' }, channel: { type: 'string' } },
    async execute(a, ctx) { const r = await require('./activityIntelligence').analyzeWithAgents(ctx.tenant, a); return { ok: true, result: r }; },
  },

  // ---------- groupes ↔ Service métier ----------
  linkServiceGroup: {
    description: 'Lie un GROUPE (WhatsApp/Telegram) à un Service métier quelconque, APRÈS vérification réelle : service existant, compte connecté, groupe trouvé, statut administrateur, autorisation. Rien n\'est lié si une vérification échoue.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { service: { type: 'string', required: true, description: 'Nom ou identifiant du Service métier.' }, channel: { type: 'string' }, groupName: { type: 'string' }, groupId: { type: 'string' } },
    async execute(a, ctx) {
      const bs = require('./businessServices'); const channel = chan(a.channel);
      const checks = { service: false, account: false, group: false, admin: false, authorization: true };
      const list = await bs.list(ctx.tenant); const q = String(a.service || '').toLowerCase();
      const svc = list.find((s) => s.id === a.service) || list.find((s) => String(s.name).toLowerCase() === q) || list.find((s) => String(s.name).toLowerCase().includes(q));
      if (!svc) return { ok: false, error: { code: 'SERVICE_NOT_FOUND', message: `Je ne trouve pas de Service métier « ${a.service} ».` }, checks };
      checks.service = true;
      const session = sessionOf(channel, ctx.tenant);
      checks.account = !!(session && typeof session.isConnected === 'function' && session.isConnected());
      if (!checks.account) return { ok: false, error: { code: 'ACCOUNT_NOT_CONNECTED', message: `Votre compte ${channel} n'est pas connecté : je ne peux pas vérifier le groupe.` }, checks };
      const groups = typeof session.getGroupsSummary === 'function' ? await session.getGroupsSummary() : [];
      let hit = null;
      if (a.groupId) hit = groups.find((g) => String(g.id) === String(a.groupId));
      else if (a.groupName) { const gq = String(a.groupName).toLowerCase(); const m = groups.filter((g) => String(g.name).toLowerCase() === gq); const p = m.length ? m : groups.filter((g) => String(g.name).toLowerCase().includes(gq)); if (p.length > 1) return { ok: false, error: { code: 'GROUP_AMBIGUOUS', message: 'Plusieurs groupes correspondent : précisez le nom complet.' }, checks }; hit = p[0]; }
      if (!hit) return { ok: false, error: { code: 'GROUP_NOT_FOUND', message: 'Aucun groupe de ce nom sur le compte connecté.' }, checks };
      checks.group = true; checks.admin = hit.isAdmin === true;
      if (!checks.admin) return { ok: false, error: { code: 'NOT_ADMIN', message: `Je ne suis pas administrateur du groupe « ${hit.name} » : je ne le lie pas. Nommez-moi admin puis redemandez.` }, checks };
      const groupsList = (svc.groups || []).filter((g) => !(g.channel === channel && String(g.id) === String(hit.id)));
      groupsList.push({ channel, id: String(hit.id), name: hit.name, linkedAt: Date.now(), verified: { admin: true, connected: true } });
      await bs.update(ctx.tenant, svc.id, { groups: groupsList });
      return { ok: true, result: { serviceId: svc.id, service: svc.name, group: { channel, id: String(hit.id), name: hit.name }, checks } };
    },
    async verify(r, a, ctx) { const s = await require('./businessServices').get(ctx.tenant, r.serviceId); return { verified: !!(s && (s.groups || []).some((g) => String(g.id) === String(r.group.id))) }; },
  },
  unlinkServiceGroup: {
    description: 'Retire la liaison d\'un groupe avec un Service métier.', permission: null, risk: 'LOW_WRITE',
    inputSchema: { service: { type: 'string', required: true }, groupId: { type: 'string', required: true } },
    async execute(a, ctx) { const bs = require('./businessServices'); const list = await bs.list(ctx.tenant); const svc = list.find((s) => s.id === a.service || String(s.name).toLowerCase() === String(a.service).toLowerCase()); if (!svc) return fail('SERVICE_NOT_FOUND'); await bs.update(ctx.tenant, svc.id, { groups: (svc.groups || []).filter((g) => String(g.id) !== String(a.groupId)) }); return { ok: true, result: { serviceId: svc.id, removed: String(a.groupId) } }; },
  },
};

module.exports = { TOOLS, explainReason, REASONS };
