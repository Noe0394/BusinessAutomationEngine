'use strict';

// Client de synchronisation vers le registre D1 maître. Les actions Cyrus
// n'attendent pas le réseau : l'événement minimal est d'abord écrit dans le
// petit outbox local, puis envoyé par lots. La clé d'idempotence est stable.
const crypto = require('node:crypto');
const storage = require('./storageAdapter');
const durableStore = require('./contactDurableStore');

const NAMESPACE = 'contact_sync_outbox';
const OUTBOX_ID = 'pending';
const BATCH_SIZE = 100;
let flushing = null;
let timer = null;
let lastError = null;
let lastSuccessAt = null;

function endpoint() {
  const base = String(process.env.CLOUDFLARE_LICENSE_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/contacts/events` : '';
}
function contactsUrl(path = '/') {
  const base = String(process.env.CLOUDFLARE_LICENSE_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/contacts${path.startsWith('/') ? path : `/${path}`}` : '';
}
function configured() {
  return !!(endpoint() && process.env.CLOUDFLARE_ADMIN_SECRET);
}
function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function safeText(value, max = 180) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null;
}
function makeEvent({ tenantId, channel, identity, source, eventId, context = {}, name, at } = {}) {
  if (!tenantId || !channel || !identity) return null;
  const platform = String(channel).toUpperCase();
  // Ne pas reconstituer un E.164 à partir d'une suite numérique brute. Le
  // + doit provenir de l'Identity Resolver ou d'un import normalisé avec un
  // indicatif explicite.
  const rawPhone = identity.internationalPhoneNumber || identity.phoneNumber || null;
  const realPhone = rawPhone && /^\+[1-9]\d{7,14}$/.test(String(rawPhone)) ? String(rawPhone) : null;
  const technicalId = identity.lid || identity.jid || identity.username || null;
  const idempotencyKey = `evt_${sha([tenantId, platform, eventId || technicalId || realPhone || 'unknown', at || Date.now()].join('|'))}`;
  return {
    idempotencyKey,
    eventType: 'CONTACT_USED_BY_CYRUS',
    tenantId: String(tenantId),
    channel: platform,
    source: safeText(source || 'incoming_message', 80),
    phone: realPhone ? String(realPhone) : null,
    technicalId: technicalId ? String(technicalId) : null,
    name: safeText(name || identity.displayName, 120),
    conversationId: safeText(identity.conversationId, 180),
    groupId: safeText(context.groupId, 180),
    groupName: safeText(context.groupName, 180),
    campaignId: safeText(context.campaignId, 180),
    campaignName: safeText(context.campaignName, 180),
    serviceId: safeText(context.serviceId, 180),
    serviceName: safeText(context.serviceName, 180),
    category: safeText(context.category, 100),
    interests: Array.isArray(context.interests) ? context.interests.map((x) => safeText(x, 80)).filter(Boolean).slice(0, 20) : [],
    status: safeText(context.status || 'active', 40),
    occurredAt: at || new Date().toISOString(),
  };
}

function readOutbox() {
  return storage.get(NAMESPACE, OUTBOX_ID, { version: 1, events: [] });
}
function writeOutbox(doc) {
  return storage.set(NAMESPACE, OUTBOX_ID, doc);
}
async function persistBackup(doc) {
  if (!durableStore.enabled()) return false;
  await durableStore.put('contact_sync_outbox', 'pending', doc);
  return true;
}
async function restoreBackup() {
  if (!durableStore.enabled()) return { restored: 0 };
  const backup = await durableStore.get('contact_sync_outbox', 'pending');
  if (!backup || !Array.isArray(backup.events) || !backup.events.length) return { restored: 0 };
  const local = await readOutbox();
  const events = new Map((local.events || []).map((item) => [item.event.idempotencyKey, item]));
  for (const item of backup.events) if (item && item.event && item.event.idempotencyKey && !events.has(item.event.idempotencyKey)) events.set(item.event.idempotencyKey, item);
  const merged = { version: 1, events: Array.from(events.values()) };
  writeOutbox(merged);
  return { restored: Math.max(0, merged.events.length - (local.events || []).length) };
}

async function enqueue(input) {
  return enqueueMany([input]);
}

