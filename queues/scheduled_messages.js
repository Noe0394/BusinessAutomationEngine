'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storageAdapter = require('../ai-engine/storageAdapter');
const githubStore = require('../githubStore');

// Scheduled messages used to live in a single JSON file on Render's ephemeral
// filesystem. Store one document per tenant through the existing encrypted
// storage adapter instead, so separate accounts stay isolated and restart-safe.
const NAMESPACE = 'scheduled_messages';
const STORE_PATH = process.env.SCHEDULED_MESSAGES_PATH || path.join(__dirname, '..', 'scheduled_messages.json');
const MEDIA_REMOTE_DIR = process.env.GITHUB_SCHEDULED_MEDIA_DIR || 'scheduled_media';
const STATUSES = ['pending', 'sending', 'sent', 'failed', 'cancelled'];
const MAX_ATTEMPTS = 5;
const chains = new Map();
let initPromise = null;

function sanitizeTenant(id) {
  return String(id || '__admin__').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || '__admin__';
}
function tenantHash(id) { return crypto.createHash('sha256').update(sanitizeTenant(id)).digest('hex'); }
function uid() { return `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function withTenant(tenant, fn) {
  const key = sanitizeTenant(tenant);
  const previous = chains.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}
async function load(tenant) {
  const id = sanitizeTenant(tenant);
  return storageAdapter.get(NAMESPACE, id, { tenantId: id, messages: [] });
}
async function save(tenant, doc) {
  const id = sanitizeTenant(tenant);
  doc.tenantId = id;
  doc.updatedAt = new Date().toISOString();
  return storageAdapter.setDurable(NAMESPACE, id, doc);
}

async function readLegacyFile() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch (_) { /* no local legacy store */ }
  if (!githubStore.enabled) return null;
  const legacy = await githubStore.createStore('scheduled_messages.json').fetchRemote();
  const content = await githubStore.fetchRemoteContent(legacy);
  return content ? JSON.parse(content) : null;
}

async function importLegacyRecords() {
  const legacyRecords = await readLegacyFile();
  if (!Array.isArray(legacyRecords) || !legacyRecords.length) return 0;
  const grouped = new Map();
  for (const item of legacyRecords) {
    if (!item || !item.id) continue;
    const owner = item.tenantId ? sanitizeTenant(item.tenantId) : '__admin__';
    if (!grouped.has(owner)) grouped.set(owner, []);
    const record = { ...item, tenantId: owner, legacy: !item.tenantId };
    grouped.get(owner).push(record);
  }
  let imported = 0;
  for (const [tenant, messages] of grouped) {
    await withTenant(tenant, async () => {
      const doc = await load(tenant);
      const seen = new Set((doc.messages || []).map((item) => item.id));
      const missing = messages.filter((item) => !seen.has(item.id));
      if (!missing.length) return;
      doc.messages = (doc.messages || []).concat(missing);
      await save(tenant, doc);
      imported += missing.length;
    });
  }
  return imported;
}

async function initialize() {
  if (!initPromise) {
    initPromise = importLegacyRecords().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

async function persistMedia(tenantId, filename, buffer) {
  if (!githubStore.enabled) {
    if (process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL) {
      throw new Error('SCHEDULED_MEDIA_DURABLE_STORE_UNAVAILABLE');
    }
    return null;
  }
  const remotePath = `${MEDIA_REMOTE_DIR}/${tenantHash(tenantId)}/${path.basename(filename)}`;
  return githubStore.pushLargeFile(remotePath, Buffer.from(buffer));
}

async function list({ channel, tenantId, includeLegacy = false } = {}) {
  await initialize();
  const tenants = tenantId == null
    ? await storageAdapter.listIdsAsync(NAMESPACE)
    : [sanitizeTenant(tenantId)];
  const rows = [];
  for (const tenant of tenants) {
    const doc = await load(tenant);
    for (const item of doc.messages || []) {
      if (tenantId != null && String(item.tenantId || tenant) !== sanitizeTenant(tenantId)) continue;
      if (!includeLegacy && item.legacy) continue;
      if (channel && item.channel !== channel) continue;
      rows.push(item);
    }
  }
  return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function findTenantForId(id, options = {}) {
  if (options.tenantId != null) {
    const tenant = sanitizeTenant(options.tenantId);
    const doc = await load(tenant);
    if ((doc.messages || []).some((item) => item.id === id)) return tenant;
    return null;
  }
  for (const tenant of await storageAdapter.listIdsAsync(NAMESPACE)) {
    const doc = await load(tenant);
    if ((doc.messages || []).some((item) => item.id === id)) return tenant;
  }
  return null;
}

async function get(id, options = {}) {
  await initialize();
  const tenant = await findTenantForId(id, options);
  if (!tenant) return null;
  const doc = await load(tenant);
  return (doc.messages || []).find((item) => item.id === id) || null;
}

async function create({
  tenantId, channel, recipientType, recipients, message, mediaUrl, mediaMimetype,
  mediaFilename, media, sequence, sequenceDelayMinSeconds, sequenceDelayMaxSeconds,
  scheduledAt, keyword,
}) {
  await initialize();
  const tenant = sanitizeTenant(tenantId);
  const normalizedSequence = Array.isArray(sequence) && sequence.length ? sequence : null;
  const normalizedMedia = normalizedSequence
    ? normalizedSequence.filter((step) => step.type === 'media')
    : (Array.isArray(media) && media.length ? media : (mediaUrl ? [{ mediaUrl, mediaMimetype: mediaMimetype || null, mediaFilename: mediaFilename || null }] : []));
  const primary = normalizedMedia[0] || null;
  const derivedMessage = message || (normalizedSequence && (normalizedSequence.find((step) => step.type === 'text') || {}).text) || '';
  const entry = {
    id: uid(), tenantId: tenant, channel,
    recipientType: recipientType || null,
    recipients: Array.isArray(recipients) ? recipients : [],
    message: derivedMessage,
    media: normalizedMedia,
    mediaUrl: primary ? primary.mediaUrl : null,
    mediaMimetype: primary ? primary.mediaMimetype : null,
    mediaFilename: primary ? primary.mediaFilename : null,
    sequence: normalizedSequence,
    sequenceDelayMinSeconds: Number.isFinite(sequenceDelayMinSeconds) ? sequenceDelayMinSeconds : 2,
    sequenceDelayMaxSeconds: Number.isFinite(sequenceDelayMaxSeconds) ? sequenceDelayMaxSeconds : 5,
    keyword: keyword || null, scheduledAt,
    status: 'pending', attempts: 0, lastError: null, result: null,
    createdAt: new Date().toISOString(), sentAt: null,
  };
  await withTenant(tenant, async () => {
    const doc = await load(tenant);
    doc.messages = doc.messages || [];
    doc.messages.push(entry);
    await save(tenant, doc);
  });
  return entry;
}

async function update(id, patch, options = {}) {
  await initialize();
  const tenant = await findTenantForId(id, options);
  if (!tenant) return null;
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    const idx = (doc.messages || []).findIndex((item) => item.id === id);
    if (idx < 0) return null;
    doc.messages[idx] = { ...doc.messages[idx], ...patch };
    await save(tenant, doc);
    return doc.messages[idx];
  });
}

async function cancel(id, options = {}) {
  const entry = await get(id, options);
  if (!entry) return null;
  if (entry.status !== 'pending') throw new Error('ONLY_PENDING_CAN_BE_CANCELLED');
  return update(id, { status: 'cancelled' }, options);
}

async function getDuePending(now = new Date()) {
  const all = await list({ includeLegacy: true });
  return all.filter((item) => item.status === 'pending' && new Date(item.scheduledAt).getTime() <= now.getTime());
}

module.exports = { STATUSES, MAX_ATTEMPTS, NAMESPACE, initialize, persistMedia, list, get, create, update, cancel, getDuePending };
