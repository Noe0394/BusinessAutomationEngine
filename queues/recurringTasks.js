const storageAdapter = require('../ai-engine/storageAdapter');

// TÂCHES RÉCURRENTES — queues/recurringTasks.js
// ---------------------------------------------------------------------------
// Planificateur RÉCURRENT (quotidien à une heure donnée) — distinct de
// queues/scheduled_messages.js (ponctuel, une seule fois). Sert le cahier des
// charges "chaque matin, envoie un message au groupe X". Persisté par tenant
// via storageAdapter (miroir GitHub), exécuté par un tick dans index.js qui
// appelle runtime.sendToGroups. Ne fait AUCUN envoi lui-même (séparation :
// stockage + éligibilité ici, exécution côté index.js).
//
// Heure : stockée en heures/minutes "locales vendeur" = heure serveur (UTC sur
// la VM) décalée de RECURRING_TZ_OFFSET_HOURS (défaut 0 ; ex. Afrique de
// l'Ouest = 0/GMT). Volontairement simple : pas de vraie base de fuseaux.

const NAMESPACE = 'recurring_tasks';

function sanitize(id) {
  return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
}
function uid() {
  return 'rec_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function tzOffsetHours() {
  const v = parseFloat(process.env.RECURRING_TZ_OFFSET_HOURS);
  return Number.isFinite(v) ? v : 0;
}
// Date "locale vendeur" (YYYY-MM-DD) et minutes-depuis-minuit, à partir d'un
// instant donné + l'offset configuré.
function localParts(now) {
  const shifted = new Date(now.getTime() + tzOffsetHours() * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return {
    dateStr: `${y}-${m}-${d}`,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

async function load(tenantId) {
  return storageAdapter.get(NAMESPACE, sanitize(tenantId), { tenantId: sanitize(tenantId), tasks: [] });
}
function save(tenantId, doc) {
  doc.updatedAt = new Date().toISOString();
  return storageAdapter.set(NAMESPACE, sanitize(tenantId), doc);
}

// Crée une tâche quotidienne. `target` = {kind:'named'|'subject'|'admin'|'all',
// value}. hour 0-23, minute 0-59.
async function create(tenantId, { channel, target, message, hour, minute }) {
  const doc = await load(tenantId);
  const task = {
    id: uid(),
    tenantId: sanitize(tenantId),
    channel: String(channel || 'WHATSAPP').toUpperCase(),
    target: target || { kind: 'all', value: '' },
    message: String(message || ''),
    hour: Math.max(0, Math.min(23, parseInt(hour, 10) || 0)),
    minute: Math.max(0, Math.min(59, parseInt(minute, 10) || 0)),
    active: true,
    lastRunDate: null,
    createdAt: new Date().toISOString(),
  };
  doc.tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  doc.tasks.push(task);
  save(tenantId, doc);
  return task;
}

async function list(tenantId) {
  return (await load(tenantId)).tasks || [];
}

async function stop(tenantId, id) {
  const doc = await load(tenantId);
  const task = (doc.tasks || []).find((t) => t.id === id);
  if (!task) return false;
  task.active = false;
  save(tenantId, doc);
  return true;
}

// Supprime toutes les tâches inactives (nettoyage facultatif).
async function stopAll(tenantId) {
  const doc = await load(tenantId);
  const n = (doc.tasks || []).filter((t) => t.active).length;
  (doc.tasks || []).forEach((t) => { t.active = false; });
  save(tenantId, doc);
  return n;
}

// Une tâche est due si active, l'heure locale a atteint hour:minute, et elle
// n'a pas déjà tourné aujourd'hui (lastRunDate != date locale du jour).
function isDue(task, now) {
  if (!task || !task.active) return false;
  const { dateStr, minutes } = localParts(now || new Date());
  if (task.lastRunDate === dateStr) return false;
  const taskMinutes = (task.hour || 0) * 60 + (task.minute || 0);
  return minutes >= taskMinutes;
}

async function markRun(tenantId, id, now) {
  const doc = await load(tenantId);
  const task = (doc.tasks || []).find((t) => t.id === id);
  if (!task) return;
  task.lastRunDate = localParts(now || new Date()).dateStr;
  task.lastRunAt = new Date().toISOString();
  save(tenantId, doc);
}

// Tenants ayant au moins une tâche enregistrée (pour le tick global).
function listTenantIds() {
  return storageAdapter.listIds(NAMESPACE);
}

module.exports = { create, list, stop, stopAll, isDue, markRun, listTenantIds, NAMESPACE, localParts };
