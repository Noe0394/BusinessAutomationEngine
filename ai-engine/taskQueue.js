// File de tâches DURABLE (persistée par tenant) : priorité, planification (runAt), verrou à bail,
// retries bornés avec backoff, reprise après crash (recover). Aucune dépendance à l'interface ni à l'IA.
const storageAdapter = require('./storageAdapter');

const NAMESPACE = 'task_queue';
const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const KEEP_FINISHED_MS = 7 * 24 * 3600 * 1000;
const MAX_TASKS = 1000;

// États d'une tâche longue : QUEUED, RUNNING (= PROCESSING en interne), WAITING_EXTERNAL (attend une réponse/validation externe), VERIFYING,
// COMPLETED, FAILED, CANCELLED, PAUSED. Aucune tâche ne disparaît : les états terminaux sont conservés 7 jours.
const STATE = { QUEUED: 'QUEUED', PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED', PAUSED: 'PAUSED', WAITING_EXTERNAL: 'WAITING_EXTERNAL', VERIFYING: 'VERIFYING' };
const normalizeState = (s) => (s === 'PROCESSING' ? 'RUNNING' : s); // vocabulaire public des rapports
const PUBLIC_STATES = ['QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'];

const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = () => 'tsk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Sérialise les écritures d'un même tenant (get -> modifier -> set) dans ce processus.
const chains = new Map();
function withTenant(tenant, fn) {
  const key = sanitize(tenant);
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

async function load(tenant) { return storageAdapter.get(NAMESPACE, sanitize(tenant), { tenant: sanitize(tenant), tasks: [] }); }
async function save(tenant, doc) {
  const cut = Date.now() - KEEP_FINISHED_MS;
  doc.tasks = doc.tasks.filter((t) => ![STATE.COMPLETED, STATE.FAILED, STATE.CANCELLED].includes(t.state) || (t.finishedAt || 0) >= cut).slice(-MAX_TASKS);
  return storageAdapter.setDurable(NAMESPACE, sanitize(tenant), doc);
}

// create_queue est implicite (une file par tenant). Idempotence : `dedupeKey` identique et tâche non terminée => même tâche.
function enqueue(tenant, { type, payload, runAt, priority, ref, dedupeKey, maxAttempts }) {
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    if (dedupeKey) {
      const existing = doc.tasks.find((t) => t.dedupeKey === dedupeKey && [STATE.QUEUED, STATE.PROCESSING].includes(t.state));
      if (existing) {
        scheduleWorker(existing.runAt <= Date.now() ? 0 : existing.runAt - Date.now());
        return { task: existing, deduplicated: true };
      }
    }
    const task = {
      id: uid(), type, payload: payload || {}, ref: ref || null, dedupeKey: dedupeKey || null,
      state: STATE.QUEUED, priority: Number(priority) || 0, runAt: runAt ? new Date(runAt).getTime() : Date.now(),
      attempts: 0, maxAttempts: maxAttempts || MAX_ATTEMPTS, lockedUntil: 0, result: null, error: null,
      createdAt: Date.now(), finishedAt: null,
    };
    doc.tasks.push(task);
    await save(tenant, doc);
    // Les tâches dues réveillent immédiatement le worker. Les tâches
    // programmées sont armées à leur échéance; le balayage périodique ne sert
    // que de garde-fou en cas d'événement perdu ou après un redémarrage.
    scheduleWorker(task.runAt <= Date.now() ? 0 : task.runAt - Date.now());
    return { task, deduplicated: false };
  });
}

// get_next_task + lock_task + mark_task_processing : atomique. Renvoie la tâche due de plus haute priorité.
function claimNext(tenant, now) {
  const t0 = now == null ? Date.now() : now;
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    const due = doc.tasks
      .filter((t) => t.state === STATE.QUEUED && t.runAt <= t0)
      .sort((a, b) => (b.priority - a.priority) || (a.runAt - b.runAt));
    const task = due[0];
    if (!task) return null;
    task.state = STATE.PROCESSING; task.lockedUntil = t0 + LEASE_MS; task.attempts += 1; task.startedAt = t0;
    await save(tenant, doc);
    return task;
  });
}

function finish(tenant, id, patch) {
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    const task = doc.tasks.find((t) => t.id === id);
    if (!task) return null;
    Object.assign(task, patch, { lockedUntil: 0 });
    await save(tenant, doc);
    return task;
  });
}

const complete = (tenant, id, result) => finish(tenant, id, { state: STATE.COMPLETED, result: result || null, finishedAt: Date.now(), error: null });

