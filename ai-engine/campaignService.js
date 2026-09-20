// Service Campagnes unifié (WhatsApp + Telegram) : destinataires -> brouillon -> lancement/programmation -> suivi -> rapport.
// N'exécute AUCUN envoi lui-même : le lancement passe par runtime.sendCampaign (moteurs de campagne existants, avec
// cadence, protections anti-blocage, persistance et reprise). Les statuts affichés viennent des moteurs, jamais d'un
// état d'interface.
const pipeline = require('./contactsPipeline');
const ocrProvider = require('./ocrProvider');
const chatUploads = require('./chatUploads');
const contactCrm = require('./contactCrm');
const storageAdapter = require('./storageAdapter');
const taskQueue = require('./taskQueue');
const continuity = require('./campaignContinuity');
const status = require('../lib/campaignStatus');

const CHANNELS = ['WHATSAPP', 'TELEGRAM'];
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const chan = (c) => String(c || 'WHATSAPP').toUpperCase();
const err = (code, message, http) => Object.assign(new Error(message || code), { code, http: http || 400 });

const load = (tenant) => storageAdapter.get('campaign_drafts', sanitize(tenant), { tenant: sanitize(tenant), drafts: {} });
const save = (tenant, doc) => storageAdapter.set('campaign_drafts', sanitize(tenant), doc);

function requireChannelModule(allowedModules, channel) {
  if (allowedModules === null || allowedModules === undefined) return;
  const need = channel === 'TELEGRAM' ? 'telegram' : 'whatsapp';
  if (!Array.isArray(allowedModules) || !allowedModules.includes(need)) throw err('MODULE_NOT_ALLOWED', `Votre clé de licence n'inclut pas le module "${need}".`, 403);
}

// Lancement RÉEL : filtre des refus, média éventuel, puis runtime.sendCampaign (moteurs existants).
async function launchDraft(tenant, draft, runtime) {
  const fail = (code, message, retryable) => ({ ok: false, error: { code, message: message || code, retryable: !!retryable } });
  if (!runtime || typeof runtime.sendCampaign !== 'function') return fail('RUNTIME_MISSING', 'Moteur de campagne indisponible.');
  const optedOut = await contactCrm.optedOutSet(tenant, draft.channel);
  // Les contacts ayant demandé l'arrêt sont exclus PAR DÉFAUT ; l'utilisateur peut décider de les inclure (includeOptOut).
  const recipients = draft.includeOptOut ? draft.recipients : draft.recipients.filter((r) => !optedOut.has(contactCrm.identityOf(r.telephone || r)));
  if (!recipients.length) return fail('EMPTY_RECIPIENTS', 'Tous les destinataires sont exclus (refus) ou la liste est vide.');
  const payload = { channel: draft.channel, tenantId: tenant, recipients, text: draft.text, name: draft.name };
  if (draft.mediaFileId) {
    if (draft.channel !== 'WHATSAPP') return fail('MEDIA_NOT_SUPPORTED_CHANNEL', 'Média de campagne géré uniquement pour WhatsApp.');
    const f = await chatUploads.readFile(tenant, draft.mediaFileId);
    if (!f) return fail('MEDIA_NOT_FOUND', 'Média introuvable.');
    payload.sequence = [{ type: 'media', buffer: f.buffer, mimetype: f.meta.type, filename: f.meta.name }, { type: 'text', text: draft.text }];
  }
  const out = await runtime.sendCampaign(payload);
  if (!out || out.ok === false) return fail('LAUNCH_FAILED', (out && out.error) || 'échec du lancement', true);
  return { ok: true, result: Object.assign({ excludedOptOut: draft.recipients.length - recipients.length }, out.result || {}) };
}