async function enqueueMany(inputs) {
  if (!configured()) return { queued: false, reason: 'CENTRAL_CONTACT_STORE_NOT_CONFIGURED' };
  const events = (Array.isArray(inputs) ? inputs : []).map(makeEvent).filter(Boolean);
  if (!events.length) return { queued: false, reason: 'INVALID_CONTACT_EVENT' };
  const doc = await readOutbox();
  doc.events = Array.isArray(doc.events) ? doc.events : [];
  const known = new Set(doc.events.map((item) => item.idempotencyKey));
  for (const event of events) if (!known.has(event.idempotencyKey)) {
    known.add(event.idempotencyKey);
    doc.events.push({ event, attempts: 0, queuedAt: new Date().toISOString() });
  }
  writeOutbox(doc);
  setImmediate(async () => {
    try { await persistBackup(doc); } catch (err) { lastError = `DURABLE_BACKUP_${err.message}`; }
    flush().catch((err) => { lastError = err.message; });
  });
  return { queued: true, queuedCount: events.length, idempotencyKeys: events.map((e) => e.idempotencyKey) };
}

async function postBatch(events, fetchImpl = globalThis.fetch) {
  return request('/events', { method: 'POST', body: { events } }, fetchImpl);
}

async function request(path, options = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_UNAVAILABLE');
  if (!contactsUrl(path) || !process.env.CLOUDFLARE_ADMIN_SECRET) throw new Error('CENTRAL_CONTACT_STORE_NOT_CONFIGURED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(contactsUrl(path), {
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-admin-secret': process.env.CLOUDFLARE_ADMIN_SECRET },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`CONTACTS_SYNC_HTTP_${response.status}${data.error ? `_${String(data.error).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 70)}` : ''}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function flush({ fetchImpl } = {}) {
  if (flushing) return flushing;
  if (!configured()) return { sent: 0, pending: 0, enabled: false };
  flushing = (async () => {
    const doc = await readOutbox();
    const queued = Array.isArray(doc.events) ? doc.events : [];
    if (!queued.length) return { sent: 0, pending: 0, enabled: true };
    let sent = 0;
    for (let i = 0; i < queued.length; i += BATCH_SIZE) {
      const batch = queued.slice(i, i + BATCH_SIZE);
      try {
        await postBatch(batch.map((x) => x.event), fetchImpl);
        const keys = new Set(batch.map((x) => x.event.idempotencyKey));
        doc.events = doc.events.filter((x) => !keys.has(x.event.idempotencyKey));
        writeOutbox(doc);
        sent += batch.length;
        lastSuccessAt = new Date().toISOString();
        lastError = null;
        const byTenant = new Map();
        for (const item of batch) {
          const tenant = item.event.tenantId;
          byTenant.set(tenant, (byTenant.get(tenant) || 0) + 1);
        }
        for (const [tenant, count] of byTenant) {
          const prior = await storage.get('contact_sync_status', tenant, { sent: 0 });
          storage.set('contact_sync_status', tenant, { configured: true, sent: (prior.sent || 0) + count, lastSuccessAt, pending: doc.events.filter((x) => x.event.tenantId === tenant).length });
        }
      } catch (err) {
        batch.forEach((x) => { x.attempts = (x.attempts || 0) + 1; x.lastAttemptAt = new Date().toISOString(); });
        writeOutbox(doc);
        lastError = err.message;
        try { await persistBackup(doc); } catch (backupErr) { lastError = `${err.message}; DURABLE_BACKUP_${backupErr.message}`; }
        break;
      }
    }
    if (sent > 0 && !doc.events.length) {
      try { await persistBackup(doc); } catch (err) { lastError = `DURABLE_BACKUP_${err.message}`; }
    }
    return { sent, pending: doc.events.length, enabled: true };
  })().finally(() => { flushing = null; });
  return flushing;
}

async function init() {
  try { await restoreBackup(); }
  catch (err) { lastError = `DURABLE_RESTORE_${err.message}`; }
  if (!timer) {
    timer = setInterval(() => { flush().catch((err) => { lastError = err.message; }); }, 15000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  setImmediate(() => flush().catch((err) => { lastError = err.message; }));
}

async function status() {
  const doc = configured() ? await readOutbox() : { events: [] };
  return {
    configured: configured(),
    pending: Array.isArray(doc.events) ? doc.events.length : 0,
    lastSuccessAt,
    lastError,
    durableBackup: durableStore.status(),
  };
}

async function statusForTenant(tenantId) {
  const doc = configured() ? await readOutbox() : { events: [] };
  const pending = (doc.events || []).filter((x) => x.event.tenantId === String(tenantId)).length;
  const syncState = await storage.get('contact_sync_status', tenantId, { sent: 0, lastSuccessAt: null });
  return { configured: configured(), pending, sent: syncState.sent || 0, lastSuccessAt: syncState.lastSuccessAt || null, lastError: pending ? lastError : null };
}

module.exports = { NAMESPACE, makeEvent, enqueue, enqueueMany, flush, init, status, statusForTenant, postBatch, request, contactsUrl, persistBackup, restoreBackup };
