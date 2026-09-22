// CYCLE DE VIE CLIENT GÉNÉRIQUE — ai-engine/customerLifecycle.js
// ---------------------------------------------------------------------------
// PROSPECTION → … → COMMANDE / RÉSERVATION / INSCRIPTION / PRESTATION → PAIEMENT → EXÉCUTION → LIVRAISON / ACTIVATION → SATISFACTION → SAV →
// SUIVI → FIDÉLISATION → RELANCE. Ce module est INDÉPENDANT du métier : un « dossier » peut être une commande de produits (commerce, e-commerce,
// restaurant), une réservation, une prestation, une inscription (formation)… Le vocabulaire est unique : ORDERED → PAYMENT_PENDING → PAID →
// IN_PROGRESS → DELIVERED (livré / prestation réalisée / accès activé), ou CANCELLED. La livraison n'est JAMAIS la fin : elle déclenche le suivi.
//   • dossiers   : recordOrder / setOrderStatus / listOrders (transitions validées) ;
//   • SAV        : openCase / resolveCase / listCases (dédoublonné, catégories, délais de résolution) ;
//   • relances   : planFollowUp → tâche durable FOLLOW_UP ; AU MOMENT D'ENVOYER, decideFollowUp() vérifie 10 points (statut, dernier échange, action
//                  déjà faite, conversion, activité récente, opt-out, Service métier, campagne/source, permission, décision) puis
//                  SEND / WAIT / CANCEL / HUMAN — jamais d'envoi aveugle ;
//   • candidats  : qui devrait être relancé / suivi maintenant, calculé sur les données RÉELLES (dossiers, conversations).
// Aucune donnée inventée : tout vient des dossiers saisis (par le propriétaire, un outil ou un flux existant) et de l'historique réel.
const storageAdapter = require('./storageAdapter');
const contactCrm = require('./contactCrm');

const NS = 'lifecycle';
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HOUR = 3600 * 1000;

const ORDER_STATUS = ['ORDERED', 'PAYMENT_PENDING', 'PAID', 'IN_PROGRESS', 'DELIVERED', 'CANCELLED'];
const TRANSITIONS = {
  ORDERED: ['PAYMENT_PENDING', 'PAID', 'IN_PROGRESS', 'CANCELLED'],
  PAYMENT_PENDING: ['PAID', 'CANCELLED'],
  PAID: ['IN_PROGRESS', 'DELIVERED', 'CANCELLED'],
  IN_PROGRESS: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [], CANCELLED: [],
};
const SAV_CATEGORIES = ['produit', 'livraison', 'paiement', 'acces', 'prestation', 'autre'];
const FOLLOWUP_KINDS = ['POST_DELIVERY', 'PAYMENT_REMINDER', 'PROSPECT_NUDGE', 'SATISFACTION', 'LOYALTY', 'SAV_CHECK'];
const DEFAULT_DELAY_HOURS = { POST_DELIVERY: 48, PAYMENT_REMINDER: 24, PROSPECT_NUDGE: 48, SATISFACTION: 72, LOYALTY: 24 * 30, SAV_CHECK: 48 };

const load = (tenant) => storageAdapter.get(NS, sanitize(tenant), { tenant: sanitize(tenant), orders: {}, cases: {}, followUps: {}, events: [] });
const chains = new Map();
function locked(tenant, fn) { const k = sanitize(tenant); const prev = chains.get(k) || Promise.resolve(); const next = prev.catch(() => {}).then(fn); chains.set(k, next); next.finally(() => { if (chains.get(k) === next) chains.delete(k); }).catch(() => {}); return next; }
async function save(tenant, doc) { doc.updatedAt = new Date().toISOString(); await storageAdapter.set(NS, sanitize(tenant), doc); }
function log(doc, type, ref, detail) { doc.events.unshift({ ts: Date.now(), type, ref: ref || null, detail: detail || null }); if (doc.events.length > 400) doc.events.length = 400; }
const err = (code, message) => Object.assign(new Error(message || code), { code });
const contactOf = (c) => ({ channel: String((c && c.channel) || 'WHATSAPP').toUpperCase(), id: String((c && (c.id || c.identifier || c.number)) || '').replace(/[^A-Za-z0-9_.@:+-]/g, ''), name: String((c && c.name) || '').slice(0, 120) });