// ---------------------------------------------------------------- destinataires
// Sources : text (liste collée / CSV), file { buffer, name, type } (Excel/CSV), image { buffer } (OCR).
async function prepareRecipients(tenant, src, opts) {
  const o = opts || {};
  const extractor = require('./contactExtractor');
  let input = null; let uncertainNumbers = []; let source = 'text'; let entries = [];
  if (src.image) {
    source = 'image';
    let ocr;
    try { ocr = await (o.ocr || ocrProvider).recognize(src.image); } catch (e) { throw err(e.code || 'OCR_FAILED', e.message, e.code === 'OCR_ENGINE_MISSING' ? 501 : 422); }
    entries = extractor.extractFromText(ocr.text, 'ocr');
    uncertainNumbers = (ocr.words || []).filter((w) => w.confidence < 70 && /\d/.test(w.text)).map((w) => w.text.replace(/\D/g, ''));
  } else if (src.file) {
    source = 'file';
    try { entries = extractor.extractFromFile(src.file).entries; } catch (e) { throw err('PARSE_ERROR', 'Fichier illisible (formats acceptés : .xlsx, .xls, .csv, .txt, .vcf, .json).', 422); }
  } else if (Array.isArray(src.rows)) {
    source = 'rows';
    entries = extractor.extractFromRows(src.rows);
  } else if (src.text) {
    entries = extractor.extractFromText(src.text, 'texte');
  }
  const usernames = Array.from(new Set(entries.filter((e) => e.username).map((e) => e.username)));
  input = entries.filter((e) => e.phone).map((e) => ({ raw: e.raw || e.phone, phone: e.phone, name: e.name || '' }));
  // Aucune source fournie = erreur ; une source SANS numéro exploitable renvoie un tableau vide (compteurs à 0, l'interface l'explique).
  if (!src.image && !src.file && !Array.isArray(src.rows) && !src.text) throw err('EMPTY_SOURCE', 'Aucune source de destinataires fournie.');
  const { rows, counts } = pipeline.classify(input, { defaultCountryCode: o.defaultCountryCode, uncertainNumbers });
  const doc = await load(tenant);
  const id = uid('rcp');
  doc.drafts[id] = { id, kind: 'recipients', source, rows, counts, createdAt: Date.now() };
  await save(tenant, doc);
  return { recipientsId: id, source, counts, rows: rows.slice(0, 200), usernames };
}

async function getRecipientsPage(tenant, id, { offset, limit }) {
  const d = (await load(tenant)).drafts[id];
  if (!d || d.kind !== 'recipients') throw err('NOT_FOUND', 'Liste de destinataires introuvable.', 404);
  const o = Math.max(0, Number(offset) || 0); const l = Math.min(500, Math.max(1, Number(limit) || 100));
  return { recipientsId: id, counts: d.counts, rows: d.rows.slice(o, o + l), offset: o, limit: l };
}

// ---------------------------------------------------------------- campagnes
async function createCampaign(tenant, input, allowedModules) {
  const channel = chan(input.channel);
  if (!CHANNELS.includes(channel)) throw err('INVALID_CHANNEL');
  requireChannelModule(allowedModules, channel);
  const name = String(input.name || '').trim();
  const text = String(input.text || '').trim();
  if (!name) throw err('NAME_REQUIRED', 'Nom de campagne requis.');
  if (!text) throw err('MESSAGE_REQUIRED', 'Message requis.');
  const doc = await load(tenant);
  const src = doc.drafts[input.recipientsId];
  if (!src || src.kind !== 'recipients') throw err('RECIPIENTS_NOT_FOUND', 'Liste de destinataires introuvable.', 404);
  // Seuls les destinataires « valid » partent ; doublons, invalides et incertains restent visibles mais exclus.
  const recipients = src.rows.filter((r) => r.state === 'valid').map((r) => ({ telephone: r.number, nom: r.name || '' }));
  if (!recipients.length) throw err('NO_VALID_RECIPIENT', 'Aucun destinataire valide dans cette liste.');
  if (input.mediaFileId) {
    if (channel !== 'WHATSAPP') throw err('MEDIA_NOT_SUPPORTED_CHANNEL', 'Média de campagne géré uniquement pour WhatsApp.');
    if (!(await chatUploads.get(tenant, input.mediaFileId))) throw err('MEDIA_NOT_FOUND', 'Média introuvable.', 404);
  }
  const id = uid('cmp');
  const draft = {
    id, kind: 'campaign', channel, name, text, mediaFileId: input.mediaFileId || null, includeOptOut: input.includeOptOut === true, recipients, counts: src.counts,
    status: 'draft', createdAt: Date.now(), scheduledAt: null, startedAt: null, engineCampaignId: null,
  };
  doc.drafts[id] = draft;
  await save(tenant, doc);
  if (input.scheduledAt) return schedule(tenant, id, input.scheduledAt);
  return summaryOf(draft, null);
}

async function schedule(tenant, id, at) {
  const when = new Date(at).getTime();
  if (!Number.isFinite(when)) throw err('INVALID_DATE', 'Date de programmation invalide.');
  if (when < Date.now() - 60000) throw err('DATE_IN_PAST', 'La date de programmation est dans le passé.');
  const doc = await load(tenant);
  const d = doc.drafts[id];
  if (!d || d.kind !== 'campaign') throw err('NOT_FOUND', 'Campagne introuvable.', 404);
  if (!['draft', 'scheduled'].includes(d.status)) throw err('INVALID_STATE', 'Cette campagne est déjà lancée ou terminée.', 409);
  const { task, deduplicated } = await taskQueue.enqueue(tenant, { type: 'LAUNCH_CAMPAIGN', payload: { draftId: id }, runAt: when, ref: id, dedupeKey: `launch:${id}` });
  d.status = 'scheduled'; d.scheduledAt = when; d.taskId = task.id;
  await save(tenant, doc);
  return Object.assign(summaryOf(d, null), { taskId: task.id, runAt: new Date(task.runAt).toISOString(), deduplicated });
}

