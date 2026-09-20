// CAMPAGNES DE GROUPES — ai-engine/groupCampaigns.js
// ---------------------------------------------------------------------------
// Transforme les groupes WhatsApp ADMINISTRÉS en points d'entrée commerciaux, en réutilisant les moteurs existants :
//   Service métier (offre, prix, paiement) + scheduler (tick d'une minute d'index.js) + envoi aux groupes (runtime.sendToGroups)
//   + Identity Resolver + pendingActions/manualPaymentValidator (paiement + confirmation du propriétaire) + alertes.
//
// Chaîne : résoudre les groupes (VRAIS noms, compte réellement administrateur) -> liste FIGÉE -> envois programmés (1 fois par
// créneau et par jour, arrêt automatique) -> détection d'intérêt d'un membre -> réponse en privé avec l'offre RÉELLE du service
// (prix + instructions de paiement configurés) -> preuve de paiement rattachée à l'expéditeur RÉEL (contactId exact) ->
// notification du propriétaire (pendingActionId) -> workflow de paiement existant. Rien n'est inventé : sans prix ou sans
// numéro de dépôt configuré, on le dit et on prévient le propriétaire.

const businessServices = require('./businessServices');
const adCampaigns = require('./adCampaigns');
const conversationState = require('./jarvis/conversationState');
const intentClassifier = require('./jarvis/intentClassifier');
const storageAdapter = require('./storageAdapter');
const alertCenter = require('./alertCenter');
const contactIdentity = require('./contactIdentity');
const recurringTasks = require('../queues/recurringTasks');
const { norm } = intentClassifier;

const NS = 'group_campaigns';
const LEADS_NS = 'group_leads';
const LATE_MAX_MIN = 90;              // un créneau raté de plus de 90 min n'est pas envoyé (pas de message du matin à 18h)
const GRACE_MS = 3 * 24 * 3600 * 1000; // après la fin, les membres qui répondent sont encore servis 3 jours
const MAX_EVENTS = 400;
const INTEREST_INTENTS = new Set(['INTEREST', 'REQUEST_INFORMATION', 'REQUEST_MORE_INFORMATION', 'PURCHASE_INTENT', 'PAYMENT_INTENT']);

const sanitize = (t) => String(t || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const locks = new Map();
function withLock(tenant, fn) {
  const key = sanitize(tenant);
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}
const loadDoc = (t) => storageAdapter.get(NS, sanitize(t), { tenant: sanitize(t), campaigns: {} });
const saveDoc = (t, d) => storageAdapter.set(NS, sanitize(t), d);
const loadLeads = (t) => storageAdapter.get(LEADS_NS, sanitize(t), { tenant: sanitize(t), leads: {}, processed: [] });
const saveLeads = (t, d) => { d.processed = (d.processed || []).slice(-2000); return storageAdapter.set(LEADS_NS, sanitize(t), d); };

function pushEvent(c, type, detail) {
  c.events = (c.events || []).concat([{ at: Date.now(), type, detail: detail || null }]).slice(-MAX_EVENTS);
}

// --------------------------------------------------------------------------------------------- 1. résoudre les groupes
// Groupes dont le NOM contient le mot-clé (insensible à la casse/aux accents) ET où le compte connecté est RÉELLEMENT admin.
async function resolveTargets(tenant, keyword, runtime, channel) {
  const ch = String(channel || 'WHATSAPP').toUpperCase();
  if (!runtime || typeof runtime.listGroups !== 'function') return { ok: false, error: 'RUNTIME_MISSING' };
  const r = await runtime.listGroups({ channel: ch, tenantId: tenant });
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'LIST_FAILED', connected: r && r.connected, paired: r && r.paired };
  if (r.connected === false) return { ok: false, error: 'NOT_CONNECTED', connected: false, paired: r.paired };
  const kw = norm(keyword || '');
  if (!kw) return { ok: false, error: 'KEYWORD_REQUIRED' };
  const all = r.groups || [];
  const named = all.filter((g) => norm(g.name || '').includes(kw));
  const groups = named.filter((g) => g.isAdmin === true).map((g) => ({ id: g.id, name: g.name, size: g.size || 0 }));
  const notAdmin = named.filter((g) => g.isAdmin !== true).map((g) => g.name);
  return { ok: true, groups, notAdmin, total: all.length, matched: named.length };
}

