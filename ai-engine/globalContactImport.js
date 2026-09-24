'use strict';

const crypto = require('node:crypto');
const storage = require('./storageAdapter');
const extractor = require('./contactExtractor');
const pipeline = require('./contactsPipeline');
const resolver = require('./contactIdentity');
const sync = require('./globalContactSync');
const durableStore = require('./contactDurableStore');

const NAMESPACE = 'contact_import_jobs';
const BATCH_SIZE = 100;
const jobs = new Map();

function save(job) {
  job.updatedAt = new Date().toISOString();
  storage.set(NAMESPACE, job.id, job);
  jobs.set(job.id, job);
  if (durableStore.enabled()) durableStore.put(NAMESPACE, job.id, job).catch(() => {});
  return job;
}
async function get(id) {
  if (jobs.has(id)) return jobs.get(id);
  let job = await storage.get(NAMESPACE, id, null);
  if (!job && durableStore.enabled()) {
    try { job = await durableStore.get(NAMESPACE, id); } catch (_) { job = null; }
    if (job) storage.set(NAMESPACE, id, job);
  }
  if (job) jobs.set(id, job);
  return job;
}
function publicJob(job) {
  if (!job) return null;
  const { events, ...summary } = job;
  return summary;
}
function contactEntries(file, { from, to, defaultCountryCode, channel } = {}) {
  const parsed = extractor.extractFromFile({ buffer: file.buffer, name: file.originalname, type: file.mimetype });
  const start = Math.max(1, Number(from) || 1);
  const end = Math.max(start, Number(to) || parsed.entries.length);
  const selected = parsed.entries.slice(start - 1, end);
  const seen = new Set();
  const events = [];
  let duplicates = 0;
  let invalid = 0;
  let withoutIdentity = 0;
  const phoneRows = [];
  for (let index = 0; index < selected.length; index += 1) {
    const entry = selected[index] || {};
    let identity;
    let dedupeKey;
    if (entry.phone) {
      const normalized = pipeline.normalizeOne(entry.phone, { defaultCountryCode });
      const checked = pipeline.validateContacts([{ phone: entry.phone, normalized: normalized.phone, normalizeIssue: normalized.reason }]);
      if (!checked.valid.length) { invalid += 1; continue; }
      const e164 = `+${normalized.phone}`;
      identity = resolver.resolveIdentity({ channel: String(channel || 'WHATSAPP').toUpperCase(), phone: e164, knownName: entry.name || null });
      dedupeKey = `phone:${e164}`;
      phoneRows.push(e164);
    } else if (entry.username && String(channel).toUpperCase() === 'TELEGRAM') {
      const username = String(entry.username).replace(/^@/, '');
      identity = resolver.resolveIdentity({ channel: 'TELEGRAM', username, knownName: entry.name || null });
      dedupeKey = `username:${username.toLowerCase()}`;
    } else {
      withoutIdentity += 1;
      continue;
    }
    if (seen.has(dedupeKey)) { duplicates += 1; continue; }
    seen.add(dedupeKey);
    events.push(sync.makeEvent({
      tenantId: '__global_admin_import__', channel: identity.channel, identity, name: entry.name,
      source: 'admin_import', eventId: `${dedupeKey}:${start + index}`,
    }));
  }
  return { parsed, selected, events: events.filter(Boolean), duplicates, invalid, withoutIdentity, phoneRows: Array.from(new Set(phoneRows)) };
}

async function preview(file, opts = {}) {
  const parsed = contactEntries(file, opts);
  const existing = new Set();
  let countryDetected = 0;
  for (let i = 0; i < parsed.phoneRows.length; i += 1000) {
    const r = await sync.request('/preview', { method: 'POST', body: { phones: parsed.phoneRows.slice(i, i + 1000) } });
    for (const row of (r.results || [])) {
      if (row.exists) existing.add(row.phone);
      if (row.country) countryDetected += 1;
    }
  }
  const totalFound = parsed.selected.length;
  const reliableEvents = parsed.events.length;
  return {
    totalFound, selectedRows: parsed.selected.length, uniqueContacts: reliableEvents,
    newContacts: parsed.events.filter((e) => e.phone && !existing.has(e.phone)).length,
    alreadyPresent: parsed.events.filter((e) => e.phone && existing.has(e.phone)).length,
    duplicatesInFile: parsed.duplicates, invalid: parsed.invalid, withoutReliableIdentity: parsed.withoutIdentity,
    countryDetected,
    phoneContacts: parsed.phoneRows.length, nonPhoneIdentities: parsed.events.filter((e) => !e.phone).length,
    range: { from: Math.max(1, Number(opts.from) || 1), to: Math.max(1, Number(opts.to) || parsed.parsed.entries.length) },
  };
}