async function launch(tenant, id, runtime, allowedModules) {
  const doc = await load(tenant);
  const d = doc.drafts[id];
  if (!d || d.kind !== 'campaign') throw err('NOT_FOUND', 'Campagne introuvable.', 404);
  requireChannelModule(allowedModules, d.channel);
  if (!['draft', 'scheduled'].includes(d.status)) throw err('INVALID_STATE', 'Cette campagne est déjà lancée ou terminée.', 409);
  const out = await launchDraft(tenant, d, runtime);
  if (!out.ok) throw err(out.error.code, out.error.message, out.error.code === 'RUNTIME_MISSING' ? 503 : 422);
  // La tâche programmée n'est annulée qu'APRÈS un lancement réussi (sinon la campagne programmée serait perdue).
  if (d.status === 'scheduled' && d.taskId) await taskQueue.cancel(tenant, d.taskId).catch(() => null);
  d.status = 'launched'; d.startedAt = Date.now(); d.engineCampaignId = out.result.campaignId || null;
  await save(tenant, doc);
  return summaryOf(d, null);
}

async function control(tenant, id, action, runtime) {
  const doc = await load(tenant);
  const d = doc.drafts[id];
  const channel = d ? d.channel : null;
  const engineId = d ? d.engineCampaignId : id;
  if (d && action === 'cancel' && ['draft', 'scheduled'].includes(d.status)) {
    if (d.taskId) await taskQueue.cancel(tenant, d.taskId).catch(() => null);
    d.status = 'cancelled'; d.cancelledAt = Date.now();
    await save(tenant, doc);
    return summaryOf(d, null);
  }
  if (d && !['launched'].includes(d.status)) throw err('INVALID_STATE', `Action « ${action} » impossible : campagne ${d.status}.`, 409);
  const fn = { pause: 'pauseCampaign', resume: 'resumeCampaign', cancel: 'stopCampaign' }[action];
  if (!runtime || typeof runtime[fn] !== 'function') throw err('RUNTIME_MISSING', 'Moteur de campagne indisponible.', 503);
  let out = null;
  for (const ch of (channel ? [channel] : CHANNELS)) {
    out = await runtime[fn]({ channel: ch, campaignId: engineId, tenantId: tenant });
    if (out.ok) break;
  }
  if (!out || !out.ok) throw err('ACTION_FAILED', String((out && out.error) || 'échec'), 422);
  if (d && action === 'cancel') { d.status = 'cancelled'; d.cancelledAt = Date.now(); await save(tenant, doc); }
  return get(tenant, id, runtime, {});
}

// ---------------------------------------------------------------- lecture
function summaryOf(d, live) {
  const st = live ? status.campaignState(live) : ({ draft: 'draft', scheduled: 'scheduled', cancelled: 'cancelled', launched: 'waiting' }[d.status] || 'draft');
  return {
    id: d.id, name: d.name, channel: d.channel, state: st, message: d.text, hasMedia: !!d.mediaFileId,
    createdAt: d.createdAt, scheduledAt: d.scheduledAt || null, startedAt: d.startedAt || null,
    recipients: d.counts || null, engineCampaignId: d.engineCampaignId || null,
  };
}

async function liveStatus(runtime, channel, engineId, tenant) {
  if (!runtime || !runtime.getCampaignStatus || !engineId) return null;
  const out = await runtime.getCampaignStatus({ channel, campaignId: engineId, tenantId: tenant }).catch(() => null);
  return out && out.ok ? out.result : null;
}

function enrich(base, live, rows) {
  if (!live) return base;
  const sum = rows ? status.summarize(rows) : null;
  return Object.assign(base, {
    state: status.campaignState(live),
    engineStatus: live.status, networkStatus: live.networkStatus || 'normal', retryAfterSeconds: live.retryAfterSeconds || 0,
    startedAt: live.startedAt ? Date.parse(live.startedAt) : base.startedAt,
    completedAt: live.finishedAt ? Date.parse(live.finishedAt) : null,
    progress: sum ? { total: sum.total, sent: sum.sent + sum.manual_sent, failed: sum.failed, skipped: sum.skipped, pending: sum.pending + sum.processing, percent: sum.progressPercent, remaining: sum.remaining } : {
      total: live.total, sent: live.success, failed: live.failed, skipped: live.skippedDuplicates, pending: live.pendingCount, percent: live.total ? Math.round(((live.sent || 0) / live.total) * 1000) / 10 : 0, remaining: live.total - (live.sent || 0),
    },
    manualQueue: live.manualQueue || 0,
  });
}