// mark_task_failed + retry_task : réessaie (backoff exponentiel) tant que `retryable` et sous la limite.
async function fail(tenant, id, error, retryable) {
  const doc = await load(tenant);
  const task = doc.tasks.find((t) => t.id === id);
  if (!task) return null;
  const again = retryable !== false && task.attempts < task.maxAttempts;
  return finish(tenant, id, again
    ? { state: STATE.QUEUED, error: String(error), runAt: Date.now() + 30000 * (2 ** (task.attempts - 1)) }
    : { state: STATE.FAILED, error: String(error), finishedAt: Date.now() });
}

async function cancel(tenant, id) {
  const doc = await load(tenant);
  const task = doc.tasks.find((t) => t.id === id);
  if (!task || [STATE.COMPLETED, STATE.FAILED, STATE.CANCELLED].includes(task.state)) return null;
  return finish(tenant, id, { state: STATE.CANCELLED, finishedAt: Date.now() });
}

// Pause / reprise / états intermédiaires (attente externe, vérification) : la tâche reste visible et reprend là où elle en était.
async function setState(tenant, id, state, extra) {
  if (![STATE.PAUSED, STATE.WAITING_EXTERNAL, STATE.VERIFYING, STATE.QUEUED].includes(state)) return null;
  const doc = await load(tenant);
  const task = doc.tasks.find((t) => t.id === id);
  if (!task || [STATE.COMPLETED, STATE.FAILED, STATE.CANCELLED].includes(task.state)) return null;
  const updatedTask = await finish(tenant, id, Object.assign({ state }, extra || {}));
  if (updatedTask && state === STATE.QUEUED) scheduleWorker(Math.max(0, Number(updatedTask.runAt || Date.now()) - Date.now()));
  return updatedTask;
}
const pause = (tenant, id) => setState(tenant, id, STATE.PAUSED);
const resume = (tenant, id) => setState(tenant, id, STATE.QUEUED, { runAt: Date.now() });

// recover_queue : reprise automatique uniquement quand l'action est sûre à
// rejouer. Un envoi ou une relance interrompus peuvent avoir atteint la
// plateforme avant le crash : ils passent en VERIFYING au lieu d'être renvoyés.
function recover(tenant, now) {
  const t0 = now == null ? Date.now() : now;
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    let n = 0;
    for (const t of doc.tasks) {
      if (t.state === STATE.PROCESSING && t.lockedUntil <= t0) {
        if (['SEND_MESSAGE', 'FOLLOW_UP'].includes(t.type)) {
          t.state = STATE.VERIFYING;
          t.error = 'EXECUTION_UNCONFIRMED_AFTER_RESTART';
          t.verificationRequiredAt = t0;
        }
        else if (t.attempts >= t.maxAttempts) { t.state = STATE.FAILED; t.error = 'LEASE_EXPIRED_MAX_ATTEMPTS'; t.finishedAt = t0; }
        else { t.state = STATE.QUEUED; t.runAt = t0; }
        t.lockedUntil = 0; n += 1;
      }
    }
    if (n) await save(tenant, doc);
    return n;
  });
}

async function list(tenant, filter) {
  const doc = await load(tenant);
  const f = filter || {};
  return doc.tasks.filter((t) => (!f.state || t.state === f.state) && (!f.type || t.type === f.type) && (!f.ref || t.ref === f.ref));
}

async function status(tenant) {
  const doc = await load(tenant);
  const counts = {};
  for (const t of doc.tasks) counts[t.state] = (counts[t.state] || 0) + 1;
  const now = Date.now();
  const stuck = doc.tasks.filter((t) => t.state === STATE.PROCESSING && t.lockedUntil <= now).length;
  const overdue = doc.tasks.filter((t) => t.state === STATE.QUEUED && t.runAt < now - 10 * 60 * 1000).length;
  return { counts, stuck, overdue, total: doc.tasks.length };
}

// Worker : indépendant de l'interface. `handlers[type](task) -> { ok, result?, error?, retryable? }`.
async function processTenant(tenant, handlers, opts) {
  const o = opts || {};
  await recover(tenant);
  const done = [];
  for (let i = 0; i < (o.maxPerTick || 10); i += 1) {
    const task = await claimNext(tenant);
    if (!task) break;
    const handler = handlers[task.type];
    if (!handler) { await fail(tenant, task.id, `NO_HANDLER:${task.type}`, false); done.push({ id: task.id, ok: false }); continue; }
    try {
      const out = await handler(task);
      if (out && out.ok) { await complete(tenant, task.id, out.result); done.push({ id: task.id, ok: true }); }
      else { await fail(tenant, task.id, (out && out.error) || 'FAILED', out && out.retryable); done.push({ id: task.id, ok: false }); }
    } catch (e) { await fail(tenant, task.id, e.message, true); done.push({ id: task.id, ok: false }); }
  }
  return done;
}