// --------------------------------------------------------------------------------------------- 2. création / gestion
function nextEndAt(startAt, days) { return startAt + days * 24 * 3600 * 1000; }

// spec : { name?, keyword, groups:[{id,name}], serviceName?/serviceId?/productName?, courseId?, days, slots:[{time,message,label?}], goal? , createService? }
async function create(tenant, spec) {
  const s = spec || {};
  if (!s.keyword) return { ok: false, error: { code: 'KEYWORD_REQUIRED', message: 'Quel mot-clé doit contenir le nom des groupes ?' } };
  if (!Array.isArray(s.groups) || !s.groups.length) return { ok: false, error: { code: 'NO_ADMIN_GROUP', message: 'Aucun groupe administré ne correspond.' } };
  if (!Array.isArray(s.slots) || !s.slots.length) return { ok: false, error: { code: 'SLOTS_REQUIRED', message: 'À quelles heures envoyer les messages ?' } };
  if (s.slots.some((x) => !String(x.message || '').trim())) return { ok: false, error: { code: 'MESSAGE_REQUIRED', message: 'Un message est requis pour chaque horaire.' } };
  const days = Math.max(1, Math.min(365, parseInt(s.days, 10) || 1));
  const res = await adCampaigns.resolveService(tenant, { serviceId: s.serviceId, serviceName: s.serviceName, productName: s.productName, createService: s.createService });
  if (res.needsService) return { ok: false, error: { code: 'SERVICE_REQUIRED', message: 'Quel service métier concerne cette campagne ?', choices: res.choices } };
  const svc = res.service;
  const now = s.now || Date.now(); // `now` : injection de l'horloge (tests)
  const lp = recurringTasks.localParts(new Date(now));
  const camp = {
    id: uid('gcp'), name: String(s.name || `Groupes « ${s.keyword} »`).slice(0, 160), channel: 'WHATSAPP', keyword: String(s.keyword),
    groups: s.groups.map((g) => ({ id: g.id, name: g.name })), // liste EXACTE figée à la création
    serviceId: svc.id, serviceName: svc.name, productName: s.productName || svc.name, courseId: s.courseId || null,
    startAt: now, endAt: nextEndAt(now, days), days, createdLocal: { dateStr: lp.dateStr, minutes: lp.minutes },
    slots: s.slots.map((x) => ({ time: x.time, label: x.label || null, message: String(x.message) })),
    goal: s.goal ? Object.assign({ currency: 'FCFA', period: null, setAt: now }, s.goal) : null,
    status: 'active', runs: {}, sends: [], events: [], createdAt: now, updatedAt: now,
  };
  pushEvent(camp, 'CREATED', { groups: camp.groups.map((g) => g.name), slots: camp.slots.map((x) => x.time), days });
  await withLock(tenant, async () => { const doc = await loadDoc(tenant); doc.campaigns[camp.id] = camp; await saveDoc(tenant, doc); });
  return { ok: true, result: { campaignId: camp.id, campaign: camp, serviceCreated: !!res.created } };
}

async function list(tenant) { return Object.values((await loadDoc(tenant)).campaigns).sort((a, b) => b.createdAt - a.createdAt); }
async function get(tenant, id) { return (await loadDoc(tenant)).campaigns[id] || null; }