async function run(id) {
  const job = await get(id);
  if (!job || ['complete', 'complete_with_pending_sync', 'cancelled'].includes(job.status) || job.running) return;
  job.running = true;
  job.status = 'running';
  save(job);
  try {
    while (job.events.length) {
      const batch = job.events.slice(0, BATCH_SIZE);
      const result = await sync.request('/events', { method: 'POST', body: { events: batch } });
      const rows = Array.isArray(result.results) ? result.results : [];
      job.created += rows.filter((x) => x.status === 'created').length;
      job.alreadyPresent += rows.filter((x) => x.status === 'updated' || x.status === 'duplicate_event').length;
      job.excluded += rows.filter((x) => x.status === 'excluded_primary_admin').length;
      const failedIndexes = new Set(rows.map((x, i) => x.status === 'failed' ? i : -1).filter((i) => i >= 0));
      const failedEvents = batch.filter((_, i) => failedIndexes.has(i));
      job.failures = failedEvents.length;
      job.processed += batch.length - failedEvents.length;
      job.events = failedEvents.concat(job.events.slice(batch.length));
      job.progress = job.total ? Math.round(job.processed / job.total * 100) : 100;
      save(job);
      if (failedEvents.length) throw new Error('CENTRAL_CONTACT_BATCH_PARTIAL_FAILURE');
    }
    job.status = 'complete';
    job.progress = 100;
    job.finishedAt = new Date().toISOString();
    save(job);
  } catch (err) {
    job.status = 'retrying';
    job.lastError = String(err.message || err).slice(0, 180);
    job.attempts = (job.attempts || 0) + 1;
    save(job);
    const delay = Math.min(60000, 1000 * (2 ** Math.min(job.attempts, 6)));
    const timer = setTimeout(() => run(id).catch(() => {}), delay);
    if (typeof timer.unref === 'function') timer.unref();
  } finally {
    job.running = false;
    save(job);
  }
  return publicJob(job);
}

async function start(file, opts = {}) {
  const parsed = contactEntries(file, opts);
  if (!parsed.events.length) return { job: null, report: {
    totalFound: parsed.selected.length, uniqueContacts: 0, newContacts: 0, alreadyPresent: 0,
    duplicatesInFile: parsed.duplicates, invalid: parsed.invalid, withoutReliableIdentity: parsed.withoutIdentity,
  } };
  const remote = await sync.request('/status');
  if (!remote || !remote.configured) throw new Error('PRIMARY_ADMIN_NOT_RESOLVED');
  const previewReport = await preview(file, opts);
  const id = `contact_import_${crypto.randomUUID()}`;
  const job = {
    id, type: 'global_contact_import', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    progress: 0, processed: 0, total: parsed.events.length, events: parsed.events,
    created: 0, alreadyPresent: 0, excluded: 0, failures: 0, attempts: 0,
    expectedNew: previewReport.newContacts, expectedExisting: previewReport.alreadyPresent,
    duplicatesInFile: parsed.duplicates, invalid: parsed.invalid, withoutReliableIdentity: parsed.withoutIdentity,
    selectedRows: parsed.selected.length, from: Math.max(1, Number(opts.from) || 1), to: Math.max(1, Number(opts.to) || parsed.parsed.entries.length),
  };
  save(job);
  setImmediate(() => run(id).catch(() => {}));
  return { job: publicJob(job), report: previewReport };
}

async function init() {
  if (durableStore.enabled()) {
    try {
      for (const id of await durableStore.list(NAMESPACE)) {
        if (jobs.has(id)) continue;
        const job = await durableStore.get(NAMESPACE, id);
        if (job) { jobs.set(id, job); storage.set(NAMESPACE, id, job); }
      }
    } catch (err) { console.error('Restauration chiffrée des imports contacts :', err.message); }
  }
  for (const id of storage.listIds(NAMESPACE)) {
    const job = await get(id);
    if (job && ['queued', 'running', 'retrying'].includes(job.status)) setImmediate(() => run(id).catch(() => {}));
  }
}

module.exports = { NAMESPACE, BATCH_SIZE, preview, start, get, run, init, publicJob };
