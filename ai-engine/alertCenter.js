// ALERT CENTER — ai-engine/alertCenter.js
// ---------------------------------------------------------------------------
// Système d'alerte GÉNÉRALE (pas seulement les paiements) : chaque événement qui mérite l'attention du propriétaire est
// enregistré (persistant, identifiant d'événement), soumis à un MOTEUR DE DÉCISION de notification (niveau, politique,
// agrégation) puis livré : WhatsApp du propriétaire (self-chat) en priorité, tchat du tableau de bord en repli.
//
// Niveaux : INFO < ATTENTION < IMPORTANT < ACTION_REQUIRED < ERROR < CRITICAL.
// Politique par défaut : le propriétaire n'est prévenu par WhatsApp qu'à partir de IMPORTANT (les INFO/ATTENTION sont
// seulement enregistrées, consultables dans le Chat Intelligent : « qui m'a écrit ? »). Configurable (`alertPolicy`).
// Anti-spam : les alertes d'un même groupe (ex. une même personne qui écrit plusieurs fois) sont agrégées dans une
// fenêtre glissante — la première part tout de suite, les suivantes donnent UN récapitulatif.
// Idempotence : `idempotencyKey` identique = même événement (jamais deux alertes/notifications pour le même fait).

const storageAdapter = require('./storageAdapter');
const contactIdentity = require('./contactIdentity');

const NAMESPACE = 'alerts';
const MAX_ITEMS = 300;
const LEVELS = ['INFO', 'ATTENTION', 'IMPORTANT', 'ACTION_REQUIRED', 'ERROR', 'CRITICAL'];
const rank = (l) => Math.max(0, LEVELS.indexOf(String(l || 'INFO').toUpperCase()));

// Types d'événements : niveau par défaut + pictogramme.
const TYPES = {
  NEW_PROSPECT: { level: 'ATTENTION', icon: '👤' },
  NEW_BUSINESS_REQUEST: { level: 'IMPORTANT', icon: '📩' },
  PAYMENT_PROOF_RECEIVED: { level: 'ACTION_REQUIRED', icon: '💰' },
  PAYMENT_VALIDATION_REQUIRED: { level: 'ACTION_REQUIRED', icon: '💰' },
  CUSTOMER_IMPORTANT_REQUEST: { level: 'IMPORTANT', icon: '📌' },
  PRIVATE_CASUAL: { level: 'INFO', icon: '💬' },
  PRIVATE_PERSONAL: { level: 'IMPORTANT', icon: '🔔' },
  PRIVATE_SENSITIVE: { level: 'ACTION_REQUIRED', icon: '🔔' },
  CALLBACK_REQUEST: { level: 'ACTION_REQUIRED', icon: '📞' },
  URGENT_MESSAGE: { level: 'CRITICAL', icon: '🚨' },
  HUMAN_INTERVENTION_REQUIRED: { level: 'ACTION_REQUIRED', icon: '🔔' },
  CAMPAIGN_FINISHED: { level: 'INFO', icon: '✅' },
  CAMPAIGN_BLOCKED: { level: 'IMPORTANT', icon: '⚠️' },
  CAMPAIGN_PAUSED: { level: 'ATTENTION', icon: '⏸️' },
  IMPORTANT_ERROR: { level: 'ERROR', icon: '❌' },
  ACTION_NEEDS_CONFIRMATION: { level: 'ACTION_REQUIRED', icon: '❓' },
  ACCOUNT_CREATED: { level: 'IMPORTANT', icon: '✅' },
  TRAINING_ACTIVATED: { level: 'IMPORTANT', icon: '🎓' },
  CERTIFICATE_GENERATED: { level: 'ATTENTION', icon: '📜' },
  BUSINESS_API_FAILED: { level: 'ERROR', icon: '❌' },
  TASK_DONE: { level: 'INFO', icon: '✅' },
  DECISION_REQUIRED: { level: 'ACTION_REQUIRED', icon: '❓' },
};

const DEFAULT_POLICY = {
  minOwnerLevel: 'IMPORTANT', // niveau minimal pour un envoi WhatsApp au propriétaire
  alwaysNotifyTypes: [],      // types toujours notifiés quel que soit le niveau
  neverNotifyTypes: [],       // types jamais notifiés (enregistrés seulement)
  notifyCasual: false,        // prévenir aussi pour les conversations privées banales (réponse automatique + alerte)
  aggregateWindowMs: 60000,   // fenêtre d'agrégation des alertes d'un même groupe
};

const sanitize = (t) => String(t || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = () => 'ev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function getPolicy(tenantId) {
  try {
    const settings = await storageAdapter.get('auto_settings', sanitize(tenantId), {});
    return Object.assign({}, DEFAULT_POLICY, (settings && settings.alertPolicy) || {});
  } catch (e) { return Object.assign({}, DEFAULT_POLICY); }
}