// ---------------------------------------------------------------------------- dossiers
function recordOrder(tenant, input) {
  return locked(tenant, async () => {
    const contact = contactOf(input.contact);
    if (!contact.id) throw err('CONTACT_REQUIRED', 'Un dossier doit être rattaché à un contact.');
    const doc = await load(tenant);
    const items = (Array.isArray(input.items) ? input.items : []).slice(0, 50).map((i) => ({ name: String(i.name || i.nom || '').slice(0, 120), qty: Number(i.qty || i.quantite || 1) || 1, price: i.price != null ? Number(i.price) : null })).filter((i) => i.name);
    const total = input.total != null ? Number(input.total) : (items.every((i) => i.price != null) ? items.reduce((s, i) => s + i.price * i.qty, 0) : null);
    const order = {
      id: uid('ord'), kind: ['ORDER', 'BOOKING', 'ENROLLMENT', 'QUOTE', 'SERVICE'].includes(input.kind) ? input.kind : 'ORDER',
      serviceId: input.serviceId ? String(input.serviceId) : null, serviceName: String(input.serviceName || '').slice(0, 120),
      contact, items, total: Number.isFinite(total) ? total : null, currency: String(input.currency || 'FCFA').slice(0, 8), note: String(input.note || '').slice(0, 300),
      status: 'ORDERED', createdAt: Date.now(), history: [{ status: 'ORDERED', at: Date.now(), by: input.by || 'owner' }],
    };
    doc.orders[order.id] = order; log(doc, 'order_created', order.id, `${order.kind} ${contact.name || contact.id}`);
    await save(tenant, doc); return order;
  });
}

function setOrderStatus(tenant, id, status, opts) {
  return locked(tenant, async () => {
    const doc = await load(tenant); const o = doc.orders[id];
    if (!o) throw err('NOT_FOUND', 'Dossier introuvable.');
    if (!ORDER_STATUS.includes(status)) throw err('INVALID_STATUS');
    if (o.status === status) return { order: o, changed: false };
    if (!TRANSITIONS[o.status].includes(status)) throw err('INVALID_TRANSITION', `Passage ${o.status} → ${status} impossible.`);
    o.status = status; o.history.push({ status, at: Date.now(), by: (opts && opts.by) || 'owner', note: (opts && opts.note) || null });
    if (status === 'PAID') o.paidAt = Date.now();
    if (status === 'DELIVERED') o.deliveredAt = Date.now();
    log(doc, `order_${status.toLowerCase()}`, id, o.contact.name || o.contact.id);
    await save(tenant, doc);
    return { order: o, changed: true };
  }).then(async (r) => {
    // La livraison / l'exécution n'est PAS la fin : un suivi est planifié automatiquement (une seule fois par dossier).
    if (r.changed && status === 'DELIVERED') r.followUp = await planFollowUp(tenant, { kind: 'POST_DELIVERY', orderId: id, contact: r.order.contact, serviceId: r.order.serviceId, source: 'delivery', dedupe: true }).catch(() => null);
    if (r.changed && status === 'PAYMENT_PENDING') r.followUp = await planFollowUp(tenant, { kind: 'PAYMENT_REMINDER', orderId: id, contact: r.order.contact, serviceId: r.order.serviceId, source: 'payment', dedupe: true }).catch(() => null);
    return r;
  });
}