let tenantProvider = null;
async function listTenants() {
  const local = await storageAdapter.listIdsAsync(NAMESPACE);
  let external = [];
  try { external = typeof tenantProvider === 'function' ? tenantProvider() || [] : []; } catch (_) { external = []; }
  return Array.from(new Set(local.concat(external.map(sanitize))));
}

let timer = null;
let timerDueAt = 0;
let handlersForTenant = null;
let idlePollMs = 60000;
let maxTenantsInParallel = 4;
let workerRunning = false;
let rerunRequested = false;
let workerStopped = true;
let activeTenantCount = 0;
const workerInfo = { lastStartedAt: null, lastCompletedAt: null, lastError: null, ticks: 0, tasksProcessed: 0 };

function scheduleWorker(delayMs) {
  if (workerStopped || !handlersForTenant) return;
  const wait = Math.max(0, Number(delayMs) || 0);
  const dueAt = Date.now() + wait;
  if (workerRunning) {
    if (wait === 0) rerunRequested = true;
    return;
  }
  if (timer && timerDueAt <= dueAt) return;
  if (timer) clearTimeout(timer);
  timerDueAt = dueAt;
  timer = setTimeout(() => {
    timer = null;
    timerDueAt = 0;
    runWorker().catch((err) => { workerInfo.lastError = String(err && err.message || err).slice(0, 200); });
  }, wait);
  if (timer.unref) timer.unref();
}

async function nextDueDelay(tenants) {
  let earliest = Infinity;
  await Promise.all(tenants.map(async (tenant) => {
    try {
      const doc = await load(tenant);
      for (const task of doc.tasks || []) {
        if (task.state === STATE.QUEUED && Number.isFinite(Number(task.runAt))) earliest = Math.min(earliest, Number(task.runAt));
      }
    } catch (_) { /* le prochain balayage réessaiera */ }
  }));
  if (earliest === Infinity) return idlePollMs;
  return Math.min(idlePollMs, Math.max(0, earliest - Date.now()));
}

async function runWorker() {
  if (workerStopped || !handlersForTenant) return;
  if (workerRunning) { rerunRequested = true; return; }
  workerRunning = true;
  workerInfo.lastStartedAt = new Date().toISOString();
  workerInfo.ticks += 1;
  let processed = 0;
  let tenants = [];
  try {
    tenants = await listTenants();
    let cursor = 0;
    const drain = async () => {
      while (cursor < tenants.length && !workerStopped) {
        const tenant = tenants[cursor++];
        activeTenantCount += 1;
        try {
          const done = await processTenant(tenant, handlersForTenant(tenant), { maxPerTick: 10 });
          processed += done.length;
        } catch (err) {
          workerInfo.lastError = `${tenant}: ${String(err && err.message || err).slice(0, 180)}`;
          console.error(`taskQueue worker (${tenant}) :`, err.message);
        } finally { activeTenantCount = Math.max(0, activeTenantCount - 1); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxTenantsInParallel, tenants.length) }, drain));
    workerInfo.tasksProcessed += processed;
    workerInfo.lastError = null;
  } catch (err) {
    workerInfo.lastError = String(err && err.message || err).slice(0, 200);
    console.error('taskQueue worker :', err.message);
  } finally {
    workerRunning = false;
    workerInfo.lastCompletedAt = new Date().toISOString();
    const rerun = rerunRequested || processed > 0;
    rerunRequested = false;
    if (!workerStopped) scheduleWorker(rerun ? 0 : await nextDueDelay(tenants));
  }
}

function startWorker(handlersFor, intervalMs, options) {
  if (handlersForTenant) return timer;
  handlersForTenant = handlersFor;
  workerStopped = false;
  const opts = options || {};
  if (typeof opts.tenantProvider === 'function') tenantProvider = opts.tenantProvider;
  idlePollMs = Math.max(1000, Number(intervalMs) || 60000);
  maxTenantsInParallel = Math.max(1, Math.min(16, Number(opts.concurrency) || 4));
  scheduleWorker(0); // reprise immédiate des tâches dues et des baux expirés
  return timer;
}
function stopWorker() {
  workerStopped = true;
  handlersForTenant = null;
  rerunRequested = false;
  if (timer) { clearTimeout(timer); timer = null; timerDueAt = 0; }
}
function workerStatus() {
  return Object.assign({ running: workerRunning, activeTenants: activeTenantCount, idlePollMs, concurrency: maxTenantsInParallel }, workerInfo);
}

module.exports = { NAMESPACE, STATE, PUBLIC_STATES, normalizeState, setState, pause, resume, enqueue, claimNext, complete, fail, cancel, recover, list, status, processTenant, startWorker, stopWorker, listTenants, workerStatus };
