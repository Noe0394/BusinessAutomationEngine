// PENDING ACTIONS — ai-engine/pendingActions.js
// ---------------------------------------------------------------------------
// Toute action qui attend une décision du propriétaire (validation de paiement, action sensible…) est enregistrée ici
// avec un identifiant PRÉCIS (PA-XXXX). Une réponse « OUI » / « NON » du propriétaire n'est JAMAIS appliquée « au dernier
// paiement global » : elle est reliée à UNE action (identifiant cité, message notifié cité en réponse, ou unique action
// ouverte) — sinon on demande laquelle.
//
// États : PENDING -> APPROVED -> EXECUTING -> DONE | FAILED ;  PENDING -> REJECTED ;  PENDING -> EXPIRED.
// Idempotence : `idempotencyKey` identique = même action (message dupliqué, reconnexion, retry). `claim` est atomique
// dans le process : un seul exécutant par action, un « OUI » répété ne relance jamais l'exécution.

const storageAdapter = require('./storageAdapter');

const NAMESPACE = 'pending_actions';
const DEFAULT_TTL_MS = 72 * 3600 * 1000;
const MAX_ITEMS = 500;
const OPEN = new Set(['PENDING']);
const TERMINAL = new Set(['REJECTED', 'DONE', 'FAILED', 'EXPIRED']);

const sanitize = (t) => String(t || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
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
const persist = (tenantId, doc) => {
  if (doc.items.length > MAX_ITEMS) {
    // Purge les plus anciennes actions TERMINÉES, jamais une action encore ouverte.
    const keep = doc.items.filter((a) => !TERMINAL.has(a.status));
    const done = doc.items.filter((a) => TERMINAL.has(a.status)).slice(-(MAX_ITEMS - keep.length > 0 ? MAX_ITEMS - keep.length : 0));
    doc.items = keep.concat(done).sort((a, b) => a.createdAt - b.createdAt);
  }
  return storageAdapter.set(NAMESPACE, sanitize(tenantId), doc);
};

function newId(doc) {
  const used = new Set(doc.items.map((a) => a.pendingActionId));
  for (let i = 0; i < 50; i++) {
    const id = 'PA-' + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X').padEnd(4, 'X');
    if (!used.has(id)) return id;
  }
  return 'PA-' + Date.now().toString(36).toUpperCase();
}

function expireStale(doc, now) {
  let changed = false;
  for (const a of doc.items) {
    if (a.status === 'PENDING' && a.expiresAt && a.expiresAt <= now) { a.status = 'EXPIRED'; a.updatedAt = now; changed = true; }
  }
  return changed;
}

// Crée (ou retrouve) une action en attente. Retourne { action, created }.
async function create(tenantId, spec) {
  return withLock(tenantId, async () => {
    const s = spec || {};
    const now = Date.now();
    const doc = await load(tenantId);
    if (expireStale(doc, now)) await persist(tenantId, doc);
    if (s.idempotencyKey) {
      const existing = doc.items.find((a) => a.idempotencyKey === s.idempotencyKey);
      if (existing) return { action: existing, created: false };
    }
    const action = {
      pendingActionId: newId(doc),
      tenantId: sanitize(tenantId),
      type: String(s.type || 'GENERIC'),
      status: 'PENDING',
      summary: String(s.summary || '').slice(0, 300),
      payload: s.payload || {},
      conversationId: s.conversationId || null,
      idempotencyKey: s.idempotencyKey || null,
      notification: null, // { messageId, at } du message envoyé au propriétaire (pour la réponse « en citation »)
      createdAt: now, updatedAt: now,
      expiresAt: now + (Number(s.ttlMs) > 0 ? Number(s.ttlMs) : DEFAULT_TTL_MS),
      history: [{ at: now, status: 'PENDING' }],
    };
    doc.items.push(action);
    await persist(tenantId, doc);
    return { action, created: true };
  });
}

async function get(tenantId, id) {
  const doc = await load(tenantId);
  const key = String(id || '').toUpperCase();
  return doc.items.find((a) => a.pendingActionId === key) || null;
}

async function listOpen(tenantId, type) {
  return withLock(tenantId, async () => {
    const doc = await load(tenantId);
    if (expireStale(doc, Date.now())) await persist(tenantId, doc);
    return doc.items.filter((a) => OPEN.has(a.status) && (!type || a.type === type));
  });
}

async function listAll(tenantId, limit) {
  const doc = await load(tenantId);
  return doc.items.slice(-(limit || 50)).reverse();
}

// Mise à jour contrôlée d'un champ non-statut (notification, payload…).
async function patch(tenantId, id, fields) {
  return withLock(tenantId, async () => {
    const doc = await load(tenantId);
    const a = doc.items.find((x) => x.pendingActionId === String(id).toUpperCase());
    if (!a) return null;
    Object.assign(a, fields || {}, { updatedAt: Date.now() });
    await persist(tenantId, doc);
    return a;
  });
}

// Transition atomique. `from` = état(s) attendu(s) ; refuse toute autre transition (pas de double exécution).
// Retourne { ok, action, reason }.
async function transition(tenantId, id, from, to, extra) {
  return withLock(tenantId, async () => {
    const doc = await load(tenantId);
    const a = doc.items.find((x) => x.pendingActionId === String(id).toUpperCase());
    if (!a) return { ok: false, reason: 'NOT_FOUND' };
    expireStale(doc, Date.now());
    const allowed = Array.isArray(from) ? from : [from];
    if (!allowed.includes(a.status)) return { ok: false, reason: 'BAD_STATE', action: a };
    a.status = to;
    a.updatedAt = Date.now();
    a.history.push({ at: a.updatedAt, status: to, by: (extra && extra.by) || null });
    if (extra && extra.fields) Object.assign(a, extra.fields);
    await persist(tenantId, doc);
    return { ok: true, action: a };
  });
}

// Retrouve l'action visée par le propriétaire. Ordre : identifiant cité > message notifié cité en réponse > unique
// action ouverte. Sinon { ambiguous } (liste) ou { none }. Jamais « la dernière » par défaut.
async function resolveTarget(tenantId, { pendingActionId, quotedMessageId, type }) {
  const open = await listOpen(tenantId, type);
  if (pendingActionId) {
    const a = await get(tenantId, pendingActionId);
    return a ? { action: a, open } : { notFound: true, open };
  }
  if (quotedMessageId) {
    const a = open.find((x) => x.notification && String(x.notification.messageId) === String(quotedMessageId));
    if (a) return { action: a, open };
  }
  if (open.length === 1) return { action: open[0], open };
  if (open.length === 0) return { none: true, open };
  return { ambiguous: true, open };
}

module.exports = { NAMESPACE, create, get, listOpen, listAll, patch, transition, resolveTarget, OPEN, TERMINAL };