async function listOrders(tenant, f) {
  const o = f || {}; const doc = await load(tenant);
  return Object.values(doc.orders).filter((x) => (!o.status || x.status === o.status) && (!o.serviceId || x.serviceId === o.serviceId) && (!o.contactId || x.contact.id === String(o.contactId)) && (!o.sinceMs || x.createdAt >= o.sinceMs)).sort((a, z) => z.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------- SAV
function openCase(tenant, input) {
  return locked(tenant, async () => {
    const contact = contactOf(input.contact); if (!contact.id) throw err('CONTACT_REQUIRED');
    const doc = await load(tenant);
    const category = SAV_CATEGORIES.includes(input.category) ? input.category : 'autre';
    const open = Object.values(doc.cases).find((c) => c.status !== 'RESOLVED' && c.contact.id === contact.id && c.contact.channel === contact.channel && c.category === category);
    if (open) { open.mentions = (open.mentions || 1) + 1; open.lastMentionAt = Date.now(); await save(tenant, doc); return { case: open, created: false }; } // dédoublonné : une réclamation = un dossier
    const c = { id: uid('sav'), contact, serviceId: input.serviceId ? String(input.serviceId) : null, orderId: input.orderId || null, category, summary: String(input.summary || '').slice(0, 300), source: input.source || 'owner', status: 'OPEN', openedAt: Date.now(), mentions: 1 };
    doc.cases[c.id] = c; log(doc, 'sav_opened', c.id, `${category} ${contact.name || contact.id}`);
    await save(tenant, doc); return { case: c, created: true };
  });
}
function resolveCase(tenant, id, resolution) {
  return locked(tenant, async () => {
    const doc = await load(tenant); const c = doc.cases[id];
    if (!c) throw err('NOT_FOUND', 'Dossier SAV introuvable.');
    if (c.status === 'RESOLVED') return c;
    c.status = 'RESOLVED'; c.resolvedAt = Date.now(); c.resolution = String(resolution || '').slice(0, 300);
    log(doc, 'sav_resolved', id, c.category);
    await save(tenant, doc); return c;
  });
}
async function listCases(tenant, f) { const o = f || {}; const doc = await load(tenant); return Object.values(doc.cases).filter((c) => (!o.status || c.status === o.status) && (!o.serviceId || c.serviceId === o.serviceId)).sort((a, z) => z.openedAt - a.openedAt); }

// ---------------------------------------------------------------------------- relances / suivis
function planFollowUp(tenant, input) {
  return locked(tenant, async () => {
    if (!FOLLOWUP_KINDS.includes(input.kind)) throw err('INVALID_KIND');
    const contact = contactOf(input.contact); if (!contact.id) throw err('CONTACT_REQUIRED');
    const doc = await load(tenant);
    if (input.dedupe !== false) {
      const same = Object.values(doc.followUps).find((f) => f.kind === input.kind && f.contact.id === contact.id && (f.orderId || null) === (input.orderId || null) && ['PLANNED', 'WAITING'].includes(f.status));
      if (same) return { followUp: same, created: false };
    }
    const dueAt = input.dueAt ? Number(input.dueAt) : Date.now() + (DEFAULT_DELAY_HOURS[input.kind] || 48) * HOUR;
    const f = { id: uid('fup'), kind: input.kind, contact, orderId: input.orderId || null, serviceId: input.serviceId || null, source: input.source || 'owner', note: String(input.note || '').slice(0, 300), status: 'PLANNED', dueAt, createdAt: Date.now(), attempts: 0, decisions: [] };
    doc.followUps[f.id] = f; log(doc, 'followup_planned', f.id, `${f.kind} ${contact.name || contact.id}`);
    await save(tenant, doc);
    try { await require('./taskQueue').enqueue(tenant, { type: 'FOLLOW_UP', payload: { followUpId: f.id }, runAt: dueAt, dedupeKey: `fup:${sanitize(tenant)}:${f.id}`, ref: f.id }); } catch (e) { /* la tâche sera recréée au prochain passage */ }
    return { followUp: f, created: true };
  });
}
async function listFollowUps(tenant, f) { const o = f || {}; const doc = await load(tenant); return Object.values(doc.followUps).filter((x) => (!o.status || x.status === o.status) && (!o.kind || x.kind === o.kind)).sort((a, z) => a.dueAt - z.dueAt); }

// Les 10 vérifications AVANT toute relance. deps injectables (tests) : lastMessages(contact) -> [{direction, ts}], isOptedOut(contact), service(id), settings.
async function decideFollowUp(tenant, fu, deps) {
  const d = deps || {}; const now = d.now || Date.now(); const reasons = [];
  const doc = await load(tenant);
  const order = fu.orderId ? doc.orders[fu.orderId] : null;
  const done = (action, reason, extra) => Object.assign({ action, reasons: reasons.concat([reason]), checkedAt: now }, extra || {});
  const contact = fu.contact;
  // 1) statut du dossier
  if (order) {
    if (order.status === 'CANCELLED') return done('CANCEL', 'ORDER_CANCELLED');
    if (fu.kind === 'POST_DELIVERY' && order.status !== 'DELIVERED') return done('WAIT', 'ORDER_NOT_DELIVERED_YET', { until: now + 24 * HOUR });
    // 3) l'action visée est-elle déjà réalisée ?
    if (fu.kind === 'PAYMENT_REMINDER' && ['PAID', 'IN_PROGRESS', 'DELIVERED'].includes(order.status)) return done('CANCEL', 'PAYMENT_ALREADY_DONE');
  }
  reasons.push('STATUS_OK');
  // 4) conversion (relance d'un prospect : a-t-il acheté depuis ?)
  if (fu.kind === 'PROSPECT_NUDGE') {
    const converted = Object.values(doc.orders).some((o) => o.contact.id === contact.id && o.status !== 'CANCELLED' && o.createdAt >= fu.createdAt);
    let tagged = false; try { const c = await contactCrm.getContact(tenant, contact.channel, contact.id); tagged = !!(c && (c.tags || []).includes('client')); } catch (e) { tagged = false; }
    if (converted || tagged) return done('CANCEL', 'ALREADY_CONVERTED');
  }
  // 2 + 5) dernier échange et activité récente
  let msgs = [];
  try { msgs = d.lastMessages ? await d.lastMessages(contact) : await require('./messageHistory').getConversation(tenant, contact.channel, contact.id, 10); } catch (e) { msgs = []; }
  const ts = (m) => Number(m.tsMs || (m.ts ? (m.ts > 1e12 ? m.ts : m.ts * 1000) : 0)) || 0;
  const last = msgs.slice().sort((a, z) => ts(a) - ts(z)).slice(-1)[0];
  const lastIn = msgs.filter((m) => m.direction === 'in').map(ts).sort((a, z) => z - a)[0] || 0;
  const lastOut = msgs.filter((m) => m.direction === 'out').map(ts).sort((a, z) => z - a)[0] || 0;
  if (lastIn && now - lastIn < 24 * HOUR) return done('WAIT', 'RECENT_CLIENT_ACTIVITY', { until: lastIn + 24 * HOUR + 60000 });
  if (lastOut && now - lastOut < 12 * HOUR) return done('WAIT', 'CONTACTED_RECENTLY', { until: lastOut + 12 * HOUR + 60000 });
  if (order && order.deliveredAt && lastIn > order.deliveredAt && fu.kind === 'POST_DELIVERY') return done('CANCEL', 'CLIENT_ALREADY_REPLIED_AFTER_DELIVERY');
  reasons.push(last ? 'LAST_EXCHANGE_OK' : 'NO_EXCHANGE_FOUND');
  // 6) opt-out
  let out = false; try { out = d.isOptedOut ? await d.isOptedOut(contact) : await contactCrm.isOptedOut(tenant, contact.channel, contact.id); } catch (e) { out = false; }
  if (out) return done('CANCEL', 'OPTED_OUT');
  // 7) Service métier actif
  if (fu.serviceId) { let svc = null; try { svc = d.service ? await d.service(fu.serviceId) : await require('./businessServices').get(tenant, fu.serviceId); } catch (e) { svc = null; } if (svc && svc.lifecycle && svc.lifecycle !== 'active') return done('CANCEL', 'SERVICE_INACTIVE'); }
  // 8) campagne / source (une campagne annulée n'a plus de relance)
  if (fu.source === 'campaign' && d.campaignActive && !(await d.campaignActive(fu))) return done('CANCEL', 'CAMPAIGN_INACTIVE');
  // SAV en cours : pas de relance « commerciale » pendant une réclamation ouverte → l'humain décide
  const openCase = Object.values(doc.cases).find((c) => c.status !== 'RESOLVED' && c.contact.id === contact.id && c.contact.channel === contact.channel);
  if (openCase && fu.kind !== 'SAV_CHECK') return done('HUMAN', 'OPEN_SAV_CASE', { caseId: openCase.id });
  if (fu.attempts >= 3) return done('CANCEL', 'MAX_ATTEMPTS');
  // 9) permission : l'envoi automatique de relances doit être ACTIVÉ par le propriétaire (réglage followUps:true ou FOLLOWUPS_ENABLED=true)
  let settings = d.settings; if (!settings) { try { settings = await require('./autoResponder').getSettings(tenant); } catch (e) { settings = {}; } }
  const allowed = (settings && settings.followUps === true) || process.env.FOLLOWUPS_ENABLED === 'true';
  if (!allowed) return done('HUMAN', 'AUTHORIZATION_REQUIRED');
  reasons.push('PERMISSION_OK');
  // 10) décision
  return done('SEND', 'ALL_CHECKS_PASSED');
}

const TEMPLATES = {
  POST_DELIVERY: (n, s) => `Bonjour${n ? ' ' + n : ''} 😊 Avez-vous bien reçu ${s || 'votre commande'} ? Tout se passe bien ? Dites-moi si vous avez besoin d'aide pour l'utiliser.`,
  SATISFACTION: (n, s) => `Bonjour${n ? ' ' + n : ''} 😊 Comment s'est passé ${s || 'votre expérience'} ? Votre avis m'aide à m'améliorer.`,
  PAYMENT_REMINDER: (n, s) => `Bonjour${n ? ' ' + n : ''} 😊 Je me permets de revenir vers vous au sujet de ${s || 'votre commande'} : le paiement n'a pas encore été confirmé. Avez-vous besoin d'aide pour le finaliser ?`,
  PROSPECT_NUDGE: (n, s) => `Bonjour${n ? ' ' + n : ''} 😊 Vous vous intéressiez à ${s || 'notre offre'} : avez-vous une question ou souhaitez-vous que je vous aide à finaliser ?`,
  LOYALTY: (n) => `Bonjour${n ? ' ' + n : ''} 😊 Merci encore de votre confiance ! Si vous avez besoin de quoi que ce soit, je reste disponible.`,
  SAV_CHECK: (n) => `Bonjour${n ? ' ' + n : ''} 😊 Le problème que vous aviez signalé est-il bien résolu de votre côté ?`,
};

// Exécute UNE relance : décision puis action réelle (envoi vérifié / report / annulation / transmission au propriétaire).
async function runFollowUp(tenant, followUpId, deps) {
  const d = deps || {};
  const fu = await locked(tenant, async () => { const doc = await load(tenant); return doc.followUps[followUpId] || null; });
  if (!fu) return { ok: false, error: 'NOT_FOUND' };
  if (!['PLANNED', 'WAITING'].includes(fu.status)) return { ok: true, skipped: fu.status };
  const decision = await decideFollowUp(tenant, fu, d);
  const record = async (patch, eventType) => locked(tenant, async () => { const doc = await load(tenant); const f = doc.followUps[followUpId]; f.decisions.push({ at: Date.now(), action: decision.action, reasons: decision.reasons }); if (f.decisions.length > 10) f.decisions.shift(); Object.assign(f, patch); log(doc, eventType, followUpId, decision.reasons.slice(-1)[0]); await save(tenant, doc); return f; });
  if (decision.action === 'CANCEL') { await record({ status: 'CANCELLED', cancelReason: decision.reasons.slice(-1)[0], finishedAt: Date.now() }, 'followup_cancelled'); return { ok: true, decision }; }
  if (decision.action === 'WAIT') {
    await record({ status: 'WAITING', dueAt: decision.until }, 'followup_waiting');
    try { await require('./taskQueue').enqueue(tenant, { type: 'FOLLOW_UP', payload: { followUpId }, runAt: decision.until, dedupeKey: `fup:${sanitize(tenant)}:${followUpId}:${decision.until}`, ref: followUpId }); } catch (e) { /* repris au prochain passage */ }
    return { ok: true, decision };
  }
  if (decision.action === 'HUMAN') {
    await record({ status: 'NEEDS_OWNER', ownerReason: decision.reasons.slice(-1)[0] }, 'followup_needs_owner');
    try {
      const who = fu.contact.name || fu.contact.id;
      const why = decision.reasons.slice(-1)[0] === 'AUTHORIZATION_REQUIRED' ? 'les relances automatiques ne sont pas activées : validez l\'envoi ou activez-les' : 'une réclamation est ouverte pour ce contact';
      await require('./alertCenter').raise(tenant, { type: 'HUMAN_INTERVENTION_REQUIRED', level: 'ATTENTION', notify: true, title: `Relance en attente de décision : ${who}`, body: `Une relance (${fu.kind}) était prévue pour ${who} mais ${why}.`, idempotencyKey: `fup-owner:${followUpId}` });
    } catch (e) { /* non bloquant */ }
    return { ok: true, decision };
  }
  // SEND : texte (IA si fournie, sinon gabarit), envoi VÉRIFIÉ
  const order = fu.orderId ? (await load(tenant)).orders[fu.orderId] : null;
  const subject = order ? (order.items[0] ? order.items[0].name : order.serviceName) : '';
  let text = null;
  try { text = d.compose ? await d.compose({ followUp: fu, order, decision }) : null; } catch (e) { if (e && e.code === 'CLIENT_AI_LIMIT') throw e; text = null; }
  text = String(text || (TEMPLATES[fu.kind] || TEMPLATES.LOYALTY)(fu.contact.name, subject ? `votre ${subject}` : '')).trim();
  if (!d.runtime || typeof d.runtime.sendMessageVerified !== 'function') { await record({ status: 'NEEDS_OWNER', ownerReason: 'NO_RUNTIME' }, 'followup_needs_owner'); return { ok: false, error: 'NO_RUNTIME', decision }; }
  const to = fu.contact.channel === 'WHATSAPP' && !/@/.test(fu.contact.id) ? `${fu.contact.id}@s.whatsapp.net` : fu.contact.id;
  const out = await d.runtime.sendMessageVerified({ channel: fu.contact.channel, to, text: require('./botSignature').sign(text), tenantId: tenant });
  const sent = out && out.status === 'SUCCESS';
  await record(sent ? { status: 'SENT', sentAt: Date.now(), confirmationId: out.confirmationId || null, attempts: fu.attempts + 1, text: text.slice(0, 300) } : { attempts: fu.attempts + 1, lastError: String((out && (out.error || out.status)) || 'ÉCHEC') }, sent ? 'followup_sent' : 'followup_failed');
  try { require('./activityStore').record({ type: 'follow_up', action: `Relance ${fu.kind}`, status: sent ? 'ok' : 'error', channel: fu.contact.channel, tenant, target: fu.contact.name || fu.contact.id, detail: sent ? `envoyée (réf. ${out.confirmationId || '?'})` : String(out && out.error) }); } catch (e) { /* non bloquant */ }
  return { ok: sent, decision, confirmationId: out && out.confirmationId };
}

// Qui doit être suivi / relancé MAINTENANT ? (données réelles uniquement)
async function candidates(tenant, opts) {
  const o = opts || {}; const now = o.now || Date.now(); const doc = await load(tenant);
  const fus = Object.values(doc.followUps);
  const deliveredWithoutFollowUp = Object.values(doc.orders).filter((x) => x.status === 'DELIVERED' && !fus.some((f) => f.orderId === x.id && ['PLANNED', 'WAITING', 'SENT', 'NEEDS_OWNER'].includes(f.status))).map((x) => ({ orderId: x.id, contact: x.contact, service: x.serviceName || x.serviceId, deliveredAt: x.deliveredAt }));
  const due = fus.filter((f) => ['PLANNED', 'WAITING'].includes(f.status) && f.dueAt <= now).map((f) => ({ followUpId: f.id, kind: f.kind, contact: f.contact, dueAt: f.dueAt }));
  const needsOwner = fus.filter((f) => f.status === 'NEEDS_OWNER').map((f) => ({ followUpId: f.id, kind: f.kind, contact: f.contact, reason: f.ownerReason }));
  const pendingPayments = Object.values(doc.orders).filter((x) => x.status === 'PAYMENT_PENDING').map((x) => ({ orderId: x.id, contact: x.contact, total: x.total, since: x.createdAt }));
  // prospects intéressés restés sans suite (conversations réelles)
  const idle = [];
  try {
    const prefix = `${sanitize(tenant)}__`;
    for (const id of storageAdapter.listIds('conversation_state')) {
      if (!id.startsWith(prefix)) continue;
      const st = await storageAdapter.get('conversation_state', id, null);
      if (!st || !['INTERESTED', 'DISCOVERY', 'INFORMATION', 'OBJECTION', 'NEGOTIATION', 'WAITING'].includes(st.state) || st.optOut || (st.refusal && st.refusal.active)) continue;
      const idleMs = now - (st.lastMessageTs || 0);
      if (idleMs < 24 * HOUR || idleMs > 7 * 24 * HOUR) continue;
      if (Object.values(doc.orders).some((x) => x.contact.id === String(st.chatId).split('@')[0] && x.status !== 'CANCELLED')) continue;
      if (/@g\.us$|^-\d+$/.test(String(st.chatId))) continue;
      idle.push({ channel: st.platform, contactId: String(st.chatId).split('@')[0], state: st.state, idleHours: Math.round(idleMs / HOUR), service: (st.memory && st.memory.interestService) || null });
    }
  } catch (e) { /* données de conversation indisponibles : rien n'est inventé */ }
  return { deliveredWithoutFollowUp, due, needsOwner, pendingPayments, idleProspects: idle };
}

async function events(tenant, sinceMs) { const doc = await load(tenant); return doc.events.filter((e) => e.ts >= (sinceMs || 0)); }
async function snapshot(tenant) { const doc = await load(tenant); return { orders: Object.values(doc.orders), cases: Object.values(doc.cases), followUps: Object.values(doc.followUps), events: doc.events }; }

module.exports = { ORDER_STATUS, TRANSITIONS, SAV_CATEGORIES, FOLLOWUP_KINDS, recordOrder, setOrderStatus, listOrders, openCase, resolveCase, listCases, planFollowUp, listFollowUps, decideFollowUp, runFollowUp, candidates, events, snapshot, TEMPLATES };
