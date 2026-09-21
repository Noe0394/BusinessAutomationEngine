// CENTRE D'INTELLIGENCE « RAPPORT & ACTIVITÉ » — ai-engine/activityIntelligence.js
// ---------------------------------------------------------------------------
// Répond à : qu'est-ce qui a été fait / pas fait / bloqué / à améliorer / comment / ce qui a été amélioré et avec quel résultat ?
// UNIQUEMENT à partir des données RÉELLES du compte (dossiers, SAV, relances, tâches durables, alertes, journal d'activité, campagnes,
// améliorations enregistrées). Aucune performance inventée : sans donnée, le rapport le dit. Isolation stricte : chaque lecture est faite
// dans l'espace du compte (tenantId) ; les filtres serviceId / client / canal / groupe / campagne ne font que RESTREINDRE ce périmètre.
//
// BOUCLE D'AMÉLIORATION : OBSERVATION → DIAGNOSTIC → RECOMMANDATION → (action automatique sûre SI autorisée | validation du propriétaire |
// changement technique jamais automatique) → MESURE avant/après. Une amélioration n'est « améliorée » qu'avec un résultat mesuré.
const storageAdapter = require('./storageAdapter');
const lifecycle = require('./customerLifecycle');
const { explainReason } = require('./toolsLifecycle');

const NS = 'improvements';
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const HOUR = 3600 * 1000; const DAY = 24 * HOUR;
const safe = async (fn, d) => { try { return await fn(); } catch (e) { return d; } };
const STATUSES = ['DONE', 'NOT_DONE', 'BLOCKED', 'TO_IMPROVE', 'IMPROVED'];

const inPeriod = (ts, f) => (!f.since || ts >= f.since) && (!f.until || ts <= f.until);
const lc = (v) => String(v == null ? '' : v).toLowerCase();

// Période : « 7d » / « 24h » / dates. Par défaut 30 jours.
function normalizeFilters(raw) {
  const f = Object.assign({}, raw || {}); const now = Date.now();
  if (typeof f.period === 'string' && /^\d+[dh]$/.test(f.period)) f.since = now - Number(f.period.slice(0, -1)) * (f.period.endsWith('h') ? HOUR : DAY);
  if (f.since != null) f.since = Number(f.since) || undefined; if (f.until != null) f.until = Number(f.until) || undefined;
  if (!f.since && !f.until) f.since = now - 30 * DAY;
  if (f.status) f.status = String(f.status).toUpperCase();
  return f;
}
const matchContact = (c, q) => !q || lc(c && c.name).includes(lc(q)) || String((c && c.id) || '').includes(String(q).replace(/\D/g, '') || '§');

