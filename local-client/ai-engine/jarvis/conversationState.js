// État conversationnel persistant par (tenant, canal, contact) — mémoire compacte
// et éphémère (TTL 7×24 h glissant), jamais une archive des messages.
const storageAdapter = require('../storageAdapter');

const NAMESPACE = 'conversation_state';
const TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_RECENT_REPLIES = 6;
const MAX_PROCESSED_IDS = 50;

const STATES = [
  'NEW', 'DISCOVERY', 'INFORMATION', 'INTERESTED', 'OBJECTION', 'NEGOTIATION',
  'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'ENROLLED', 'WAITING', 'FOLLOW_UP',
  'REFUSED', 'CLOSED', 'SUPPORT', 'COMPLAINT',
];
const TERMINAL = new Set(['REFUSED', 'CLOSED', 'ENROLLED', 'PAYMENT_CONFIRMED']);

function sanitize(id) { return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown'; }
function conversationId(tenantId, channel, from) {
  return `${sanitize(tenantId)}__${sanitize(String(channel || '').toUpperCase())}__${sanitize(from)}`;
}

function blank(tenantId, channel, from) {
  const now = Date.now();
  return {
    conversationId: conversationId(tenantId, channel, from),
    tenantId: String(tenantId), platform: String(channel || '').toUpperCase(), chatId: String(from),
    state: 'NEW',
    refusal: { active: false, kind: null, count: 0, at: null },
    optOut: false,
    memory: { explained: [], accepted: [], refused: [], waiting: null, questions: {} },
    recentReplies: [],
    pendingActions: [],
    processedIds: [],
    lastMessage: null, lastMessageTs: null, lastReplyTs: null,
    turns: 0,
    createdAt: now, updatedAt: now, expiresAt: now + TTL_MS,
  };
}

function isExpired(doc, now) {
  const t = now == null ? Date.now() : now;
  return !doc || !doc.updatedAt || (t - doc.updatedAt) > TTL_MS || doc.updatedAt > t;
}

async function get(tenantId, channel, from) {
  const id = conversationId(tenantId, channel, from);
  const doc = await storageAdapter.get(NAMESPACE, id, null);
  if (!doc || isExpired(doc)) return blank(tenantId, channel, from);
  return doc;
}

function save(doc) {
  doc.updatedAt = Date.now();
  doc.expiresAt = doc.updatedAt + TTL_MS;
  doc.processedIds = (doc.processedIds || []).slice(-MAX_PROCESSED_IDS);
  doc.recentReplies = (doc.recentReplies || []).slice(-MAX_RECENT_REPLIES);
  return storageAdapter.set(NAMESPACE, doc.conversationId, doc);
}

// Purge : supprime tout document dont la dernière activité sort de la fenêtre 7×24 h.
async function purgeExpired(now) {
  const t = now == null ? Date.now() : now;
  let removed = 0;
  for (const id of storageAdapter.listIds(NAMESPACE)) {
    const doc = await storageAdapter.get(NAMESPACE, id, null);
    if (!doc || isExpired(doc, t)) { storageAdapter.remove(NAMESPACE, id); removed += 1; }
  }
  return removed;
}

// Le code décide de l'état ; l'IA n'écrit jamais directement dans l'état.
function nextState(prev, intent, flags) {
  const f = flags || {};
  switch (intent) {
    case 'STOP': return 'CLOSED';
    case 'REFUSAL': case 'DISINTEREST': case 'CANCELLATION': return 'REFUSED';
    case 'PAYMENT_INTENT': return f.deferral ? 'WAITING' : 'PAYMENT_PENDING';
    case 'PURCHASE_INTENT': return f.deferral ? 'WAITING' : 'INTERESTED';
    case 'PRICE_OBJECTION': case 'OBJECTION': return 'OBJECTION';
    case 'HESITATION': case 'LATER': case 'REQUEST_TIME': return 'WAITING';
    case 'QUESTION': case 'REQUEST_INFORMATION': case 'REQUEST_MORE_INFORMATION': return prev === 'NEW' ? 'DISCOVERY' : (TERMINAL.has(prev) ? 'INFORMATION' : (prev === 'PAYMENT_PENDING' ? prev : 'INFORMATION'));
    case 'INTEREST': return 'INTERESTED';
    case 'COMPLAINT': return 'COMPLAINT';
    case 'SUPPORT': return 'SUPPORT';
    case 'GREETING': return prev === 'NEW' ? 'DISCOVERY' : prev;
    default: return prev; // THANKS, CONFIRMATION, UNKNOWN : l'état ne change pas
  }
}

module.exports = { NAMESPACE, TTL_MS, STATES, TERMINAL, conversationId, blank, get, save, isExpired, purgeExpired, nextState };
