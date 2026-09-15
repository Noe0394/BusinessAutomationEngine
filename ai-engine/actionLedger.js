const storageAdapter = require('./storageAdapter');

// REGISTRE D'ACTIONS (machine à états) — ai-engine/actionLedger.js
// ---------------------------------------------------------------------------
// Garantit la RÉALITÉ de l'exécution : chaque action réelle (envoi de message,
// etc.) est tracée avec un état qui ne peut passer à SUCCESS que sur
// CONFIRMATION réelle. Interdit les faux positifs : une simple tentative reste
// IN_PROGRESS/PENDING, un échec reste FAILED. L'agent lit ce registre pour
// rapporter un statut qui correspond TOUJOURS à l'état réel du système.
//
// États : REQUESTED -> IN_PROGRESS -> SUCCESS | FAILED | PENDING.
// Persisté par tenant (storageAdapter, miroir GitHub côté VPS), borné.

const NAMESPACE = 'action_ledger';
const MAX_PER_TENANT = 500;

const STATUS = { REQUESTED: 'REQUESTED', IN_PROGRESS: 'IN_PROGRESS', SUCCESS: 'SUCCESS', FAILED: 'FAILED', PENDING: 'PENDING' };

function sanitize(id) { return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default'; }
function uid() { return 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function load(tenantId) {
  return storageAdapter.get(NAMESPACE, sanitize(tenantId), { tenantId: sanitize(tenantId), actions: [] });
}
function save(tenantId, doc) {
  doc.actions = (doc.actions || []).slice(-MAX_PER_TENANT);
  return storageAdapter.set(NAMESPACE, sanitize(tenantId), doc);
}
function findIdx(doc, id) { return (doc.actions || []).findIndex((a) => a.id === id); }

// Crée une action à l'état REQUESTED. `type` ex. 'SEND_MESSAGE', channel,
// target (destinataire), payload (texte...).
async function create(tenantId, { type, channel, target, payload }) {
  const doc = await load(tenantId);
  const action = {
    id: uid(), tenantId: sanitize(tenantId),
    type: type || 'ACTION', channel: channel || null, target: target || null,
    payload: payload || null,
    status: STATUS.REQUESTED,
    requestedAt: new Date().toISOString(),
    startedAt: null, finishedAt: null,
    confirmation: null, error: null,
  };
  doc.actions = Array.isArray(doc.actions) ? doc.actions : [];
  doc.actions.push(action);
  save(tenantId, doc);
  return action;
}

async function update(tenantId, id, patch) {
  const doc = await load(tenantId);
  const i = findIdx(doc, id);
  if (i < 0) return null;
  doc.actions[i] = Object.assign(doc.actions[i], patch);
  save(tenantId, doc);
  return doc.actions[i];
}

function markInProgress(tenantId, id) {
  return update(tenantId, id, { status: STATUS.IN_PROGRESS, startedAt: new Date().toISOString() });
}
// SUCCESS UNIQUEMENT sur confirmation réelle (ex. identifiant de message renvoyé
// par la plateforme). `confirmation` doit être une preuve réelle, jamais vide.
function markSuccess(tenantId, id, confirmation) {
  return update(tenantId, id, { status: STATUS.SUCCESS, finishedAt: new Date().toISOString(), confirmation: confirmation || { note: 'confirmé' } });
}
function markFailed(tenantId, id, error) {
  return update(tenantId, id, { status: STATUS.FAILED, finishedAt: new Date().toISOString(), error: String(error || 'échec inconnu') });
}
function markPending(tenantId, id, note) {
  return update(tenantId, id, { status: STATUS.PENDING, note: note || 'non confirmé' });
}

async function get(tenantId, id) {
  const doc = await load(tenantId);
  const i = findIdx(doc, id);
  return i >= 0 ? doc.actions[i] : null;
}
async function listRecent(tenantId, n) {
  const doc = await load(tenantId);
  return (doc.actions || []).slice(-(Math.max(1, Math.min(200, n || 20)))).reverse();
}

module.exports = { STATUS, create, markInProgress, markSuccess, markFailed, markPending, get, listRecent, NAMESPACE };
