// FACEBOOK ADS — CAMPAGNES D'ENTRÉE — ai-engine/adCampaigns.js
// ---------------------------------------------------------------------------
// Une campagne publicitaire Facebook (Click-to-WhatsApp) est une configuration PERSISTANTE d'un SERVICE MÉTIER
// (champ `service.adCampaigns`, voir businessServices.js) : source, campagne/publication, période, produit, critères
// d'entrée, variantes du message d'entrée, message initial EXACT du propriétaire, règles de continuation, statut.
//
// À l'arrivée d'un message :
//   1. origine : on n'affirme « publicité Facebook » QUE si WhatsApp fournit réellement des données d'origine
//      (contextInfo.externalAdReply / conversionSource / entryPointConversionSource / ctwaClid…). Rien n'est inventé ;
//   2. règle : campagne active, dans sa période, dont les critères correspondent (annonce reconnue OU message d'entrée
//      reconnu, variantes raisonnables comprises) ;
//   3. NOUVEAU contact strict (sinon rien) ; envoi UNIQUE (idempotence) du message EXACT — jamais reformulé par l'IA ;
//   4. tags/source + mémoire de conversation ; ensuite le Chat Intelligent reprend avec le contexte du service.
// Un message reconnu seulement par son texte est marqué « déclaré » (source non vérifiée) : pas de fausse attribution.

const businessServices = require('./businessServices');
const contactCrm = require('./contactCrm');
const messageHistory = require('./messageHistory');
const storageAdapter = require('./storageAdapter');
const conversationState = require('./jarvis/conversationState');
const alertCenter = require('./alertCenter');
const { norm } = require('./jarvis/intentClassifier');

const SOURCE = 'FACEBOOK_ADS';
const NS = 'ad_entries';
const MAX_ATTEMPTS = 2;
const TAG_VERIFIED = 'source_facebook_ads';
const TAG_DECLARED = 'source_declared_facebook_ads';

const sanitize = (t) => String(t || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = () => 'adc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// --------------------------------------------------------------------------------------------- origine (données réelles)
function walkContextInfos(msg) {
  const out = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return;
    seen.add(node);
    if (node.contextInfo && typeof node.contextInfo === 'object') out.push(node.contextInfo);
    for (const v of Object.values(node)) if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) visit(v, depth + 1);
  };
  visit(msg && msg.message, 0);
  return out;
}

// Origine publicitaire RÉELLEMENT présente dans le message (aucune déduction). Retourne toujours un objet.
function extractAdOrigin(msg) {
  const infos = walkContextInfos(msg);
  const origin = { isMetaAd: false, platform: null, adId: null, sourceUrl: null, ref: null, ctwaClid: null, sourceType: null, title: null, body: null, conversionSource: null, entryPoint: null, evidence: [] };
  for (const ci of infos) {
    const ear = ci.externalAdReply || null;
    if (ear) {
      const st = ear.sourceType ? String(ear.sourceType) : null;
      if (st) origin.sourceType = origin.sourceType || st;
      if (ear.sourceId) origin.adId = origin.adId || String(ear.sourceId);
      if (ear.sourceUrl) origin.sourceUrl = origin.sourceUrl || String(ear.sourceUrl);
      if (ear.ref) origin.ref = origin.ref || String(ear.ref);
      if (ear.ctwaClid) origin.ctwaClid = origin.ctwaClid || String(ear.ctwaClid);
      if (ear.title) origin.title = origin.title || String(ear.title);
      if (ear.body) origin.body = origin.body || String(ear.body);
      if (st === 'ad') origin.evidence.push('externalAdReply.sourceType=ad');
      if (ear.ctwaClid) origin.evidence.push('externalAdReply.ctwaClid');
    }
    if (ci.conversionSource) { origin.conversionSource = origin.conversionSource || String(ci.conversionSource); if (/ctwa|ad|fb|facebook|instagram|meta/i.test(ci.conversionSource)) origin.evidence.push('conversionSource=' + ci.conversionSource); }
    const ep = ci.entryPointConversionSource || ci.entryPointConversionExternalSource || null;
    if (ep) { origin.entryPoint = origin.entryPoint || String(ep); if (/ctwa|ad|fb|facebook|instagram|meta/i.test(ep)) origin.evidence.push('entryPoint=' + ep); }
    if (ci.entryPointConversionApp) origin.entryPoint = origin.entryPoint || String(ci.entryPointConversionApp);
  }
  origin.isMetaAd = origin.evidence.length > 0;
  if (origin.isMetaAd) {
    const hint = `${origin.sourceUrl || ''} ${origin.entryPoint || ''} ${origin.conversionSource || ''}`.toLowerCase();
    origin.platform = /instagram/.test(hint) ? 'instagram' : (/facebook|fb\.|fb_/.test(hint) ? 'facebook' : 'meta');
  }
  return origin;
}