// Moteur de décision : faut-il prévenir le propriétaire maintenant ?
function shouldNotify(alert, policy) {
  const p = Object.assign({}, DEFAULT_POLICY, policy || {});
  if (alert.notify === false) return false;
  if (alert.notify === true) return true;
  if ((p.neverNotifyTypes || []).includes(alert.type)) return false;
  if ((p.alwaysNotifyTypes || []).includes(alert.type)) return true;
  if (alert.type === 'PRIVATE_CASUAL') return !!p.notifyCasual;
  return rank(alert.level) >= rank(p.minOwnerLevel);
}

// --- Livraison -------------------------------------------------------------
// deliverers : fonctions (tenantId, text, alert) -> { ok, channel }. Essayées dans l'ordre jusqu'au premier succès.
let deliverers = [];
function setDeliverers(list) { deliverers = Array.isArray(list) ? list.slice() : []; }
function addDeliverer(fn) { if (typeof fn === 'function') deliverers.push(fn); }

async function deliver(tenantId, text, alert) {
  const clean = contactIdentity.scrubTechnicalIds(text);
  const tried = [];
  for (const fn of deliverers) {
    try {
      const r = await fn(tenantId, clean, alert);
      tried.push({ channel: (r && r.channel) || 'unknown', ok: !!(r && r.ok), error: (r && r.error) || null, messageId: (r && r.messageId) || null });
      if (r && r.ok) return { ok: true, channel: r.channel, messageId: r.messageId || null, tried };
    } catch (err) {
      tried.push({ channel: 'error', ok: false, error: err.message });
    }
  }
  return { ok: false, tried };
}

// --- Persistance -----------------------------------------------------------
const locks = new Map();
function withLock(tenantId, fn) {
  const key = sanitize(tenantId);
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}
const load = (tenantId) => storageAdapter.get(NAMESPACE, sanitize(tenantId), { tenant: sanitize(tenantId), items: [] });
const save = (tenantId, doc) => { doc.items = doc.items.slice(-MAX_ITEMS); return storageAdapter.set(NAMESPACE, sanitize(tenantId), doc); };

// --- Formatage -------------------------------------------------------------
function formatAlert(alert) {
  const t = TYPES[alert.type] || { icon: '🔔' };
  const lines = [`${t.icon} ${alert.title}`];
  if (alert.body) lines.push(alert.body);
  if (alert.hint) lines.push(alert.hint);
  if (alert.pendingActionId) lines.push(`Réf. ${alert.pendingActionId}`);
  return lines.join('\n');
}

// --- Agrégation ------------------------------------------------------------
// windows : `${tenant}|${groupKey}` -> { openedAt, count, last, timer, alertEventId, build }
const windows = new Map();
const clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) };
function useClock(c) { Object.assign(clock, c || {}); }

async function flushWindow(tenantId, wkey, policy) {
  const w = windows.get(wkey);
  if (!w) return null;
  windows.delete(wkey);
  if (w.timer && w.timer.unref) w.timer.unref();
  if (!w.count) return null;
  const title = typeof w.aggregateTitle === 'function' ? w.aggregateTitle(w.count) : `${w.count} nouveaux messages`;
  const alert = Object.assign({}, w.template, { title, body: w.lastBody ? `Dernier message : “${w.lastBody}”` : '', aggregated: true, count: w.count + 1 });
  const res = await deliver(tenantId, formatAlert(alert), alert);
  await withLock(tenantId, async () => {
    const doc = await load(tenantId);
    const item = doc.items.find((a) => a.eventId === w.alertEventId);
    if (item) {
      item.count = (item.count || 1) + w.count;
      item.lastAt = clock.now();
      item.body = alert.body || item.body;
      item.deliveries = (item.deliveries || []).concat([{ at: clock.now(), aggregated: true, ok: res.ok, channel: res.channel || null }]);
      await save(tenantId, doc);
    }
  });
  return res;
}