// ------------------------------------------------------------------ collecte
async function collect(tenant, f) {
  const items = []; const push = (i) => items.push(Object.assign({ serviceId: null, channel: null, contact: null, campaign: null, group: null, how: null, reason: null }, i));
  const services = await safe(() => require('./businessServices').list(tenant), []);
  const svcName = (id) => { const s = services.find((x) => x.id === id); return s ? s.name : null; };

  const snap = await safe(() => lifecycle.snapshot(tenant), { orders: [], cases: [], followUps: [], events: [] });
  for (const o of snap.orders) {
    const done = o.status === 'DELIVERED'; const cancelled = o.status === 'CANCELLED';
    push({ id: o.id, ts: o.deliveredAt || o.createdAt, source: 'lifecycle', actionType: 'order', serviceId: o.serviceId, channel: o.contact.channel, contact: o.contact,
      status: done ? 'DONE' : (cancelled ? 'NOT_DONE' : (o.status === 'PAYMENT_PENDING' ? 'BLOCKED' : 'NOT_DONE')),
      title: `Dossier ${o.kind} — ${o.contact.name || o.contact.id}`, detail: `statut ${o.status}${o.total != null ? `, ${o.total} ${o.currency}` : ''}`,
      reason: o.status === 'PAYMENT_PENDING' ? 'en attente du paiement' : (cancelled ? 'annulé' : (done ? null : 'pas encore livré')) });
  }
  for (const c of snap.cases) {
    const resolved = c.status === 'RESOLVED'; const age = Date.now() - c.openedAt;
    push({ id: c.id, ts: c.resolvedAt || c.openedAt, source: 'lifecycle', actionType: 'sav', serviceId: c.serviceId, channel: c.contact.channel, contact: c.contact,
      status: resolved ? 'DONE' : (age > 2 * DAY ? 'BLOCKED' : 'NOT_DONE'), title: `SAV ${c.category} — ${c.contact.name || c.contact.id}`, detail: c.summary,
      how: resolved ? c.resolution : null, reason: resolved ? null : (age > 2 * DAY ? `réclamation ouverte depuis ${Math.round(age / DAY)} jours` : 'en cours de traitement') });
  }
  for (const u of snap.followUps) {
    const last = u.decisions.length ? u.decisions[u.decisions.length - 1] : null;
    const st = u.status === 'SENT' ? 'DONE' : (u.status === 'NEEDS_OWNER' ? 'BLOCKED' : 'NOT_DONE');
    push({ id: u.id, ts: u.sentAt || u.createdAt, source: 'lifecycle', actionType: 'followup', serviceId: u.serviceId, channel: u.contact.channel, contact: u.contact, status: st,
      title: `Relance ${u.kind} — ${u.contact.name || u.contact.id}`, detail: `statut ${u.status}`,
      how: u.status === 'SENT' ? 'envoyée après vérification des conditions' : null,
      reason: u.status === 'SENT' ? null : explainReason(u.cancelReason || u.ownerReason || (last ? last.reasons.slice(-1)[0] : 'PLANNED')) });
  }

  const tasks = await safe(() => require('./taskQueue').list(tenant), []);
  const pub = require('./taskQueue').normalizeState;
  for (const t of tasks) {
    if (t.type === 'FOLLOW_UP') continue; // déjà représentée par la relance elle-même
    const s = pub(t.state);
    push({ id: t.id, ts: t.finishedAt || t.updatedAt || t.createdAt || t.runAt, source: 'task', actionType: String(t.type || 'task').toLowerCase(), status: s === 'COMPLETED' ? 'DONE' : (['FAILED', 'PAUSED', 'WAITING_EXTERNAL'].includes(s) ? 'BLOCKED' : 'NOT_DONE'),
      title: `Tâche ${t.type}`, detail: `état ${s}`, reason: s === 'FAILED' ? String(t.error || 'échec') : (s === 'PAUSED' ? 'en pause' : (s === 'WAITING_EXTERNAL' ? 'attend une réponse externe' : (s === 'CANCELLED' ? 'annulée' : null))) });
  }

  const alerts = await safe(() => require('./alertCenter').list(tenant, { limit: 100 }), []);
  for (const a of alerts) push({ id: a.id || a.alertId, ts: a.createdAt, source: 'alert', actionType: 'alert', status: a.status === 'OPEN' || !a.status ? 'BLOCKED' : 'DONE', title: a.title || a.type, detail: a.body || null, reason: a.status === 'OPEN' || !a.status ? 'demande votre intervention' : null });

  // Journal d'activité (global au serveur, mais chaque évènement porte son compte : on ne garde QUE celui-ci).
  const act = require('./activityStore');
  for (let d = 0; d < 7; d += 1) {
    const day = new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const s = await safe(() => act.summary(day, 300), { events: [] });
    for (const e of s.events) {
      if (String(e.tenant) !== String(tenant)) continue;
      if (e.type === 'follow_up') continue; // évite le doublon avec la relance elle-même
      push({ id: e.activityId, ts: Date.parse(e.ts), source: 'activity', actionType: e.type, channel: e.channel, contact: e.target ? { id: e.target, name: e.target } : null, status: e.status === 'error' ? 'BLOCKED' : (e.status === 'warning' ? 'TO_IMPROVE' : (e.status === 'pending' ? 'NOT_DONE' : 'DONE')), title: e.action || e.type, detail: e.detail, reason: e.status === 'error' ? (e.detail || 'erreur') : null });
    }
  }

  const camps = await safe(() => require('./campaignService').list(tenant, null), []);
  for (const c of camps) push({ id: c.id, ts: c.launchedAt || c.startedAt || c.createdAt || 0, source: 'campaign', actionType: 'campaign', channel: c.channel, campaign: c.name || c.id, serviceId: c.serviceId || null,
    status: ['completed', 'done', 'launched'].includes(lc(c.status)) ? 'DONE' : (['failed', 'error', 'paused'].includes(lc(c.status)) ? 'BLOCKED' : 'NOT_DONE'), title: `Campagne ${c.name || c.id}`, detail: `statut ${c.status}${c.sent != null ? `, ${c.sent} envoyés` : ''}`, reason: ['failed', 'error', 'paused'].includes(lc(c.status)) ? `campagne ${c.status}` : null });

  const imps = await loadImprovements(tenant);
  for (const r of imps.items) {
    const st = r.status === 'MEASURED' ? 'IMPROVED' : (r.status === 'APPLIED' ? 'IMPROVED' : (r.status === 'REJECTED' ? 'NOT_DONE' : 'TO_IMPROVE'));
    push({ id: r.id, ts: r.appliedAt || r.createdAt, source: 'improvement', actionType: 'improvement', serviceId: r.serviceId || null, status: st, title: r.recommendation, detail: r.observation, how: r.kind === 'AUTO_SAFE' ? 'action sûre appliquée automatiquement (autorisée)' : (r.status === 'PROPOSED' ? null : 'appliquée avec votre validation'), reason: r.status === 'PROPOSED' ? 'attend votre décision' : null, result: r.result || null });
  }

  for (const it of items) { if (it.serviceId && !it.serviceName) it.serviceName = svcName(it.serviceId); }
  return items.filter((i) => inPeriod(i.ts || 0, f)
    && (!f.serviceId || i.serviceId === f.serviceId)
    && (!f.channel || lc(i.channel) === lc(f.channel))
    && (!f.client || matchContact(i.contact, f.client))
    && (!f.campaign || lc(i.campaign).includes(lc(f.campaign)))
    && (!f.group || lc(i.group).includes(lc(f.group)) || lc(i.title).includes(lc(f.group)))
    && (!f.product || lc(i.title + ' ' + i.detail).includes(lc(f.product)))
    && (!f.actionType || lc(i.actionType) === lc(f.actionType))
    && (!f.status || i.status === f.status));
}