async function findCampaign(tenant, ref) {
  const all = await list(tenant);
  if (!all.length) return { none: true };
  if (ref) {
    const n = norm(ref);
    const hits = all.filter((c) => c.id === ref || norm(c.name).includes(n) || norm(c.keyword) === n);
    if (hits.length === 1) return { campaign: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
    return { notFound: true };
  }
  const active = all.filter((c) => c.status === 'active');
  if (active.length === 1) return { campaign: active[0] };
  if (active.length > 1) return { ambiguous: active };
  return { campaign: all[0] };
}

async function stop(tenant, ref) {
  const f = await findCampaign(tenant, ref);
  if (f.none || f.notFound) return { ok: false, error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campagne introuvable.' } };
  if (f.ambiguous) return { ok: false, error: { code: 'AMBIGUOUS_CAMPAIGN', message: 'Plusieurs campagnes correspondent.', choices: f.ambiguous.map((c) => c.name) } };
  return withLock(tenant, async () => {
    const doc = await loadDoc(tenant); const c = doc.campaigns[f.campaign.id];
    c.status = 'stopped'; c.updatedAt = Date.now(); pushEvent(c, 'STOPPED_BY_OWNER');
    await saveDoc(tenant, doc);
    return { ok: true, result: { campaignId: c.id, name: c.name, status: c.status } };
  });
}

async function setGoal(tenant, ref, goal) {
  const f = await findCampaign(tenant, ref);
  if (f.none || f.notFound) return { ok: false, error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Aucune campagne de groupes à laquelle rattacher cet objectif.' } };
  if (f.ambiguous) return { ok: false, error: { code: 'AMBIGUOUS_CAMPAIGN', message: 'Plusieurs campagnes actives : précise laquelle.', choices: f.ambiguous.map((c) => c.name) } };
  return withLock(tenant, async () => {
    const doc = await loadDoc(tenant); const c = doc.campaigns[f.campaign.id];
    c.goal = Object.assign({ currency: 'FCFA', period: null }, goal, { setAt: Date.now() });
    c.updatedAt = Date.now(); pushEvent(c, 'GOAL_SET', c.goal);
    await saveDoc(tenant, doc);
    return { ok: true, result: { campaignId: c.id, name: c.name, goal: c.goal } };
  });
}

// --------------------------------------------------------------------------------------------- 3. scheduler (tick 1 min)
// deps : { listGroups(payload), sendToGroups(payload) } (runtime). Retourne un résumé des actions du tick.
async function tick(tenant, deps, nowDate) {
  const now = nowDate || new Date();
  const nowMs = now.getTime();
  const lp = recurringTasks.localParts(now);
  const summary = [];
  const doc0 = await loadDoc(tenant);
  for (const c0 of Object.values(doc0.campaigns)) {
    if (c0.status !== 'active') continue;
    // Arrêt automatique à la fin de la période.
    if (nowMs > c0.endAt) {
      await withLock(tenant, async () => {
        const doc = await loadDoc(tenant); const c = doc.campaigns[c0.id];
        if (c.status !== 'active') return;
        c.status = 'completed'; c.updatedAt = nowMs; pushEvent(c, 'COMPLETED', { sent: c.sends.filter((x) => x.ok).length });
        await saveDoc(tenant, doc);
      });
      const done = await get(tenant, c0.id);
      await alertCenter.raise(tenant, { type: 'CAMPAIGN_FINISHED', title: `Campagne « ${c0.name} » terminée`, body: `${done.sends.filter((x) => x.ok).length} message(s) envoyé(s) dans ${done.groups.length} groupe(s). Les membres intéressés restent servis 3 jours.`, notify: true, idempotencyKey: `gcdone:${c0.id}` }).catch(() => {});
      summary.push({ campaignId: c0.id, completed: true });
      continue;
    }
    for (const slot of c0.slots) {
      const slotKey = `${lp.dateStr}|${slot.time}`;
      if (c0.runs[slotKey]) continue;
      const [hh, mm] = slot.time.split(':').map((x) => parseInt(x, 10));
      const slotMin = hh * 60 + mm;
      if (lp.minutes < slotMin) continue;
      // créneaux du jour de création déjà passés à la création : jamais envoyés rétroactivement
      if (c0.createdLocal && c0.createdLocal.dateStr === lp.dateStr && slotMin < c0.createdLocal.minutes) continue;
      if (lp.minutes - slotMin > LATE_MAX_MIN) {
        await withLock(tenant, async () => { const doc = await loadDoc(tenant); const c = doc.campaigns[c0.id]; if (!c.runs[slotKey]) { c.runs[slotKey] = { status: 'missed', at: nowMs }; pushEvent(c, 'SLOT_MISSED', { slotKey }); await saveDoc(tenant, doc); } });
        summary.push({ campaignId: c0.id, slotKey, status: 'missed' });
        continue;
      }
      // Vérification RÉELLE au moment de l'envoi : compte connecté et toujours administrateur de chaque groupe figé.
      const lg = await deps.listGroups({ channel: 'WHATSAPP', tenantId: tenant });
      if (!lg || lg.ok === false || lg.connected === false) { summary.push({ campaignId: c0.id, slotKey, status: 'deferred', reason: (lg && lg.error) || 'NOT_CONNECTED' }); continue; } // réessai au tick suivant
      const byId = new Map((lg.groups || []).map((g) => [String(g.id), g]));
      const eligible = c0.groups.filter((g) => byId.get(String(g.id)) && byId.get(String(g.id)).isAdmin === true);
      const skipped = c0.groups.filter((g) => !eligible.includes(g)).map((g) => ({ name: g.name, reason: byId.get(String(g.id)) ? 'NOT_ADMIN' : 'NOT_IN_GROUP' }));
      // Claim AVANT l'envoi : jamais deux envois pour le même créneau, même en cas de redémarrage/retry.
      const claimed = await withLock(tenant, async () => {
        const doc = await loadDoc(tenant); const c = doc.campaigns[c0.id];
        if (c.runs[slotKey]) return false;
        c.runs[slotKey] = { status: 'running', at: nowMs }; pushEvent(c, 'SLOT_STARTED', { slotKey, groups: eligible.length, skipped }); await saveDoc(tenant, doc);
        return true;
      });
      if (!claimed) continue;
      let out;
      try { out = eligible.length ? await deps.sendToGroups({ channel: 'WHATSAPP', tenantId: tenant, groupIds: eligible.map((g) => g.id), text: slot.message }) : { ok: false, error: 'NO_ELIGIBLE_GROUP', results: [] }; }
      catch (e) { out = { ok: false, error: String((e && e.message) || e), results: [] }; }
      const results = Array.isArray(out.results) ? out.results : [];
      await withLock(tenant, async () => {
        const doc = await loadDoc(tenant); const c = doc.campaigns[c0.id];
        const sent = results.filter((x) => x.ok).length; const failed = results.length - sent;
        for (const r of results) c.sends.push({ slotKey, time: slot.time, groupId: r.id, groupName: r.name, ok: !!r.ok, error: r.error || null, at: Date.now() });
        for (const sk of skipped) c.sends.push({ slotKey, time: slot.time, groupName: sk.name, ok: false, error: sk.reason, at: Date.now() });
        c.runs[slotKey] = { status: sent && !failed && !skipped.length ? 'done' : (sent ? 'partial' : 'failed'), at: nowMs, sent, failed, skipped: skipped.length, error: sent ? null : (out.error || null) };
        pushEvent(c, 'SLOT_FINISHED', c.runs[slotKey]);
        c.sends = c.sends.slice(-2000);
        await saveDoc(tenant, doc);
      });
      const run = (await get(tenant, c0.id)).runs[slotKey];
      if (run.status !== 'done') {
        await alertCenter.raise(tenant, { type: 'IMPORTANT_ERROR', title: `Campagne « ${c0.name} » : envoi ${slot.time} ${run.status === 'failed' ? 'échoué' : 'partiel'}`, body: `${run.sent} groupe(s) envoyé(s), ${run.failed} échec(s), ${run.skipped} ignoré(s)${run.error ? ` (${run.error})` : ''}.`, notify: true, idempotencyKey: `gcslot:${c0.id}:${slotKey}` }).catch(() => {});
      }
      summary.push({ campaignId: c0.id, slotKey, status: run.status, sent: run.sent, failed: run.failed });
    }
  }
  return summary;
}

async function tickAll(deps, nowDate) {
  const out = [];
  for (const id of storageAdapter.listIds(NS)) {
    try { const r = await tick(id, deps, nowDate); if (r.length) out.push({ tenant: id, actions: r }); } catch (e) { console.error(`groupCampaigns.tick (tenant "${id}") :`, e.message); }
  }
  return out;
}

// --------------------------------------------------------------------------------------------- 4. intérêt d'un membre
function isInterest(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const cls = intentClassifier.classify(raw, {});
  if (cls.flags && cls.flags.negative) return false;
  if (cls.intents.some((i) => INTEREST_INTENTS.has(i))) return true;
  const n = norm(raw);
  return /(?:^|\s)(?:interess\w*|ca m interesse|je prends|je veux|ca m interesse|comment (?:faire|participer|commander|payer|s inscrire)|moi aussi|prix|tarif|combien|dispo(?:nible)?)(?=\s|$|[?!])/.test(n) && n.length <= 200;
}

function findService(svcs, id) { return (svcs || []).find((s) => s.id === id) || null; }

// Message d'offre composé UNIQUEMENT à partir des données réelles du Service métier.
function buildOfferMessage(service, camp, firstName) {
  const c = (service && service.commercial) || {};
  const cur = c.currency || 'FCFA';
  const product = camp.productName || (service && service.name) || 'notre offre';
  const prod = (service && service.products || []).find((p) => p && norm(p.name || '') === norm(product));
  const price = prod && prod.price != null ? prod.price : c.price;
  const lines = [`Bonjour${firstName ? ' ' + firstName : ''} ! Merci pour votre intérêt pour « ${product} ». 🙌`];
  if (c.description) lines.push(c.description);
  if (price != null) lines.push(`💰 Prix : ${c.promoPrice != null ? `${c.promoPrice} ${cur} (au lieu de ${price} ${cur})` : `${price} ${cur}`}`);
  if (c.advantages) lines.push(c.advantages);
  const missing = [];
  if (price == null) missing.push('prix');
  if (c.paymentTerms) lines.push(`📲 Pour payer : ${c.paymentTerms}`); else missing.push('numéro/instructions de dépôt');
  lines.push('📸 Une fois le paiement effectué, envoyez-moi ici la capture de votre preuve de paiement, avec l\'adresse email à utiliser pour votre accès.');
  return { text: lines.join('\n'), missing };
}

// input : { tenantId, groupJid, senderJid, identity (expéditeur RÉEL), text, messageId }
// deps  : { send(to, text) -> {status,error?} }
async function handleGroupMessage(input, deps) {
  const { tenantId, groupJid, identity, text, messageId } = input;
  const d = deps || {};
  const all = await list(tenantId);
  const nowMs = input.now || Date.now();
  const relevant = all.filter((c) => c.groups.some((g) => String(g.id) === String(groupJid)) && (c.status === 'active' || (c.endAt + GRACE_MS > nowMs && c.status !== 'stopped')));
  if (!relevant.length) return { handled: false, reason: 'NOT_A_CAMPAIGN_GROUP' };
  if (!identity || !identity.contactId) return { handled: false, reason: 'SENDER_UNIDENTIFIED' };
  if (!isInterest(text)) return { handled: false, reason: 'NO_INTEREST' };
  // Plusieurs campagnes pour ce groupe : la plus récente (les critères sont les mêmes : le groupe).
  const camp = relevant.sort((a, b) => b.createdAt - a.createdAt)[0];
  const leadKey = `${camp.id}|${identity.contactId}`;

  return withLock(tenantId, async () => {
    const ld = await loadLeads(tenantId);
    if (messageId && ld.processed.includes(String(messageId))) return { handled: true, reason: 'DUPLICATE_DELIVERY' };
    if (messageId) ld.processed.push(String(messageId));
    if (ld.leads[leadKey] && ld.leads[leadKey].status !== 'DM_FAILED') { await saveLeads(tenantId, ld); return { handled: true, reason: 'ALREADY_ANSWERED', leadKey }; }
    const svc = findService(await businessServices.list(tenantId), camp.serviceId);
    const offer = buildOfferMessage(svc, camp, identity.displayName);
    const groupName = (camp.groups.find((g) => String(g.id) === String(groupJid)) || {}).name || null;
    const lead = Object.assign(ld.leads[leadKey] || {}, {
      leadKey, campaignId: camp.id, contactId: identity.contactId, contactLabel: identity.label, phoneNumber: identity.phoneNumber || null,
      senderJid: input.senderJid || null, groupId: groupJid, groupName, serviceId: camp.serviceId, productName: camp.productName, courseId: camp.courseId,
      interestAt: ld.leads[leadKey] ? ld.leads[leadKey].interestAt : nowMs, interestText: String(text).slice(0, 300), interestMessageId: messageId || null,
      paymentStatus: 'NONE', attempts: ((ld.leads[leadKey] && ld.leads[leadKey].attempts) || 0) + 1,
    });
    let out;
    try { out = await d.send(input.senderJid, offer.text); } catch (e) { out = { status: 'FAILED', error: e.message }; }
    const ok = !!(out && out.status === 'SUCCESS');
    lead.status = ok ? 'INSTRUCTIONS_SENT' : 'DM_FAILED'; lead.instructionsSentAt = ok ? Date.now() : null; lead.confirmationId = (out && out.confirmationId) || null; lead.error = ok ? null : ((out && (out.error || out.status)) || 'SEND_FAILED');
    ld.leads[leadKey] = lead;
    await saveLeads(tenantId, ld);
    // Mémoire de conversation privée : origine + service + produit (retrouvée si le membre écrit depuis un autre identifiant).
    if (input.senderJid) await stampConversation(tenantId, input.senderJid, lead).catch(() => {});
    const doc = await loadDoc(tenantId); const c = doc.campaigns[camp.id];
    if (c) { pushEvent(c, ok ? 'LEAD_ANSWERED' : 'LEAD_DM_FAILED', { contact: identity.label, group: groupName, error: lead.error }); await saveDoc(tenantId, doc); }
    if (!ok) {
      await alertCenter.raise(tenantId, { type: 'DECISION_REQUIRED', title: `${identity.label} s'intéresse à « ${camp.productName} » mais je n'ai pas pu lui écrire en privé`, body: `Groupe : ${groupName}. Erreur : ${lead.error}. Écris-lui directement.`, contact: identity, idempotencyKey: `gcdmfail:${leadKey}:${lead.attempts}` }).catch(() => {});
      return { handled: true, reason: 'DM_FAILED', leadKey, error: lead.error };
    }
    await alertCenter.raise(tenantId, { type: 'NEW_PROSPECT', title: `${identity.label} s'intéresse à « ${camp.productName} » (groupe ${groupName})`, body: `Offre et instructions de paiement envoyées en privé.${offer.missing.length ? ` ⚠️ Non configuré dans le service : ${offer.missing.join(', ')}.` : ''}`, contact: identity, idempotencyKey: `gclead:${leadKey}` }).catch(() => {});
    if (offer.missing.length) {
      await alertCenter.raise(tenantId, { type: 'ACTION_NEEDS_CONFIRMATION', title: `Service « ${camp.serviceName} » incomplet`, body: `Le prospect ${identity.label} a reçu l'offre sans : ${offer.missing.join(', ')}. Renseigne ces informations dans le Service métier.`, notify: true, idempotencyKey: `gcmissing:${camp.id}:${offer.missing.join('|')}` }).catch(() => {});
    }
    return { handled: true, reason: 'OFFER_SENT', leadKey, missing: offer.missing, text: offer.text };
  });
}

async function stampConversation(tenantId, jid, lead) {
  const st = await conversationState.get(tenantId, 'WHATSAPP', jid);
  st.groupOrigin = { campaignId: lead.campaignId, groupId: lead.groupId, groupName: lead.groupName, serviceId: lead.serviceId, productName: lead.productName, contactId: lead.contactId, at: Date.now() };
  st.memory = st.memory || {}; st.memory.subject = lead.productName || st.memory.subject || null;
  if (st.state === 'NEW') st.state = 'INFORMATION';
  st.lastReplyTs = Date.now();
  await conversationState.save(st);
}

// Le membre écrit en privé (avec un autre identifiant éventuellement) : on retrouve son origine par contactId EXACT.
async function leadForContact(tenantId, contactId) {
  if (!contactId) return null;
  const ld = await loadLeads(tenantId);
  const mine = Object.values(ld.leads).filter((l) => l.contactId === contactId);
  return mine.sort((a, b) => (b.interestAt || 0) - (a.interestAt || 0))[0] || null;
}

async function ensureConversationOrigin(tenantId, jid, identity) {
  const lead = await leadForContact(tenantId, identity && identity.contactId);
  if (!lead) return null;
  const st = await conversationState.get(tenantId, 'WHATSAPP', jid);
  if (!st.groupOrigin || st.groupOrigin.campaignId !== lead.campaignId) await stampConversation(tenantId, jid, lead);
  return lead;
}

// --------------------------------------------------------------------------------------------- 5. preuve de paiement d'un prospect
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PENDING_PROOF_TTL = 24 * 3600 * 1000;

// input : { tenantId, contactId, identity, jidForReply, text, hasAttachment, messageId }
// deps  : { send(to, text), registerProof(args) }
// Retourne { handled, reason }. Ne fait AUCUNE correspondance approximative : le lead est retrouvé par contactId exact.
async function handleLeadProof(input, deps) {
  const { tenantId, identity, text, hasAttachment, messageId } = input;
  const d = deps || {};
  const lead = await leadForContact(tenantId, identity && identity.contactId);
  if (!lead || !['INSTRUCTIONS_SENT', 'PROOF_PENDING_EMAIL'].includes(lead.status)) return { handled: false, reason: 'NO_OPEN_LEAD' };
  const email = (String(text || '').match(EMAIL_RE) || [null])[0];
  const to = input.jidForReply;

  return withLock(tenantId, async () => {
    const ld = await loadLeads(tenantId);
    const cur = ld.leads[lead.leadKey];
    if (messageId && ld.processed.includes(`proof:${messageId}`)) return { handled: true, reason: 'DUPLICATE_DELIVERY' };
    if (messageId) ld.processed.push(`proof:${messageId}`);

    // Capture sans email : on la mémorise (id du message) et on demande l'email — rien n'est rattaché au hasard.
    if (hasAttachment && !email) {
      cur.pendingProof = { messageId: messageId || null, at: Date.now() }; cur.status = 'PROOF_PENDING_EMAIL';
      await saveLeads(tenantId, ld);
      if (d.send && to) await d.send(to, 'Merci, capture bien reçue ! 🙏 Envoyez-moi maintenant l\'adresse email à utiliser pour créer votre accès.');
      return { handled: true, reason: 'PROOF_WAITING_EMAIL' };
    }
    const pp = cur.pendingProof && Date.now() - cur.pendingProof.at < PENDING_PROOF_TTL ? cur.pendingProof : null;
    if (!(hasAttachment && email) && !(email && pp)) { await saveLeads(tenantId, ld); return { handled: false, reason: 'NOT_A_PROOF' }; }

    const proofMessageId = hasAttachment ? messageId : (pp && pp.messageId);
    const reg = await d.registerProof({
      tenantId, channel: 'WHATSAPP', from: to, text: `${text || ''} (preuve)`, hasAttachment: true, courseId: cur.courseId || undefined,
      product: cur.productName, proofMessageId, proofMediaId: proofMessageId, identity,
      origin: { campaignId: cur.campaignId, groupId: cur.groupId, groupName: cur.groupName, serviceId: cur.serviceId, productName: cur.productName, leadKey: cur.leadKey },
    });
    cur.status = reg && reg.record ? 'PAYMENT_PENDING_OWNER' : cur.status;
    cur.paymentStatus = reg && reg.record ? 'PENDING' : cur.paymentStatus;
    cur.pendingActionId = (reg && reg.pendingActionId) || cur.pendingActionId || null;
    cur.proofMessageId = proofMessageId || null; cur.pendingProof = null;
    await saveLeads(tenantId, ld);
    if (d.send && to && reg && reg.ack) await d.send(to, reg.ack);
    return { handled: true, reason: 'PROOF_REGISTERED', pendingActionId: cur.pendingActionId, duplicate: !!(reg && reg.duplicate) };
  });
}

// Appelé par manualPaymentValidator quand le propriétaire tranche : met à jour le lead et les résultats de la campagne.
async function recordPaymentOutcome(tenantId, record, outcome) {
  const o = record && record.origin;
  if (!o || !o.leadKey) return null;
  return withLock(tenantId, async () => {
    const ld = await loadLeads(tenantId); const lead = ld.leads[o.leadKey]; if (!lead) return null;
    lead.paymentStatus = outcome; lead.status = outcome === 'CONFIRMED' ? 'CONVERTED' : (outcome === 'REJECTED' ? 'INSTRUCTIONS_SENT' : lead.status);
    if (outcome === 'CONFIRMED') { lead.convertedAt = Date.now(); lead.amount = amountOf(record); }
    await saveLeads(tenantId, ld);
    const doc = await loadDoc(tenantId); const c = doc.campaigns[lead.campaignId];
    if (c) { pushEvent(c, `PAYMENT_${outcome}`, { contact: lead.contactLabel, amount: lead.amount || null }); await saveDoc(tenantId, doc); }
    return lead;
  });
}

function numberFrom(str) { const m = String(str || '').match(/[\d][\d\s.,]*/); return m ? require('./groupCampaignParser').parseAmount(m[0]) : null; }
function amountOf(record) {
  const declared = numberFrom(record && record.declaredAmount);
  return declared != null ? { value: declared, source: 'declared' } : null;
}

// --------------------------------------------------------------------------------------------- 6. contexte + rapport
async function continuationContext(tenantId, channel, from) {
  let st; try { st = await conversationState.get(tenantId, channel, from); } catch (e) { return ''; }
  if (!st || !st.groupOrigin) return '';
  const o = st.groupOrigin;
  const lead = await leadForContact(tenantId, o.contactId);
  const lines = [`Ce contact vient du groupe WhatsApp « ${o.groupName} » (campagne de groupes, produit/service : ${o.productName || 'non précisé'}). Il s'est montré intéressé et a déjà reçu l'offre et les instructions de paiement en privé — ne les répète pas en entier, réponds à ses questions avec les seules informations réelles du service.`];
  if (lead) {
    const label = { INSTRUCTIONS_SENT: 'instructions de paiement envoyées, en attente de sa preuve', PROOF_PENDING_EMAIL: 'capture reçue, email attendu', PAYMENT_PENDING_OWNER: 'preuve reçue, en attente de validation du propriétaire (ne promets aucune activation)', CONVERTED: 'paiement confirmé et accès créé', DM_FAILED: 'premier message privé non envoyé' }[lead.status];
    if (label) lines.push(`État du paiement : ${label}.`);
    if (lead.proofMessageId) lines.push(`Une preuve de paiement a été reçue (message ${lead.proofMessageId}).`);
  }
  return lines.join('\n');
}

async function report(tenant, ref) {
  const f = await findCampaign(tenant, ref);
  if (f.none || f.notFound) return { ok: false, error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Aucune campagne de groupes.' } };
  if (f.ambiguous) return { ok: false, error: { code: 'AMBIGUOUS_CAMPAIGN', message: 'Plusieurs campagnes : précise laquelle.', choices: f.ambiguous.map((c) => c.name) } };
  const c = f.campaign;
  const ld = await loadLeads(tenant);
  const leads = Object.values(ld.leads).filter((l) => l.campaignId === c.id);
  const sends = c.sends || [];
  const converted = leads.filter((l) => l.paymentStatus === 'CONFIRMED');
  const knownAmounts = converted.filter((l) => l.amount && l.amount.value != null);
  const confirmedTotal = knownAmounts.reduce((s, l) => s + l.amount.value, 0);
  const goal = c.goal || null;
  return { ok: true, result: {
    campaignId: c.id, name: c.name, status: c.status, keyword: c.keyword, groups: c.groups.map((g) => g.name), startAt: c.startAt, endAt: c.endAt,
    slots: c.slots.map((s) => s.time), messagesSent: sends.filter((x) => x.ok).length, messagesFailed: sends.filter((x) => !x.ok).length,
    slotRuns: Object.entries(c.runs).map(([k, v]) => ({ slot: k, status: v.status, sent: v.sent || 0, failed: v.failed || 0 })),
    leads: leads.length, offersSent: leads.filter((l) => l.instructionsSentAt).length,
    proofsReceived: leads.filter((l) => l.proofMessageId).length, paymentsPending: leads.filter((l) => l.paymentStatus === 'PENDING').length,
    paymentsConfirmed: converted.length, confirmedAmount: confirmedTotal, confirmedAmountKnownFor: knownAmounts.length,
    goal: goal ? { amount: goal.amount, currency: goal.currency, period: goal.period, progressPercent: goal.amount ? Math.round((confirmedTotal / goal.amount) * 1000) / 10 : null, remaining: Math.max(0, goal.amount - confirmedTotal) } : null,
    note: converted.length > knownAmounts.length ? `${converted.length - knownAmounts.length} paiement(s) confirmé(s) sans montant déclaré : non comptés dans le total.` : null,
  } };
}

module.exports = {
  NS, LEADS_NS, resolveTargets, create, list, get, stop, setGoal, tick, tickAll, isInterest, buildOfferMessage,
  handleGroupMessage, leadForContact, ensureConversationOrigin, handleLeadProof, recordPaymentOutcome, continuationContext, report, findCampaign,
};