// raise : point d'entrée unique.
//   alert = { type, level?, title, body?, hint?, contact?, contactId?, conversationId?, pendingActionId?, idempotencyKey?,
//             groupKey?, aggregateTitle?(n), notify? (true/false pour forcer), lastBody? }
async function raise(tenantId, alertIn) {
  const a = alertIn || {};
  const t = TYPES[a.type] || { level: 'ATTENTION', icon: '🔔' };
  const policy = await getPolicy(tenantId);
  const now = clock.now();
  const alert = {
    eventId: uid(),
    type: a.type || 'DECISION_REQUIRED',
    level: LEVELS.includes(a.level) ? a.level : t.level,
    title: String(a.title || 'Alerte').slice(0, 200),
    body: String(a.body || '').slice(0, 600),
    hint: a.hint ? String(a.hint).slice(0, 300) : null,
    contactId: a.contactId || (a.contact && a.contact.contactId) || null,
    contactLabel: a.contact ? a.contact.label : (a.contactLabel || null),
    conversationId: a.conversationId || (a.contact && a.contact.conversationId) || null,
    pendingActionId: a.pendingActionId || null,
    idempotencyKey: a.idempotencyKey || null,
    notify: a.notify,
    status: 'OPEN', createdAt: now, lastAt: now, count: 1, deliveries: [],
  };

  // 1) idempotence + persistance
  const stored = await withLock(tenantId, async () => {
    const doc = await load(tenantId);
    if (alert.idempotencyKey) {
      const dup = doc.items.find((x) => x.idempotencyKey === alert.idempotencyKey);
      if (dup) return { duplicate: dup };
    }
    doc.items.push(alert);
    await save(tenantId, doc);
    return { alert };
  });
  if (stored.duplicate) return { duplicate: true, alert: stored.duplicate, delivered: false };

  // 2) décision de notification
  if (!shouldNotify(alert, policy)) return { alert, delivered: false, reason: 'POLICY_STORED_ONLY' };

  // 3) agrégation (même groupe = une seule notification par fenêtre)
  if (a.groupKey && policy.aggregateWindowMs > 0) {
    const wkey = `${sanitize(tenantId)}|${a.groupKey}`;
    let w = windows.get(wkey);
    if (w && now - w.openedAt >= policy.aggregateWindowMs) { await flushWindow(tenantId, wkey, policy); w = null; }
    if (w && now - w.openedAt < policy.aggregateWindowMs) {
      w.count += 1;
      w.lastBody = a.lastBody != null ? a.lastBody : w.lastBody;
      // l'alerte de cette occurrence est rattachée à la première (comptée), pas envoyée séparément
      await withLock(tenantId, async () => {
        const doc = await load(tenantId);
        doc.items = doc.items.filter((x) => x.eventId !== alert.eventId);
        await save(tenantId, doc);
      });
      return { alert: { eventId: w.alertEventId }, delivered: false, aggregated: true, reason: 'AGGREGATED' };
    }
    windows.set(wkey, { openedAt: now, count: 0, lastBody: null, alertEventId: alert.eventId, template: alert, aggregateTitle: a.aggregateTitle });
    const timer = clock.setTimeout(() => { flushWindow(tenantId, wkey, policy).catch(() => {}); }, policy.aggregateWindowMs);
    if (timer && timer.unref) timer.unref();
    windows.get(wkey).timer = timer;
  }

  // 4) livraison immédiate
  const res = await deliver(tenantId, formatAlert(alert), alert);
  await withLock(tenantId, async () => {
    const doc = await load(tenantId);
    const item = doc.items.find((x) => x.eventId === alert.eventId);
    if (item) {
      item.deliveries = [{ at: clock.now(), ok: res.ok, channel: res.channel || null, messageId: res.messageId || null, tried: res.tried }];
      if (res.ok) item.deliveredAt = clock.now();
      await save(tenantId, doc);
    }
  });
  return { alert, delivered: res.ok, channel: res.channel || null, messageId: res.messageId || null };
}

async function list(tenantId, opts) {
  const o = opts || {};
  const doc = await load(tenantId);
  let items = doc.items.slice();
  if (o.status) items = items.filter((a) => a.status === o.status);
  if (o.sinceMs) items = items.filter((a) => a.createdAt >= o.sinceMs);
  if (o.minLevel) items = items.filter((a) => rank(a.level) >= rank(o.minLevel));
  return items.reverse().slice(0, o.limit || 50);
}

async function resolveAlerts(tenantId, match) {
  return withLock(tenantId, async () => {
    const doc = await load(tenantId);
    let n = 0;
    for (const a of doc.items) {
      if (a.status === 'OPEN' && ((match.conversationId && a.conversationId === match.conversationId) || (match.contactId && a.contactId === match.contactId) || (match.pendingActionId && a.pendingActionId === match.pendingActionId))) {
        a.status = 'RESOLVED'; a.resolvedAt = clock.now(); n += 1;
      }
    }
    if (n) await save(tenantId, doc);
    return n;
  });
}

// Vide les fenêtres d'agrégation en attente (arrêt propre / tests).
async function flushAll() {
  const keys = Array.from(windows.keys());
  for (const k of keys) {
    const tenant = k.split('|')[0];
    await flushWindow(tenant, k, await getPolicy(tenant));
  }
}

module.exports = { NAMESPACE, LEVELS, TYPES, DEFAULT_POLICY, rank, getPolicy, shouldNotify, formatAlert, raise, list, resolveAlerts, setDeliverers, addDeliverer, deliver, flushAll, useClock };
