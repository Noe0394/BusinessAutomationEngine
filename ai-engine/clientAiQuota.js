// LIMITE DE CONSOMMATION IA PAR CLIENT — ai-engine/clientAiQuota.js
// ---------------------------------------------------------------------------
// Maximum de 10 ÉCHANGES IA (un message client traité par l'IA + sa réponse) sur une fenêtre GLISSANTE d'une heure, par client et
// par tenant/business. Appliquée côté BACKEND, jamais dans un prompt :
//   • compteur indépendant par (tenant, client) — le client A n'affecte jamais le client B, ni un autre tenant ;
//   • clé de client stable entre canaux (contactId d'identité, sinon numéro, sinon canal:identifiant) et valable en groupe
//     (la clé est celle de l'EXPÉDITEUR, pas celle du groupe) ;
//   • opération ATOMIQUE : lecture → décision → écriture sérialisées par clé (file de promesses) — dix messages simultanés ne
//     peuvent pas franchir la limite ; idempotente par exchangeId (un retry ou une régénération du même échange ne compte pas deux fois) ;
//   • PERSISTANTE (storageAdapter) : survit aux redémarrages, indépendante du canal ;
//   • appliquée au point de passage UNIQUE des appels IA (lib/ai/llmFallbackEngine.js) via un contexte d'exécution : un appel IA
//     rattaché à un client (réponse, arbitrage, réponse privée) est compté ; le chemin PROPRIÉTAIRE (self-chat WhatsApp/Telegram,
//     Chat intelligent du tableau de bord) ne pose jamais ce contexte : il reste ILLIMITÉ.
// Un échange = un exchangeId (lot de messages traités ensemble). Les appels IA d'un même échange (arbitrage + rédaction +
// régénération) consomment UN seul échange.

const { AsyncLocalStorage } = require('async_hooks');
const storageAdapter = require('./storageAdapter');

const NAMESPACE = 'client_ai_quota';
const limit = () => Math.max(1, parseInt(process.env.CLIENT_AI_LIMIT, 10) || 10);
const windowMs = () => Math.max(1000, parseInt(process.env.CLIENT_AI_WINDOW_MS, 10) || 60 * 60 * 1000);

const als = new AsyncLocalStorage();
const chains = new Map(); // clé de document -> promesse (sérialisation)
const sanitize = (s) => String(s == null ? '' : s).trim().replace(/[^A-Za-z0-9_.:-]/g, '_') || 'unknown';
const docId = (tenant, clientKey) => `${sanitize(tenant)}__${sanitize(clientKey)}`.slice(0, 180);

// Clé de client : identité résolue (stable entre canaux) > numéro réel > canal:expéditeur.
function clientKeyFor({ channel, from, senderId, identity, isGroup }) {
  // En GROUPE, l'identité résolue est celle du groupe : la clé est celle de l'EXPÉDITEUR (le numéro réel si son JID est téléphonique,
  // donc le même compteur que sa conversation privée), jamais celle du groupe.
  if (isGroup || (senderId && /@g\.us$/i.test(String(from || '')))) {
    const m = String(senderId || '').match(/^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/i);
    return m ? `p:${m[1]}` : `${String(channel || '').toUpperCase()}:${senderId || from}`;
  }
  if (identity && identity.contactId) return `c:${identity.contactId}`;
  if (identity && identity.phoneNumber) return `p:${identity.phoneNumber}`;
  return `${String(channel || '').toUpperCase()}:${senderId || from}`;
}

function serialize(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(id, next);
  next.finally(() => { if (chains.get(id) === next) chains.delete(id); }).catch(() => {});
  return next;
}

async function load(id, now) {
  const doc = await storageAdapter.get(NAMESPACE, id, { entries: [], notifiedFor: null });
  const cutoff = now - windowMs();
  doc.entries = (doc.entries || []).filter((e) => e.ts > cutoff);
  return doc;
}
const snapshot = (doc, now) => {
  const oldest = doc.entries.length ? doc.entries[0].ts : null;
  return { count: doc.entries.length, limit: limit(), remaining: Math.max(0, limit() - doc.entries.length), exhausted: doc.entries.length >= limit(), resumeAt: doc.entries.length >= limit() ? oldest + windowMs() : null, windowStart: oldest, now };
};

// Lecture seule : ce client peut-il encore déclencher un échange IA ?
function status(tenant, clientKey, now) {
  const id = docId(tenant, clientKey); const t = now || Date.now();
  return serialize(id, async () => snapshot(await load(id, t), t));
}

// Consomme UN échange (atomique + idempotent). Renvoie { allowed, ...snapshot }. Refus si la fenêtre contient déjà `limit` échanges
// distincts et que cet exchangeId n'en fait pas partie.
function consume(tenant, clientKey, exchangeId, now) {
  const id = docId(tenant, clientKey); const t = now || Date.now();
  return serialize(id, async () => {
    const doc = await load(id, t);
    const already = exchangeId && doc.entries.some((e) => e.id === String(exchangeId));
    if (!already) {
      if (doc.entries.length >= limit()) { await storageAdapter.set(NAMESPACE, id, doc); return Object.assign({ allowed: false }, snapshot(doc, t)); }
      doc.entries.push({ ts: t, id: String(exchangeId || `x${t}${Math.random().toString(36).slice(2, 6)}`) });
      await storageAdapter.set(NAMESPACE, id, doc);
    }
    return Object.assign({ allowed: true }, snapshot(doc, t));
  });
}

// La notification « limite atteinte » n'est envoyée qu'UNE fois par fenêtre saturée (atomique) : renvoie true pour l'appelant qui
// doit notifier, false pour tous les autres.
function claimLimitNotice(tenant, clientKey, now) {
  const id = docId(tenant, clientKey); const t = now || Date.now();
  return serialize(id, async () => {
    const doc = await load(id, t);
    if (doc.entries.length < limit()) return false;
    const marker = String(doc.entries[0].ts);
    if (doc.notifiedFor === marker) return false;
    doc.notifiedFor = marker;
    await storageAdapter.set(NAMESPACE, id, doc);
    return true;
  });
}

// --- contexte d'exécution : tout appel IA fait sous runFor() est compté pour ce client -----------------------------------
function runFor(ctx, fn) {
  if (!ctx || !ctx.tenant || !ctx.clientKey) return fn();
  return als.run({ tenant: ctx.tenant, clientKey: ctx.clientKey, exchangeId: ctx.exchangeId || null }, fn);
}
const current = () => als.getStore() || null;

class ClientAiLimitError extends Error {
  constructor(snap) {
    super('Limite de conversation IA atteinte pour ce client.');
    this.name = 'ClientAiLimitError'; this.code = 'CLIENT_AI_LIMIT'; this.userSafe = false; this.snapshot = snap;
  }
}

// Appelé par le gateway IA avant CHAQUE appel : sans contexte client (propriétaire, tâches internes) => illimité.
async function enforceForCurrent() {
  const c = als.getStore();
  if (!c) return null;
  const r = await consume(c.tenant, c.clientKey, c.exchangeId);
  if (!r.allowed) throw new ClientAiLimitError(r);
  return r;
}

module.exports = { NAMESPACE, limit, windowMs, clientKeyFor, status, consume, claimLimitNotice, runFor, current, enforceForCurrent, ClientAiLimitError, _chains: chains };