async function get(tenant, id, runtime, page) {
  const doc = await load(tenant);
  const d = doc.drafts[id];
  const p = page || {};
  const offset = Math.max(0, Number(p.offset) || 0); const limit = Math.min(500, Math.max(1, Number(p.limit) || 100));
  if (d && d.kind === 'campaign') {
    const base = summaryOf(d, null);
    if (d.status !== 'launched') {
      const rows = d.recipients.map((r, i) => ({ index: i, name: r.nom, number: r.telephone, status: 'pending', lastAttemptAt: null, error: null }));
      base.progress = { total: rows.length, sent: 0, failed: 0, skipped: 0, pending: rows.length, percent: 0, remaining: rows.length };
      base.recipientRows = rows.slice(offset, offset + limit);
      return base;
    }
    const live = await liveStatus(runtime, d.channel, d.engineCampaignId, tenant);
    const rr = runtime && runtime.getCampaignRecipients ? await runtime.getCampaignRecipients({ channel: d.channel, campaignId: d.engineCampaignId, tenantId: tenant }) : null;
    const rows = rr && rr.ok ? rr.result.recipients : null;
    const out = enrich(base, live, rows);
    out.recipientRows = rows ? rows.slice(offset, offset + limit) : [];
    const fb = (await continuity.list(tenant)).find((f) => f.parentCampaignId === d.engineCampaignId);
    out.fallback = fb ? { status: fb.status, fallbackCampaignId: fb.fallbackCampaignId, events: fb.events } : null;
    if (!live) out.warning = 'Statut du moteur indisponible (session non connectée ?).';
    return out;
  }
  // campagne créée depuis un ancien onglet : lecture directe du moteur
  for (const ch of CHANNELS) {
    const live = await liveStatus(runtime, ch, id, tenant);
    if (!live) continue;
    const rr = runtime.getCampaignRecipients ? await runtime.getCampaignRecipients({ channel: ch, campaignId: id, tenantId: tenant }) : null;
    const rows = rr && rr.ok ? rr.result.recipients : null;
    const base = { id, name: live.name, channel: ch, state: 'running', message: null, hasMedia: false, createdAt: Date.parse(live.createdAt) || null, scheduledAt: null, startedAt: null, recipients: null, legacy: true };
    const out = enrich(base, live, rows);
    out.recipientRows = rows ? rows.slice(offset, offset + limit) : [];
    return out;
  }
  throw err('NOT_FOUND', 'Campagne introuvable.', 404);
}

async function list(tenant, runtime) {
  const doc = await load(tenant);
  const out = [];
  const known = new Set();
  for (const d of Object.values(doc.drafts).filter((x) => x.kind === 'campaign').sort((a, b) => b.createdAt - a.createdAt)) {
    if (d.engineCampaignId) known.add(d.engineCampaignId);
    const base = summaryOf(d, null);
    if (d.status === 'launched') {
      const live = await liveStatus(runtime, d.channel, d.engineCampaignId, tenant);
      enrich(base, live, null);
    }
    out.push(base);
  }
  if (runtime && runtime.getCampaignStatus) {
    for (const ch of CHANNELS) {
      const r = await runtime.getCampaignStatus({ channel: ch, tenantId: tenant }).catch(() => null);
      for (const c of (r && r.ok ? r.result.campaigns : [])) {
        if (known.has(c.id)) continue;
        out.push(enrich({ id: c.id, name: c.name, channel: ch, state: 'running', hasMedia: false, createdAt: Date.parse(c.createdAt) || null, legacy: true }, c, null));
      }
    }
  }
  return out;
}

async function report(tenant, id, runtime) {
  const c = await get(tenant, id, runtime, { limit: 500, offset: 0 });
  const rows = c.recipientRows || [];
  const fbList = await continuity.list(tenant);
  const fb = fbList.find((f) => f.parentCampaignId === (c.engineCampaignId || c.id));
  const started = c.startedAt; const ended = c.completedAt || Date.now();
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  return {
    id: c.id, name: c.name, channel: c.channel, state: c.state,
    total: c.progress ? c.progress.total : 0, sent: c.progress ? c.progress.sent : 0, failed: c.progress ? c.progress.failed : 0, skipped: c.progress ? c.progress.skipped : 0,
    durationSeconds: started ? Math.max(0, Math.round((ended - started) / 1000)) : null,
    fallbackUsed: !!fb, fallbackEvents: fb ? fb.events : 0,
    errors: rows.filter((r) => r.error).slice(0, 20).map((r) => ({ number: r.number, error: r.error })),
    csv: ['nom,numero,statut,derniere_tentative,erreur'].concat(rows.map((r) => [r.name, r.number, r.status, r.lastAttemptAt || '', r.error || ''].map(q).join(','))).join('\n'),
  };
}

module.exports = { launchDraft, prepareRecipients, getRecipientsPage, createCampaign, schedule, launch, control, get, list, report };
