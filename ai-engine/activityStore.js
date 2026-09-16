// ACTIVITY STORE / EVENT SINK — ai-engine/activityStore.js
// ---------------------------------------------------------------------------
// Journal central des activités RÉELLES (§16/§27) : messages, réponses, appels
// d'outils, erreurs, reconnexions… Point de convergence unique alimentant
// l'interface « Rapports, Activités & Amélioration ». 100 % DÉTERMINISTE
// (aucun appel IA — c'est du monitoring, §0.1 cat. A) et NON bloquant.
//
// Agrégat en mémoire (source de vérité du jour) + persistance par jour
// (storageAdapter, docId=YYYY-MM-DD). Borné (300 derniers évènements/jour).

const storageAdapter = require('./storageAdapter');

const NAMESPACE = 'activity';
const MAX_EVENTS = 300;

function today() { return new Date().toISOString().slice(0, 10); }
function uid() { return 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

let current = null; // { date, events[], counts:{byType,byStatus,byChannel} }

async function ensureLoaded() {
  const d = today();
  if (current && current.date === d) return current;
  const fresh = { date: d, events: [], counts: { byType: {}, byStatus: {}, byChannel: {} } };
  try {
    const doc = await storageAdapter.get(NAMESPACE, d, null);
    current = (doc && doc.date === d) ? Object.assign(fresh, doc) : fresh;
  } catch (e) { current = fresh; }
  return current;
}

function inc(map, key) { const k = key || 'unknown'; map[k] = (map[k] || 0) + 1; }

// Enregistre un évènement. Champs (tous facultatifs sauf type/action) :
// { type, action, status, channel, tenant, target, detail }.
// status attendu : 'ok' | 'error' | 'warning' | 'pending'.
async function record(evt) {
  try {
    const agg = await ensureLoaded();
    const e = {
      activityId: uid(), ts: new Date().toISOString(),
      type: evt.type || 'event', action: evt.action || '',
      status: evt.status || 'ok', channel: evt.channel || null,
      tenant: evt.tenant || null, target: evt.target || null,
      detail: evt.detail != null ? String(evt.detail).slice(0, 300) : null,
    };
    agg.events.unshift(e);
    if (agg.events.length > MAX_EVENTS) agg.events.length = MAX_EVENTS;
    inc(agg.counts.byType, e.type);
    inc(agg.counts.byStatus, e.status);
    if (e.channel) inc(agg.counts.byChannel, e.channel);
    storageAdapter.set(NAMESPACE, agg.date, agg);
    return e;
  } catch (err) { return null; }
}

async function summary(dateStr, limit) {
  const d = dateStr || today();
  let agg;
  if (current && current.date === d) agg = current;
  else { try { agg = await storageAdapter.get(NAMESPACE, d, null); } catch (e) { agg = null; } }
  if (!agg) agg = { date: d, events: [], counts: { byType: {}, byStatus: {}, byChannel: {} } };
  const n = Math.max(1, Math.min(MAX_EVENTS, limit || 60));
  return { date: agg.date, counts: agg.counts, events: (agg.events || []).slice(0, n) };
}

module.exports = { record, summary, NAMESPACE, MAX_EVENTS };