async function buildReport(tenant, rawFilters) {
  const f = normalizeFilters(rawFilters); const items = (await collect(tenant, f)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const by = (s) => items.filter((i) => i.status === s);
  const totals = Object.fromEntries(STATUSES.map((s) => [s, by(s).length]));
  const cand = await safe(() => lifecycle.candidates(tenant), null);
  return {
    tenant: sanitize(tenant), filters: f, generatedAt: Date.now(), total: items.length, totals,
    sections: { done: by('DONE'), notDone: by('NOT_DONE'), blocked: by('BLOCKED'), toImprove: by('TO_IMPROVE'), improved: by('IMPROVED') },
    toDoNow: cand ? { idleProspects: cand.idleProspects.length, dueFollowUps: cand.due.length, pendingPayments: cand.pendingPayments.length, deliveredWithoutFollowUp: cand.deliveredWithoutFollowUp.length, needsOwner: cand.needsOwner.length } : null,
    empty: items.length === 0,
    note: items.length === 0 ? "Aucune activité enregistrée pour ce périmètre : je n'invente rien." : null,
  };
}

// ------------------------------------------------------------------ boucle d'amélioration
const loadImprovements = (tenant) => storageAdapter.get(NS, sanitize(tenant), { tenant: sanitize(tenant), items: [] });
const saveImprovements = (tenant, doc) => storageAdapter.set(NS, sanitize(tenant), doc);
let chain = Promise.resolve();
const serial = (fn) => { const n = chain.catch(() => {}).then(fn); chain = n; return n; };

// Métrique mesurable pour chaque type de recommandation (avant / après).
async function metric(tenant, key) {
  const c = await safe(() => lifecycle.candidates(tenant), null); if (!c) return null;
  const m = { DELIVERED_WITHOUT_FOLLOWUP: c.deliveredWithoutFollowUp.length, PENDING_PAYMENT_NO_REMINDER: c.pendingPayments.length, IDLE_PROSPECTS: c.idleProspects.length, FOLLOWUPS_WAITING_AUTH: c.needsOwner.length };
  return m[key] != null ? m[key] : null;
}

// OBSERVATION → DIAGNOSTIC → RECOMMANDATION à partir des données réelles.
async function diagnose(tenant) {
  const out = []; const snap = await safe(() => lifecycle.snapshot(tenant), { orders: [], cases: [], followUps: [], events: [] });
  const cand = await safe(() => lifecycle.candidates(tenant), null);
  const add = (r) => out.push(Object.assign({ status: 'PROPOSED' }, r));
  if (cand && cand.deliveredWithoutFollowUp.length) add({ key: 'DELIVERED_WITHOUT_FOLLOWUP', observation: `${cand.deliveredWithoutFollowUp.length} commande(s) livrée(s) sans suivi planifié.`, diagnostic: "Le suivi après livraison n'a pas été planifié pour ces dossiers.", recommendation: 'Planifier le suivi après livraison pour ces clients.', kind: 'AUTO_SAFE', targets: cand.deliveredWithoutFollowUp.map((x) => x.orderId) });
  const stalePay = (cand ? cand.pendingPayments : []).filter((p) => Date.now() - p.since > 2 * DAY && !snap.followUps.some((u) => u.orderId === p.orderId && ['PLANNED', 'WAITING', 'SENT'].includes(u.status)));
  if (stalePay.length) add({ key: 'PENDING_PAYMENT_NO_REMINDER', observation: `${stalePay.length} paiement(s) en attente depuis plus de 48 h sans relance.`, diagnostic: 'Aucune relance de paiement ne couvre ces dossiers.', recommendation: 'Planifier une relance de paiement (soumise aux vérifications avant envoi).', kind: 'AUTO_SAFE', targets: stalePay.map((x) => x.orderId) });
  if (cand && cand.needsOwner.some((n) => n.reason === 'AUTHORIZATION_REQUIRED')) add({ key: 'FOLLOWUPS_WAITING_AUTH', observation: `${cand.needsOwner.filter((n) => n.reason === 'AUTHORIZATION_REQUIRED').length} relance(s) attendent votre autorisation.`, diagnostic: "Les relances automatiques ne sont pas autorisées : elles s'accumulent sans être envoyées.", recommendation: 'Autoriser les relances automatiques (je continue de vérifier chaque envoi) ou valider chaque relance à la main.', kind: 'NEEDS_VALIDATION' });
  if (cand && cand.idleProspects.length >= 3) add({ key: 'IDLE_PROSPECTS', observation: `${cand.idleProspects.length} prospects intéressés sont restés sans suite depuis plus de 24 h.`, diagnostic: 'Des prospects chauds ne sont pas relancés.', recommendation: 'Planifier une relance douce pour ces prospects.', kind: 'AUTO_SAFE', targets: cand.idleProspects.map((p) => ({ channel: p.channel, contactId: p.contactId, service: p.service })) });
  const oldCases = snap.cases.filter((c) => c.status !== 'RESOLVED' && Date.now() - c.openedAt > 2 * DAY);
  if (oldCases.length) add({ key: 'OLD_SAV_CASES', observation: `${oldCases.length} dossier(s) SAV ouvert(s) depuis plus de 48 h.`, diagnostic: 'Des réclamations restent sans résolution.', recommendation: 'Traiter ces dossiers SAV en priorité (je peux préparer une réponse pour chacun).', kind: 'NEEDS_VALIDATION', targets: oldCases.map((c) => c.id) });
  const services = await safe(() => require('./businessServices').list(tenant), []);
  for (const s of services.filter((x) => x.lifecycle === 'active')) {
    const c = s.commercial || {}; const miss = [];
    if (!(c.price != null || (s.products || []).some((p) => p && p.price != null))) miss.push('prix'); if (!c.paymentTerms) miss.push('conditions de paiement'); if (!c.supportRules) miss.push('règles SAV');
    if (miss.length) add({ key: `SERVICE_INCOMPLETE:${s.id}`, serviceId: s.id, observation: `Le service « ${s.name} » n'a pas : ${miss.join(', ')}.`, diagnostic: 'Sans ces informations, je ne peux pas répondre précisément et je transmets plus souvent.', recommendation: `Compléter le service « ${s.name} » (${miss.join(', ')}).`, kind: 'NEEDS_VALIDATION' });
  }
  const failed = (await safe(() => require('./taskQueue').list(tenant, { state: 'FAILED' }), [])).filter((t) => Date.now() - (t.finishedAt || 0) < 7 * DAY);
  if (failed.length >= 2) add({ key: 'TASKS_FAILING', observation: `${failed.length} tâche(s) automatique(s) en échec cette semaine (${[...new Set(failed.map((t) => t.type))].join(', ')}).`, diagnostic: 'Un traitement échoue de façon répétée : cause technique possible.', recommendation: 'Faire examiner ces échecs (changement technique : jamais appliqué automatiquement).', kind: 'TECHNICAL' });
  return out;
}

// Enregistre les recommandations NOUVELLES (dédoublonnées par clé tant qu'une n'est pas close) + mesure de base.
async function refresh(tenant) {
  const found = await diagnose(tenant);
  return serial(async () => {
    const doc = await loadImprovements(tenant); const created = [];
    for (const r of found) {
      if (doc.items.some((x) => x.key === r.key && ['PROPOSED', 'APPLIED'].includes(x.status))) continue;
      const item = Object.assign({ id: `imp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, createdAt: Date.now() }, r, { baseline: await metric(tenant, r.key.split(':')[0]) });
      doc.items.unshift(item); created.push(item);
    }
    doc.items = doc.items.slice(0, 200); await saveImprovements(tenant, doc); return { created, open: doc.items.filter((x) => x.status === 'PROPOSED') };
  });
}

async function applyAutoSafe(tenant, item) {
  const done = [];
  if (item.key === 'DELIVERED_WITHOUT_FOLLOWUP') { const orders = await lifecycle.listOrders(tenant, { status: 'DELIVERED' }); for (const o of orders.filter((x) => item.targets.includes(x.id))) { const r = await lifecycle.planFollowUp(tenant, { kind: 'POST_DELIVERY', orderId: o.id, contact: o.contact, serviceId: o.serviceId, source: 'improvement', dedupe: true }); if (r.created) done.push(o.id); } }
  else if (item.key === 'PENDING_PAYMENT_NO_REMINDER') { const orders = await lifecycle.listOrders(tenant, { status: 'PAYMENT_PENDING' }); for (const o of orders.filter((x) => item.targets.includes(x.id))) { const r = await lifecycle.planFollowUp(tenant, { kind: 'PAYMENT_REMINDER', orderId: o.id, contact: o.contact, serviceId: o.serviceId, source: 'improvement', dedupe: true }); if (r.created) done.push(o.id); } }
  else if (item.key === 'IDLE_PROSPECTS') { for (const p of item.targets) { const r = await lifecycle.planFollowUp(tenant, { kind: 'PROSPECT_NUDGE', contact: { channel: p.channel, id: p.contactId }, source: 'improvement', dedupe: true }); if (r.created) done.push(p.contactId); } }
  return done;
}

// Applique UNE recommandation. AUTO_SAFE : seulement si `authorized` (réglage propriétaire ou confirmation) ; TECHNICAL : jamais ; NEEDS_VALIDATION : jamais
// sans `approvedByOwner` (et l'application concrète — compléter un service, autoriser les relances — est faite par le propriétaire ou son outil dédié).
async function apply(tenant, id, opts) {
  const o = opts || {};
  return serial(async () => {
    const doc = await loadImprovements(tenant); const item = doc.items.find((x) => x.id === id);
    if (!item) return { ok: false, error: 'NOT_FOUND' };
    if (item.status !== 'PROPOSED') return { ok: false, error: 'ALREADY_' + item.status };
    if (item.kind === 'TECHNICAL') return { ok: false, error: 'TECHNICAL_CHANGE_NEVER_AUTOMATIC', message: 'Changement technique : je vous le propose, je ne l\'applique jamais seul.' };
    if (item.kind === 'NEEDS_VALIDATION' && !o.approvedByOwner) return { ok: false, error: 'OWNER_VALIDATION_REQUIRED', message: 'Cette amélioration attend votre validation.' };
    if (item.kind === 'AUTO_SAFE' && !o.authorized && !o.approvedByOwner) return { ok: false, error: 'NOT_AUTHORIZED', message: "L'application automatique n'est pas autorisée : dites « applique » pour valider." };
    let changed = [];
    if (item.kind === 'AUTO_SAFE') changed = await applyAutoSafe(tenant, item);
    else if (item.key === 'FOLLOWUPS_WAITING_AUTH') { await require('./autoResponder').setSettings(tenant, { followUps: true }); changed = ['followUps=true']; }
    item.status = 'APPLIED'; item.appliedAt = Date.now(); item.appliedBy = o.approvedByOwner ? 'owner' : 'auto'; item.changed = changed;
    await saveImprovements(tenant, doc);
    return { ok: true, item, changed };
  });
}

// MESURE : compare la métrique de départ à la valeur actuelle. Sans mesure possible, on ne déclare aucun gain.
async function measure(tenant, id) {
  return serial(async () => {
    const doc = await loadImprovements(tenant); const item = doc.items.find((x) => x.id === id);
    if (!item || item.status === 'PROPOSED') return { ok: false, error: item ? 'NOT_APPLIED_YET' : 'NOT_FOUND' };
    const now = await metric(tenant, item.key.split(':')[0]);
    if (item.baseline == null || now == null) { item.result = { measurable: false, message: "Pas de mesure comparable : je ne déclare aucun gain." }; }
    else { const delta = item.baseline - now; item.result = { measurable: true, before: item.baseline, after: now, improved: delta > 0, message: delta > 0 ? `Avant : ${item.baseline}, maintenant : ${now} (${delta} de moins).` : (delta === 0 ? `Inchangé (${now}) : pas encore d'effet mesurable.` : `Dégradé : ${item.baseline} → ${now}.`) }; }
    if (item.result.measurable && item.result.improved) item.status = 'MEASURED';
    item.measuredAt = Date.now(); await saveImprovements(tenant, doc); return { ok: true, item };
  });
}

// Analyse par les spécialistes (agents d'analyse de conversation, commercial, SAV, stratégie, marketing) — sur des données RÉELLES uniquement,
// via l'Orchestrateur (une seule voix). Si l'IA est indisponible, on le dit : aucune analyse n'est fabriquée.
async function analyzeWithAgents(tenant, rawFilters, principal) {
  const report = await buildReport(tenant, rawFilters);
  if (report.empty) return { ok: true, available: false, reason: 'NO_DATA', text: "Je n'ai aucune activité réelle à analyser pour ce périmètre." };
  const line = (i) => `- [${i.status}] ${i.title}${i.reason ? ` — ${i.reason}` : ''}`;
  const material = ['Totaux : ' + JSON.stringify(report.totals), 'DONNÉES RÉELLES (ne rien ajouter, ne rien supposer) :', ...report.sections.blocked.slice(0, 15).map(line), ...report.sections.notDone.slice(0, 15).map(line), ...report.sections.done.slice(0, 10).map(line)].join('\n');
  const text = `Analyse commerciale, SAV et suivi client : que faut-il améliorer, et pourquoi ? Appuie-toi UNIQUEMENT sur les données réelles ci-dessous.\nPIÈCES JOINTES reçues\n${material}`;
  const authz = require('./authz');
  const p = principal || authz.issuePrincipal({ tenant, role: 'OWNER', source: 'activity-analysis' });
  const r = await require('./agents/orchestrationService').advise({ audience: 'OWNER', tenantId: tenant, principal: p, channel: 'WEB', text, history: [], useAI: true });
  if (!r.synthesis) return { ok: true, available: false, reason: r.trace && r.trace.reason, text: "L'analyse par mes spécialistes n'est pas disponible pour le moment : voici le rapport factuel, sans interprétation ajoutée." };
  return { ok: true, available: true, agents: r.used.map((u) => u.name), text: r.synthesis, cautions: r.cautions };
}

module.exports = { STATUSES, normalizeFilters, collect, buildReport, diagnose, refresh, apply, measure, analyzeWithAgents, loadImprovements, metric };
