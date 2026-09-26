'use strict';

// Persistent, identity-bound confirmations for Tool Registry calls.
// The prepared tool arguments are the authority: a confirmation resumes these
// exact arguments and never asks the planner to reconstruct them.
const crypto = require('crypto');
const storage = require('./storageAdapter');
const vault = require('./secretVault');

const NS = 'pending_tool_actions';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL = new Set(['DONE', 'FAILED', 'REJECTED', 'EXPIRED', 'NEEDS_REVIEW']);
const locks = new Map();
const safe = (v) => String(v || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
const tenantKey = (tenant) => crypto.createHash('sha256').update(String(tenant || '')).digest('hex');

function withLock(tenant, fn) {
  const key = safe(tenant);
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

const load = (tenant) => storage.get(NS, tenantKey(tenant), { tenant: String(tenant || ''), actions: {} });
const persist = (tenant, doc) => storage.setDurable(NS, tenantKey(tenant), doc);

function hasSecretField(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /(?:api.?key|access.?token|refresh.?token|password|passwd|secret|authorization|bearer)/i.test(key)
      || hasSecretField(child));
}

function packPayload(payload) {
  const raw = JSON.stringify(payload || {});
  if (hasSecretField(payload)) {
    if (!vault.isEncryptionConfigured()) throw new Error('PENDING_ACTION_ENCRYPTION_REQUIRED');
    return { payloadEncrypted: vault.encrypt(raw) };
  }
  return { payload: payload || {} };
}

function unpackPayload(action) {
  if (action && action.payloadEncrypted) {
    const raw = vault.decrypt(action.payloadEncrypted);
    if (!raw) throw new Error('PENDING_ACTION_DECRYPT_FAILED');
    return JSON.parse(raw);
  }
  return (action && action.payload) || {};
}

async function expire(tenant, doc) {
  let changed = false;
  const now = Date.now();
  for (const action of Object.values(doc.actions || {})) {
    if (action.status === 'PENDING' && action.expiresAt && action.expiresAt <= now) {
      action.status = 'EXPIRED'; action.updatedAt = now; changed = true;
    }
  }
  if (changed) await persist(tenant, doc);
}

async function create(tenant, spec) {
  return withLock(tenant, async () => {
    const doc = await load(tenant);
    await expire(tenant, doc);
    const now = Date.now();
    const id = 'ACT-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const action = Object.assign({
      pendingActionId: id,
      tenantId: String(tenant || ''),
      userId: String(spec.userId || ''),
      role: String(spec.role || ''),
      conversationId: String(spec.conversationId || spec.sessionId || ''),
      sessionId: String(spec.sessionId || ''),
      serviceId: spec.serviceId || null,
      tool: String(spec.tool || ''),
      riskLevel: String(spec.riskLevel || 'WRITE'),
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + (Number(spec.ttlMs) > 0 ? Number(spec.ttlMs) : DEFAULT_TTL_MS),
      history: [{ at: now, status: 'PENDING' }],
    }, packPayload(spec.payload));
    doc.actions[id] = action;
    await persist(tenant, doc);
    return action;
  });
}

function matches(action, identity) {
  const x = identity || {};
  return action && action.tenantId === String(x.tenant || '')
    && action.userId === String(x.userId || '')
    && action.conversationId === String(x.conversationId || x.sessionId || '')
    && (!x.role || action.role === x.role);
}

async function listOpen(tenant, identity) {
  return withLock(tenant, async () => {
    const doc = await load(tenant);
    await expire(tenant, doc);
    return Object.values(doc.actions || {}).filter((action) => action.status === 'PENDING' && matches(action, identity));
  });
}

async function listForIdentity(tenant, identity) {
  const doc = await load(tenant);
  return Object.values(doc.actions || {}).filter((action) => matches(action, identity))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function get(tenant, id) {
  const doc = await load(tenant);
  const action = doc.actions[String(id || '').toUpperCase()];
  if (!action) return null;
  if (action.status === 'PENDING' && action.expiresAt <= Date.now()) {
    const result = await transition(tenant, action.pendingActionId, 'PENDING', 'EXPIRED');
    return result.action;
  }
  return action;
}

async function readPayload(action) { return unpackPayload(action); }

async function transition(tenant, id, from, to, fields) {
  return withLock(tenant, async () => {
    const doc = await load(tenant);
    const action = doc.actions[String(id || '').toUpperCase()];
    if (!action) return { ok: false, reason: 'NOT_FOUND', action: null };
    const expected = Array.isArray(from) ? from : [from];
    if (!expected.includes(action.status)) return { ok: false, reason: 'BAD_STATE', action };
    if (action.status === 'PENDING' && action.expiresAt <= Date.now() && to !== 'EXPIRED') {
      action.status = 'EXPIRED'; action.updatedAt = Date.now();
      action.history.push({ at: action.updatedAt, status: 'EXPIRED' });
      await persist(tenant, doc);
      return { ok: false, reason: 'EXPIRED', action };
    }
    if (fields && fields.payload) {
      delete action.payload; delete action.payloadEncrypted;
      Object.assign(action, packPayload(fields.payload));
    }
    if (fields) {
      const safeFields = Object.assign({}, fields); delete safeFields.payload;
      Object.assign(action, safeFields);
    }
    action.status = to; action.updatedAt = Date.now();
    action.history.push({ at: action.updatedAt, status: to });
    await persist(tenant, doc);
    return { ok: true, action };
  });
}

async function list(tenant, limit) {
  const doc = await load(tenant);
  return Object.values(doc.actions || {}).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Number(limit) || 50));
}

module.exports = { NS, DEFAULT_TTL_MS, TERMINAL, create, get, readPayload, listOpen, listForIdentity, list, transition };