// --------------------------------------------------------------------------------------------- message d'entrée (variantes)
const CANON = [
  [/\b(puis je|puis-je|pourrais je|pourrai je|je voudrais|je veux|j aimerais|je souhaiterais|pouvez vous|pourriez vous)\b/g, ' want '],
  [/\b(en savoir plus|plus d info\w*|plus de details|plus de renseignements|des info\w*|des renseignements|renseignements?|informations?|infos?|details?)\b/g, ' info '],
  [/\b(a ce sujet|sur ce sujet|sur cela|sur ceci|sur ca|sur cette (?:annonce|publicite|pub|formation|offre)|de cette (?:annonce|publicite|pub)|concernant (?:cette|votre) \w+)\b/g, ' '],
  [/\b(svp|s il vous plait|s il te plait|stp|merci|please)\b/g, ' '],
  [/\b(bonjour|bonsoir|salut|hello|coucou|bjr|bsr)\b/g, ' '],
];
const STOP = new Set(['je', 'j', 'de', 'la', 'le', 'les', 'un', 'une', 'des', 'et', 'a', 'au', 'aux', 'du', 'en', 'sur', 'ce', 'cette', 'ces', 'pour', 'que', 'qui', 'me', 'moi', 'vous', 'votre', 'mon', 'ma', 'mes', 'est', 'il', 'y', 'a', 'ai', 'tu', 'ton', 'nous', 'on', 'l', 'd', 's', 'n']);
function canonTokens(text) {
  let n = ' ' + norm(text) + ' ';
  for (const [re, rep] of CANON) n = n.replace(re, rep);
  return n.split(/\s+/).map((t) => t.replace(/[?!]/g, '')).filter((t) => t && !STOP.has(t));
}
// Le texte reçu correspond-il à l'un des messages d'entrée configurés (ou à une variante raisonnable) ?
function matchesEntryMessage(text, variants) {
  const got = canonTokens(text);
  const gotSet = new Set(got);
  const rawNorm = norm(text);
  for (const v of variants || []) {
    if (!String(v || '').trim()) continue;
    if (norm(v) === rawNorm) return { matched: true, exact: true, variant: v };
    const want = canonTokens(v);
    if (!want.length) { // variante réduite à une salutation : seulement une salutation seule équivaut
      if (!got.length) return { matched: true, exact: false, variant: v };
      continue;
    }
    const covered = want.filter((t) => gotSet.has(t)).length / want.length;
    if (covered >= 0.8 && got.length <= want.length * 2 + 2) return { matched: true, exact: false, variant: v, score: covered };
  }
  return { matched: false };
}

// --------------------------------------------------------------------------------------------- campagnes (service métier)
function normalizeCampaign(input, prev) {
  const i = input || {};
  const p = prev || {};
  const list = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\n;]+/)).map((x) => String(x).trim()).filter(Boolean);
  const c = Object.assign({}, p.criteria || {}, i.criteria || {});
  const pick = (k) => (i[k] !== undefined ? i[k] : p[k]);
  const crit = {
    adIds: list(i.adIds !== undefined ? i.adIds : c.adIds),
    sourceUrls: list(i.sourceUrls !== undefined ? i.sourceUrls : c.sourceUrls),
    refs: list(i.refs !== undefined ? i.refs : c.refs),
    entryMessages: list(i.entryMessages !== undefined ? i.entryMessages : c.entryMessages),
    requireAdReferral: (i.requireAdReferral !== undefined ? i.requireAdReferral : c.requireAdReferral) === true,
    matchAnyFacebookAd: (i.matchAnyFacebookAd !== undefined ? i.matchAnyFacebookAd : c.matchAnyFacebookAd) === true,
    newContactsOnly: (i.newContactsOnly !== undefined ? i.newContactsOnly : c.newContactsOnly) !== false,
  };
  const ts = (v) => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };
  return {
    id: p.id || i.id || uid(),
    source: SOURCE,
    name: String(pick('name') || 'Campagne Facebook Ads').slice(0, 160),
    productName: pick('productName') != null ? String(pick('productName')).slice(0, 160) : null,
    startAt: i.startAt !== undefined ? ts(i.startAt) : (p.startAt || null),
    endAt: i.endAt !== undefined ? ts(i.endAt) : (p.endAt || null),
    status: (i.status || p.status || 'active') === 'inactive' ? 'inactive' : 'active',
    criteria: crit,
    // message initial EXACT : conservé tel quel (jamais reformulé) ; seuls les retours à la ligne de bord sont retirés.
    initialMessage: i.initialMessage !== undefined ? String(i.initialMessage).replace(/^\s*\n+|\n+\s*$/g, '') : (p.initialMessage || ''),
    continuation: { rules: list(i.continuationRules !== undefined ? i.continuationRules : (p.continuation && p.continuation.rules)), },
    createdAt: p.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

async function listAll(tenant) {
  const services = await businessServices.list(tenant);
  const out = [];
  for (const s of services) for (const c of (s.adCampaigns || [])) out.push(Object.assign({}, c, { serviceId: s.id, serviceName: s.name }));
  return out;
}

function isWithinPeriod(c, now) {
  const t = now == null ? Date.now() : now;
  if (c.startAt && t < c.startAt) return false;
  if (c.endAt && t > c.endAt) return false;
  return true;
}
function statusOf(c, now) {
  if (c.status !== 'active') return 'INACTIVE';
  if (c.startAt && (now == null ? Date.now() : now) < c.startAt) return 'NOT_STARTED';
  if (c.endAt && (now == null ? Date.now() : now) > c.endAt) return 'EXPIRED';
  return 'ACTIVE';
}

// Résout le service cible : id > nom > service unique. Sinon { needsService, choices }.
async function resolveService(tenant, spec) {
  const services = await businessServices.list(tenant);
  if (spec.serviceId) { const s = services.find((x) => x.id === spec.serviceId); if (s) return { service: s }; }
  const want = norm(spec.serviceName || spec.productName || '');
  if (want) {
    const hit = services.find((x) => norm(x.name) === want) || services.find((x) => norm(x.name).includes(want) || want.includes(norm(x.name)))
      || services.find((x) => (x.products || []).some((p) => { const n = norm((p && p.name) || p); return n && (n.includes(want) || want.includes(n)); }));
    if (hit) return { service: hit };
  }
  if (services.length === 1 && !spec.createService) return { service: services[0] };
  if (spec.createService || (want && !services.length)) {
    const created = await businessServices.create(tenant, { name: spec.serviceName || spec.productName || 'Service', type: spec.serviceType || 'formation' });
    return { service: created, created: true };
  }
  return { needsService: true, choices: services.map((s) => s.name) };
}

// Crée ou met à jour (par nom de campagne, dans un service) une campagne d'entrée Facebook Ads.
async function configure(tenant, spec) {
  const s = spec || {};
  if (!String(s.initialMessage || '').trim()) return { ok: false, error: { code: 'INITIAL_MESSAGE_REQUIRED', message: 'Le message initial exact à envoyer est requis.' } };
  const res = await resolveService(tenant, s);
  if (res.needsService) return { ok: false, error: { code: 'SERVICE_REQUIRED', message: 'Quel service métier concerne cette campagne ?', choices: res.choices } };
  const svc = res.service;
  const current = (await businessServices.get(tenant, svc.id)) || svc;
  const list = Array.isArray(current.adCampaigns) ? current.adCampaigns.slice() : [];
  const nm = norm(s.name || '');
  const idx = s.id ? list.findIndex((c) => c.id === s.id) : (nm ? list.findIndex((c) => norm(c.name) === nm) : -1);
  const camp = normalizeCampaign(Object.assign({}, s, { productName: s.productName || svc.name }), idx >= 0 ? list[idx] : null);
  if (idx >= 0) list[idx] = camp; else list.push(camp);
  await businessServices.update(tenant, svc.id, { adCampaigns: list });
  return { ok: true, result: { campaignId: camp.id, serviceId: svc.id, serviceName: svc.name, updated: idx >= 0, serviceCreated: !!res.created, campaign: camp } };
}

async function setStatus(tenant, campaignRef, active) {
  const all = await listAll(tenant);
  const nm = norm(campaignRef || '');
  const matches = all.filter((c) => c.id === campaignRef || (nm && norm(c.name).includes(nm)));
  if (!matches.length) return { ok: false, error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campagne introuvable.' } };
  if (matches.length > 1) return { ok: false, error: { code: 'AMBIGUOUS_CAMPAIGN', message: 'Plusieurs campagnes correspondent.', choices: matches.map((m) => m.name) } };
  const m = matches[0];
  const svc = await businessServices.get(tenant, m.serviceId);
  const list = (svc.adCampaigns || []).map((c) => (c.id === m.id ? Object.assign({}, c, { status: active ? 'active' : 'inactive', updatedAt: Date.now() }) : c));
  await businessServices.update(tenant, m.serviceId, { adCampaigns: list });
  return { ok: true, result: { campaignId: m.id, name: m.name, status: active ? 'active' : 'inactive' } };
}

// --------------------------------------------------------------------------------------------- nouveau contact strict
async function isNewContact(tenant, channel, from, currentMessageId, extra) {
  try { if (await contactCrm.getContact(tenant, channel, from)) return { isNew: false, reason: 'CRM_CONTACT_EXISTS' }; } catch (e) { /* facultatif */ }
  try {
    const conv = await messageHistory.getConversation(tenant, channel, from, 100);
    if (conv.some((m) => !currentMessageId || String(m.messageId || '') !== String(currentMessageId))) return { isNew: false, reason: 'PRIOR_MESSAGES_IN_MEMORY' };
  } catch (e) { /* facultatif */ }
  try {
    const st = await conversationState.get(tenant, channel, from);
    if ((st.turns || 0) > 0 || st.lastReplyTs || (st.handoff && st.handoff.state)) return { isNew: false, reason: 'CONVERSATION_STATE_EXISTS' };
  } catch (e) { /* facultatif */ }
  const dir = await storageAdapter.get(NS, sanitize(tenant), { tenant: sanitize(tenant), entries: {}, contacts: {} });
  const key = extra && extra.contactKey;
  if (key && dir.contacts[key] && dir.contacts[key].firstMessageId !== String(currentMessageId)) return { isNew: false, reason: 'ALREADY_SEEN_BY_AD_REGISTRY' };
  return { isNew: true, reason: 'NO_PRIOR_TRACE' };
}

// --------------------------------------------------------------------------------------------- décision
// Évalue chaque campagne ; retourne { winner?, ambiguous?, considered:[{campaign, verdict, ...}] }.
function evaluate(campaigns, { origin, text, now }) {
  const considered = [];
  for (const c of campaigns) {
    const st = statusOf(c, now);
    if (st !== 'ACTIVE') { considered.push({ campaign: c, verdict: st }); continue; }
    const crit = c.criteria || {};
    let strength = 0; let how = null; let verified = false;
    if (origin && origin.isMetaAd) {
      const adHit = origin.adId && (crit.adIds || []).includes(origin.adId);
      const urlHit = origin.sourceUrl && (crit.sourceUrls || []).some((u) => u && origin.sourceUrl.toLowerCase().includes(String(u).toLowerCase()));
      const refHit = origin.ref && (crit.refs || []).includes(origin.ref);
      if (adHit || urlHit || refHit) { strength = 3; how = adHit ? 'ad_id' : (urlHit ? 'ad_url' : 'ad_ref'); verified = true; }
      else if (crit.matchAnyFacebookAd) { strength = 1.5; how = 'any_meta_ad'; verified = true; }
    }
    const mm = matchesEntryMessage(text, crit.entryMessages);
    if (mm.matched && !crit.requireAdReferral) {
      const s2 = mm.exact ? 2 : 1.75;
      if (s2 > strength) { strength = s2; how = mm.exact ? 'entry_message' : 'entry_message_variant'; verified = !!(origin && origin.isMetaAd && strength >= 3); }
      // message reconnu ET annonce Meta réelle : l'origine est vérifiée par l'annonce, pas déclarée
      if (origin && origin.isMetaAd) verified = true;
    }
    if (crit.requireAdReferral && !(origin && origin.isMetaAd)) { considered.push({ campaign: c, verdict: 'AD_REFERRAL_REQUIRED_BUT_ABSENT' }); continue; }
    if (crit.requireAdReferral && strength < 3 && !crit.matchAnyFacebookAd) { considered.push({ campaign: c, verdict: 'AD_NOT_RECOGNISED' }); continue; }
    if (!strength) { considered.push({ campaign: c, verdict: 'NO_MATCH' }); continue; }
    considered.push({ campaign: c, verdict: 'MATCH', strength, how, verified, entryMatch: mm.matched ? mm.variant : null });
  }
  const matches = considered.filter((x) => x.verdict === 'MATCH').sort((a, b) => b.strength - a.strength);
  if (!matches.length) return { considered };
  const top = matches.filter((m) => m.strength === matches[0].strength);
  if (top.length > 1) return { considered, ambiguous: top.map((t) => t.campaign) };
  return { considered, winner: matches[0] };
}

// --------------------------------------------------------------------------------------------- exécution (idempotente)
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

// input : { tenantId, channel, from, messageId, text, msg, identity, isNew?, now? }
// deps  : { send(text) -> {status, confirmationId?, error?} }
// Retourne { handled, reason, ... }. handled=true : le message entrant a reçu le message initial (rien d'autre à répondre).
async function handleEntry(input, deps) {
  const { tenantId, channel, from, messageId, text, msg, identity } = input;
  const d = deps || {};
  const now = input.now || Date.now();
  const all = await listAll(tenantId);
  if (!all.length) return { handled: false, reason: 'NO_CAMPAIGN_CONFIGURED' };
  const active = all.filter((c) => c.status === 'active');
  if (!active.length) return { handled: false, reason: 'NO_ACTIVE_CAMPAIGN' };

  const origin = extractAdOrigin(msg);
  const ev = evaluate(active, { origin, text, now });
  const contactKey = (identity && identity.contactId) || `${channel}:${from}`;

  if (ev.ambiguous) {
    await alertCenter.raise(tenantId, {
      type: 'DECISION_REQUIRED', title: `${identity ? identity.label : 'Un contact'} correspond à plusieurs campagnes Facebook Ads`,
      body: `Aucun message automatique envoyé : ${ev.ambiguous.map((c) => `« ${c.name} »`).join(', ')} correspondent aussi bien. Précise les critères (identifiant d'annonce, lien, message d'entrée).`,
      contact: identity || null, idempotencyKey: `adamb:${tenantId}:${contactKey}:${messageId || ''}`,
    }).catch(() => {});
    return { handled: false, reason: 'AMBIGUOUS_CAMPAIGNS', campaigns: ev.ambiguous.map((c) => c.id) };
  }
  if (!ev.winner) {
    const expired = ev.considered.find((x) => x.verdict === 'EXPIRED');
    return { handled: false, reason: expired ? 'CAMPAIGN_EXPIRED' : 'NO_MATCH', considered: ev.considered.map((x) => ({ id: x.campaign.id, verdict: x.verdict })) };
  }
  const w = ev.winner; const camp = w.campaign;
  const entryKey = `${camp.id}|${contactKey}`;

  return withLock(`${sanitize(tenantId)}|${entryKey}`, async () => {
    const dir = await storageAdapter.get(NS, sanitize(tenantId), { tenant: sanitize(tenantId), entries: {}, contacts: {} });
    const existing = dir.entries[entryKey];
    if (existing) {
      // Redélivrance du MÊME message : déjà traité, rien de plus à répondre. Autre message : conversation normale.
      if (existing.triggerMessageId && String(existing.triggerMessageId) === String(messageId) && existing.status === 'SENT') return { handled: true, reason: 'DUPLICATE_DELIVERY', campaignId: camp.id };
      if (existing.status === 'SENT') return { handled: false, reason: 'INITIAL_MESSAGE_ALREADY_SENT', campaignId: camp.id };
      if (existing.status === 'SENDING') return { handled: true, reason: 'SEND_IN_PROGRESS', campaignId: camp.id };
      if ((existing.attempts || 0) >= MAX_ATTEMPTS) return { handled: false, reason: 'MAX_ATTEMPTS_REACHED', campaignId: camp.id };
    }
    // Nouveau contact STRICT (sauf si la campagne autorise explicitement les anciens contacts).
    // (une nouvelle tentative après un échec d'envoi n'est pas un « ancien contact » : il a déjà été jugé nouveau)
    if (camp.criteria.newContactsOnly !== false && !(existing && existing.status === 'FAILED')) {
      const fresh = input.isNew != null ? { isNew: !!input.isNew, reason: 'PROVIDED' } : await isNewContact(tenantId, channel, from, messageId, { contactKey });
      if (!fresh.isNew) return { handled: false, reason: 'EXISTING_CONTACT', detail: fresh.reason, campaignId: camp.id };
    }
    if (!String(camp.initialMessage || '').trim()) return { handled: false, reason: 'NO_INITIAL_MESSAGE', campaignId: camp.id };
    if (typeof d.send !== 'function') return { handled: false, reason: 'NO_SENDER', campaignId: camp.id };

    const entry = Object.assign({ campaignId: camp.id, contactKey, firstAt: now, attempts: 0 }, existing || {}, { status: 'SENDING', attempts: ((existing && existing.attempts) || 0) + 1, triggerMessageId: messageId || null, how: w.how, verified: w.verified, updatedAt: now });
    dir.entries[entryKey] = entry;
    dir.contacts[contactKey] = dir.contacts[contactKey] || { firstSeenAt: now, firstMessageId: messageId || null };
    await storageAdapter.set(NS, sanitize(tenantId), dir);

    let out;
    try { out = await d.send(camp.initialMessage); } catch (err) { out = { status: 'FAILED', error: err.message }; }
    const ok = !!(out && out.status === 'SUCCESS');
    const dir2 = await storageAdapter.get(NS, sanitize(tenantId), dir);
    const e2 = dir2.entries[entryKey] || entry;
    e2.status = ok ? 'SENT' : 'FAILED';
    e2.confirmationId = (out && out.confirmationId) || null; e2.error = ok ? null : ((out && (out.error || out.status)) || 'SEND_FAILED');
    e2.sentAt = ok ? Date.now() : null; e2.updatedAt = Date.now();
    dir2.entries[entryKey] = e2;
    await storageAdapter.set(NS, sanitize(tenantId), dir2);

    if (!ok) {
      await alertCenter.raise(tenantId, { type: 'IMPORTANT_ERROR', title: `Message d'accueil Facebook Ads non envoyé (${camp.name})`, body: `${identity ? identity.label : 'Contact'} : ${e2.error}. Le Chat Intelligent répond normalement.`, contact: identity || null, idempotencyKey: `adfail:${entryKey}:${e2.attempts}` }).catch(() => {});
      return { handled: false, reason: 'SEND_FAILED', campaignId: camp.id, error: e2.error };
    }

    // Tags / source (vérifiée ou seulement déclarée) + mémoire de conversation.
    const idKey = contactCrm.identityOf(from);
    const tags = [w.verified ? TAG_VERIFIED : TAG_DECLARED, `campaign_${camp.id}`];
    try {
      await contactCrm.recordSeen(tenantId, { channel, from: idKey, name: identity && identity.displayName });
      await contactCrm.addTags(tenantId, channel, idKey, tags);
    } catch (e) { /* le tag est secondaire : l'envoi est déjà fait et enregistré */ }
    try {
      const st = await conversationState.get(tenantId, channel, from);
      st.ad = { source: SOURCE, campaignId: camp.id, serviceId: camp.serviceId, campaignName: camp.name, productName: camp.productName, sourceVerified: !!w.verified, how: w.how, initialSent: true, sentAt: e2.sentAt, adId: origin.adId || null, platform: origin.platform || null };
      st.state = st.state === 'NEW' ? 'DISCOVERY' : st.state;
      st.memory = st.memory || {}; st.memory.subject = camp.productName || st.memory.subject || null;
      st.recentReplies = (st.recentReplies || []).concat([{ text: camp.initialMessage.slice(0, 600), ts: Date.now(), kind: 'AD_INITIAL' }]).slice(-6);
      st.lastReplyTs = Date.now();
      if (messageId) st.processedIds = (st.processedIds || []).concat([String(messageId)]);
      await conversationState.save(st);
    } catch (e) { /* mémoire secondaire */ }
    await alertCenter.raise(tenantId, {
      type: 'NEW_PROSPECT', title: `Nouveau contact ${w.verified ? 'Facebook Ads' : '(message d\'entrée reconnu)'} : ${identity ? identity.label : 'contact'}`,
      body: `Campagne « ${camp.name} ». Message d'accueil envoyé.${w.verified ? '' : ' Origine Facebook non vérifiée par WhatsApp (reconnu par le texte configuré).'}`,
      contact: identity || null, idempotencyKey: `adnew:${entryKey}`,
    }).catch(() => {});
    return { handled: true, reason: 'INITIAL_MESSAGE_SENT', campaignId: camp.id, verified: !!w.verified, how: w.how, tags, confirmationId: e2.confirmationId };
  });
}

// Contexte de continuation à injecter dans le prompt du Chat Intelligent pour un contact issu d'une campagne.
async function continuationContext(tenant, channel, from) {
  let st; try { st = await conversationState.get(tenant, channel, from); } catch (e) { return ''; }
  if (!st || !st.ad) return '';
  const all = await listAll(tenant);
  const camp = all.find((c) => c.id === st.ad.campaignId);
  const lines = [`Ce contact est arrivé par la campagne Facebook Ads « ${st.ad.campaignName || (camp && camp.name)} »${st.ad.productName ? ` (produit/service : ${st.ad.productName})` : ''}${st.ad.sourceVerified ? '' : ' (origine reconnue par le message d\'entrée, non vérifiée par Facebook)'}.`];
  if (camp && camp.initialMessage) lines.push(`Le message d'accueil ci-dessous lui a DÉJÀ été envoyé tel quel — ne le répète pas et ne le reformule pas :\n«${camp.initialMessage}»`);
  if (camp && camp.continuation && camp.continuation.rules.length) lines.push(`Règles de continuation du propriétaire : ${camp.continuation.rules.join(' | ')}`);
  lines.push('Poursuis la conversation naturellement à partir de ce message, en t\'appuyant uniquement sur les informations réelles du service.');
  return lines.join('\n');
}

module.exports = {
  SOURCE, NS, TAG_VERIFIED, TAG_DECLARED, extractAdOrigin, matchesEntryMessage, canonTokens, normalizeCampaign, listAll, statusOf, isWithinPeriod,
  configure, setStatus, isNewContact, evaluate, handleEntry, continuationContext,
};
